using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Vibe.Api.Data;
using Vibe.Api.Features.D1;
using Vibe.Api.Features.Sync;
using Xunit;

namespace Vibe.Api.Tests;

public sealed partial class SyncIntegrationTests
{
    [Fact]
    public async Task SnapshotCapRetainsLastPagesReuseNeverExtendsTtlAndExpiryFreesPins()
    {
        using var session = await Account(); var client = session.Client; await Category(client);
        var now = DateTimeOffset.UtcNow; fixture.Clock.SetUtcNow(now);
        try
        {
            var first = await Bootstrap(client, 1); string page = Wire.Str(first, "nextPageCursor"), expiry = Wire.Str(first, "expiresAt");
            fixture.Clock.Advance(TimeSpan.FromMinutes(1));
            var reuse = await Bootstrap(client, 1); Assert.Equal(Wire.Str(first, "snapshotId"), Wire.Str(reuse, "snapshotId")); Assert.Equal(expiry, Wire.Str(reuse, "expiresAt"));
            await Json(await client.GetAsync(CursorPath("bootstrap", page))); // terminal page still counts against the cap.
            for (int i = 0; i < 3; i++) { await Category(client); await Bootstrap(client, 1); }
            await Category(client); await Error(await client.GetAsync("/api/v1/sync/bootstrap?pageSize=1"), HttpStatusCode.TooManyRequests, "syncBootstrapBusy");
            await using (var db = Db()) Assert.Equal(4, await db.SyncSnapshots.CountAsync(s => s.UserId == session.Owner));
            await Json(await client.GetAsync(CursorPath("bootstrap", page))); // no eviction of a valid snapshot.
            fixture.Clock.SetUtcNow(now.AddMinutes(17));
            await Error(await client.GetAsync(CursorPath("bootstrap", page)), HttpStatusCode.Gone, "snapshotExpired");
            var next = await Bootstrap(client, 1); Assert.NotEqual(Wire.Str(first, "snapshotId"), Wire.Str(next, "snapshotId"));
            await using var actual = Db(); Assert.Equal(1, await actual.SyncSnapshots.CountAsync(s => s.UserId == session.Owner));
            var snapshotId = Guid.Parse(Wire.Str(next, "snapshotId"));
            Assert.False(await actual.SyncSnapshotItems.AnyAsync(i => i.UserId == session.Owner && i.SnapshotId != snapshotId));
        }
        finally { fixture.Clock.Reset(); }
    }

    [Fact]
    public async Task FiveThousandItemsSucceedAndTheNextItemRejectsWithoutPartialSnapshot()
    {
        using var session = await Account();
        await using (var seed = Db())
        {
            seed.Categories.AddRange(Enumerable.Range(0, 4999).Select(i => new CategoryRow { UserId = session.Owner, Id = Guid.NewGuid(), Name = "bounded " + i }));
            await seed.SaveChangesAsync();
        }
        var first = await Bootstrap(session.Client, 100);
        var snapshot = Guid.Parse(Wire.Str(first, "snapshotId"));
        await using (var db = Db()) Assert.Equal(5000, await db.SyncSnapshotItems.CountAsync(i => i.UserId == session.Owner && i.SnapshotId == snapshot));
        await Category(session.Client); // new head prevents reuse of the previous complete snapshot.
        await Error(await session.Client.GetAsync("/api/v1/sync/bootstrap"), HttpStatusCode.Conflict, "syncSnapshotTooLarge");
        await using var actual = Db(); Assert.Equal(1, await actual.SyncSnapshots.CountAsync(s => s.UserId == session.Owner));
        Assert.Equal(5000, await actual.SyncSnapshotItems.CountAsync(i => i.UserId == session.Owner));
        Assert.Single(await actual.SyncChanges.Where(c => c.UserId == session.Owner).ToListAsync());
    }

    [Theory]
    [InlineData(0, true)]
    [InlineData(-1, false)]
    public async Task SnapshotCompactUtf8PayloadBoundaryIsExact(int adjustment, bool accepted)
    {
        var settings = new SettingsRow(); var plan = new PlanRow();
        long bytes = Encoding.UTF8.GetByteCount(Wire.Json(SyncProjection.Item("settings", D1Service.Settings(settings))))
            + Encoding.UTF8.GetByteCount(Wire.Json(D1Service.Plan(plan)));
        await using var app = new TestApp(fixture.Connection, fixture.Clock, new Dictionary<string, string?> { ["Sync:MaxSnapshotPayloadBytes"] = (bytes + adjustment).ToString(System.Globalization.CultureInfo.InvariantCulture) });
        using var session = await Account(app);
        if (accepted) { var page = await Bootstrap(session.Client); Assert.Single(page["items"]!.AsArray()); }
        else await Error(await session.Client.GetAsync("/api/v1/sync/bootstrap"), HttpStatusCode.Conflict, "syncSnapshotTooLarge");
        await using var actual = Db(); Assert.Equal(accepted ? 1 : 0, await actual.SyncSnapshots.CountAsync(s => s.UserId == session.Owner));
        Assert.Equal(accepted ? 1 : 0, await actual.SyncSnapshotItems.CountAsync(i => i.UserId == session.Owner));
    }

    [Fact]
    public async Task LargeDefinitionPayloadStopsAtByteBudgetBeforeLaterProjectionAndLeavesNoRows()
    {
        await using var app = new TestApp(fixture.Connection, fixture.Clock, new Dictionary<string, string?> { ["Sync:MaxSnapshotPayloadBytes"] = "4096" });
        using var session = await Account(app); string place = await SetupPlace(session.Client);
        var fields = DefinitionCommand(place); fields.Remove("id"); fields.Remove("opId");
        var windows = fields["availabilityRules"]!["windows"]!.AsArray();
        for (int i = 0; i < 400; i++) windows.Add(Wire.Obj("{\"daysOfWeek\":[\"monday\"],\"startLocalTime\":\"00:00\",\"endLocalTime\":\"23:00\",\"endDayOffset\":0}"));
        string largeJson = Wire.Json(fields);
        await using (var seed = Db())
        {
            // Each field JSON is well below the normal 1MiB command limit. The account as a
            // whole exceeds this test's byte budget; enumeration must stop on the first item.
            for (int i = 1; i <= 30; i++) seed.Definitions.Add(new DefinitionRow { UserId = session.Owner, Id = Guid.Parse("00000000-0000-0000-0000-" + i.ToString("x12")), PlaceId = Guid.Parse(place), FieldsJson = largeJson });
            seed.Definitions.Add(new DefinitionRow { UserId = session.Owner, Id = Guid.Parse("ffffffff-ffff-ffff-ffff-ffffffffffff"), PlaceId = Guid.Parse(place), FieldsJson = "[]" }); // would fail projection if reached.
            await seed.SaveChangesAsync();
        }
        await Error(await session.Client.GetAsync("/api/v1/sync/bootstrap"), HttpStatusCode.Conflict, "syncSnapshotTooLarge");
        await using var actual = Db(); Assert.False(await actual.SyncSnapshots.AnyAsync(s => s.UserId == session.Owner)); Assert.False(await actual.SyncSnapshotItems.AnyAsync(i => i.UserId == session.Owner));
    }

    [Fact]
    public async Task GuardBudgetReturnsBusyAndReleasesWithoutSnapshotOrDomainChange()
    {
        using var session = await Account();
        await using var connection = new NpgsqlConnection(fixture.Connection); await connection.OpenAsync();
        await using var transaction = await connection.BeginTransactionAsync();
        await using (var locked = new NpgsqlCommand("SELECT * FROM \"UserPlanState\" WHERE \"UserId\" = @owner FOR UPDATE", connection, transaction))
        { locked.Parameters.AddWithValue("owner", session.Owner); await locked.ExecuteNonQueryAsync(); }
        var elapsed = Stopwatch.StartNew();
        await Error(await session.Client.GetAsync("/api/v1/sync/bootstrap"), HttpStatusCode.ServiceUnavailable, "syncBootstrapBusy");
        Assert.InRange(elapsed.Elapsed.TotalSeconds, 1, 8);
        await transaction.RollbackAsync();
        await using (var actual = Db()) { Assert.False(await actual.SyncSnapshots.AnyAsync(s => s.UserId == session.Owner)); Assert.Equal(0, (await Stream(session.Owner)).LastSequence); }
        await Bootstrap(session.Client);
    }

    [Fact]
    public async Task BuildBudgetIncludesSaveChangesAndRollsBackSnapshotHeaderItemsAndPin()
    {
        using var session = await Account(); string suffix = Guid.NewGuid().ToString("N"), function = "sync_slow_" + suffix, trigger = "sync_slow_trigger_" + suffix;
        await Sql($$"""CREATE FUNCTION "{{function}}"() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN PERFORM pg_sleep(12); RETURN NEW; END $fn$; CREATE TRIGGER "{{trigger}}" BEFORE INSERT ON "SyncSnapshots" FOR EACH ROW WHEN (NEW."UserId" = '{{session.Owner}}') EXECUTE FUNCTION "{{function}}"();""");
        try
        {
            var elapsed = Stopwatch.StartNew();
            await Error(await session.Client.GetAsync("/api/v1/sync/bootstrap"), HttpStatusCode.ServiceUnavailable, "syncBootstrapBusy");
            Assert.InRange(elapsed.Elapsed.TotalSeconds, 3.5, 10);
            await using var actual = Db(); Assert.False(await actual.SyncSnapshots.AnyAsync(s => s.UserId == session.Owner)); Assert.False(await actual.SyncSnapshotItems.AnyAsync(i => i.UserId == session.Owner));
            Assert.False(await actual.Operations.AnyAsync(o => o.UserId == session.Owner)); Assert.Equal(0, (await Stream(session.Owner)).LastSequence);
        }
        finally { await Sql($"DROP TRIGGER \"{trigger}\" ON \"SyncSnapshots\"; DROP FUNCTION \"{function}\"();"); }
        await Category(session.Client); await Bootstrap(session.Client);
    }
}
