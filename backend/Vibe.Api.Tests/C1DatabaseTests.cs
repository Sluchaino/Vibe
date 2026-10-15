using Microsoft.EntityFrameworkCore;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;
using Vibe.Api.Data;
using Xunit;

namespace Vibe.Api.Tests;

public class C1DatabaseTests(PostgresFixture fixture) : IClassFixture<PostgresFixture>
{
    static readonly string[] D1Tables = ["AspNetUsers", "UserSettings", "Places", "UserPlanState", "Categories", "TaskDefinitions", "TaskOccurrences", "CalendarBlocks", "OperationResults"];
    static void VerifyTarget(NpgsqlConnectionStringBuilder connection, string schema)
    {
        if (connection.Database != "vibe_d1_tests" || !System.Text.RegularExpressions.Regex.IsMatch(schema, "^vibe_test_[a-f0-9]{32}$"))
            throw new InvalidOperationException("Unsafe isolated migration test target.");
    }
    static async Task<Dictionary<string, string>> Hashes(string connection)
    {
        var values = new Dictionary<string, string>();
        await using var c = new NpgsqlConnection(connection); await c.OpenAsync();
        foreach (string table in D1Tables)
        {
            await using var command = new NpgsqlCommand("SELECT md5(COALESCE(string_agg(to_jsonb(row_value)::text, E'\\n' ORDER BY to_jsonb(row_value)::text), '')) FROM \"" + table + "\" row_value", c);
            values[table] = (string)(await command.ExecuteScalarAsync())!;
        }
        return values;
    }
    static async Task<(string Owner, Guid Occurrence)> SeedD1(VibeDb db)
    {
        string owner = Guid.NewGuid().ToString("D"); Guid place = Guid.NewGuid(), category = Guid.NewGuid(), definition = Guid.NewGuid(), occurrence = Guid.NewGuid();
        db.Users.Add(new VibeUser { Id = owner, UserName = "migration-test", NormalizedUserName = "MIGRATION-TEST" }); await db.SaveChangesAsync();
        db.Plans.Add(new PlanRow { UserId = owner, InputRevision = 42, ScheduleRevision = 7 });
        db.Settings.Add(new SettingsRow { UserId = owner, Place = new PlaceRow { UserId = owner, Id = place, Name = "test place", Version = "place_legacy" }, Version = "settings_legacy" });
        db.Categories.Add(new CategoryRow { UserId = owner, Id = category, Name = "test category", Version = "category_legacy" }); await db.SaveChangesAsync();
        string snapshot = $$"""{"durationPolicy":{"mode":"fixedWork","requiredWorkMinutes":90},"splitAllowed":false,"mobilityPolicy":"fixedAfterPlacement","availabilityRules":{"timezone":"Europe/Moscow","windows":[],"dateExceptions":[]},"placeId":"{{place:D}}","requiredRestMinutes":0}""";
        var fields = JsonNode.Parse(snapshot)!.AsObject(); fields["title"] = "D1 migration fixture"; fields["description"] = ""; fields["categoryId"] = category.ToString("D"); fields["importance"] = "normal"; fields["difficulty"] = "medium"; fields["executionPriority"] = 3;
        db.Definitions.Add(new DefinitionRow { UserId = owner, Id = definition, CategoryId = category, PlaceId = place, FieldsJson = fields.ToJsonString(), Version = "definition_legacy" }); await db.SaveChangesAsync();
        db.Occurrences.Add(new OccurrenceRow { UserId = owner, Id = occurrence, DefinitionId = definition, PlaceId = place, LogicalDate = new DateOnly(2026, 10, 14), SourceDefinitionVersion = "definition_legacy", SnapshotJson = snapshot, Version = "occurrence_legacy" }); await db.SaveChangesAsync();
        db.Blocks.Add(new BlockRow { UserId = owner, Id = Guid.NewGuid(), OccurrenceId = occurrence, Start = new DateTime(2026, 10, 14, 12, 0, 0, DateTimeKind.Utc), End = new DateTime(2026, 10, 14, 13, 30, 0, DateTimeKind.Utc), Fixed = true, Version = "block_legacy" });
        db.Operations.Add(new OperationRow { UserId = owner, OpId = Guid.NewGuid(), Fingerprint = "legacy-fingerprint", Status = 200, Body = "{\r\n  \"old\": true\r\n}\n", ETag = "\"occurrence_legacy\"", Location = "/api/v1/occurrences/" + occurrence }); await db.SaveChangesAsync();
        return (owner, occurrence);
    }
    [Fact]
    public async Task AdditiveMigrationPreservesEveryPopulatedD1TableAndOperationByte()
    {
        string schema = "vibe_test_" + Guid.NewGuid().ToString("N");
        var builder = new NpgsqlConnectionStringBuilder(fixture.Connection); VerifyTarget(builder, schema); builder.SearchPath = schema;
        string connection = builder.ConnectionString;
        await using (var c = new NpgsqlConnection(fixture.Connection))
        {
            await c.OpenAsync(); await using var command = new NpgsqlCommand("CREATE SCHEMA \"" + schema + "\"", c); await command.ExecuteNonQueryAsync();
        }
        try
        {
            var options = new DbContextOptionsBuilder<VibeDb>().UseNpgsql(connection).Options;
            await using (var old = new VibeDb(options))
            {
                await old.GetService<IMigrator>().MigrateAsync("20261012171233_InitialD1");
                await SeedD1(old);
            }
            var before = await Hashes(connection);
            await using (var current = new VibeDb(options))
            {
                await current.Database.MigrateAsync();
                Assert.Empty(await current.Completions.ToListAsync());
                Assert.Equal("{\r\n  \"old\": true\r\n}\n", (await current.Operations.SingleAsync()).Body);
                Assert.Equal("occurrence_legacy", (await current.Occurrences.SingleAsync()).Version);
                Assert.True((await current.Blocks.SingleAsync()).Fixed);
            }
            var after = await Hashes(connection);
            foreach (string table in D1Tables) Assert.Equal(before[table], after[table]);
        }
        finally
        {
            VerifyTarget(builder, schema);
            await using var c = new NpgsqlConnection(fixture.Connection); await c.OpenAsync();
            await using var command = new NpgsqlCommand("DROP SCHEMA \"" + schema + "\" CASCADE", c); await command.ExecuteNonQueryAsync();
        }
    }
    [Fact]
    public async Task PartialUniqueAndOwnerForeignKeyAllowRevokedHistoryButRejectSecondActiveAndForeignLinks()
    {
        var options = new DbContextOptionsBuilder<VibeDb>().UseNpgsql(fixture.Connection).Options;
        (string Owner, Guid Occurrence) target;
        await using (var seed = new VibeDb(options)) target = await SeedD1(seed);
        var instant = new DateTime(2026, 10, 14, 12, 0, 0, DateTimeKind.Utc);
        string snapshot;
        await using (var source = new VibeDb(options)) snapshot = (await source.Occurrences.SingleAsync(o => o.UserId == target.Owner && o.Id == target.Occurrence)).SnapshotJson;
        string context = new JsonObject { ["logicalDate"] = "2026-10-14", ["sourceDefinitionVersion"] = "definition_legacy", ["constraintsSnapshot"] = JsonNode.Parse(snapshot) }.ToJsonString();
        CompletionRow Fact(string owner, Guid occurrence, DateTime? revoked = null, string source = "manual") => new()
        { UserId = owner, Id = Guid.NewGuid(), OccurrenceId = occurrence, CompletedAtUtc = instant, RevokedAtUtc = revoked, Source = source, OccurrenceSnapshotJson = context };
        await using (var allowed = new VibeDb(options))
        {
            allowed.Completions.AddRange(Fact(target.Owner, target.Occurrence, instant.AddMinutes(-2)), Fact(target.Owner, target.Occurrence, instant), Fact(target.Owner, target.Occurrence));
            await allowed.SaveChangesAsync();
            Assert.Equal(3, await allowed.Completions.CountAsync(c => c.UserId == target.Owner && c.OccurrenceId == target.Occurrence));
            Assert.Single(await allowed.Completions.Where(c => c.UserId == target.Owner && c.OccurrenceId == target.Occurrence && c.RevokedAtUtc == null).ToListAsync());
        }
        async Task Reject(CompletionRow fact, string sqlState)
        {
            await using var db = new VibeDb(options); db.Completions.Add(fact);
            var error = await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync());
            Assert.Equal(sqlState, Assert.IsType<PostgresException>(error.InnerException).SqlState);
        }
        await Reject(Fact(target.Owner, target.Occurrence), PostgresErrorCodes.UniqueViolation);
        await Reject(Fact(target.Owner, Guid.NewGuid()), PostgresErrorCodes.ForeignKeyViolation);
        string anotherOwner;
        await using (var users = new VibeDb(options)) anotherOwner = (await users.Users.SingleAsync(u => u.UserName == "boris")).Id;
        await Reject(Fact(anotherOwner, target.Occurrence), PostgresErrorCodes.ForeignKeyViolation);
        await Reject(Fact(target.Owner, target.Occurrence, instant, source: "timer"), PostgresErrorCodes.CheckViolation);
    }
}
