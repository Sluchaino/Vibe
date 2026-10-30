using System.Globalization;
using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Vibe.Api.Data;
using Vibe.Api.Features.D1;
using Vibe.Api.Features.Recurrence;
using Xunit;

namespace Vibe.Api.Tests;

public sealed partial class SyncIntegrationTests
{
    [Theory]
    [InlineData("2026-10-17T12:00:00Z", "2026-12-01", null, "monday", 0, null)]
    [InlineData("2026-10-17T12:00:00Z", "2026-10-17", "2026-10-17", "saturday", 1, "2026-10-17")]
    [InlineData("2026-10-17T12:00:00Z", "2026-10-17", "2026-10-17", "sunday", 0, "2026-10-17")]
    [InlineData("2026-10-17T12:00:00Z", "2026-01-01", null, "monday", 5, "2026-11-16")]
    [InlineData("2028-02-28T12:00:00Z", "2028-02-28", "2028-03-01", "all", 3, "2028-03-01")]
    [InlineData("0001-01-01T12:00:00Z", "0001-01-01", "0001-01-31", "all", 31, "0001-01-31")]
    [InlineData("9999-12-20T12:00:00Z", "9999-12-01", null, "all", 12, "9999-12-31")]
    public async Task R1FutureStartInclusiveEndLeapWeekAndRepresentableDateBoundaries(string now, string start, string? end, string day, int expected, string? through)
    {
        using var session = await Account(now: R1Now(now));
        try
        {
            var definition = await RuleDefinition(session.Client); var command = RuleCommand(definition, start, day == "all" ? null : [day], end, "Etc/UTC");
            var rule = await CreateRule(session.Client, definition, command);
            Assert.Equal(through, rule["rule"]!["generatedThrough"]?.GetValue<string>()); Assert.Equal(expected, (await RuleCounters(session.Owner)).Slots);
            var before = await RuleCounters(session.Owner); Assert.False(await Generate(session.Owner, rule)); Assert.Equal(before, await RuleCounters(session.Owner));
            await using var db = Db(); Assert.Equal(expected, await db.Occurrences.CountAsync(o => o.UserId == session.Owner)); Assert.False(await db.Blocks.AnyAsync(b => b.UserId == session.Owner));
        }
        finally { fixture.Clock.Reset(); }
    }

    [Fact]
    public async Task R1CatchupTraversesEveryMissedDayInSeparateThirtyOneDateTransactionsAndClockRollbackIsNoop()
    {
        using var session = await Account(now: R1Now()); var rule = await CreateRule(session.Client, await RuleDefinition(session.Client));
        try
        {
            fixture.Clock.Advance(TimeSpan.FromDays(100)); DateOnly previous = new(2026, 11, 16); int transactions = 0;
            while (await Generate(session.Owner, rule))
            {
                var counters = await RuleCounters(session.Owner); await using var read = Db();
                var current = await read.RecurrenceRules.SingleAsync(r => r.UserId == session.Owner); Assert.NotNull(current.GeneratedThrough);
                Assert.InRange(current.GeneratedThrough.Value.DayNumber - previous.DayNumber, 1, 31); previous = current.GeneratedThrough.Value; transactions++;
                Assert.InRange(transactions, 1, 4); Assert.Equal(0, counters.Schedule);
            }
            Assert.Equal(4, transactions); Assert.Equal(new DateOnly(2027, 2, 24), previous);
            await using (var read = Db())
            {
                var dates = await read.RecurrenceSlots.Where(s => s.UserId == session.Owner).OrderBy(s => s.SlotDate).Select(s => s.SlotDate).ToArrayAsync();
                Assert.Equal(Enumerable.Range(0, 131).Select(i => new DateOnly(2026, 10, 17).AddDays(i)), dates);
                var jobs = await read.Operations.Where(o => o.UserId == session.Owner && o.Fingerprint.StartsWith("internal:R1:")).ToArrayAsync(); Assert.Equal(4, jobs.Length);
                foreach (var job in jobs) { Assert.Equal(200, job.Status); Assert.Null(job.Location); var body = Wire.Obj(job.Body); Wire.Validate(body, "RecurrenceResponseU1"); Assert.Equal(ETag(body, "rule"), job.ETag); }
                foreach (var group in (await read.SyncChanges.Where(c => c.UserId == session.Owner).ToArrayAsync()).GroupBy(c => c.OpId))
                { var ordered = group.OrderBy(c => c.Sequence).ToArray(); Assert.Equal(Enumerable.Range(0, ordered.Length), ordered.Select(c => c.Ordinal)); Assert.All(ordered, c => Assert.Equal(ordered[0].PlanStateJson, c.PlanStateJson)); }
            }
            var before = await RuleCounters(session.Owner); fixture.Clock.SetUtcNow(R1Now()); Assert.False(await Generate(session.Owner, rule)); Assert.Equal(before, await RuleCounters(session.Owner));
        }
        finally { fixture.Clock.Reset(); }
    }

    [Fact]
    public async Task R1ProgressOnlyScanChangesRuleAndInternalResultButNotInputOrSchedule()
    {
        using var session = await Account(now: R1Now()); var definition = await RuleDefinition(session.Client);
        var rule = await CreateRule(session.Client, definition, RuleCommand(definition, "2026-11-20", ["monday"])); Assert.Null(rule["rule"]!["generatedThrough"]);
        try
        {
            var before = await RuleCounters(session.Owner); fixture.Clock.Advance(TimeSpan.FromDays(4)); Assert.True(await Generate(session.Owner, rule));
            var after = await RuleCounters(session.Owner); Assert.Equal(before.Input, after.Input); Assert.Equal(before.Schedule, after.Schedule); Assert.Equal(before.Head + 1, after.Head); Assert.Equal(before.Results + 1, after.Results); Assert.Equal(0, after.Slots);
            await using var db = Db(); var updated = await db.RecurrenceRules.SingleAsync(r => r.UserId == session.Owner);
            Assert.Equal(new DateOnly(2026, 11, 20), updated.GeneratedThrough); Assert.NotEqual(Wire.Str(rule["rule"]!, "serverVersion"), updated.Version);
            Assert.False(await Generate(session.Owner, rule)); Assert.Equal(after, await RuleCounters(session.Owner));
        }
        finally { fixture.Clock.Reset(); }
    }

    [Theory]
    [InlineData("2026-03-28T23:30:00Z", "2026-03-29", "2026-04-28", "2026-04-29")]
    [InlineData("2026-10-24T22:30:00Z", "2026-10-25", "2026-11-24", "2026-11-25")]
    public async Task R1RuleTimezoneRemainsFixedAcrossDstAndSettingsTimezoneChange(string now, string first, string through, string extended)
    {
        using var session = await Account(now: R1Now(now)); var client = session.Client;
        try
        {
            var definition = await RuleDefinition(client); var rule = await CreateRule(client, definition, RuleCommand(definition, "2026-01-01", timezone: "Europe/Berlin"));
            Assert.Equal(through, Wire.Str(rule["rule"]!, "generatedThrough"));
            var settingsResponse = await client.GetAsync("/api/v1/settings"); var settings = await Json(settingsResponse);
            await Json(await Send(client, HttpMethod.Put, "/api/v1/settings", new JsonObject { ["opId"] = Id(), ["timezone"] = "Pacific/Honolulu", ["weekStartsOn"] = "monday", ["place"] = new JsonObject { ["id"] = settings["settings"]!["place"]!["id"]!.DeepClone(), ["name"] = "Дом" } }, settingsResponse.Headers.ETag!.ToString()));
            fixture.Clock.Advance(TimeSpan.FromHours(25)); Assert.True(await Generate(session.Owner, rule));
            await using var db = Db(); var stored = await db.RecurrenceRules.SingleAsync(r => r.UserId == session.Owner);
            Assert.Equal("Europe/Berlin", stored.Timezone); Assert.Equal(extended, RecurrenceService.Date(stored.GeneratedThrough!.Value));
            var dates = await db.RecurrenceSlots.Where(s => s.UserId == session.Owner).Select(s => s.SlotDate).ToArrayAsync(); Assert.Equal(32, dates.Length);
            Assert.Equal(first, RecurrenceService.Date(dates.Min())); Assert.False(await db.Blocks.AnyAsync(b => b.UserId == session.Owner));
        }
        finally { fixture.Clock.Reset(); }
    }

    [Fact]
    public async Task R1GeneratedOccurrencesKeepIndependentSnapshotsBlocksAndCompletionsWhileNewSlotsCopyFreshDefinition()
    {
        using var session = await Account(now: R1Now()); var client = session.Client; var definition = await RuleDefinition(client); var rule = await CreateRule(client, definition);
        var ids = Array.Empty<Guid>(); await using (var db = Db()) ids = await db.RecurrenceSlots.Where(s => s.UserId == session.Owner).OrderBy(s => s.SlotDate).Select(s => s.OccurrenceId).Take(2).ToArrayAsync();
        var first = await Json(await client.GetAsync("/api/v1/occurrences/" + ids[0])); var second = await Json(await client.GetAsync("/api/v1/occurrences/" + ids[1]));
        var placement = Placement(first, "place"); placement["localStart"] = "2026-10-17T10:00:00";
        first = await Json(await Send(client, HttpMethod.Post, OccPath(first) + "/placement", placement, ETag(first))); first = await Place(client, first, "setFixed"); var block = first["occurrence"]!["calendarBlock"]!.DeepClone();
        first = await Json(await Send(client, HttpMethod.Post, OccPath(first) + "/completion", new JsonObject { ["opId"] = Id() }, ETag(first)));
        Assert.Equal(0, Wire.Int(first["occurrence"]!, "remainingWorkMinutes")); Assert.True(JsonNode.DeepEquals(second["occurrence"], (await Json(await client.GetAsync(OccPath(second))))["occurrence"]));
        var edit = DefinitionCommand(await SetupPlace(client)); edit.Remove("id"); edit["durationPolicy"]!["requiredWorkMinutes"] = 60;
        var updated = await Json(await Send(client, HttpMethod.Put, "/api/v1/task-definitions/" + Wire.Str(definition["definition"]!, "id"), edit, ETag(definition, "definition")));
        string factId = Wire.Str(first["occurrence"]!["completion"]!, "id");
        first = await Json(await Send(client, HttpMethod.Post, OccPath(first) + "/completion/reopen", new JsonObject { ["opId"] = Id(), ["completionId"] = factId }, ETag(first)));
        Assert.Equal(90, Wire.Int(first["occurrence"]!, "remainingWorkMinutes")); Assert.True(JsonNode.DeepEquals(block, first["occurrence"]!["calendarBlock"]));
        try
        {
            fixture.Clock.Advance(TimeSpan.FromHours(12)); Assert.True(await Generate(session.Owner, rule));
            await using var db = Db(); var latest = await db.Occurrences.Where(o => o.UserId == session.Owner).OrderByDescending(o => o.LogicalDate).FirstAsync();
            Assert.Equal(60, Wire.Int(Wire.Obj(latest.SnapshotJson)["durationPolicy"]!, "requiredWorkMinutes")); Assert.Equal(Wire.Str(updated["definition"]!, "serverVersion"), latest.SourceDefinitionVersion);
            var prior = await db.Occurrences.SingleAsync(o => o.UserId == session.Owner && o.Id == ids[0]); Assert.Equal(90, Wire.Int(Wire.Obj(prior.SnapshotJson)["durationPolicy"]!, "requiredWorkMinutes"));
            var fact = await db.Completions.SingleAsync(c => c.UserId == session.Owner); Assert.NotNull(fact.RevokedAtUtc); Assert.Equal(90, Wire.Int(Wire.Obj(fact.OccurrenceSnapshotJson)["constraintsSnapshot"]!["durationPolicy"]!, "requiredWorkMinutes"));
            Assert.Equal(2, (await db.Plans.SingleAsync(p => p.UserId == session.Owner)).ScheduleRevision); // only explicit place/setFixed.
        }
        finally { fixture.Clock.Reset(); }
    }
}
