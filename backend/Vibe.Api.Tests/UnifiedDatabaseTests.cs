using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;
using Vibe.Api.Data;
using Vibe.Api.Features.D1;
using Vibe.Api.Features.Recurrence;
using Xunit;

namespace Vibe.Api.Tests;

public sealed partial class SyncDatabaseTests
{
    // Capture the pre-upgrade column set, so both sides include EVERY legacy column,
    // while genuinely additive nullable/default columns are deliberately excluded.
    static async Task<Dictionary<string, string[]>> LegacyColumns(string connection)
    {
        await using var db = new NpgsqlConnection(connection); await db.OpenAsync();
        await using var command = new NpgsqlCommand("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name NOT IN ('__EFMigrationsHistory','SyncSnapshots','SyncSnapshotItems') ORDER BY table_name,ordinal_position", db);
        await using var rows = await command.ExecuteReaderAsync(); var columns = new Dictionary<string, List<string>>();
        while (await rows.ReadAsync()) { string table = rows.GetString(0); if (!columns.TryGetValue(table, out var list)) columns[table] = list = []; list.Add(rows.GetString(1)); }
        return columns.ToDictionary(p => p.Key, p => p.Value.ToArray());
    }
    static async Task<Dictionary<string, string>> LegacyHashes(string connection, Dictionary<string, string[]> columns)
    {
        static string Q(string name) => "\"" + name.Replace("\"", "\"\"") + "\"";
        await using var db = new NpgsqlConnection(connection); await db.OpenAsync(); var result = new Dictionary<string, string>();
        foreach (var (table, names) in columns)
        {
            await using var command = new NpgsqlCommand("SELECT md5(COALESCE(string_agg(to_jsonb(r)::text,E'\\n' ORDER BY to_jsonb(r)::text),'')) FROM (SELECT " + string.Join(",", names.Select(Q)) + " FROM " + Q(table) + ") r", db);
            result[table] = (string)(await command.ExecuteScalarAsync())!;
        }
        return result;
    }
    [Fact]
    public async Task U1MigrationPreservesEveryLegacyColumnOfTwentyStableTablesAndOnlyDiscardsTransientSnapshots()
    {
        string schema = "vibe_test_" + Guid.NewGuid().ToString("N"); var builder = new NpgsqlConnectionStringBuilder(fixture.Connection); Safe(builder, schema); builder.SearchPath = schema;
        await using (var c = new NpgsqlConnection(fixture.Connection)) { await c.OpenAsync(); await using var command = new NpgsqlCommand("CREATE SCHEMA \"" + schema + "\"", c); await command.ExecuteNonQueryAsync(); }
        try
        {
            var options = new DbContextOptionsBuilder<VibeDb>().UseNpgsql(builder.ConnectionString).Options; Guid ruleId = Guid.NewGuid(); string owner;
            await using (var old = new VibeDb(options))
            {
                await old.GetService<IMigrator>().MigrateAsync("20261017132233_AddRecurrenceRules"); var seed = await C1DatabaseTests.SeedD1(old); owner = seed.Owner;
                Guid definition = await old.Definitions.Where(d => d.UserId == owner).Select(d => d.Id).SingleAsync(); var date = new DateOnly(2026, 10, 14);
                await old.Database.ExecuteSqlInterpolatedAsync($"INSERT INTO \"RecurrenceRules\" (\"UserId\",\"Id\",\"DefinitionId\",\"DaysMask\",\"Timezone\",\"StartDate\",\"EndDate\",\"GenerationStartDate\",\"Enabled\",\"GeneratedThrough\",\"Version\") VALUES ({owner},{ruleId},{definition},127,'Europe/Moscow',{date},NULL,{date},true,{date},'rule_legacy')");
                old.RecurrenceSlots.Add(new RecurrenceSlotRow { UserId = owner, RuleId = ruleId, SlotDate = date, OccurrenceId = seed.Occurrence });
                string snapshot = await old.Database.SqlQuery<string>($"SELECT \"SnapshotJson\"::text AS \"Value\" FROM \"TaskOccurrences\" WHERE \"UserId\"={owner}").SingleAsync();
                old.Completions.Add(new CompletionRow { UserId = owner, Id = Guid.NewGuid(), OccurrenceId = seed.Occurrence, CompletedAtUtc = new DateTime(2026, 10, 14, 15, 0, 0, DateTimeKind.Utc), OccurrenceSnapshotJson = new JsonObject { ["logicalDate"] = "2026-10-14", ["sourceDefinitionVersion"] = "definition_legacy", ["constraintsSnapshot"] = Wire.Obj(snapshot) }.ToJsonString() });
                Guid stream = Guid.NewGuid(), header = Guid.NewGuid(); old.SyncStreams.Add(new SyncStreamRow { UserId = owner, StreamId = stream, LastSequence = 1 });
                Guid operation = await old.Operations.Where(o => o.UserId == owner).Select(o => o.OpId).SingleAsync(); string item = "{\"kind\":\"category\",\"value\":{\"id\":\"" + Guid.NewGuid() + "\",\"name\":\"historical\",\"serverVersion\":\"historical_v1\"}}";
                old.SyncChanges.Add(new SyncChangeRow { UserId = owner, StreamId = stream, Sequence = 1, OpId = operation, Ordinal = 0, ItemJson = item, PlanStateJson = "{\"inputVersion\":\"42\",\"scheduleVersion\":\"7\"}", RecordedAtUtc = DateTime.UtcNow });
                old.SyncSnapshots.Add(new SyncSnapshotRow { UserId = owner, StreamId = stream, Id = header, WatermarkSequence = 1, PageSize = 1, AsOfCursor = "old-s2-cursor", CreatedAtUtc = DateTime.UtcNow, ExpiresAtUtc = DateTime.UtcNow.AddMinutes(15) });
                old.SyncSnapshotItems.Add(new SyncSnapshotItemRow { UserId = owner, SnapshotId = header, ItemJson = item }); await old.SaveChangesAsync();
            }
            var columns = await LegacyColumns(builder.ConnectionString); Assert.Equal(20, columns.Count); var before = await LegacyHashes(builder.ConnectionString, columns);
            await using (var current = new VibeDb(options))
            {
                await current.Database.MigrateAsync(); var rule = await current.RecurrenceRules.SingleAsync(); Assert.Equal("weekly", rule.Pattern); Assert.Null(rule.TimeIntentJson); Assert.Null(rule.IntervalDays); Assert.Null(rule.AnchorDate); Wire.Validate(RecurrenceService.Rule(rule), "RecurrenceRuleU1");
                var occurrence = await current.Occurrences.Include(o => o.Block).Include(o => o.Completions).SingleAsync(); Assert.Null(occurrence.TimeIntentJson); Assert.Null(occurrence.ResolvedTimingJson); Assert.Null(occurrence.PlacementIssue); Assert.False(Wire.Obj(occurrence.SnapshotJson).ContainsKey("workOrigin")); Wire.Validate(D1Service.Occurrence(occurrence), "TaskOccurrenceU1");
                var definition = await current.Definitions.SingleAsync(); Assert.False(Wire.Obj(definition.FieldsJson).ContainsKey("workOrigin")); Assert.Equal("manual", Wire.Str(D1Service.Definition(definition), "workOrigin"));
                Assert.Equal(3, Wire.Obj((await current.Completions.SingleAsync()).OccurrenceSnapshotJson).Count); Assert.Empty(await current.SyncSnapshots.ToArrayAsync()); Assert.Empty(await current.SyncSnapshotItems.ToArrayAsync());
            }
            var after = await LegacyHashes(builder.ConnectionString, columns); foreach (var (table, hash) in before) Assert.Equal(hash, after[table]);
        }
        finally
        {
            Safe(builder, schema); await using var c = new NpgsqlConnection(fixture.Connection); await c.OpenAsync(); await using var command = new NpgsqlCommand("DROP SCHEMA \"" + schema + "\" CASCADE", c); await command.ExecuteNonQueryAsync();
        }
    }
}
