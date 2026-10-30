using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;
using NpgsqlTypes;
using Vibe.Api.Data;
using Vibe.Api.Features.D1;
using Xunit;

namespace Vibe.Api.Tests;

public sealed partial class SyncDatabaseTests
{
    static async Task<string> SyncHash(string connection, string table, bool removeOrdinal = false)
    {
        await using var c = new NpgsqlConnection(connection); await c.OpenAsync();
        string row = removeOrdinal ? "(to_jsonb(r)-'Ordinal')" : "to_jsonb(r)";
        await using var command = new NpgsqlCommand("SELECT md5(COALESCE(string_agg(" + row + "::text, E'\\n' ORDER BY " + row + "::text), '')) FROM \"" + table + "\" r", c);
        return (string)(await command.ExecuteScalarAsync())!;
    }
    [Fact]
    public async Task R1MigrationPreservesSixteenDomainTablesAndOldFeedStreamWhileDiscardingOnlyTransientSnapshots()
    {
        string schema = "vibe_test_" + Guid.NewGuid().ToString("N"); var builder = new NpgsqlConnectionStringBuilder(fixture.Connection); Safe(builder, schema); builder.SearchPath = schema;
        await using (var c = new NpgsqlConnection(fixture.Connection)) { await c.OpenAsync(); await using var command = new NpgsqlCommand("CREATE SCHEMA \"" + schema + "\"", c); await command.ExecuteNonQueryAsync(); }
        try
        {
            var options = new DbContextOptionsBuilder<VibeDb>().UseNpgsql(builder.ConnectionString).Options;
            string owner; Guid streamId = Guid.NewGuid(), snapshotId = Guid.NewGuid(), changeId = Guid.NewGuid(), opId; string item, plan;
            await using (var old = new VibeDb(options))
            {
                await old.GetService<IMigrator>().MigrateAsync("20261015124530_AddSyncStream");
                var seed = await C1DatabaseTests.SeedD1(old); owner = seed.Owner;
                old.SyncStreams.Add(new SyncStreamRow { UserId = owner, StreamId = streamId, LastSequence = 1 });
                string oldSnapshot = await old.Database.SqlQuery<string>($"SELECT \"SnapshotJson\"::text AS \"Value\" FROM \"TaskOccurrences\" WHERE \"UserId\"={owner}").SingleAsync();
                old.Completions.Add(new CompletionRow { UserId = owner, Id = Guid.NewGuid(), OccurrenceId = seed.Occurrence, CompletedAtUtc = new DateTime(2026, 10, 17, 0, 0, 0, DateTimeKind.Utc),
                    OccurrenceSnapshotJson = new JsonObject { ["logicalDate"] = "2026-10-14", ["sourceDefinitionVersion"] = "definition_legacy", ["constraintsSnapshot"] = JsonNode.Parse(oldSnapshot) }.ToJsonString() });
                item = new JsonObject { ["kind"] = "category", ["value"] = D1Service.Category(await old.Categories.SingleAsync(c => c.UserId == owner)) }.ToJsonString();
                plan = D1Service.Plan(await old.Plans.SingleAsync(p => p.UserId == owner)).ToJsonString(); opId = (await old.Operations.SingleAsync(o => o.UserId == owner)).OpId;
                old.SyncSnapshots.Add(new SyncSnapshotRow { UserId = owner, Id = snapshotId, StreamId = streamId, WatermarkSequence = 1, PlanStateJson = plan,
                    AsOfCursor = "preserved-old-s1-protected-token", PageSize = 1, CreatedAtUtc = DateTime.UtcNow, ExpiresAtUtc = DateTime.UtcNow.AddMinutes(15) });
                old.SyncSnapshotItems.Add(new SyncSnapshotItemRow { UserId = owner, SnapshotId = snapshotId, ItemJson = item }); await old.SaveChangesAsync();
            }
            // The pre-R1 schema intentionally has no Ordinal column: seed a real old row.
            await using (var c = new NpgsqlConnection(builder.ConnectionString))
            {
                await c.OpenAsync(); await using var command = new NpgsqlCommand("INSERT INTO \"SyncChanges\" (\"UserId\",\"StreamId\",\"Sequence\",\"ChangeId\",\"OpId\",\"ItemJson\",\"PlanStateJson\",\"RecordedAtUtc\") VALUES (@u,@s,1,@c,@o,@i,@p,@t)", c);
                command.Parameters.AddWithValue("u", owner); command.Parameters.AddWithValue("s", streamId); command.Parameters.AddWithValue("c", changeId); command.Parameters.AddWithValue("o", opId);
                command.Parameters.Add(new NpgsqlParameter("i", NpgsqlDbType.Jsonb) { Value = item }); command.Parameters.Add(new NpgsqlParameter("p", NpgsqlDbType.Jsonb) { Value = plan }); command.Parameters.AddWithValue("t", DateTime.UtcNow); await command.ExecuteNonQueryAsync();
            }
            var before = await Hashes(builder.ConnectionString); string streamBefore = await SyncHash(builder.ConnectionString, "SyncStreams"), feedBefore = await SyncHash(builder.ConnectionString, "SyncChanges", true);
            await using (var current = new VibeDb(options))
            {
                await current.Database.MigrateAsync(); Assert.Empty(await current.RecurrenceRules.ToArrayAsync()); Assert.Empty(await current.RecurrenceSlots.ToArrayAsync());
                Assert.Empty(await current.SyncSnapshots.ToArrayAsync()); Assert.Empty(await current.SyncSnapshotItems.ToArrayAsync());
                var row = await current.SyncChanges.SingleAsync(); Assert.Equal(changeId, row.ChangeId); Assert.Equal(opId, row.OpId); Assert.Equal(0, row.Ordinal); Assert.Equal(1, row.Sequence);
                Assert.Equal(streamId, (await current.SyncStreams.SingleAsync()).StreamId); Assert.Equal(1, (await current.SyncStreams.SingleAsync()).LastSequence);
            }
            var after = await Hashes(builder.ConnectionString); foreach (var (table, hash) in before) Assert.Equal(hash, after[table]);
            Assert.Equal(streamBefore, await SyncHash(builder.ConnectionString, "SyncStreams")); Assert.Equal(feedBefore, await SyncHash(builder.ConnectionString, "SyncChanges", true));
            await using (var current = new VibeDb(options))
            {
                current.SyncChanges.Add(new SyncChangeRow { UserId = owner, StreamId = streamId, Sequence = 2, OpId = opId, Ordinal = 1, ItemJson = item, PlanStateJson = plan, RecordedAtUtc = DateTime.UtcNow });
                await current.SaveChangesAsync(); Assert.Equal(2, await current.SyncChanges.CountAsync()); // same op allowed with distinct ordinal, old FK retained.
            }
        }
        finally
        {
            Safe(builder, schema); await using var c = new NpgsqlConnection(fixture.Connection); await c.OpenAsync(); await using var command = new NpgsqlCommand("DROP SCHEMA \"" + schema + "\" CASCADE", c); await command.ExecuteNonQueryAsync();
        }
    }
}

public sealed partial class SyncIntegrationTests
{
    [Fact]
    public async Task R1StableSlotUniquenessAndCompositeOwnerForeignKeysAreEnforcedByPostgres()
    {
        using var session = await Account(now: R1Now()); var definition = await RuleDefinition(session.Client);
        var rule = await CreateRule(session.Client, definition, RuleCommand(definition, "2026-12-01")); var a = await NewOccurrence(session.Client, definition); var b = await NewOccurrence(session.Client, definition);
        var unbound = await NewOccurrence(session.Client, definition);
        using var foreign = await Account(now: R1Now()); var foreignDefinition = await RuleDefinition(foreign.Client); var foreignRule = await CreateRule(foreign.Client, foreignDefinition, RuleCommand(foreignDefinition, "2026-12-01")); var foreignOccurrence = await NewOccurrence(foreign.Client, foreignDefinition);
        Guid ruleId = Guid.Parse(Wire.Str(rule["rule"]!, "id")), occurrenceId = Guid.Parse(Wire.Str(a["occurrence"]!, "id")); var date = new DateOnly(2026, 12, 1);
        await using (var seed = Db()) { seed.RecurrenceSlots.Add(new RecurrenceSlotRow { UserId = session.Owner, RuleId = ruleId, SlotDate = date, OccurrenceId = occurrenceId }); await seed.SaveChangesAsync(); }
        async Task Reject(object row, string expected, string? constraint = null)
        {
            await using var db = Db(); db.Add(row); var error = await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync());
            var postgres = Assert.IsType<PostgresException>(error.InnerException); Assert.Equal(expected, postgres.SqlState);
            if (constraint is not null) Assert.Equal(constraint, postgres.ConstraintName);
        }
        await Reject(new RecurrenceSlotRow { UserId = session.Owner, RuleId = ruleId, SlotDate = date, OccurrenceId = Guid.Parse(Wire.Str(b["occurrence"]!, "id")) }, PostgresErrorCodes.UniqueViolation);
        await Reject(new RecurrenceSlotRow { UserId = session.Owner, RuleId = ruleId, SlotDate = date.AddDays(1), OccurrenceId = occurrenceId }, PostgresErrorCodes.UniqueViolation);
        // Keep the unique owner/occurrence pair free so the foreign rule FK is the sole
        // violated constraint, rather than the earlier unique index on occurrenceId=a.
        await Reject(new RecurrenceSlotRow { UserId = session.Owner, RuleId = Guid.Parse(Wire.Str(foreignRule["rule"]!, "id")), SlotDate = date.AddDays(3), OccurrenceId = Guid.Parse(Wire.Str(unbound["occurrence"]!, "id")) }, PostgresErrorCodes.ForeignKeyViolation, "FK_RecurrenceSlots_RecurrenceRules_UserId_RuleId");
        await Reject(new RecurrenceSlotRow { UserId = session.Owner, RuleId = ruleId, SlotDate = date.AddDays(2), OccurrenceId = Guid.Parse(Wire.Str(foreignOccurrence["occurrence"]!, "id")) }, PostgresErrorCodes.ForeignKeyViolation, "FK_RecurrenceSlots_TaskOccurrences_UserId_OccurrenceId");
        RecurrenceRuleRow Row(string owner, Guid definitionId) => new() { UserId = owner, Id = Guid.NewGuid(), DefinitionId = definitionId, DaysMask = 127, Timezone = "Europe/Moscow", StartDate = date, GenerationStartDate = date };
        await Reject(Row(session.Owner, Guid.Parse(Wire.Str(definition["definition"]!, "id"))), PostgresErrorCodes.UniqueViolation);
        await Reject(Row(session.Owner, Guid.Parse(Wire.Str(foreignDefinition["definition"]!, "id"))), PostgresErrorCodes.ForeignKeyViolation, "FK_RecurrenceRules_TaskDefinitions_UserId_DefinitionId");
        var invalid = Row(session.Owner, Guid.Parse(Wire.Str(definition["definition"]!, "id"))); invalid.DaysMask = 0; await Reject(invalid, PostgresErrorCodes.CheckViolation);
        await using var actual = Db(); Assert.Single(await actual.RecurrenceSlots.Where(s => s.UserId == session.Owner).ToListAsync());
    }
}
