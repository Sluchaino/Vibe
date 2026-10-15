using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Vibe.Api.Data;
using Vibe.Api.Features.D1;
using Xunit;

namespace Vibe.Api.Tests;

public partial class ApiIntegrationTests
{
    [Fact]
    public async Task C1IncompleteSnapshotKeepsD1ReferenceValidationWhileActiveChecksVersionFirst()
    {
        using var client = await Login(); var original = await Occurrence(client, await Definition(client)); var invalid = C1Edit(original);
        invalid["constraintsSnapshot"]!["placeId"] = Id();
        await Error(await Send(client, HttpMethod.Put, C1Path(original), invalid, "\"staleVersion\""), HttpStatusCode.NotFound, "referenceNotFound");
        var completed = await C1Response(await C1Complete(client, original));
        NewOp(invalid); await Error(await Send(client, HttpMethod.Put, C1Path(completed), invalid, C1ETag(original)), HttpStatusCode.PreconditionFailed, "staleEntity");
        NewOp(invalid); await Error(await Send(client, HttpMethod.Put, C1Path(completed), invalid, C1ETag(completed)), HttpStatusCode.Conflict, "occurrenceCompleted");
    }
    [Fact]
    public async Task C1ConcurrentSameOpCommitsOneFactAndReplaysOneExactResult()
    {
        using var client = await Login(); var original = await Occurrence(client, await Definition(client)); var before = await C1Counters(client, original); var body = C1CompleteBody();
        var replies = await Task.WhenAll(C1Complete(client, original, body), C1Complete(client, original, body));
        var raw = new List<string>();
        foreach (var reply in replies) { raw.Add(await reply.Content.ReadAsStringAsync()); await C1Response(reply); }
        Assert.Equal(raw[0], raw[1]); Assert.Single(replies, r => r.Headers.GetValues("Idempotency-Replayed").Single() == "true");
        var actual = await C1Refresh(client, original); var after = await C1Counters(client, actual);
        Assert.Equal(before.Input + 1, after.Input); Assert.Equal(before.Schedule, after.Schedule); Assert.Equal(1, after.Active); Assert.Equal(1, after.History);
        string owner = Wire.Str(await Json(await client.GetAsync("/api/v1/me")), "userId"); var opId = Guid.Parse(Wire.Str(body, "opId"));
        using var scope = C1Fixture.App.Services.CreateScope(); var db = scope.ServiceProvider.GetRequiredService<VibeDb>();
        Assert.Equal(1, await db.Operations.CountAsync(o => o.UserId == owner && o.OpId == opId));
    }
    [Fact]
    public async Task C1SavedCompletionReplayStillRequiresUnexpiredAuthenticatedSession()
    {
        var now = DateTimeOffset.UtcNow;
        var started = new DateTimeOffset(now.UtcTicks - now.UtcTicks % TimeSpan.TicksPerSecond, TimeSpan.Zero);
        C1Fixture.Clock.SetUtcNow(started);
        try
        {
            using var client = C1Fixture.App.Client(); await Token(client);
            var loggedIn = await Send(client, HttpMethod.Post, "/api/v1/auth/login", new JsonObject { ["userName"] = "anna", ["password"] = PostgresFixture.Password });
            await Json(loggedIn);
            AuthenticationTicket Ticket(HttpResponseMessage response)
            {
                Assert.True(response.Headers.TryGetValues("Set-Cookie", out var cookies), "Security stamp validation must actually refresh its principal cookie.");
                const string prefix = "__Host-Vibe.Session=";
                string cookie = cookies!.Single(c => c.StartsWith(prefix, StringComparison.Ordinal));
                string protectedTicket = cookie.Split(';', 2)[0][prefix.Length..];
                var options = C1Fixture.App.Services.GetRequiredService<IOptionsMonitor<CookieAuthenticationOptions>>().Get(IdentityConstants.ApplicationScheme);
                var ticket = options.TicketDataFormat.Unprotect(protectedTicket); Assert.NotNull(ticket); return ticket!;
            }
            var initial = Ticket(loggedIn); var deadline = initial.Properties.ExpiresUtc;
            Assert.Equal(started, initial.Properties.IssuedUtc); Assert.Equal(started.AddHours(24), deadline);
            await Token(client);
            var original = await Occurrence(client, await Definition(client)); var body = C1CompleteBody();
            await C1Response(await C1Complete(client, original, body));
            C1Fixture.Clock.Advance(TimeSpan.FromMinutes(31));
            var at31Minutes = await client.GetAsync("/api/v1/me"); await Json(at31Minutes); var renewed31 = Ticket(at31Minutes);
            Assert.Equal(started.AddMinutes(31), renewed31.Properties.IssuedUtc); Assert.Equal(deadline, renewed31.Properties.ExpiresUtc);
            C1Fixture.Clock.Advance(TimeSpan.FromHours(23) - TimeSpan.FromMinutes(31));
            var at23Hours = await client.GetAsync("/api/v1/me"); await Json(at23Hours); var renewed23 = Ticket(at23Hours);
            Assert.Equal(started.AddHours(23), renewed23.Properties.IssuedUtc); Assert.Equal(deadline, renewed23.Properties.ExpiresUtc);
            C1Fixture.Clock.Advance(TimeSpan.FromHours(2));
            await Error(await client.GetAsync("/api/v1/me"), HttpStatusCode.Unauthorized, "unauthorized");
            await Error(await C1Complete(client, original, body), HttpStatusCode.Unauthorized, "unauthorized");
        }
        finally { C1Fixture.Clock.Reset(); }
    }
    [Fact]
    public async Task C1SharedClockStillEnforcesSecurityStampRejectionAfterValidationInterval()
    {
        using var client = await Login(); var original = await Occurrence(client, await Definition(client)); var body = C1CompleteBody();
        await C1Response(await C1Complete(client, original, body));
        using (var scope = C1Fixture.App.Services.CreateScope())
        {
            var users = scope.ServiceProvider.GetRequiredService<UserManager<VibeUser>>();
            var user = await users.FindByNameAsync("anna"); Assert.NotNull(user);
            Assert.True((await users.UpdateSecurityStampAsync(user!)).Succeeded);
        }
        C1Fixture.Clock.Advance(TimeSpan.FromMinutes(31));
        try
        {
            await Error(await client.GetAsync("/api/v1/me"), HttpStatusCode.Unauthorized, "unauthorized");
            await Error(await C1Complete(client, original, body), HttpStatusCode.Unauthorized, "unauthorized");
        }
        finally { C1Fixture.Clock.Reset(); }
    }
    [Fact]
    public async Task C1OwnershipAuthenticationCsrfAndIfMatchRemainRequiredForEveryDelivery()
    {
        using var anna = await Login(); using var boris = await Login("boris");
        var original = await Occurrence(anna, await Definition(anna)); var ownB = await Occurrence(boris, await Definition(boris));
        var sharedOp = C1CompleteBody(); var activeA = await C1Response(await C1Complete(anna, original, sharedOp));
        var activeB = await C1Response(await C1Complete(boris, ownB, sharedOp));
        Assert.NotEqual(C1FactId(activeA), C1FactId(activeB)); Assert.Equal(Wire.Str(C1Occ(ownB), "id"), Wire.Str(C1Occ(activeB), "id"));
        var otherA = await C1Response(await C1Complete(anna, await Occurrence(anna, await Definition(anna))));
        foreach (string wrongFact in new[] { Id(), C1FactId(activeB), C1FactId(otherA) })
        {
            await Error(await C1Reopen(anna, original, wrongFact), HttpStatusCode.PreconditionFailed, "staleEntity");
            await Error(await C1Reopen(anna, activeA, wrongFact), HttpStatusCode.NotFound, "referenceNotFound");
        }
        await Error(await C1Complete(boris, activeA), HttpStatusCode.NotFound, "notFound");
        await Error(await C1Reopen(boris, activeA, C1FactId(activeA)), HttpStatusCode.NotFound, "notFound");
        var missing = activeA.DeepClone().AsObject(); missing["occurrence"]!["id"] = Id();
        await Error(await C1Complete(anna, missing), HttpStatusCode.NotFound, "notFound");
        await Error(await Send(anna, HttpMethod.Post, C1Path(activeA) + "/completion", C1CompleteBody()), (HttpStatusCode)428, "preconditionRequired");
        await Error(await Send(anna, HttpMethod.Post, C1Path(activeA) + "/completion/reopen", C1ReopenBody(C1FactId(activeA))), (HttpStatusCode)428, "preconditionRequired");
        var before = await C1Counters(anna, activeA);
        var invalid = C1CompleteBody(); invalid["completedAt"] = "2026-10-14T00:00:00.000Z";
        await Error(await C1Complete(anna, activeA, invalid), HttpStatusCode.BadRequest, "validationFailed");
        await Error(await Send(anna, HttpMethod.Post, C1Path(activeA) + "/completion?extra=1", C1CompleteBody(), C1ETag(activeA)), HttpStatusCode.BadRequest, "validationFailed");
        Assert.Equal(before, await C1Counters(anna, activeA));
        using var anonymous = C1Fixture.App.Client(); var denied = C1CompleteBody();
        await Error(await C1Complete(anonymous, activeA, denied), HttpStatusCode.Unauthorized, "unauthorized");
        anna.DefaultRequestHeaders.Remove("X-CSRF-TOKEN");
        await Error(await C1Complete(anna, original, sharedOp), HttpStatusCode.Forbidden, "invalidAntiforgery");
        using (var scope = C1Fixture.App.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<VibeDb>(); var deniedId = Guid.Parse(Wire.Str(denied, "opId")); var sharedId = Guid.Parse(Wire.Str(sharedOp, "opId"));
            Assert.False(await db.Operations.AnyAsync(o => o.OpId == deniedId));
            Assert.Equal(2, await db.Operations.CountAsync(o => o.OpId == sharedId));
        }
    }
    [Fact]
    public async Task C1StatusFiltersRunBeforeTakeAndLegacyCursorKeepsAllStatusScope()
    {
        using var client = await Login(); var definition = await Definition(client); string definitionId = Wire.Str(definition["definition"]!, "id");
        string[] ids = new[] { Id(), Id(), Id() }.OrderBy(x => x, StringComparer.Ordinal).ToArray(); var states = new List<JsonObject>();
        foreach (string id in ids)
        {
            var request = new JsonObject { ["opId"] = Id(), ["id"] = id, ["definitionVersion"] = Wire.Str(definition["definition"]!, "serverVersion"), ["logicalDate"] = "2026-10-14" };
            var response = await Send(client, HttpMethod.Post, "/api/v1/task-definitions/" + definitionId + "/occurrences", request);
            var state = await Json(response, HttpStatusCode.Created); Wire.Validate(state, "OccurrenceResponse"); states.Add(state);
        }
        var first = await C1Response(await C1Complete(client, states[0]));
        var last = await C1Response(await C1Complete(client, states[2]));
        string path = "/api/v1/occurrences?definitionId=" + definitionId + "&pageSize=1";
        var all = await Json(await client.GetAsync(path + "&placementStatus=unplanned"));
        Wire.Validate(all, "OccurrencePage"); Assert.Equal(ids[0], Wire.Str(all["items"]![0]!, "id")); Assert.Equal("completed", Wire.Str(all["items"]![0]!, "completionStatus"));
        var work = await Json(await client.GetAsync(path + "&placementStatus=unplanned&completionStatus=incomplete"));
        Assert.Single(work["items"]!.AsArray()); Assert.Equal(ids[1], Wire.Str(work["items"]![0]!, "id")); Assert.Null(work["nextCursor"]);
        var completed = await Json(await client.GetAsync(path + "&completionStatus=completed"));
        Assert.Equal(ids[0], Wire.Str(completed["items"]![0]!, "id")); Assert.NotNull(completed["nextCursor"]);
        var next = await Json(await client.GetAsync(path + "&completionStatus=completed&cursor=" + Uri.EscapeDataString(Wire.Str(completed, "nextCursor"))));
        Assert.Equal(ids[2], Wire.Str(next["items"]![0]!, "id"));
        string owner = Wire.Str(await Json(await client.GetAsync("/api/v1/me")), "userId");
        string filter = JsonSerializer.Serialize(new[] { new { Key = "definitionId", value = definitionId }, new { Key = "pageSize", value = "1" } });
        string oldCursor = C1Fixture.App.Services.GetRequiredService<IDataProtectionProvider>().CreateProtector("Vibe.D1.Cursor", owner, "occurrences", filter).Protect(ids[0]);
        var resumed = await Json(await client.GetAsync(path + "&cursor=" + Uri.EscapeDataString(oldCursor)));
        Assert.Equal(ids[1], Wire.Str(resumed["items"]![0]!, "id"));
        await Error(await client.GetAsync(path + "&completionStatus=incomplete&cursor=" + Uri.EscapeDataString(oldCursor)), HttpStatusCode.BadRequest, "invalidCursor");
        await Error(await client.GetAsync(path + "&completionStatus=unknown"), HttpStatusCode.BadRequest, "validationFailed");
        var reopened = await C1Response(await C1Reopen(client, first, C1FactId(first)));
        var restored = await Json(await client.GetAsync(path + "&placementStatus=unplanned&completionStatus=incomplete"));
        Assert.Equal(ids[0], Wire.Str(restored["items"]![0]!, "id")); Assert.Null(restored["items"]![0]!["completion"]);
        var onlyActive = await Json(await client.GetAsync(path + "&completionStatus=completed")); Assert.Equal(ids[2], Wire.Str(onlyActive["items"]![0]!, "id"));
        Assert.Equal(C1FactId(last), C1FactId(await C1Refresh(client, last)));
        Assert.Equal("incomplete", Wire.Str(C1Occ(reopened), "completionStatus"));
    }
    [Fact]
    public async Task C1LegacyOperationResultsReplayExactBytesWithoutRewritingFreshState()
    {
        using var client = await Login(); var original = await Occurrence(client, await Definition(client));
        string owner = Wire.Str(await Json(await client.GetAsync("/api/v1/me")), "userId");
        var legacy = original.DeepClone().AsObject(); legacy["occurrence"]!.AsObject().Remove("completionStatus"); legacy["occurrence"]!.AsObject().Remove("completion");
        legacy["occurrence"]!["serverVersion"] = "legacy_occurrence_v1"; Wire.Validate(legacy, "OccurrenceResponseLegacyD1");
        string legacyBody = legacy.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\r\n";
        var oldError = new JsonObject { ["type"] = "about:blank", ["title"] = "historical stale entity", ["status"] = 412, ["detail"] = "Old operation result.", ["instance"] = C1Path(original), ["code"] = "staleEntity", ["correlationId"] = "old-result-correlation", ["currentServerVersion"] = "legacy_occurrence_v1", ["currentOccurrence"] = legacy["occurrence"]!.DeepClone() };
        Wire.Validate(oldError, "ProblemDetails"); string oldErrorBody = oldError.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n";
        var successPayload = C1Edit(original); var errorPayload = C1Edit(original); string oldEtag = C1ETag(original);
        string Fingerprint(JsonObject payload)
        {
            var context = new DefaultHttpContext(); context.Request.Method = "PUT"; context.Request.Path = C1Path(original); context.Request.Headers.IfMatch = oldEtag;
            return Wire.Fingerprint(context.Request, payload);
        }
        using (var scope = C1Fixture.App.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<VibeDb>();
            db.Operations.AddRange(
                new OperationRow { UserId = owner, OpId = Guid.Parse(Wire.Str(successPayload, "opId")), Fingerprint = Fingerprint(successPayload), Status = 200, Body = legacyBody, ETag = "\"legacy_occurrence_v1\"", Location = C1Path(original) },
                new OperationRow { UserId = owner, OpId = Guid.Parse(Wire.Str(errorPayload, "opId")), Fingerprint = Fingerprint(errorPayload), Status = 412, Body = oldErrorBody, ETag = "\"legacy_occurrence_v1\"" });
            await db.SaveChangesAsync();
        }
        var completed = await C1Response(await C1Complete(client, original)); var counters = await C1Counters(client, completed);
        long syncHead;
        using (var headScope = C1Fixture.App.Services.CreateScope()) syncHead = (await headScope.ServiceProvider.GetRequiredService<VibeDb>().SyncStreams.AsNoTracking().SingleAsync(s => s.UserId == owner)).LastSequence;
        var success = await Send(client, HttpMethod.Put, C1Path(original), successPayload, oldEtag);
        Assert.Equal(HttpStatusCode.OK, success.StatusCode); Assert.Equal(legacyBody, await success.Content.ReadAsStringAsync()); Assert.Equal("\"legacy_occurrence_v1\"", success.Headers.ETag!.ToString()); Assert.Equal(C1Path(original), success.Headers.Location!.ToString()); Assert.Equal("true", success.Headers.GetValues("Idempotency-Replayed").Single());
        Wire.Validate(Wire.Obj(await success.Content.ReadAsStringAsync()), "OccurrenceMutationResponse");
        var error = await Send(client, HttpMethod.Put, C1Path(original), errorPayload, oldEtag);
        Assert.Equal(HttpStatusCode.PreconditionFailed, error.StatusCode); Assert.Equal(oldErrorBody, await error.Content.ReadAsStringAsync()); Assert.Equal("true", error.Headers.GetValues("Idempotency-Replayed").Single());
        Assert.Equal(counters, await C1Counters(client, completed)); Assert.Equal(C1FactId(completed), C1FactId(await C1Refresh(client, completed)));
        using var verifyScope = C1Fixture.App.Services.CreateScope(); var verify = verifyScope.ServiceProvider.GetRequiredService<VibeDb>();
        var successId = Guid.Parse(Wire.Str(successPayload, "opId")); var errorId = Guid.Parse(Wire.Str(errorPayload, "opId"));
        Assert.Equal(legacyBody, (await verify.Operations.AsNoTracking().SingleAsync(o => o.UserId == owner && o.OpId == successId)).Body);
        Assert.Equal(oldErrorBody, (await verify.Operations.AsNoTracking().SingleAsync(o => o.UserId == owner && o.OpId == errorId)).Body);
        Assert.Equal(syncHead, (await verify.SyncStreams.AsNoTracking().SingleAsync(s => s.UserId == owner)).LastSequence);
        Assert.False(await verify.SyncChanges.AnyAsync(c => c.UserId == owner && (c.OpId == successId || c.OpId == errorId)));
    }
}
