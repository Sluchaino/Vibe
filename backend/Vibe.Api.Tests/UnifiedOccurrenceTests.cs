using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Vibe.Api.Features.D1;
using Xunit;

namespace Vibe.Api.Tests;

public sealed partial class SyncIntegrationTests
{
    static JsonObject Intent(string? start, string? end = null, int offset = 0, string zone = "Europe/Moscow", string? startChoice = null, string? endChoice = null)
        => UnifiedTimingTests.Intent(start, end, offset, zone, startChoice, endChoice);
    static JsonNode? Duration(int? minutes) => minutes is int n ? new JsonObject { ["mode"] = "fixedWork", ["requiredWorkMinutes"] = n } : null;
    static async Task<JsonObject> U1Definition(HttpClient client, string origin = "unspecified", int? minutes = null)
    {
        var body = DefinitionCommand(await SetupPlace(client)); body["workOrigin"] = origin; body["durationPolicy"] = Duration(minutes);
        var result = await Json(await Send(client, HttpMethod.Post, "/api/v1/task-definitions", body), HttpStatusCode.Created); Wire.Validate(result, "DefinitionResponseU1"); return result;
    }
    static JsonObject U1CreateBody(JsonObject definition, string? date, JsonObject? intent = null) => new()
    { ["opId"] = Id(), ["id"] = Id(), ["definitionVersion"] = Wire.Str(definition["definition"]!, "serverVersion"), ["logicalDate"] = date, ["timeIntent"] = intent?.DeepClone() };
    static string U1CreatePath(JsonObject definition) => "/api/v1/task-definitions/" + Wire.Str(definition["definition"]!, "id") + "/occurrences";
    static async Task<JsonObject> U1Occurrence(HttpClient client, JsonObject definition, string? date, JsonObject? intent = null)
    {
        var result = await Json(await Send(client, HttpMethod.Post, U1CreatePath(definition), U1CreateBody(definition, date, intent)), HttpStatusCode.Created); Wire.Validate(result, "OccurrenceResponseU1"); return result;
    }
    static JsonObject U1Edit(JsonObject state, string? date, JsonObject? intent, string origin, int? minutes = null)
    {
        var constraints = U1Projection.Constraints(state["occurrence"]!["constraintsSnapshot"]!.AsObject()); constraints["workOrigin"] = origin; constraints["durationPolicy"] = Duration(minutes);
        return new JsonObject { ["opId"] = Id(), ["logicalDate"] = date, ["timeIntent"] = intent?.DeepClone(), ["constraintsSnapshot"] = constraints, ["allowFixedChange"] = false };
    }

    [Fact]
    public async Task U1UndatedUnknownWorkAndPartialIntentPersistAndDateFiltersRunBeforePaging()
    {
        using var session = await Account(now: R1Now()); var client = session.Client; var definition = await U1Definition(client);
        for (int i = 1; i <= 3; i++)
        {
            var body = U1CreateBody(definition, null); body["id"] = "00000000-0000-0000-0000-" + i.ToString("x12");
            var saved = await Json(await Send(client, HttpMethod.Post, U1CreatePath(definition), body), HttpStatusCode.Created);
            Assert.Null(saved["occurrence"]!["logicalDate"]); Assert.Null(saved["occurrence"]!["remainingWorkMinutes"]); Assert.Null(saved["occurrence"]!["calendarBlock"]);
        }
        var partial = await U1Occurrence(client, definition, "2026-10-17", Intent("09:00"));
        Assert.Null(partial["occurrence"]!["remainingWorkMinutes"]); Assert.Null(partial["occurrence"]!["resolvedTiming"]); Assert.Null(partial["occurrence"]!["placementIssue"]);
        var from = await Json(await client.GetAsync("/api/v1/occurrences?logicalDateFrom=2026-10-17&pageSize=1"));
        Assert.Equal(Wire.Str(partial["occurrence"]!, "id"), Wire.Str(Assert.Single(from["items"]!.AsArray())!, "id"));
        var to = await Json(await client.GetAsync("/api/v1/occurrences?logicalDateTo=2026-10-18&pageSize=1")); Assert.NotNull(Assert.Single(to["items"]!.AsArray())!["logicalDate"]);
        var all = await Json(await client.GetAsync("/api/v1/occurrences")); Assert.Equal(3, all["items"]!.AsArray().Count(i => i!["logicalDate"] is null));
        await using var restart = new TestApp(fixture.Connection, fixture.Clock); using var fresh = await Authenticate(restart, session.Name);
        var persisted = await Json(await fresh.GetAsync(OccPath(partial))); Assert.True(JsonNode.DeepEquals(partial["occurrence"], persisted["occurrence"]));
        await using var db = Db(); Assert.False(await db.Blocks.AnyAsync(b => b.UserId == session.Owner));
    }

    [Fact]
    public async Task U1UnknownCompleteAndTargetedReopenRestoreNullAndExactOldCompletionReplayNeverOverwritesFreshState()
    {
        using var session = await Account(now: R1Now()); var client = session.Client; var state = await U1Occurrence(client, await U1Definition(client), null);
        string path = OccPath(state), etag = ETag(state); var command = new JsonObject { ["opId"] = Id() }; var before = await RuleCounters(session.Owner);
        var response = await Send(client, HttpMethod.Post, path + "/completion", command, etag); string bytes = await response.Content.ReadAsStringAsync(); var completed = await Json(response);
        Assert.Equal(0, Wire.Int(completed["occurrence"]!, "remainingWorkMinutes"));
        await Error(await Send(client, HttpMethod.Put, path, U1Edit(completed, null, null, "unspecified"), ETag(completed)), HttpStatusCode.Conflict, "occurrenceCompleted");
        var reopened = await Json(await Send(client, HttpMethod.Post, path + "/completion/reopen", new JsonObject { ["opId"] = Id(), ["completionId"] = Wire.Str(completed["occurrence"]!["completion"]!, "id") }, ETag(completed)));
        Assert.Null(reopened["occurrence"]!["remainingWorkMinutes"]); Assert.Null(reopened["occurrence"]!["logicalDate"]);
        var replay = await Send(client, HttpMethod.Post, path + "/completion", command, etag); Assert.Equal(bytes, await replay.Content.ReadAsStringAsync()); Assert.Equal("true", replay.Headers.GetValues("Idempotency-Replayed").Single());
        var current = await Json(await client.GetAsync(path)); Assert.True(JsonNode.DeepEquals(reopened["occurrence"], current["occurrence"]));
        var after = await RuleCounters(session.Owner); Assert.Equal(before.Schedule, after.Schedule); Assert.Equal(before.Input + 2, after.Input);
        await using var db = Db(); var context = Wire.Obj((await db.Completions.SingleAsync(c => c.UserId == session.Owner)).OccurrenceSnapshotJson);
        Assert.Null(context["logicalDate"]); Assert.Null(context["constraintsSnapshot"]!["durationPolicy"]); Assert.Equal("unspecified", Wire.Str(context["constraintsSnapshot"]!, "workOrigin")); Assert.Null(context["timeIntent"]); Assert.Null(context["resolvedTiming"]);
    }

    [Fact]
    public async Task U1AutoPlacementPreservesResolvedVolumeOnConflictAndAllowsTouchingBlocks()
    {
        using var session = await Account(now: R1Now()); var client = session.Client; var definition = await U1Definition(client, "interval"); var before = await RuleCounters(session.Owner);
        var first = await U1Occurrence(client, definition, "2026-10-17", Intent("09:00", "11:00")); Assert.Equal(120, Wire.Int(first["occurrence"]!, "remainingWorkMinutes")); Assert.NotNull(first["occurrence"]!["calendarBlock"]);
        var second = await U1Occurrence(client, definition, "2026-10-17", Intent("09:30", "11:30"));
        Assert.Null(second["occurrence"]!["calendarBlock"]); Assert.Equal("placementConflict", Wire.Str(second["occurrence"]!, "placementIssue")); Assert.Equal(120, Wire.Int(second["occurrence"]!, "remainingWorkMinutes")); Assert.NotNull(second["occurrence"]!["resolvedTiming"]);
        var third = await U1Occurrence(client, definition, "2026-10-17", Intent("11:00", "12:00")); Assert.NotNull(third["occurrence"]!["calendarBlock"]);
        var after = await RuleCounters(session.Owner); Assert.Equal(before.Input + 3, after.Input); Assert.Equal(before.Schedule + 2, after.Schedule);
        using var foreign = await Account(now: R1Now()); var other = await U1Occurrence(foreign.Client, await U1Definition(foreign.Client, "interval"), "2026-10-17", Intent("09:00", "11:00")); Assert.NotNull(other["occurrence"]!["calendarBlock"]);
    }

    [Fact]
    public async Task U1PutResolvesWithoutAutoPlacementAndManualPlacementDoesNotRewriteIntentOrRetryAfterUnplace()
    {
        using var session = await Account(now: R1Now()); var client = session.Client; var state = await U1Occurrence(client, await U1Definition(client), "2026-10-17", Intent("09:00")); var before = await RuleCounters(session.Owner);
        state = await Json(await Send(client, HttpMethod.Put, OccPath(state), U1Edit(state, "2026-10-17", Intent("09:00", "11:00"), "interval"), ETag(state)));
        Assert.NotNull(state["occurrence"]!["resolvedTiming"]); Assert.Null(state["occurrence"]!["calendarBlock"]); Assert.Equal(before.Schedule, (await RuleCounters(session.Owner)).Schedule);
        var resolved = state["occurrence"]!["resolvedTiming"]!.DeepClone(); var intent = state["occurrence"]!["timeIntent"]!.DeepClone();
        var place = Placement(state, "place"); place["localStart"] = "2026-10-17T13:00:00"; state = await Json(await Send(client, HttpMethod.Post, OccPath(state) + "/placement", place, ETag(state)));
        Assert.True(JsonNode.DeepEquals(resolved, state["occurrence"]!["resolvedTiming"])); Assert.True(JsonNode.DeepEquals(intent, state["occurrence"]!["timeIntent"]));
        await Error(await Send(client, HttpMethod.Put, OccPath(state), U1Edit(state, null, null, "unspecified"), ETag(state)), HttpStatusCode.Conflict, "invalidExistingPlacement");
        state = await Place(client, state, "unplace"); Assert.Null(state["occurrence"]!["calendarBlock"]); Assert.True(JsonNode.DeepEquals(intent, state["occurrence"]!["timeIntent"]));
        // A frozen legacy PUT is accepted as legacy manualN and preserves the current intent.
        var legacy = new JsonObject { ["opId"] = Id(), ["logicalDate"] = "2026-10-17", ["constraintsSnapshot"] = LegacyTestWire.Constraints(state["occurrence"]!["constraintsSnapshot"]!), ["allowFixedChange"] = false };
        state = await Json(await Send(client, HttpMethod.Put, OccPath(state), legacy, ETag(state))); Assert.True(JsonNode.DeepEquals(intent, state["occurrence"]!["timeIntent"]));
        state = await Json(await Send(client, HttpMethod.Put, OccPath(state), U1Edit(state, null, null, "unspecified"), ETag(state)));
        await Error(await PlaceResponse(client, state, "place"), HttpStatusCode.BadRequest, "validationFailed");
    }
    static Task<HttpResponseMessage> PlaceResponse(HttpClient client, JsonObject state, string action) => Send(client, HttpMethod.Post, OccPath(state) + "/placement", Placement(state, action), ETag(state));

    [Theory]
    [InlineData("manual", 90, "2026-10-17", "09:00", "11:00", 0)]
    [InlineData("interval", null, "2026-10-17", "09:00", null, 0)]
    [InlineData("unspecified", null, "2026-10-17", "09:00", "11:00", 0)]
    [InlineData("manual", 90, null, "09:00", null, 0)]
    [InlineData("interval", null, "2026-10-17", "23:00", "01:00", 0)]
    public async Task U1InitialContradictionIsSaved400ReplayWithoutPartialOccurrence(string origin, int? minutes, string? date, string? start, string? end, int offset)
    {
        using var session = await Account(now: R1Now()); var definition = await U1Definition(session.Client, origin, minutes); var before = await RuleCounters(session.Owner);
        var command = U1CreateBody(definition, date, Intent(start, end, offset)); var response = await Send(session.Client, HttpMethod.Post, U1CreatePath(definition), command); string bytes = await response.Content.ReadAsStringAsync(); await Error(response, HttpStatusCode.BadRequest, "validationFailed");
        var replay = await Send(session.Client, HttpMethod.Post, U1CreatePath(definition), command); Assert.Equal(bytes, await replay.Content.ReadAsStringAsync()); Assert.Equal("true", replay.Headers.GetValues("Idempotency-Replayed").Single());
        var after = await RuleCounters(session.Owner); Assert.Equal(before.Head, after.Head); Assert.Equal(before.Input, after.Input); Assert.Equal(before.Schedule, after.Schedule); Assert.Equal(before.Results + 1, after.Results);
        await using var db = Db(); Assert.False(await db.Occurrences.AnyAsync(o => o.UserId == session.Owner));
    }

    [Theory]
    [InlineData(null, null, "ambiguousLocalTime")]
    [InlineData("earlier", 120, null)]
    [InlineData("later", 60, null)]
    public async Task U1FoldCreatesAnHonestUnplannedOrFullElapsedPlacement(string? choice, int? minutes, string? issue)
    {
        using var session = await Account(now: R1Now()); var definition = await U1Definition(session.Client, "interval");
        var state = await U1Occurrence(session.Client, definition, "2026-10-25", Intent("02:30", "03:30", zone: "Europe/Berlin", startChoice: choice));
        Assert.Equal(minutes, state["occurrence"]!["remainingWorkMinutes"]?.GetValue<int>()); Assert.Equal(issue, state["occurrence"]!["placementIssue"]?.GetValue<string>()); Assert.Equal(minutes is not null, state["occurrence"]!["calendarBlock"] is not null);
    }
}
