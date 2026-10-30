using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Vibe.Api.Data;
using Vibe.Api.Features.D1;
using Xunit;

namespace Vibe.Api.Tests;

public sealed partial class SyncIntegrationTests
{
    [Fact]
    public async Task R1ConcurrentCreateSameOpReplaysWhileDistinctCommandsCannotDuplicateDefinitionRuleOrSlots()
    {
        using var session = await Account(now: R1Now()); var client = session.Client; var definition = await RuleDefinition(client); var command = RuleCommand(definition);
        var replies = await Task.WhenAll(Send(client, HttpMethod.Post, CreateRulePath(definition), command), Send(client, HttpMethod.Post, CreateRulePath(definition), command));
        Assert.Equal(await replies[0].Content.ReadAsStringAsync(), await replies[1].Content.ReadAsStringAsync()); Assert.Single(replies, r => r.Headers.GetValues("Idempotency-Replayed").Single() == "true");
        var rule = await RuleReply(replies[0], HttpStatusCode.Created); Assert.Equal(31, (await RuleCounters(session.Owner)).Slots);
        var stop = new JsonObject { ["opId"] = Id() };
        var stops = await Task.WhenAll(Send(client, HttpMethod.Post, RulePath(rule) + "/stop", stop, ETag(rule, "rule")), Send(client, HttpMethod.Post, RulePath(rule) + "/stop", stop, ETag(rule, "rule")));
        Assert.Equal(await stops[0].Content.ReadAsStringAsync(), await stops[1].Content.ReadAsStringAsync()); Assert.Single(stops, r => r.Headers.GetValues("Idempotency-Replayed").Single() == "true");
        var another = await RuleDefinition(client); var a = RuleCommand(another); var b = RuleCommand(another);
        var races = await Task.WhenAll(Send(client, HttpMethod.Post, CreateRulePath(another), a), Send(client, HttpMethod.Post, CreateRulePath(another), b));
        Assert.Single(races, r => r.StatusCode == HttpStatusCode.Created); var rejected = Assert.Single(races, r => r.StatusCode == HttpStatusCode.Conflict); await Error(rejected, HttpStatusCode.Conflict, "recurrenceAlreadyExists");
        await using var db = Db(); Assert.Equal(2, await db.RecurrenceRules.CountAsync(r => r.UserId == session.Owner)); Assert.Equal(62, await db.RecurrenceSlots.CountAsync(s => s.UserId == session.Owner));
        Assert.Equal(62, await db.Occurrences.CountAsync(o => o.UserId == session.Owner));
    }

    [Fact]
    public async Task R1TwoWorkersOnOneDueRuleCommitOneChunkAndOneInternalResult()
    {
        using var session = await Account(now: R1Now()); var rule = await CreateRule(session.Client, await RuleDefinition(session.Client));
        try
        {
            var before = await RuleCounters(session.Owner); fixture.Clock.Advance(TimeSpan.FromHours(12));
            var jobs = await Task.WhenAll(Generate(session.Owner, rule), Generate(session.Owner, rule)); Assert.Single(jobs, changed => changed); Assert.Single(jobs, changed => !changed);
            var after = await RuleCounters(session.Owner); Assert.Equal(before.Slots + 1, after.Slots); Assert.Equal(before.Results + 1, after.Results); Assert.Equal(before.Head + 2, after.Head); Assert.Equal(before.Input + 1, after.Input); Assert.Equal(before.Schedule, after.Schedule);
        }
        finally { fixture.Clock.Reset(); }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task R1StopAndWorkerRaceUseSameGuardAndNeverDeleteAlreadyCommittedSlots(bool workerWins)
    {
        using var session = await Account(now: R1Now()); var client = session.Client; var rule = await CreateRule(client, await RuleDefinition(client));
        var before = await RuleCounters(session.Owner); string suffix = Guid.NewGuid().ToString("N"), function = "r1_gate_" + suffix, trigger = "r1_gate_trigger_" + suffix;
        int key = Random.Shared.Next(1, int.MaxValue); await using var connection = new NpgsqlConnection(fixture.Connection); await connection.OpenAsync();
        await using var transaction = await connection.BeginTransactionAsync(); bool released = false;
        await using (var locked = new NpgsqlCommand("SELECT pg_advisory_xact_lock(@key)", connection, transaction)) { locked.Parameters.AddWithValue("key", (long)key); await locked.ExecuteNonQueryAsync(); }
        string condition = workerWins ? "NEW.\"Enabled\" AND NEW.\"GeneratedThrough\" IS DISTINCT FROM OLD.\"GeneratedThrough\"" : "NOT NEW.\"Enabled\"";
        await Sql($$"""CREATE FUNCTION "{{function}}"() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN PERFORM pg_advisory_xact_lock({{key}}); RETURN NEW; END $fn$; CREATE TRIGGER "{{trigger}}" BEFORE UPDATE ON "RecurrenceRules" FOR EACH ROW WHEN (NEW."UserId" = '{{session.Owner}}' AND ({{condition}})) EXECUTE FUNCTION "{{function}}"();""");
        try
        {
            fixture.Clock.Advance(TimeSpan.FromHours(12));
            Task<bool>? generation = null; Task<HttpResponseMessage>? stop = null;
            if (workerWins) generation = Generate(session.Owner, rule);
            else stop = Send(client, HttpMethod.Post, RulePath(rule) + "/stop", new JsonObject { ["opId"] = Id() }, ETag(rule, "rule"));
            await WaitForBlocked("locktype='advisory' AND objid=" + key + "::oid");
            if (workerWins) stop = Send(client, HttpMethod.Post, RulePath(rule) + "/stop", new JsonObject { ["opId"] = Id() }, ETag(rule, "rule"));
            else generation = Generate(session.Owner, rule);
            await Task.Delay(50); Assert.False(workerWins ? stop!.IsCompleted : generation!.IsCompleted);
            await transaction.CommitAsync(); released = true;
            Assert.Equal(workerWins, await generation!);
            if (workerWins)
            {
                await Error(await stop!, HttpStatusCode.PreconditionFailed, "staleEntity");
                var fresh = await RuleReply(await client.GetAsync(RulePath(rule))); await StopRule(client, fresh);
            }
            else await RuleReply(await stop!);
            var after = await RuleCounters(session.Owner); Assert.Equal(before.Slots + (workerWins ? 1 : 0), after.Slots); Assert.Equal(before.Schedule, after.Schedule);
            Assert.False(await Generate(session.Owner, rule)); var stopped = await RuleReply(await client.GetAsync(RulePath(rule))); Assert.False(stopped["rule"]!["enabled"]!.GetValue<bool>());
        }
        finally
        {
            if (!released) await transaction.RollbackAsync();
            await Sql($"DROP TRIGGER \"{trigger}\" ON \"RecurrenceRules\"; DROP FUNCTION \"{function}\"();"); fixture.Clock.Reset();
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task R1PostgresFailureMidGroupRollsBackRuleSlotsEntitiesResultsCursorAndFeed(bool worker)
    {
        using var session = await Account(now: R1Now()); var client = session.Client; var definition = await RuleDefinition(client); var command = RuleCommand(definition);
        JsonObject? rule = worker ? await CreateRule(client, definition, command) : null;
        var before = await RuleCounters(session.Owner); string? version = rule is null ? null : Wire.Str(rule["rule"]!, "serverVersion");
        string suffix = Guid.NewGuid().ToString("N"), function = "r1_fail_" + suffix, trigger = "r1_fail_trigger_" + suffix;
        await Sql($$"""CREATE FUNCTION "{{function}}"() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'forced R1 group failure'; END $fn$; CREATE TRIGGER "{{trigger}}" BEFORE INSERT ON "SyncChanges" FOR EACH ROW WHEN (NEW."UserId" = '{{session.Owner}}' AND NEW."Ordinal" = 1) EXECUTE FUNCTION "{{function}}"();""");
        try
        {
            if (worker) { fixture.Clock.Advance(TimeSpan.FromHours(12)); await Assert.ThrowsAsync<DbUpdateException>(() => Generate(session.Owner, rule!)); }
            else Assert.Equal(HttpStatusCode.ServiceUnavailable, (await Send(client, HttpMethod.Post, CreateRulePath(definition), command)).StatusCode);
            Assert.Equal(before, await RuleCounters(session.Owner)); await using var db = Db();
            Assert.Equal(worker ? 1 : 0, await db.RecurrenceRules.CountAsync(r => r.UserId == session.Owner)); Assert.Equal(worker ? 31 : 0, await db.Occurrences.CountAsync(o => o.UserId == session.Owner));
            if (worker) Assert.Equal(version, (await db.RecurrenceRules.SingleAsync(r => r.UserId == session.Owner)).Version);
        }
        finally { await Sql($"DROP TRIGGER \"{trigger}\" ON \"SyncChanges\"; DROP FUNCTION \"{function}\"();"); }
        try
        {
            if (worker) { Assert.True(await Generate(session.Owner, rule!)); Assert.False(await Generate(session.Owner, rule!)); }
            else
            {
                var accepted = await Send(client, HttpMethod.Post, CreateRulePath(definition), command); var bytes = await accepted.Content.ReadAsStringAsync(); await RuleReply(accepted, HttpStatusCode.Created);
                var replay = await Send(client, HttpMethod.Post, CreateRulePath(definition), command); Assert.Equal(bytes, await replay.Content.ReadAsStringAsync()); Assert.Equal("true", replay.Headers.GetValues("Idempotency-Replayed").Single());
            }
            var after = await RuleCounters(session.Owner); Assert.Equal(before.Input + 1, after.Input); Assert.Equal(before.Slots + (worker ? 1 : 31), after.Slots); Assert.Equal(before.Head + (worker ? 2 : 32), after.Head);
        }
        finally { fixture.Clock.Reset(); }
    }

    [Fact]
    public async Task R1RegisteredWorkerRoundRobinReachesDueRuleAfterMoreThanOneHundredFutureRulesWithoutBrowser()
    {
        await using var app = new TestApp(fixture.Connection, fixture.Clock, new Dictionary<string, string?> { ["Recurrence:PollIntervalSeconds"] = "1" });
        using var session = await Account(app, "ffffffff-ffff-ffff-ffff-fffffffffffc", R1Now());
        try
        {
            var definition = await RuleDefinition(session.Client); string fields;
            await using (var db = Db())
            {
                var source = await db.Definitions.SingleAsync(d => d.UserId == session.Owner); fields = source.FieldsJson;
                for (int i = 1; i <= 101; i++)
                {
                    var d = new DefinitionRow { UserId = session.Owner, Id = Guid.NewGuid(), PlaceId = source.PlaceId, FieldsJson = fields }; db.Definitions.Add(d);
                    db.RecurrenceRules.Add(new RecurrenceRuleRow { UserId = session.Owner, Id = Guid.Parse("00000000-0000-0000-0000-" + i.ToString("x12")), DefinitionId = d.Id,
                        DaysMask = 127, Timezone = "Europe/Moscow", StartDate = new DateOnly(2027, 1, 1), GenerationStartDate = new DateOnly(2027, 1, 1) });
                }
                await db.SaveChangesAsync();
            }
            var command = RuleCommand(definition); command["id"] = "ffffffff-ffff-ffff-ffff-ffffffffffff";
            await CreateRule(session.Client, definition, command); fixture.Clock.Advance(TimeSpan.FromHours(12));
            using var budget = new CancellationTokenSource(TimeSpan.FromSeconds(12));
            while ((await RuleCounters(session.Owner)).Slots != 32) await Task.Delay(100, budget.Token);
            await using var actual = Db(); Assert.Equal(102, await actual.RecurrenceRules.CountAsync(r => r.UserId == session.Owner));
            Assert.Equal(101, await actual.RecurrenceRules.CountAsync(r => r.UserId == session.Owner && r.GeneratedThrough == null));
            Assert.Single(await actual.Operations.Where(o => o.UserId == session.Owner && o.Fingerprint.StartsWith("internal:R1:")).ToListAsync());
        }
        finally { fixture.Clock.Reset(); }
    }
}
