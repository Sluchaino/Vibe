using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;
using System.Text.Json.Nodes;
using Vibe.Api.Data;
using Xunit;

namespace Vibe.Api.Tests;

public sealed class SyncDatabaseTests(PostgresFixture fixture) : IClassFixture<PostgresFixture>
{
    static void Safe(NpgsqlConnectionStringBuilder connection, string schema)
    {
        if (connection.Database != "vibe_d1_tests" || !System.Text.RegularExpressions.Regex.IsMatch(schema, "^vibe_test_[a-f0-9]{32}$")) throw new InvalidOperationException("Unsafe migration test target.");
    }
    static async Task<Dictionary<string, string>> Hashes(string connection)
    {
        await using var db = new NpgsqlConnection(connection); await db.OpenAsync(); var tables = new List<string>();
        await using (var names = new NpgsqlCommand("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name <> '__EFMigrationsHistory' AND table_name NOT LIKE 'Sync%' ORDER BY table_name", db))
        await using (var rows = await names.ExecuteReaderAsync()) while (await rows.ReadAsync()) tables.Add(rows.GetString(0));
        var result = new Dictionary<string, string>();
        foreach (string table in tables)
        {
            await using var command = new NpgsqlCommand("SELECT md5(COALESCE(string_agg(to_jsonb(r)::text, E'\\n' ORDER BY to_jsonb(r)::text), '')) FROM \"" + table.Replace("\"", "\"\"") + "\" r", db);
            result[table] = (string)(await command.ExecuteScalarAsync())!;
        }
        return result;
    }
    [Fact]
    public async Task AdditiveMigrationPreservesAllSixteenC1TablesAndSeedsExistingAccountsAtZero()
    {
        string schema = "vibe_test_" + Guid.NewGuid().ToString("N"); var builder = new NpgsqlConnectionStringBuilder(fixture.Connection); Safe(builder, schema); builder.SearchPath = schema;
        await using (var c = new NpgsqlConnection(fixture.Connection))
        { await c.OpenAsync(); await using var command = new NpgsqlCommand("CREATE SCHEMA \"" + schema + "\"", c); await command.ExecuteNonQueryAsync(); }
        try
        {
            var options = new DbContextOptionsBuilder<VibeDb>().UseNpgsql(builder.ConnectionString).Options;
            string owner;
            await using (var old = new VibeDb(options))
            {
                await old.GetService<IMigrator>().MigrateAsync("20261013233411_AddCompletionHistory");
                var seed = await C1DatabaseTests.SeedD1(old); owner = seed.Owner;
                var role = new IdentityRole { Id = Guid.NewGuid().ToString(), Name = "test-role", NormalizedName = "TEST-ROLE" };
                old.Roles.Add(role); old.Users.Add(new VibeUser { Id = Guid.NewGuid().ToString(), UserName = "second", NormalizedUserName = "SECOND" }); await old.SaveChangesAsync();
                old.UserRoles.Add(new IdentityUserRole<string> { UserId = owner, RoleId = role.Id });
                old.UserClaims.Add(new IdentityUserClaim<string> { UserId = owner, ClaimType = "test", ClaimValue = "preserve" });
                old.RoleClaims.Add(new IdentityRoleClaim<string> { RoleId = role.Id, ClaimType = "test", ClaimValue = "preserve" });
                old.UserLogins.Add(new IdentityUserLogin<string> { UserId = owner, LoginProvider = "test", ProviderKey = "key" });
                old.UserTokens.Add(new IdentityUserToken<string> { UserId = owner, LoginProvider = "test", Name = "test", Value = "non-secret-fixture" });
                var instant = new DateTime(2026, 10, 15, 10, 0, 0, DateTimeKind.Utc);
                var occurrence = await old.Occurrences.SingleAsync(o => o.UserId == owner);
                string context = new JsonObject { ["logicalDate"] = "2026-10-14", ["sourceDefinitionVersion"] = occurrence.SourceDefinitionVersion, ["constraintsSnapshot"] = JsonNode.Parse(occurrence.SnapshotJson) }.ToJsonString();
                old.Completions.AddRange(new CompletionRow { UserId = owner, Id = Guid.NewGuid(), OccurrenceId = seed.Occurrence, CompletedAtUtc = instant, RevokedAtUtc = instant.AddMinutes(-1), OccurrenceSnapshotJson = context, Version = "revoked_legacy" },
                    new CompletionRow { UserId = owner, Id = Guid.NewGuid(), OccurrenceId = seed.Occurrence, CompletedAtUtc = instant, OccurrenceSnapshotJson = context, Version = "active_legacy" });
                old.Operations.Add(new OperationRow { UserId = owner, OpId = Guid.NewGuid(), Fingerprint = "failed-legacy", Status = 409, Body = "{ \"legacyError\": true }\n", ETag = "\"old_legacy\"" });
                await old.SaveChangesAsync();
            }
            var before = await Hashes(builder.ConnectionString); Assert.Equal(16, before.Count);
            await using (var current = new VibeDb(options))
            {
                await current.Database.MigrateAsync();
                Assert.Equal(2, await current.SyncStreams.CountAsync());
                foreach (var stream in await current.SyncStreams.ToListAsync()) { Assert.NotEqual(Guid.Empty, stream.StreamId); Assert.Equal(0, stream.LastSequence); Assert.Equal(0, stream.PrunedThrough); }
                Assert.Empty(await current.SyncChanges.ToListAsync()); Assert.Empty(await current.SyncSnapshots.ToListAsync()); Assert.Empty(await current.SyncSnapshotItems.ToListAsync());
                Assert.Equal(2, await current.Completions.CountAsync(c => c.UserId == owner));
            }
            var after = await Hashes(builder.ConnectionString); foreach (var (table, checksum) in before) Assert.Equal(checksum, after[table]);
        }
        finally
        {
            Safe(builder, schema); await using var c = new NpgsqlConnection(fixture.Connection); await c.OpenAsync();
            await using var command = new NpgsqlCommand("DROP SCHEMA \"" + schema + "\" CASCADE", c); await command.ExecuteNonQueryAsync();
        }
    }

    [Fact]
    public async Task CompositeOwnerKeysUniqueChangeAndOperationAndSequenceRangesAreEnforcedByPostgres()
    {
        var options = new DbContextOptionsBuilder<VibeDb>().UseNpgsql(fixture.Connection).Options;
        string a = Guid.NewGuid().ToString(), b = Guid.NewGuid().ToString(); Guid sa = Guid.NewGuid(), sb = Guid.NewGuid(), op = Guid.NewGuid(), otherOp = Guid.NewGuid(), foreignOp = Guid.NewGuid(), change = Guid.NewGuid(), snapshot = Guid.NewGuid();
        await using (var seed = new VibeDb(options))
        {
            seed.Users.AddRange(new VibeUser { Id = a }, new VibeUser { Id = b });
            seed.SyncStreams.AddRange(new SyncStreamRow { UserId = a, StreamId = sa, LastSequence = 10 }, new SyncStreamRow { UserId = b, StreamId = sb });
            seed.Operations.AddRange(new OperationRow { UserId = a, OpId = op }, new OperationRow { UserId = a, OpId = otherOp }, new OperationRow { UserId = b, OpId = foreignOp });
            seed.SyncChanges.Add(new SyncChangeRow { UserId = a, StreamId = sa, Sequence = 1, OpId = op, ChangeId = change, RecordedAtUtc = DateTime.UtcNow });
            seed.SyncSnapshots.Add(new SyncSnapshotRow { UserId = a, Id = snapshot, StreamId = sa, PageSize = 1, CreatedAtUtc = DateTime.UtcNow, ExpiresAtUtc = DateTime.UtcNow.AddMinutes(15) });
            await seed.SaveChangesAsync();
        }
        async Task Reject(object row, string sqlState)
        {
            await using var db = new VibeDb(options); db.Add(row); var error = await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync());
            Assert.Equal(sqlState, Assert.IsType<PostgresException>(error.InnerException).SqlState);
        }
        SyncChangeRow Change(Guid stream, long sequence, Guid operation, Guid? id = null) => new() { UserId = a, StreamId = stream, Sequence = sequence, OpId = operation, ChangeId = id ?? Guid.NewGuid(), RecordedAtUtc = DateTime.UtcNow };
        await Reject(Change(sa, 2, op), PostgresErrorCodes.UniqueViolation);
        await Reject(Change(sa, 2, otherOp, change), PostgresErrorCodes.UniqueViolation);
        await Reject(Change(sb, 2, otherOp), PostgresErrorCodes.ForeignKeyViolation);
        await Reject(Change(sa, 2, foreignOp), PostgresErrorCodes.ForeignKeyViolation);
        await Reject(Change(sa, 0, otherOp), PostgresErrorCodes.CheckViolation);
        await Reject(new SyncSnapshotItemRow { UserId = b, SnapshotId = snapshot }, PostgresErrorCodes.ForeignKeyViolation);
        await Reject(new SyncSnapshotRow { UserId = a, StreamId = sb, PageSize = 1, CreatedAtUtc = DateTime.UtcNow, ExpiresAtUtc = DateTime.UtcNow.AddMinutes(15) }, PostgresErrorCodes.ForeignKeyViolation);
        await using var actual = new VibeDb(options);
        var range = await Assert.ThrowsAsync<PostgresException>(() => actual.SyncStreams.Where(s => s.UserId == a).ExecuteUpdateAsync(u => u.SetProperty(s => s.PrunedThrough, 11L)));
        Assert.Equal(PostgresErrorCodes.CheckViolation, range.SqlState);
    }
}
