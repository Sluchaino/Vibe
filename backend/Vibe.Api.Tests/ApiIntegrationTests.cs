using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Vibe.Api.Data;
using Vibe.Api.Features.D1;
using Xunit;

namespace Vibe.Api.Tests;

public partial class ApiIntegrationTests(PostgresFixture fixture) : IClassFixture<PostgresFixture>
{
    PostgresFixture C1Fixture => fixture;
    static string Id() => Guid.NewGuid().ToString("D");
    static JsonObject NewOp(JsonObject b) { b["opId"] = Id(); return b; }
    static async Task<JsonObject> Json(HttpResponseMessage r, HttpStatusCode expected = HttpStatusCode.OK)
    {
        string text = await r.Content.ReadAsStringAsync(); Assert.True(r.StatusCode == expected, $"Expected {expected}, received {r.StatusCode}: {text}");
        Assert.Equal("no-store", r.Headers.CacheControl?.ToString()); return Wire.Obj(text);
    }
    static async Task<string> Token(HttpClient c)
    {
        var body = await Json(await c.GetAsync("/api/v1/auth/antiforgery"));
        Wire.Validate(body, "AntiforgeryResponse"); string token = Wire.Str(body, "requestToken");
        c.DefaultRequestHeaders.Remove("X-CSRF-TOKEN"); c.DefaultRequestHeaders.Add("X-CSRF-TOKEN", token); return token;
    }
    async Task<HttpClient> Login(string name = "anna")
    {
        fixture.Clock.Reset(); var client = fixture.App.Client(); await Token(client);
        var body = new JsonObject { ["userName"] = name, ["password"] = PostgresFixture.Password };
        var result = await Json(await Send(client, HttpMethod.Post, "/api/v1/auth/login", body)); Wire.Validate(result, "MeResponse");
        await Token(client); return client;
    }
    static Task<HttpResponseMessage> Send(HttpClient c, HttpMethod method, string path, JsonObject body, string? etag = null)
    {
        var message = new HttpRequestMessage(method, path) { Content = new StringContent(Wire.Json(body), Encoding.UTF8, "application/json") };
        if (etag is not null) message.Headers.TryAddWithoutValidation("If-Match", etag);
        return c.SendAsync(message);
    }
    async Task<string> PlaceId(HttpClient c)
    {
        var r = await c.GetAsync("/api/v1/settings"); var current = await Json(r); Wire.Validate(current, "SettingsResponse");
        if (current["settings"]!["place"] is not null) return Wire.Str(current["settings"]!["place"]!, "id");
        var request = new JsonObject { ["opId"] = Id(), ["timezone"] = "Europe/Moscow", ["weekStartsOn"] = "monday", ["place"] = new JsonObject { ["id"] = Id(), ["name"] = "Дом" } };
        var updated = await Json(await Send(c, HttpMethod.Put, "/api/v1/settings", request, r.Headers.ETag!.ToString()));
        return Wire.Str(updated["settings"]!["place"]!, "id");
    }
    async Task<JsonObject> DefinitionBody(HttpClient c, int minutes = 90, string mobility = "movable", JsonObject? availability = null)
        => new() { ["opId"] = Id(), ["id"] = Id(), ["title"] = "Задача 😀", ["description"] = "", ["categoryId"] = null, ["importance"] = "high", ["difficulty"] = "light", ["executionPriority"] = 2, ["durationPolicy"] = new JsonObject { ["mode"] = "fixedWork", ["requiredWorkMinutes"] = minutes }, ["splitAllowed"] = false, ["mobilityPolicy"] = mobility, ["availabilityRules"] = availability ?? Wire.Obj("{\"timezone\":\"Europe/Berlin\",\"windows\":[],\"dateExceptions\":[]}"), ["placeId"] = await PlaceId(c), ["requiredRestMinutes"] = 0 };
    async Task<JsonObject> Definition(HttpClient c, int minutes = 90, string mobility = "movable", JsonObject? availability = null)
    {
        var b = await DefinitionBody(c, minutes, mobility, availability);
        var result = await Json(await Send(c, HttpMethod.Post, "/api/v1/task-definitions", b), HttpStatusCode.Created); Wire.Validate(result, "DefinitionResponse"); return result;
    }
    static async Task<JsonObject> Occurrence(HttpClient c, JsonObject definition, string logicalDate = "2026-10-12")
    {
        var d = definition["definition"]!;
        var body = new JsonObject { ["opId"] = Id(), ["id"] = Id(), ["definitionVersion"] = Wire.Str(d, "serverVersion"), ["logicalDate"] = logicalDate };
        var result = await Json(await Send(c, HttpMethod.Post, "/api/v1/task-definitions/" + Wire.Str(d, "id") + "/occurrences", body), HttpStatusCode.Created); Wire.Validate(result, "OccurrenceResponse"); return result;
    }
    static JsonObject Placement(JsonObject occurrence, string local, string offset = "+03:00", string action = "place", bool allow = false)
    {
        var body = new JsonObject { ["opId"] = Id(), ["action"] = action, ["baseScheduleVersion"] = Wire.Str(occurrence["planState"]!, "scheduleVersion"), ["allowFixedChange"] = allow };
        if (action is "place" or "move") { body["localStart"] = local; body["timezone"] = "Europe/Moscow"; body["utcOffset"] = offset; }
        return body;
    }
    static Task<HttpResponseMessage> Place(HttpClient c, JsonObject occurrence, JsonObject body) => Send(c, HttpMethod.Post, "/api/v1/occurrences/" + Wire.Str(occurrence["occurrence"]!, "id") + "/placement", body, ApiReply.Quote(Wire.Str(occurrence["occurrence"]!, "serverVersion")));
    static async Task<JsonObject> Error(HttpResponseMessage r, HttpStatusCode status, string code)
    {
        var result = await Json(r, status); Assert.Equal("application/problem+json", r.Content.Headers.ContentType!.MediaType); Wire.Validate(result, "ProblemDetails"); Assert.Equal(code, Wire.Str(result, "code")); return result;
    }
    [Fact]
    public async Task AuthenticationCsrfCookieFlagsLogoutAndAbsoluteExpiry()
    {
        using var c = fixture.App.Client();
        var anonymous = await c.GetAsync("/api/v1/me"); await Error(anonymous, HttpStatusCode.Unauthorized, "unauthorized"); Assert.Null(anonymous.Headers.Location);
        var login = new JsonObject { ["userName"] = "anna", ["password"] = PostgresFixture.Password };
        await Error(await Send(c, HttpMethod.Post, "/api/v1/auth/login", login), HttpStatusCode.Forbidden, "invalidAntiforgery");
        var tokenResponse = await c.GetAsync("/api/v1/auth/antiforgery");
        string antiforgeryCookie = string.Join(";", tokenResponse.Headers.GetValues("Set-Cookie"));
        Assert.Contains("__Host-Vibe.Antiforgery", antiforgeryCookie); Assert.Contains("secure", antiforgeryCookie); Assert.Contains("httponly", antiforgeryCookie); Assert.Contains("samesite=strict", antiforgeryCookie); Assert.DoesNotContain("domain=", antiforgeryCookie);
        await Token(c);
        var loggedIn = await Send(c, HttpMethod.Post, "/api/v1/auth/login", login); await Json(loggedIn);
        var cookie = string.Join(";", loggedIn.Headers.GetValues("Set-Cookie")); Assert.Contains("__Host-Vibe.Session", cookie); Assert.Contains("secure", cookie); Assert.Contains("httponly", cookie); Assert.Contains("samesite=strict", cookie); Assert.Contains("path=/", cookie); Assert.DoesNotContain("domain=", cookie);
        // Token minted for anonymous identity cannot authorize the authenticated account.
        await Error(await c.PostAsync("/api/v1/auth/logout", null), HttpStatusCode.Forbidden, "invalidAntiforgery");
        await Token(c); Assert.Equal(HttpStatusCode.NoContent, (await c.PostAsync("/api/v1/auth/logout", null)).StatusCode);
        await Error(await c.GetAsync("/api/v1/me"), HttpStatusCode.Unauthorized, "unauthorized");
        using var expiring = await Login();
        var authenticatedOperation = new JsonObject { ["opId"] = Id(), ["id"] = Id(), ["name"] = "TTL" };
        await Json(await Send(expiring, HttpMethod.Post, "/api/v1/categories", authenticatedOperation), HttpStatusCode.Created);
        fixture.Clock.Advance(TimeSpan.FromHours(23)); await Json(await expiring.GetAsync("/api/v1/me"));
        fixture.Clock.Advance(TimeSpan.FromHours(2)); await Error(await expiring.GetAsync("/api/v1/me"), HttpStatusCode.Unauthorized, "unauthorized");
        await Error(await Send(expiring, HttpMethod.Post, "/api/v1/categories", authenticatedOperation), HttpStatusCode.Unauthorized, "unauthorized"); fixture.Clock.Reset();
        using var http = fixture.App.Client(); http.BaseAddress = new Uri("http://localhost");
        await Error(await http.GetAsync("/api/v1/auth/antiforgery"), HttpStatusCode.Forbidden, "forbidden"); Assert.Equal(HttpStatusCode.OK, (await http.GetAsync("/health")).StatusCode);
    }
    [Fact]
    public async Task LockoutUsesFiveFailuresAndDoesNotRevealUserExistence()
    {
        using var c = fixture.App.Client(); await Token(c);
        var b = new JsonObject { ["userName"] = "lockout-user", ["password"] = "Incorrect-test-password1!" };
        for (int i = 0; i < 5; i++) await Error(await Send(c, HttpMethod.Post, "/api/v1/auth/login", b), HttpStatusCode.Unauthorized, "invalidCredentials");
        b["password"] = PostgresFixture.Password; await Error(await Send(c, HttpMethod.Post, "/api/v1/auth/login", b), HttpStatusCode.Unauthorized, "invalidCredentials");
        using var scope = fixture.App.Services.CreateScope(); var db = scope.ServiceProvider.GetRequiredService<VibeDb>();
        var user = await db.Users.SingleAsync(x => x.UserName == "lockout-user");
        Assert.True(user.LockoutEnd > DateTimeOffset.UtcNow.AddMinutes(14)); Assert.True(user.LockoutEnd < DateTimeOffset.UtcNow.AddMinutes(16));
        b["userName"] = "nonexistent-account"; await Error(await Send(c, HttpMethod.Post, "/api/v1/auth/login", b), HttpStatusCode.Unauthorized, "invalidCredentials");
    }
    [Fact]
    public async Task SnapshotsRemainImmutableAndPersistenceHasSeparateMetadata()
    {
        using var c = await Login(); var definition = await Definition(c); var occurrence = await Occurrence(c, definition);
        var request = definition["definition"]!.DeepClone().AsObject(); request.Remove("id"); request.Remove("serverVersion"); NewOp(request);
        request["title"] = "Новое определение"; request["durationPolicy"]!["requiredWorkMinutes"] = 60; request["importance"] = "low"; request["difficulty"] = "heavy"; request["executionPriority"] = 5;
        string definitionId = Wire.Str(definition["definition"]!, "id");
        var updated = await Json(await Send(c, HttpMethod.Put, "/api/v1/task-definitions/" + definitionId, request, ApiReply.Quote(Wire.Str(definition["definition"]!, "serverVersion"))));
        var persisted = await Json(await c.GetAsync("/api/v1/occurrences/" + Wire.Str(occurrence["occurrence"]!, "id")));
        Assert.True(JsonNode.DeepEquals(occurrence["occurrence"]!["constraintsSnapshot"], persisted["occurrence"]!["constraintsSnapshot"]));
        Assert.Equal(Wire.Str(definition["definition"]!, "serverVersion"), Wire.Str(persisted["occurrence"]!, "sourceDefinitionVersion"));
        var next = await Occurrence(c, updated); Assert.Equal(60, Wire.Int(next["occurrence"]!, "remainingWorkMinutes"));
        using var restarted = new TestApp(fixture.Connection, fixture.Clock); using var restartedClient = restarted.Client();
        await Token(restartedClient); await Json(await Send(restartedClient, HttpMethod.Post, "/api/v1/auth/login", new JsonObject { ["userName"] = "anna", ["password"] = PostgresFixture.Password })); await Token(restartedClient);
        var reread = await Json(await restartedClient.GetAsync("/api/v1/task-definitions/" + definitionId));
        Assert.Equal("low", Wire.Str(reread["definition"]!, "importance")); Assert.Equal("heavy", Wire.Str(reread["definition"]!, "difficulty")); Assert.Equal(5, Wire.Int(reread["definition"]!, "executionPriority"));
    }
    [Fact]
    public async Task FullFixedWorkRejectsPartialAndDstPlacementPreservesElapsedMinutes()
    {
        using var c = await Login();
        var rules = Wire.Obj("{\"timezone\":\"Europe/Moscow\",\"windows\":[{\"daysOfWeek\":[\"monday\"],\"startLocalTime\":\"18:00\",\"endLocalTime\":\"19:00\",\"endDayOffset\":0}],\"dateExceptions\":[]}");
        var o = await Occurrence(c, await Definition(c, availability: rules)); var b = Placement(o, "2026-10-12T18:00:00");
        await Error(await Place(c, o, b), HttpStatusCode.BadRequest, "outsideAvailability");
        var unchanged = await Json(await c.GetAsync("/api/v1/occurrences/" + Wire.Str(o["occurrence"]!, "id")));
        Assert.Null(unchanged["occurrence"]!["calendarBlock"]); Assert.Equal(90, Wire.Int(unchanged["occurrence"]!, "remainingWorkMinutes")); Assert.True(JsonNode.DeepEquals(o["planState"], unchanged["planState"]));
        var dst = await Occurrence(c, await Definition(c)); var command = Placement(dst, "2026-10-25T02:30:00", "+02:00"); command["timezone"] = "Europe/Berlin";
        var planned = await Json(await Place(c, dst, command)); var block = planned["occurrence"]!["calendarBlock"]!;
        Assert.Equal("2026-10-25T00:30:00Z", Wire.Str(block, "startInstant")); Assert.Equal("2026-10-25T02:00:00Z", Wire.Str(block, "endInstant")); Assert.Equal(90, Wire.Int(planned["occurrence"]!, "remainingWorkMinutes"));
        var calendar = await Json(await c.GetAsync("/api/v1/calendar?from=2026-10-25T00%3A00%3A00Z&to=2026-10-26T00%3A00%3A00Z")); Wire.Validate(calendar, "CalendarResponse"); Assert.Contains(calendar["blocks"]!.AsArray(), x => Wire.Str(x!, "id") == Wire.Str(block, "id"));
    }
    [Fact]
    public async Task FixedConfirmationCannotBeBypassedViaSnapshotAndNoHiddenResize()
    {
        using var c = await Login(); var o = await Occurrence(c, await Definition(c, mobility: "fixedAfterPlacement"));
        var planned = await Json(await Place(c, o, Placement(o, "2030-01-01T18:00:00")));
        await Error(await Place(c, planned, Placement(planned, "2030-01-01T20:00:00", action: "move")), HttpStatusCode.Conflict, "fixedChangeRequiresConfirmation");
        var edit = new JsonObject { ["opId"] = Id(), ["logicalDate"] = "2030-01-01", ["constraintsSnapshot"] = planned["occurrence"]!["constraintsSnapshot"]!.DeepClone(), ["allowFixedChange"] = false };
        edit["constraintsSnapshot"]!["mobilityPolicy"] = "movable"; string path = "/api/v1/occurrences/" + Wire.Str(planned["occurrence"]!, "id"); string etag = ApiReply.Quote(Wire.Str(planned["occurrence"]!, "serverVersion"));
        await Error(await Send(c, HttpMethod.Put, path, edit, etag), HttpStatusCode.Conflict, "fixedChangeRequiresConfirmation");
        NewOp(edit); edit["allowFixedChange"] = true; edit["constraintsSnapshot"]!["durationPolicy"]!["requiredWorkMinutes"] = 60;
        await Error(await Send(c, HttpMethod.Put, path, edit, etag), HttpStatusCode.Conflict, "invalidExistingPlacement");
        var moved = await Json(await Place(c, planned, Placement(planned, "2030-01-01T20:00:00", action: "move", allow: true)));
        Assert.Equal(Wire.Str(planned["occurrence"]!["calendarBlock"]!, "id"), Wire.Str(moved["occurrence"]!["calendarBlock"]!, "id"));
        var unplaced = await Json(await Place(c, moved, Placement(moved, "", action: "unplace", allow: true)));
        Assert.Null(unplaced["occurrence"]!["calendarBlock"]); Assert.Equal(90, Wire.Int(unplaced["occurrence"]!, "remainingWorkMinutes"));
    }
    [Fact]
    public async Task SuccessAndFinalErrorReplayRemainAtomicAndFingerprintRejectsChangedRequests()
    {
        using var c = await Login(); var b = new JsonObject { ["opId"] = Id(), ["id"] = Id(), ["name"] = "Категория" };
        var results = await Task.WhenAll(Send(c, HttpMethod.Post, "/api/v1/categories", b), Send(c, HttpMethod.Post, "/api/v1/categories", b));
        var bodies = new List<string>();
        foreach (var r in results) { Assert.Equal(HttpStatusCode.Created, r.StatusCode); bodies.Add(await r.Content.ReadAsStringAsync()); }
        Assert.Equal(bodies[0], bodies[1]); Assert.Single(results, r => r.Headers.GetValues("Idempotency-Replayed").Single() == "true");
        var changed = b.DeepClone().AsObject(); changed["name"] = "Другое"; await Error(await Send(c, HttpMethod.Post, "/api/v1/categories", changed), HttpStatusCode.Conflict, "idempotencyMismatch");
        await Error(await Send(c, HttpMethod.Post, "/api/v1/categories?extra=1", b), HttpStatusCode.Conflict, "idempotencyMismatch");
        var settings = await c.GetAsync("/api/v1/settings"); var s = await Json(settings);
        var invalid = new JsonObject { ["opId"] = Id(), ["timezone"] = "Europe/Moscow", ["weekStartsOn"] = "monday", ["place"] = s["settings"]!["place"] is null ? new JsonObject { ["id"] = Id(), ["name"] = "Дом" } : new JsonObject { ["id"] = Wire.Str(s["settings"]!["place"]!, "id"), ["name"] = "Дом" } };
        var first = await Send(c, HttpMethod.Put, "/api/v1/settings", invalid); var errorBody = await Error(first, (HttpStatusCode)428, "preconditionRequired");
        var replay = await Send(c, HttpMethod.Put, "/api/v1/settings", invalid); var replayBody = await Error(replay, (HttpStatusCode)428, "preconditionRequired"); Assert.True(JsonNode.DeepEquals(errorBody, replayBody)); Assert.Equal("true", replay.Headers.GetValues("Idempotency-Replayed").Single());
        await Error(await Send(c, HttpMethod.Put, "/api/v1/settings", invalid, settings.Headers.ETag!.ToString()), HttpStatusCode.Conflict, "idempotencyMismatch");
        var reread = await Json(await c.GetAsync("/api/v1/settings")); Assert.True(JsonNode.DeepEquals(s["planState"], reread["planState"]));
        c.DefaultRequestHeaders.Remove("X-CSRF-TOKEN"); await Error(await Send(c, HttpMethod.Post, "/api/v1/categories", b), HttpStatusCode.Forbidden, "invalidAntiforgery");
    }
    [Fact]
    public async Task OldSuccessReplayAndValidationReplayNeverOverwriteFreshVersions()
    {
        using var c = await Login(); var create = await DefinitionBody(c);
        var original = await Json(await Send(c, HttpMethod.Post, "/api/v1/task-definitions", create), HttpStatusCode.Created);
        string path = "/api/v1/task-definitions/" + Wire.Str(original["definition"]!, "id");
        var update = original["definition"]!.DeepClone().AsObject(); update.Remove("id"); update.Remove("serverVersion"); NewOp(update); update["title"] = "Свежая редакция";
        var fresh = await Json(await Send(c, HttpMethod.Put, path, update, ApiReply.Quote(Wire.Str(original["definition"]!, "serverVersion"))));
        var replay = await Send(c, HttpMethod.Post, "/api/v1/task-definitions", create); var old = await Json(replay, HttpStatusCode.Created);
        Assert.True(JsonNode.DeepEquals(original, old)); Assert.Equal("true", replay.Headers.GetValues("Idempotency-Replayed").Single());
        var now = await Json(await c.GetAsync(path)); Assert.True(JsonNode.DeepEquals(fresh, now));
        var rejected = await DefinitionBody(c); rejected["unrecognized"] = 1;
        var before = await Json(await c.GetAsync("/api/v1/settings"));
        var first = await Error(await Send(c, HttpMethod.Post, "/api/v1/task-definitions", rejected), HttpStatusCode.BadRequest, "validationFailed");
        var again = await Send(c, HttpMethod.Post, "/api/v1/task-definitions", rejected); var second = await Error(again, HttpStatusCode.BadRequest, "validationFailed"); Assert.True(JsonNode.DeepEquals(first, second));
        rejected.Remove("unrecognized"); await Error(await Send(c, HttpMethod.Post, "/api/v1/task-definitions", rejected), HttpStatusCode.Conflict, "idempotencyMismatch");
        var after = await Json(await c.GetAsync("/api/v1/settings")); Assert.True(JsonNode.DeepEquals(before["planState"], after["planState"]));
    }
    [Fact]
    public async Task ConcurrentEntityUpdatesScheduleWritesAndOverlapsHaveSingleWinner()
    {
        using var c = await Login(); var d = await Definition(c); var body = d["definition"]!.DeepClone().AsObject(); body.Remove("id"); body.Remove("serverVersion"); NewOp(body);
        var other = body.DeepClone().AsObject(); NewOp(other); other["title"] = "Конкурент"; string path = "/api/v1/task-definitions/" + Wire.Str(d["definition"]!, "id"); string etag = ApiReply.Quote(Wire.Str(d["definition"]!, "serverVersion"));
        var updates = await Task.WhenAll(Send(c, HttpMethod.Put, path, body, etag), Send(c, HttpMethod.Put, path, other, etag));
        Assert.Single(updates, x => x.StatusCode == HttpStatusCode.OK); await Error(updates.Single(x => x.StatusCode == HttpStatusCode.PreconditionFailed), HttpStatusCode.PreconditionFailed, "staleEntity");
        d = await Json(await c.GetAsync(path)); var a = await Occurrence(c, d); var b = await Occurrence(c, d);
        var writes = await Task.WhenAll(Place(c, a, Placement(a, "2031-01-01T10:00:00")), Place(c, b, Placement(b, "2031-01-01T10:00:00")));
        Assert.Single(writes, x => x.StatusCode == HttpStatusCode.OK); await Error(writes.Single(x => x.StatusCode == HttpStatusCode.Conflict), HttpStatusCode.Conflict, "staleSchedule");
        string loserId = writes[0].StatusCode == HttpStatusCode.OK ? Wire.Str(b["occurrence"]!, "id") : Wire.Str(a["occurrence"]!, "id");
        var loser = await Json(await c.GetAsync("/api/v1/occurrences/" + loserId));
        await Error(await Place(c, loser, Placement(loser, "2031-01-01T10:30:00")), HttpStatusCode.Conflict, "placementConflict");
        var adjacent = await Json(await Place(c, loser, Placement(loser, "2031-01-01T11:30:00"))); Assert.Equal("planned", Wire.Str(adjacent["occurrence"]!, "placementStatus"));
        // Entity precondition is checked before the now-stale schedule precondition.
        await Error(await Place(c, loser, Placement(loser, "2031-01-01T13:00:00", action: "move")), HttpStatusCode.PreconditionFailed, "staleEntity");
    }
    [Fact]
    public async Task OwnerIsolationForeignReferencesCursorScopeAndClosedFields()
    {
        using var anna = await Login(); using var boris = await Login("boris"); var d = await Definition(anna);
        string id = Wire.Str(d["definition"]!, "id"); await Error(await boris.GetAsync("/api/v1/task-definitions/" + id), HttpStatusCode.NotFound, "notFound");
        await Error(await boris.GetAsync("/api/v1/occurrences?definitionId=" + id), HttpStatusCode.NotFound, "referenceNotFound");
        var b = await DefinitionBody(boris); b["placeId"] = d["definition"]!["placeId"]!.DeepClone(); await Error(await Send(boris, HttpMethod.Post, "/api/v1/task-definitions", b), HttpStatusCode.NotFound, "referenceNotFound");
        var category = new JsonObject { ["opId"] = Id(), ["id"] = Id(), ["name"] = "A" }; await Json(await Send(anna, HttpMethod.Post, "/api/v1/categories", category), HttpStatusCode.Created);
        var foreignCategory = await DefinitionBody(boris); foreignCategory["categoryId"] = category["id"]!.DeepClone(); await Error(await Send(boris, HttpMethod.Post, "/api/v1/task-definitions", foreignCategory), HttpStatusCode.NotFound, "referenceNotFound");
        var sameOpOtherUser = category.DeepClone().AsObject(); sameOpOtherUser["name"] = "B"; await Json(await Send(boris, HttpMethod.Post, "/api/v1/categories", sameOpOtherUser), HttpStatusCode.Created);
        NewOp(category); category["id"] = Id(); await Json(await Send(anna, HttpMethod.Post, "/api/v1/categories", category), HttpStatusCode.Created);
        var page = await Json(await anna.GetAsync("/api/v1/categories?pageSize=1")); var cursor = Uri.EscapeDataString(Wire.Str(page, "nextCursor"));
        await Error(await boris.GetAsync("/api/v1/categories?pageSize=1&cursor=" + cursor), HttpStatusCode.BadRequest, "invalidCursor");
        await Error(await anna.GetAsync("/api/v1/categories?pageSize=2&cursor=" + cursor), HttpStatusCode.BadRequest, "invalidCursor");
        await Json(await anna.GetAsync("/api/v1/categories?pageSize=1&cursor=" + cursor));
        await Error(await anna.GetAsync("/api/v1/settings?unknown=1"), HttpStatusCode.BadRequest, "validationFailed");
        await Error(await anna.GetAsync("/api/v1/categories?pageSize=1&pageSize=2"), HttpStatusCode.BadRequest, "validationFailed");
        var unsupported = await DefinitionBody(anna); unsupported["splitAllowed"] = true; await Error(await Send(anna, HttpMethod.Post, "/api/v1/task-definitions", unsupported), HttpStatusCode.BadRequest, "unsupportedConstraint");
        var missing = await DefinitionBody(anna); missing.Remove("splitAllowed"); await Error(await Send(anna, HttpMethod.Post, "/api/v1/task-definitions", missing), HttpStatusCode.BadRequest, "validationFailed");
        var unknown = await DefinitionBody(anna); unknown["owner"] = "boris"; await Error(await Send(anna, HttpMethod.Post, "/api/v1/task-definitions", unknown), HttpStatusCode.BadRequest, "validationFailed");
        var duplicate = new HttpRequestMessage(HttpMethod.Post, "/api/v1/categories") { Content = new StringContent("{\"opId\":\"" + Id() + "\",\"id\":\"" + Id() + "\",\"name\":\"a\",\"name\":\"b\"}", Encoding.UTF8, "application/json") };
        await Error(await anna.SendAsync(duplicate), HttpStatusCode.BadRequest, "validationFailed");
        string duplicateOp = Id();
        await Error(await anna.SendAsync(new HttpRequestMessage(HttpMethod.Post, "/api/v1/categories") { Content = new StringContent("{\"opId\":\"" + duplicateOp + "\",\"id\":\"" + Id() + "\",\"name\":\"a\",\"name\":\"b\"}", Encoding.UTF8, "application/json") }), HttpStatusCode.BadRequest, "validationFailed");
        using var scope = fixture.App.Services.CreateScope(); var db = scope.ServiceProvider.GetRequiredService<VibeDb>(); Guid parseFailureId = Guid.Parse(duplicateOp);
        Assert.False(await db.Operations.AnyAsync(x => x.OpId == parseFailureId));
    }
    [Fact]
    public async Task ResolvedEndpointAliasesReplayAndAnonymousLoginAcceptsTrailingSlash()
    {
        using var c = fixture.App.Client(); await Token(c);
        await Json(await Send(c, HttpMethod.Post, "/API/v1/auth/LOGIN/", new JsonObject { ["userName"] = "anna", ["password"] = PostgresFixture.Password }));
        await Token(c);
        var category = new JsonObject { ["opId"] = Id(), ["id"] = Id(), ["name"] = "Алиасы маршрута" };
        var original = await Json(await Send(c, HttpMethod.Post, "/api/v1/categories", category), HttpStatusCode.Created);
        foreach (string alias in new[] { "/API/v1/categories", "/api/v1/categories/", "/API/V1/CATEGORIES/" })
        {
            var response = await Send(c, HttpMethod.Post, alias, category);
            Assert.True(JsonNode.DeepEquals(original, await Json(response, HttpStatusCode.Created)));
            Assert.Equal("true", response.Headers.GetValues("Idempotency-Replayed").Single());
        }
        var definition = await Definition(c);
        var update = definition["definition"]!.DeepClone().AsObject(); update.Remove("id"); update.Remove("serverVersion"); NewOp(update); update["title"] = "Путь с UUID";
        string id = Wire.Str(definition["definition"]!, "id"); string etag = ApiReply.Quote(Wire.Str(definition["definition"]!, "serverVersion"));
        var changed = await Json(await Send(c, HttpMethod.Put, "/api/v1/task-definitions/" + id, update, etag));
        var replay = await Send(c, HttpMethod.Put, "/API/v1/task-definitions/" + id.ToUpperInvariant() + "/", update, etag);
        Assert.True(JsonNode.DeepEquals(changed, await Json(replay))); Assert.Equal("true", replay.Headers.GetValues("Idempotency-Replayed").Single());
    }
    [Fact]
    public async Task FractionalNumbersAndMalformedClockFieldsGiveStored400WithoutPartialWrites()
    {
        using var c = await Login();
        Action<JsonObject>[] invalidDefinitions =
        [
            b => b["durationPolicy"]!["requiredWorkMinutes"] = JsonNode.Parse("1.0000000000000000000000000000001"),
            b => b["durationPolicy"]!["requiredWorkMinutes"] = JsonNode.Parse("1e999999999999999999999999999999999999"),
            b => b["placeId"] = " " + Wire.Str(b, "placeId") + " ",
            b => b["availabilityRules"]!["windows"] = new JsonArray(new JsonObject { ["daysOfWeek"] = new JsonArray("monday"), ["startLocalTime"] = "18:00\n", ["endLocalTime"] = "19:00", ["endDayOffset"] = 0 }),
            b => b["availabilityRules"]!["windows"] = new JsonArray(new JsonObject { ["daysOfWeek"] = new JsonArray("monday"), ["startLocalTime"] = "18:0٠", ["endLocalTime"] = "19:00", ["endDayOffset"] = 0 }),
            b => b["availabilityRules"]!["windows"] = new JsonArray(new JsonObject { ["daysOfWeek"] = new JsonArray("monday"), ["startLocalTime"] = "18:00", ["endLocalTime"] = "19:00", ["endDayOffset"] = JsonNode.Parse("1e999999999999999999999999999999999999") })
        ];
        foreach (var invalidate in invalidDefinitions)
        {
            var b = await DefinitionBody(c); invalidate(b);
            var before = await Json(await c.GetAsync("/api/v1/settings"));
            var original = await Error(await Send(c, HttpMethod.Post, "/api/v1/task-definitions", b), HttpStatusCode.BadRequest, "validationFailed");
            var replay = await Send(c, HttpMethod.Post, "/api/v1/task-definitions", b);
            Assert.True(JsonNode.DeepEquals(original, await Error(replay, HttpStatusCode.BadRequest, "validationFailed")));
            Assert.Equal("true", replay.Headers.GetValues("Idempotency-Replayed").Single());
            await Error(await c.GetAsync("/api/v1/task-definitions/" + Wire.Str(b, "id")), HttpStatusCode.NotFound, "notFound");
            var after = await Json(await c.GetAsync("/api/v1/settings")); Assert.True(JsonNode.DeepEquals(before["planState"], after["planState"]));
        }
        var occurrence = await Occurrence(c, await Definition(c));
        foreach (var bad in new[] { (Field: "utcOffset", Value: "+03:00\n"), (Field: "utcOffset", Value: "+03:0٠"), (Field: "localStart", Value: "2034-01-01T10:00:00\n"), (Field: "baseScheduleVersion", Value: "version\n") })
        {
            var command = Placement(occurrence, "2034-01-01T10:00:00"); command[bad.Field] = bad.Value;
            var original = await Error(await Place(c, occurrence, command), HttpStatusCode.BadRequest, "validationFailed");
            var replay = await Place(c, occurrence, command); Assert.True(JsonNode.DeepEquals(original, await Error(replay, HttpStatusCode.BadRequest, "validationFailed"))); Assert.Equal("true", replay.Headers.GetValues("Idempotency-Replayed").Single());
            var reread = await Json(await c.GetAsync("/api/v1/occurrences/" + Wire.Str(occurrence["occurrence"]!, "id"))); Assert.True(JsonNode.DeepEquals(occurrence, reread));
        }
    }
    [Fact]
    public async Task HugeZeroExponentsAndEquivalentIntegralPayloadsPersistExactValuesAndReplay()
    {
        using var c = await Login(); var b = await DefinitionBody(c);
        b["requiredRestMinutes"] = JsonNode.Parse("-0e999999999999999999999999999999999999");
        b["durationPolicy"]!["requiredWorkMinutes"] = JsonNode.Parse("9.000e1");
        b["availabilityRules"]!["windows"] = new JsonArray(new JsonObject { ["daysOfWeek"] = new JsonArray("monday"), ["startLocalTime"] = "18:00", ["endLocalTime"] = "20:00", ["endDayOffset"] = JsonNode.Parse("0e999999999999999999999999999999999999") });
        var initial = await Json(await Send(c, HttpMethod.Post, "/api/v1/task-definitions", b), HttpStatusCode.Created);
        Assert.Equal(90, Wire.Int(initial["definition"]!["durationPolicy"]!, "requiredWorkMinutes")); Assert.Equal(0, Wire.Int(initial["definition"]!, "requiredRestMinutes"));
        var equivalent = b.DeepClone().AsObject(); equivalent["requiredRestMinutes"] = 0; equivalent["durationPolicy"]!["requiredWorkMinutes"] = 90; equivalent["availabilityRules"]!["windows"]![0]!["endDayOffset"] = 0;
        var replay = await Send(c, HttpMethod.Post, "/api/v1/task-definitions", equivalent); Assert.True(JsonNode.DeepEquals(initial, await Json(replay, HttpStatusCode.Created))); Assert.Equal("true", replay.Headers.GetValues("Idempotency-Replayed").Single());
        var occurrence = await Occurrence(c, initial); Assert.Equal(90, Wire.Int(occurrence["occurrence"]!, "remainingWorkMinutes"));
    }
    [Fact]
    public async Task ManualPlacementAtDateExtremesKeepsWholeRepresentableBlock()
    {
        using var c = await Login();
        var minimum = Wire.Obj("{\"timezone\":\"Asia/Dubai\",\"windows\":[{\"daysOfWeek\":[\"monday\"],\"startLocalTime\":\"00:00\",\"endLocalTime\":\"23:00\",\"endDayOffset\":0}],\"dateExceptions\":[]}");
        var o = await Occurrence(c, await Definition(c, 60, availability: minimum));
        var b = Placement(o, "0001-01-01T12:00:00", "+04:00"); b["timezone"] = "Asia/Dubai";
        var planned = await Json(await Place(c, o, b)); Assert.Equal("0001-01-01T08:00:00Z", Wire.Str(planned["occurrence"]!["calendarBlock"]!, "startInstant")); Assert.Equal("0001-01-01T09:00:00Z", Wire.Str(planned["occurrence"]!["calendarBlock"]!, "endInstant"));
        var maximum = Wire.Obj("{\"timezone\":\"Etc/UTC\",\"windows\":[{\"daysOfWeek\":[\"friday\"],\"startLocalTime\":\"09:00\",\"endLocalTime\":\"18:00\",\"endDayOffset\":0},{\"daysOfWeek\":[\"friday\"],\"startLocalTime\":\"22:00\",\"endLocalTime\":\"02:00\",\"endDayOffset\":1}],\"dateExceptions\":[]}");
        var last = await Occurrence(c, await Definition(c, 60, availability: maximum));
        var command = Placement(last, "9999-12-31T10:00:00", "+00:00"); command["timezone"] = "Etc/UTC";
        var final = await Json(await Place(c, last, command)); Assert.Equal("9999-12-31T10:00:00Z", Wire.Str(final["occurrence"]!["calendarBlock"]!, "startInstant")); Assert.Equal("9999-12-31T11:00:00Z", Wire.Str(final["occurrence"]!["calendarBlock"]!, "endInstant")); Assert.Equal(60, Wire.Int(final["occurrence"]!, "remainingWorkMinutes"));
    }
    [Fact]
    public async Task StablePlaceReplacementHasUniformErrorForMissingAndForeignIds()
    {
        using var anna = await Login(); using var boris = await Login("boris"); await PlaceId(anna); string foreign = await PlaceId(boris);
        var currentResponse = await anna.GetAsync("/api/v1/settings"); var current = await Json(currentResponse); string etag = currentResponse.Headers.ETag!.ToString();
        foreach (string id in new[] { Id(), foreign })
        {
            var request = new JsonObject { ["opId"] = Id(), ["timezone"] = "Europe/Moscow", ["weekStartsOn"] = "monday", ["place"] = new JsonObject { ["id"] = id, ["name"] = "Замена" } };
            await Error(await Send(anna, HttpMethod.Put, "/api/v1/settings", request, etag), HttpStatusCode.BadRequest, "unsupportedConstraint");
            Assert.True(JsonNode.DeepEquals(current, await Json(await anna.GetAsync("/api/v1/settings"))));
        }
    }
    [Fact]
    public async Task TargetsUseNotFoundWhileMissingAndForeignReferencesUseReferenceNotFound()
    {
        using var anna = await Login(); using var boris = await Login("boris");
        var foreignDefinition = await Definition(anna); var foreignOccurrence = await Occurrence(anna, foreignDefinition);
        var ownDefinition = await Definition(boris); var ownOccurrence = await Occurrence(boris, ownDefinition);
        foreach (string id in new[] { Id(), Wire.Str(foreignDefinition["definition"]!, "id") })
        {
            string path = "/api/v1/task-definitions/" + id;
            await Error(await boris.GetAsync(path), HttpStatusCode.NotFound, "notFound");
            var update = ownDefinition["definition"]!.DeepClone().AsObject(); update.Remove("id"); update.Remove("serverVersion"); NewOp(update);
            await Error(await Send(boris, HttpMethod.Put, path, update, "\"validVersion\""), HttpStatusCode.NotFound, "notFound");
            await Error(await Send(boris, HttpMethod.Post, path + "/occurrences", new JsonObject { ["opId"] = Id(), ["id"] = Id(), ["definitionVersion"] = "validVersion", ["logicalDate"] = "2026-10-12" }), HttpStatusCode.NotFound, "notFound");
            await Error(await boris.GetAsync("/api/v1/occurrences?definitionId=" + id), HttpStatusCode.NotFound, "referenceNotFound");
        }
        foreach (string id in new[] { Id(), Wire.Str(foreignOccurrence["occurrence"]!, "id") })
        {
            string path = "/api/v1/occurrences/" + id;
            await Error(await boris.GetAsync(path), HttpStatusCode.NotFound, "notFound");
            var update = new JsonObject { ["opId"] = Id(), ["logicalDate"] = "2026-10-12", ["constraintsSnapshot"] = ownOccurrence["occurrence"]!["constraintsSnapshot"]!.DeepClone(), ["allowFixedChange"] = false };
            await Error(await Send(boris, HttpMethod.Put, path, update, "\"validVersion\""), HttpStatusCode.NotFound, "notFound");
            await Error(await Send(boris, HttpMethod.Post, path + "/placement", Placement(ownOccurrence, "2037-01-01T10:00:00"), "\"validVersion\""), HttpStatusCode.NotFound, "notFound");
        }
        foreach (string place in new[] { Id(), Wire.Str(foreignDefinition["definition"]!, "placeId") })
        {
            var body = await DefinitionBody(boris); body["placeId"] = place; await Error(await Send(boris, HttpMethod.Post, "/api/v1/task-definitions", body), HttpStatusCode.NotFound, "referenceNotFound");
        }
        var category = new JsonObject { ["opId"] = Id(), ["id"] = Id(), ["name"] = "Чужая категория" }; await Json(await Send(anna, HttpMethod.Post, "/api/v1/categories", category), HttpStatusCode.Created);
        foreach (string categoryId in new[] { Id(), Wire.Str(category, "id") })
        {
            var body = await DefinitionBody(boris); body["categoryId"] = categoryId; await Error(await Send(boris, HttpMethod.Post, "/api/v1/task-definitions", body), HttpStatusCode.NotFound, "referenceNotFound");
        }
    }
}
