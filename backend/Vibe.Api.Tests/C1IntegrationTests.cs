using System.Globalization;
using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Vibe.Api.Data;
using Vibe.Api.Features.D1;
using Xunit;

namespace Vibe.Api.Tests;

public partial class ApiIntegrationTests
{
    static JsonNode C1Occ(JsonObject response) => response["occurrence"]!;
    static string C1Path(JsonObject response) => "/api/v1/occurrences/" + Wire.Str(C1Occ(response), "id");
    static string C1ETag(JsonObject response) => ApiReply.Quote(Wire.Str(C1Occ(response), "serverVersion"));
    static string C1FactId(JsonObject response) => Wire.Str(C1Occ(response)["completion"]!, "id");
    static JsonObject C1CompleteBody() => new() { ["opId"] = Id() };
    static JsonObject C1ReopenBody(string id) => new() { ["opId"] = Id(), ["completionId"] = id };
    static Task<HttpResponseMessage> C1Complete(HttpClient client, JsonObject state, JsonObject? body = null) => Send(client, HttpMethod.Post, C1Path(state) + "/completion", body ?? C1CompleteBody(), C1ETag(state));
    static Task<HttpResponseMessage> C1Reopen(HttpClient client, JsonObject state, string id, JsonObject? body = null) => Send(client, HttpMethod.Post, C1Path(state) + "/completion/reopen", body ?? C1ReopenBody(id), C1ETag(state));
    static async Task<JsonObject> C1Response(HttpResponseMessage response)
    {
        var body = await Json(response);
        Wire.Validate(body, "OccurrenceResponse");
        Assert.Equal(C1ETag(body), response.Headers.ETag!.ToString());
        return body;
    }
    static async Task<JsonObject> C1Refresh(HttpClient client, JsonObject state) => await C1Response(await client.GetAsync(C1Path(state)));
    static void C1SameInputs(JsonObject before, JsonObject after)
    {
        foreach (string field in new[] { "id", "definitionId", "logicalDate", "sourceDefinitionVersion", "constraintsSnapshot", "placementStatus", "calendarBlock" })
            Assert.True(JsonNode.DeepEquals(C1Occ(before)[field], C1Occ(after)[field]), "Changed " + field);
        Assert.Equal(Wire.Str(before["planState"]!, "scheduleVersion"), Wire.Str(after["planState"]!, "scheduleVersion"));
    }
    static JsonObject C1Edit(JsonObject state, int? minutes = null)
    {
        var body = new JsonObject { ["opId"] = Id(), ["logicalDate"] = "2026-10-14", ["constraintsSnapshot"] = C1Occ(state)["constraintsSnapshot"]!.DeepClone(), ["allowFixedChange"] = false };
        if (minutes is int n) body["constraintsSnapshot"]!["durationPolicy"]!["requiredWorkMinutes"] = n;
        return body;
    }
    async Task<CompletionRow> C1StoredFact(string id)
    {
        using var scope = C1Fixture.App.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<VibeDb>();
        var guid = Guid.Parse(id);
        return await db.Completions.AsNoTracking().SingleAsync(c => c.Id == guid);
    }
    async Task<(long Input, long Schedule, int Active, int History)> C1Counters(HttpClient client, JsonObject state)
    {
        string owner = Wire.Str(await Json(await client.GetAsync("/api/v1/me")), "userId");
        using var scope = C1Fixture.App.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<VibeDb>();
        var p = await db.Plans.AsNoTracking().SingleAsync(x => x.UserId == owner);
        var id = Guid.Parse(Wire.Str(C1Occ(state), "id"));
        return (p.InputRevision, p.ScheduleRevision,
            await db.Completions.CountAsync(c => c.UserId == owner && c.OccurrenceId == id && c.RevokedAtUtc == null),
            await db.Completions.CountAsync(c => c.UserId == owner && c.OccurrenceId == id));
    }
    [Fact]
    public async Task C1LifecyclePreservesHistoryAndContextAcrossEditsClockCorrectionAndRestart()
    {
        C1Fixture.Clock.SetUtcNow(DateTimeOffset.Parse("2026-10-25T00:30:00.1234567Z", CultureInfo.InvariantCulture));
        try
        {
            using var client = C1Fixture.App.Client(); await Token(client);
            await Json(await Send(client, HttpMethod.Post, "/api/v1/auth/login", new JsonObject { ["userName"] = "anna", ["password"] = PostgresFixture.Password })); await Token(client);
            var definition = await Definition(client); var original = await Occurrence(client, definition); var other = await Occurrence(client, definition);
            original = await C1Refresh(client, original);
            var initial = await C1Counters(client, original);
            var completeRequest = C1CompleteBody();
            var completed = await C1Response(await C1Complete(client, original, completeRequest));
            string firstId = C1FactId(completed);
            Assert.Equal("2026-10-25T00:30:00.123Z", Wire.Str(C1Occ(completed)["completion"]!, "completedAt"));
            Assert.Equal(0, Wire.Int(C1Occ(completed), "remainingWorkMinutes")); Assert.Equal("completed", Wire.Str(C1Occ(completed), "completionStatus"));
            C1SameInputs(original, completed);
            var afterComplete = await C1Counters(client, completed);
            Assert.Equal(initial.Input + 1, afterComplete.Input); Assert.Equal(initial.Schedule, afterComplete.Schedule); Assert.Equal(1, afterComplete.Active);
            var first = await C1StoredFact(firstId); string firstContext = first.OccurrenceSnapshotJson;
            Assert.Equal(3, Wire.Obj(firstContext).Count); Assert.Equal(90, Wire.Int(Wire.Obj(firstContext)["constraintsSnapshot"]!["durationPolicy"]!, "requiredWorkMinutes"));
            C1Fixture.Clock.Advance(TimeSpan.FromMinutes(1));
            var noOp = await C1Response(await C1Complete(client, completed));
            Assert.True(JsonNode.DeepEquals(completed, noOp)); Assert.Equal(afterComplete, await C1Counters(client, noOp));
            var sameRequest = await C1Complete(client, original, completeRequest);
            Assert.True(JsonNode.DeepEquals(completed, await C1Response(sameRequest))); Assert.Equal("true", sameRequest.Headers.GetValues("Idempotency-Replayed").Single());
            C1Fixture.Clock.SetUtcNow(DateTimeOffset.Parse("2026-10-25T00:28:00.1229999Z", CultureInfo.InvariantCulture));
            var reopened = await C1Response(await C1Reopen(client, noOp, firstId));
            Assert.Equal(90, Wire.Int(C1Occ(reopened), "remainingWorkMinutes")); Assert.Null(C1Occ(reopened)["completion"]); C1SameInputs(completed, reopened);
            var revoked = await C1StoredFact(firstId);
            Assert.Equal(firstContext, revoked.OccurrenceSnapshotJson); Assert.Equal(first.CompletedAtUtc, revoked.CompletedAtUtc);
            Assert.Equal(TimeRules.Utc("2026-10-25T00:28:00Z").AddMilliseconds(122), revoked.RevokedAtUtc);
            Assert.True(revoked.RevokedAtUtc < revoked.CompletedAtUtc); Assert.NotEqual(first.Version, revoked.Version);
            var edited = await C1Response(await Send(client, HttpMethod.Put, C1Path(reopened), C1Edit(reopened, 60), C1ETag(reopened)));
            var counters = await C1Counters(client, edited);
            var alreadyRevoked = await C1Response(await C1Reopen(client, edited, firstId));
            Assert.True(JsonNode.DeepEquals(edited, alreadyRevoked)); Assert.Equal(counters, await C1Counters(client, alreadyRevoked));
            Assert.Equal(revoked.RevokedAtUtc, (await C1StoredFact(firstId)).RevokedAtUtc);
            var second = await C1Response(await C1Complete(client, edited)); string secondId = C1FactId(second);
            Assert.NotEqual(firstId, secondId); Assert.Equal(firstContext, (await C1StoredFact(firstId)).OccurrenceSnapshotJson);
            Assert.Equal(60, Wire.Int(Wire.Obj((await C1StoredFact(secondId)).OccurrenceSnapshotJson)["constraintsSnapshot"]!["durationPolicy"]!, "requiredWorkMinutes"));
            Assert.Equal("2026-10-14", Wire.Str(Wire.Obj((await C1StoredFact(secondId)).OccurrenceSnapshotJson), "logicalDate"));
            Assert.True(JsonNode.DeepEquals(C1Occ(other), C1Occ(await C1Refresh(client, other))));
            Assert.Equal(2, (await C1Counters(client, second)).History);
            using var restarted = new TestApp(C1Fixture.Connection, C1Fixture.Clock); using var freshClient = restarted.Client();
            await Token(freshClient); await Json(await Send(freshClient, HttpMethod.Post, "/api/v1/auth/login", new JsonObject { ["userName"] = "anna", ["password"] = PostgresFixture.Password })); await Token(freshClient);
            Assert.Equal(secondId, C1FactId(await C1Refresh(freshClient, second)));
        }
        finally { C1Fixture.Clock.Reset(); }
    }
    [Fact]
    public async Task C1CompletedFixedDstBlockStaysBusyAndAllPlacementAndSnapshotEditsAreReadOnly()
    {
        using var client = await Login();
        var definition = await Definition(client, mobility: "fixedAfterPlacement");
        var state = await Occurrence(client, definition);
        var day = new DateTime(2090, 10, 31); day = day.AddDays(-(int)day.DayOfWeek);
        string local = day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + "T02:30:00";
        var placement = Placement(state, local, "+02:00"); placement["timezone"] = "Europe/Berlin";
        state = await C1Response(await Place(client, state, placement));
        var fixedCommand = Placement(state, "", action: "setFixed"); fixedCommand["fixed"] = true;
        state = await C1Response(await Place(client, state, fixedCommand));
        var completed = await C1Response(await C1Complete(client, state));
        C1SameInputs(state, completed); Assert.Equal(0, Wire.Int(C1Occ(completed), "remainingWorkMinutes"));
        var invalidReference = C1Edit(completed); invalidReference["constraintsSnapshot"]!["placeId"] = Id();
        await Error(await Send(client, HttpMethod.Put, C1Path(completed), invalidReference, C1ETag(state)), HttpStatusCode.PreconditionFailed, "staleEntity");
        NewOp(invalidReference);
        await Error(await Send(client, HttpMethod.Put, C1Path(completed), invalidReference, C1ETag(completed)), HttpStatusCode.Conflict, "occurrenceCompleted");
        foreach (string action in new[] { "place", "move", "unplace", "setFixed" })
        {
            var body = Placement(completed, local, "+02:00", action, true); body["baseScheduleVersion"] = "outdatedSchedule";
            if (action is "place" or "move") body["timezone"] = "Europe/Berlin";
            if (action == "setFixed") body["fixed"] = true;
            var error = await Error(await Place(client, completed, body), HttpStatusCode.Conflict, "occurrenceCompleted");
            Assert.True(JsonNode.DeepEquals(C1Occ(completed), error["currentOccurrence"]));
        }
        var block = C1Occ(completed)["calendarBlock"]!;
        DateTime from = TimeRules.Utc(Wire.Str(block, "startInstant")).AddHours(-2), to = TimeRules.Utc(Wire.Str(block, "endInstant")).AddHours(2);
        var calendar = await Json(await client.GetAsync("/api/v1/calendar?from=" + Uri.EscapeDataString(TimeRules.Instant(from)) + "&to=" + Uri.EscapeDataString(TimeRules.Instant(to))));
        Wire.Validate(calendar, "CalendarResponse"); Assert.True(JsonNode.DeepEquals(block, calendar["blocks"]![0]));
        Assert.Equal(90, (TimeRules.Utc(Wire.Str(block, "endInstant")) - TimeRules.Utc(Wire.Str(block, "startInstant"))).TotalMinutes);
        var other = await Occurrence(client, definition);
        var overlap = Placement(other, local, "+02:00"); overlap["timezone"] = "Europe/Berlin";
        await Error(await Place(client, other, overlap), HttpStatusCode.Conflict, "placementConflict");
        completed = await C1Refresh(client, completed);
        var reopened = await C1Response(await C1Reopen(client, completed, C1FactId(completed)));
        C1SameInputs(completed, reopened);
        await Error(await Place(client, reopened, Placement(reopened, "", action: "unplace")), HttpStatusCode.Conflict, "fixedChangeRequiresConfirmation");
    }
    [Fact]
    public async Task C1DelayedTargetAndSavedErrorsCannotRevokeNewActiveFact()
    {
        using var client = await Login(); var original = await Occurrence(client, await Definition(client));
        var completeBody = C1CompleteBody(); var a = await C1Response(await C1Complete(client, original, completeBody)); string aId = C1FactId(a);
        var reopenBody = C1ReopenBody(aId); var r = await C1Response(await C1Reopen(client, a, aId, reopenBody));
        var oldComplete = await C1Complete(client, original, completeBody); Assert.True(JsonNode.DeepEquals(a, await C1Response(oldComplete)));
        Assert.Equal("incomplete", Wire.Str(C1Occ(await C1Refresh(client, r)), "completionStatus"));
        var b = await C1Response(await C1Complete(client, r)); string bId = C1FactId(b);
        var before = await C1Counters(client, b);
        var oldReopen = await C1Reopen(client, a, aId, reopenBody); Assert.True(JsonNode.DeepEquals(r, await C1Response(oldReopen)));
        Assert.Equal(bId, C1FactId(await C1Refresh(client, b))); Assert.Equal(before, await C1Counters(client, b));
        await Error(await C1Reopen(client, a, aId), HttpStatusCode.PreconditionFailed, "staleEntity");
        var mismatchBody = C1ReopenBody(aId); var mismatchResponse = await C1Reopen(client, b, aId, mismatchBody);
        string saved = await mismatchResponse.Content.ReadAsStringAsync();
        var mismatch = await Error(mismatchResponse, HttpStatusCode.Conflict, "completionMismatch"); Assert.Equal(C1ETag(b), mismatchResponse.Headers.ETag!.ToString()); Assert.True(JsonNode.DeepEquals(C1Occ(b), mismatch["currentOccurrence"]));
        var incomplete = await C1Response(await C1Reopen(client, b, bId));
        var c = await C1Response(await C1Complete(client, incomplete)); string cId = C1FactId(c);
        var replay = await C1Reopen(client, b, aId, mismatchBody);
        Assert.Equal(HttpStatusCode.Conflict, replay.StatusCode); Assert.Equal(saved, await replay.Content.ReadAsStringAsync()); Assert.Equal("true", replay.Headers.GetValues("Idempotency-Replayed").Single());
        Assert.Equal(cId, C1FactId(await C1Refresh(client, c)));
        var changed = reopenBody.DeepClone().AsObject(); changed["completionId"] = cId;
        await Error(await C1Reopen(client, a, cId, changed), HttpStatusCode.Conflict, "idempotencyMismatch");
    }
    [Theory]
    [InlineData("complete", "complete")]
    [InlineData("reopen", "reopen")]
    [InlineData("complete", "place")]
    [InlineData("complete", "update")]
    [InlineData("reopen", "place")]
    [InlineData("reopen", "update")]
    [InlineData("complete", "reopen")]
    public async Task C1ConcurrentCommandsSerializeAtOccurrenceVersion(string first, string second)
    {
        using var client = await Login(); var state = await Occurrence(client, await Definition(client));
        if (first == "reopen" || second == "reopen") state = await C1Response(await C1Complete(client, state));
        var before = await C1Counters(client, state);
        Task<HttpResponseMessage> Run(string kind) => kind switch
        {
            "complete" => C1Complete(client, state),
            "reopen" => C1Reopen(client, state, C1FactId(state)),
            "place" => Place(client, state, Placement(state, "2085-01-01T10:00:00")),
            "update" => Send(client, HttpMethod.Put, C1Path(state), C1Edit(state, 60), C1ETag(state)),
            _ => throw new InvalidOperationException()
        };
        var replies = await Task.WhenAll(Run(first), Run(second));
        Assert.Contains(replies, r => r.StatusCode == HttpStatusCode.OK);
        foreach (var reply in replies)
        {
            if (reply.StatusCode == HttpStatusCode.OK) await C1Response(reply);
            else if (reply.StatusCode == HttpStatusCode.PreconditionFailed) await Error(reply, HttpStatusCode.PreconditionFailed, "staleEntity");
            else await Error(reply, HttpStatusCode.Conflict, "occurrenceCompleted");
        }
        var after = await C1Counters(client, state);
        Assert.Equal(before.Input + 1, after.Input); Assert.InRange(after.Active, 0, 1);
        var actual = await C1Refresh(client, state);
        Assert.NotEqual(C1ETag(state), C1ETag(actual));
        if (first == "reopen" || second == "reopen")
        {
            Assert.Equal(0, after.Active); Assert.Null(C1Occ(actual)["completion"]); Assert.Equal(before.Schedule, after.Schedule); Assert.Null(C1Occ(actual)["calendarBlock"]);
        }
        else if (second == "place") Assert.Equal(before.Schedule + (C1Occ(actual)["calendarBlock"] is null ? 0 : 1), after.Schedule);
        else Assert.Equal(before.Schedule, after.Schedule);
    }
}
