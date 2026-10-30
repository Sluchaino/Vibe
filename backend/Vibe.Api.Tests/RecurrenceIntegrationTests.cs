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
    static DateTimeOffset R1Now(string instant = "2026-10-17T12:00:00Z") => DateTimeOffset.Parse(instant, CultureInfo.InvariantCulture);
    static string RulePath(JsonObject state) => "/api/v1/recurrence-rules/" + Wire.Str(state["rule"]!, "id");
    static JsonObject RuleCommand(JsonObject definition, string start = "2026-10-17", string[]? days = null, string? end = null, string timezone = "Europe/Moscow") => new()
    {
        ["opId"] = Id(), ["id"] = Id(), ["definitionVersion"] = Wire.Str(definition["definition"]!, "serverVersion"), ["pattern"] = "weekly",
        ["daysOfWeek"] = new JsonArray((days ?? RecurrenceService.Weekdays).Select(d => (JsonNode?)JsonValue.Create(d)).ToArray()),
        ["timezone"] = timezone, ["startDate"] = start, ["endDate"] = end
    };
    static string CreateRulePath(JsonObject definition) => "/api/v1/task-definitions/" + Wire.Str(definition["definition"]!, "id") + "/recurrence-rule";
    static async Task<JsonObject> RuleReply(HttpResponseMessage response, HttpStatusCode status = HttpStatusCode.OK)
    {
        var body = await Json(response, status); Wire.Validate(body, "RecurrenceResponseU1"); Assert.Equal(ETag(body, "rule"), response.Headers.ETag!.ToString()); return body;
    }
    static async Task<JsonObject> CreateRule(HttpClient client, JsonObject definition, JsonObject? command = null)
    {
        var response = await Send(client, HttpMethod.Post, CreateRulePath(definition), command ?? RuleCommand(definition));
        var result = await RuleReply(response, HttpStatusCode.Created); Assert.Equal(RulePath(result), response.Headers.Location!.ToString()); return result;
    }
    static async Task<JsonObject> StopRule(HttpClient client, JsonObject rule, JsonObject? command = null)
        => await RuleReply(await Send(client, HttpMethod.Post, RulePath(rule) + "/stop", command ?? new JsonObject { ["opId"] = Id() }, ETag(rule, "rule")));
    static async Task<JsonObject> RuleDefinition(HttpClient client)
        => await Json(await Send(client, HttpMethod.Post, "/api/v1/task-definitions", DefinitionCommand(await SetupPlace(client))), HttpStatusCode.Created);
    async Task<bool> Generate(string owner, JsonObject rule)
    {
        using var scope = fixture.App.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<RecurrenceService>().Generate(owner, Guid.Parse(Wire.Str(rule["rule"]!, "id")), CancellationToken.None);
    }
    async Task<(long Input, long Schedule, long Head, int Results, int Slots)> RuleCounters(string owner)
    {
        await using var db = Db(); var plan = await db.Plans.SingleAsync(p => p.UserId == owner); var stream = await db.SyncStreams.SingleAsync(s => s.UserId == owner);
        return (plan.InputRevision, plan.ScheduleRevision, stream.LastSequence, await db.Operations.CountAsync(o => o.UserId == owner), await db.RecurrenceSlots.CountAsync(s => s.UserId == owner));
    }

    [Fact]
    public async Task R1DailyCreateIsAtomicThirtyOneDaysWithoutBackfillAndManualOccurrenceDoesNotConsumeSlot()
    {
        using var session = await Account(now: R1Now()); var client = session.Client; var definition = await RuleDefinition(client);
        var manual = await NewOccurrence(client, definition); var baseline = await Bootstrap(client); var before = await RuleCounters(session.Owner);
        var command = RuleCommand(definition, "2026-01-01", ["sunday", "friday", "monday", "saturday", "tuesday", "thursday", "wednesday"]);
        var rule = await CreateRule(client, definition, command); var after = await RuleCounters(session.Owner);
        Assert.Equal("2026-11-16", Wire.Str(rule["rule"]!, "generatedThrough")); Assert.Equal(RecurrenceService.Weekdays, rule["rule"]!["daysOfWeek"]!.AsArray().Select(d => d!.GetValue<string>()));
        Assert.Equal(before.Input + 1, after.Input); Assert.Equal(before.Schedule, after.Schedule); Assert.Equal(before.Head + 32, after.Head); Assert.Equal(31, after.Slots);
        var delta = await Delta(client, Wire.Str(baseline, "asOfCursor"), "&pageSize=100"); var group = delta["changes"]!.AsArray(); Assert.Equal(32, group.Count);
        Assert.Equal("recurrence", Wire.Str(group[0]!["item"]!, "kind"));
        foreach (var change in group) { Assert.Equal(Wire.Str(command, "opId"), Wire.Str(change!, "opId")); Assert.True(JsonNode.DeepEquals(rule["planState"], change!["planState"])); }
        var values = group.Skip(1).Select(c => c!["item"]!["value"]!).ToArray(); Assert.Equal(31, values.Length);
        Assert.Equal(Enumerable.Range(0, 31).Select(i => new DateOnly(2026, 10, 17).AddDays(i).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)), values.Select(v => Wire.Str(v, "logicalDate")));
        foreach (var value in values) { Assert.Equal("unplanned", Wire.Str(value, "placementStatus")); Assert.Equal("incomplete", Wire.Str(value, "completionStatus")); Assert.Equal(90, Wire.Int(value, "remainingWorkMinutes")); Assert.Null(value["calendarBlock"]); Assert.Null(value["completion"]); Assert.Equal(Wire.Str(definition["definition"]!, "serverVersion"), Wire.Str(value, "sourceDefinitionVersion")); }
        await using var db = Db(); Assert.Equal(32, await db.Occurrences.CountAsync(o => o.UserId == session.Owner)); Assert.False(await db.Blocks.AnyAsync(b => b.UserId == session.Owner));
        var stored = await db.RecurrenceRules.SingleAsync(r => r.UserId == session.Owner); Assert.Equal(new DateOnly(2026, 10, 17), stored.GenerationStartDate);
        Assert.Equal(Enumerable.Range(0, 32), await db.SyncChanges.Where(c => c.UserId == session.Owner && c.OpId == Guid.Parse(Wire.Str(command, "opId"))).OrderBy(c => c.Sequence).Select(c => c.Ordinal).ToArrayAsync());
        Assert.True(JsonNode.DeepEquals(manual["occurrence"], (await Json(await client.GetAsync(OccPath(manual))))["occurrence"]));
    }

    [Fact]
    public async Task R1StopIsMatchFirstCanonicalNoopAndOriginalCreateAndStopRepliesRemainExact()
    {
        using var session = await Account(now: R1Now()); var client = session.Client; var definition = await RuleDefinition(client); var command = RuleCommand(definition);
        var createResponse = await Send(client, HttpMethod.Post, CreateRulePath(definition), command); string createBytes = await createResponse.Content.ReadAsStringAsync(); var rule = await RuleReply(createResponse, HttpStatusCode.Created);
        var stopBody = new JsonObject { ["opId"] = Id() }; string stopEtag = ETag(rule, "rule");
        var stoppedResponse = await Send(client, HttpMethod.Post, RulePath(rule) + "/stop", stopBody, stopEtag); string stopBytes = await stoppedResponse.Content.ReadAsStringAsync(); var stopped = await RuleReply(stoppedResponse);
        var counters = await RuleCounters(session.Owner); Assert.False(stopped["rule"]!["enabled"]!.GetValue<bool>());
        var replay = await Send(client, HttpMethod.Post, CreateRulePath(definition), command); Assert.Equal(createBytes, await replay.Content.ReadAsStringAsync()); Assert.Equal("true", replay.Headers.GetValues("Idempotency-Replayed").Single());
        var repeatStop = await Send(client, HttpMethod.Post, RulePath(rule) + "/stop", stopBody, stopEtag); Assert.Equal(stopBytes, await repeatStop.Content.ReadAsStringAsync());
        var noop = await StopRule(client, stopped); Assert.True(JsonNode.DeepEquals(stopped, noop));
        var after = await RuleCounters(session.Owner); Assert.Equal(counters.Input, after.Input); Assert.Equal(counters.Head, after.Head); Assert.Equal(counters.Slots, after.Slots); Assert.Equal(counters.Results + 1, after.Results);
        await Error(await Send(client, HttpMethod.Post, RulePath(rule) + "/stop", new JsonObject { ["opId"] = Id() }), HttpStatusCode.PreconditionRequired, "preconditionRequired");
        await Error(await Send(client, HttpMethod.Post, RulePath(rule) + "/stop", new JsonObject { ["opId"] = Id() }, stopEtag), HttpStatusCode.PreconditionFailed, "staleEntity");
        fixture.Clock.Advance(TimeSpan.FromDays(300)); Assert.False(await Generate(session.Owner, stopped)); fixture.Clock.Reset(); Assert.Equal(after.Head, (await RuleCounters(session.Owner)).Head);
    }

    [Fact]
    public async Task R1CreateAndStopPreserveOwnershipCsrfValidationOrderAndFailedReplay()
    {
        using var session = await Account(now: R1Now()); var definition = await RuleDefinition(session.Client); using var other = await Account(now: R1Now());
        var command = RuleCommand(definition); string path = CreateRulePath(definition);
        using var anonymous = fixture.App.Client(); await Error(await Send(anonymous, HttpMethod.Post, path, command), HttpStatusCode.Unauthorized, "unauthorized");
        session.Client.DefaultRequestHeaders.Remove("X-CSRF-TOKEN"); await Error(await Send(session.Client, HttpMethod.Post, path, command), HttpStatusCode.Forbidden, "invalidAntiforgery"); await Token(session.Client);
        await Error(await Send(other.Client, HttpMethod.Post, path, command), HttpStatusCode.NotFound, "notFound");
        var invalid = RuleCommand(definition); invalid["definitionVersion"] = "stale"; invalid["timezone"] = "Not/AZone"; invalid["endDate"] = "2020-01-01";
        var failed = await Send(session.Client, HttpMethod.Post, path, invalid); string bytes = await failed.Content.ReadAsStringAsync(); await Error(failed, HttpStatusCode.PreconditionFailed, "staleDefinition");
        var again = await Send(session.Client, HttpMethod.Post, path, invalid); Assert.Equal(bytes, await again.Content.ReadAsStringAsync()); Assert.Equal("true", again.Headers.GetValues("Idempotency-Replayed").Single());
        foreach (var edit in new Action<JsonObject>[] { b => b["daysOfWeek"] = new JsonArray(), b => b["daysOfWeek"] = new JsonArray("monday", "monday"), b => b.Remove("endDate"), b => b["timezone"] = "Not/AZone", b => b["endDate"] = "2020-01-01", b => b["pattern"] = "monthly", b => b["unexpected"] = true })
        { var body = RuleCommand(definition); edit(body); await Error(await Send(session.Client, HttpMethod.Post, path, body), HttpStatusCode.BadRequest, "validationFailed"); }
        var rule = await CreateRule(session.Client, definition, command);
        foreach (string target in new[] { RulePath(rule), "/api/v1/recurrence-rules/" + Id() }) await Error(await other.Client.GetAsync(target), HttpStatusCode.NotFound, "notFound");
        await Error(await Send(other.Client, HttpMethod.Post, RulePath(rule) + "/stop", new JsonObject { ["opId"] = Id() }, ETag(rule, "rule")), HttpStatusCode.NotFound, "notFound");
        await Error(await session.Client.GetAsync(RulePath(rule) + "?unknown=1"), HttpStatusCode.BadRequest, "validationFailed");
        var get = new HttpRequestMessage(HttpMethod.Get, RulePath(rule)) { Content = new StringContent("{}") }; await Error(await session.Client.SendAsync(get), HttpStatusCode.BadRequest, "validationFailed");
        var sameId = RuleCommand(definition); sameId["id"] = rule["rule"]!["id"]!.DeepClone(); await Error(await Send(session.Client, HttpMethod.Post, path, sameId), HttpStatusCode.Conflict, "idUnavailable");
        await Error(await Send(session.Client, HttpMethod.Post, path, RuleCommand(definition)), HttpStatusCode.Conflict, "recurrenceAlreadyExists");
        command["startDate"] = "2026-10-18"; await Error(await Send(session.Client, HttpMethod.Post, path, command), HttpStatusCode.Conflict, "idempotencyMismatch");
        await using var db = Db(); Assert.Single(await db.RecurrenceRules.Where(r => r.UserId == session.Owner).ToListAsync()); Assert.False(await db.RecurrenceRules.AnyAsync(r => r.UserId == other.Owner));
    }
}
