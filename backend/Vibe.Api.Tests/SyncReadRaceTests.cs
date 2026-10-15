using System.Net;
using System.Text.Json.Nodes;
using Npgsql;
using Vibe.Api.Features.D1;
using Xunit;

namespace Vibe.Api.Tests;

public sealed partial class SyncIntegrationTests
{
    async Task WaitForBlocked(string predicate)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await using var connection = new NpgsqlConnection(fixture.Connection); await connection.OpenAsync(timeout.Token);
        while (true)
        {
            await using var command = new NpgsqlCommand("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted AND " + predicate + ")", connection);
            if ((bool)(await command.ExecuteScalarAsync(timeout.Token))!) return;
            await Task.Delay(10, timeout.Token);
        }
    }
    [Fact]
    public async Task SnapshotExpiryDuringItemReadReturnsGoneInsteadOfPublishingExpiredPage()
    {
        using var session = await Account(); await Category(session.Client); var snapshot = await Bootstrap(session.Client, 1);
        await using var connection = new NpgsqlConnection(fixture.Connection); await connection.OpenAsync();
        await using var transaction = await connection.BeginTransactionAsync(); bool released = false;
        await using (var locked = new NpgsqlCommand("LOCK TABLE \"SyncSnapshotItems\" IN ACCESS EXCLUSIVE MODE", connection, transaction)) await locked.ExecuteNonQueryAsync();
        try
        {
            var request = session.Client.GetAsync(CursorPath("bootstrap", Wire.Str(snapshot, "nextPageCursor")));
            await WaitForBlocked("relation='\"SyncSnapshotItems\"'::regclass");
            fixture.Clock.Advance(TimeSpan.FromMinutes(16)); await transaction.CommitAsync(); released = true;
            await Error(await request, HttpStatusCode.Gone, "snapshotExpired");
        }
        finally { if (!released) await transaction.RollbackAsync(); fixture.Clock.Reset(); }
    }

    [Fact]
    public async Task MaterializationPinsUnderSameGuardAndConcurrentWriterAppearsOnlyAfterWatermark()
    {
        using var session = await Account(); string suffix = Guid.NewGuid().ToString("N"), function = "sync_gate_" + suffix, trigger = "sync_gate_trigger_" + suffix;
        int key = Random.Shared.Next(1, int.MaxValue);
        await using var connection = new NpgsqlConnection(fixture.Connection); await connection.OpenAsync();
        await using var transaction = await connection.BeginTransactionAsync(); bool released = false;
        await using (var locked = new NpgsqlCommand("SELECT pg_advisory_xact_lock(@key)", connection, transaction)) { locked.Parameters.AddWithValue("key", (long)key); await locked.ExecuteNonQueryAsync(); }
        await Sql($$"""CREATE FUNCTION "{{function}}"() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN PERFORM pg_advisory_xact_lock({{key}}); RETURN NEW; END $fn$; CREATE TRIGGER "{{trigger}}" BEFORE INSERT ON "SyncSnapshots" FOR EACH ROW WHEN (NEW."UserId" = '{{session.Owner}}') EXECUTE FUNCTION "{{function}}"();""");
        try
        {
            var bootstrap = session.Client.GetAsync("/api/v1/sync/bootstrap");
            await WaitForBlocked("locktype='advisory' AND objid=" + key + "::oid");
            var write = Category(session.Client, "after watermark"); await Task.Delay(50); Assert.False(write.IsCompleted);
            await transaction.CommitAsync(); released = true;
            var snapshot = await Json(await bootstrap); Wire.Validate(snapshot, "BootstrapPage"); await write;
            Assert.Single(snapshot["items"]!.AsArray());
            var delta = await Delta(session.Client, Wire.Str(snapshot, "asOfCursor"));
            Assert.Equal("after watermark", Wire.Str(Assert.Single(delta["changes"]!.AsArray())!["item"]!["value"]!, "name"));
            Assert.Equal(1, (await Stream(session.Owner)).LastSequence);
        }
        finally
        {
            if (!released) await transaction.RollbackAsync();
            await Sql($"DROP TRIGGER \"{trigger}\" ON \"SyncSnapshots\"; DROP FUNCTION \"{function}\"();");
        }
    }
}
