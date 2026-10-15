using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Vibe.Api.Data;
using Vibe.Api.Features.D1;
using Vibe.Api.Features.Sync;
using Xunit;

namespace Vibe.Api.Tests;

public sealed partial class SyncIntegrationTests(PostgresFixture fixture) : IClassFixture<PostgresFixture>
{
    sealed record Session(string Owner, string Name, HttpClient Client) : IDisposable { public void Dispose() => Client.Dispose(); }
    VibeDb Db() => new(new DbContextOptionsBuilder<VibeDb>().UseNpgsql(fixture.Connection).Options);
    static string Id() => Guid.NewGuid().ToString("D");
    static async Task<JsonObject> Json(HttpResponseMessage response, HttpStatusCode expected = HttpStatusCode.OK)
    {
        string body = await response.Content.ReadAsStringAsync();
        Assert.True(response.StatusCode == expected, $"Expected {expected}, got {response.StatusCode}: {body}");
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString()); return Wire.Obj(body);
    }
    static async Task Error(HttpResponseMessage response, HttpStatusCode status, string code)
    {
        var body = await Json(response, status); Wire.Validate(body, "ProblemDetails"); Assert.Equal(code, Wire.Str(body, "code"));
        Assert.Null(body["nextCursor"]); Assert.Null(body["nextPageCursor"]);
    }
    static Task<HttpResponseMessage> Send(HttpClient client, HttpMethod method, string path, JsonObject body, string? etag = null)
    {
        var request = new HttpRequestMessage(method, path) { Content = new StringContent(Wire.Json(body), Encoding.UTF8, "application/json") };
        if (etag is not null) request.Headers.TryAddWithoutValidation("If-Match", etag);
        return client.SendAsync(request);
    }
    static async Task Token(HttpClient client)
    {
        var token = await Json(await client.GetAsync("/api/v1/auth/antiforgery"));
        client.DefaultRequestHeaders.Remove("X-CSRF-TOKEN"); client.DefaultRequestHeaders.Add("X-CSRF-TOKEN", Wire.Str(token, "requestToken"));
    }
    async Task<Session> Account(TestApp? app = null, string? ownerId = null)
    {
        fixture.Clock.Reset(); app ??= fixture.App;
        string name = "sync_" + Guid.NewGuid().ToString("N"); var user = new VibeUser { UserName = name };
        if (ownerId is not null) user.Id = ownerId;
        using (var scope = app.Services.CreateScope())
        {
            var users = scope.ServiceProvider.GetRequiredService<UserManager<VibeUser>>();
            Assert.True((await users.CreateAsync(user, PostgresFixture.Password)).Succeeded);
            var db = scope.ServiceProvider.GetRequiredService<VibeDb>();
            db.Plans.Add(new PlanRow { UserId = user.Id });
            db.Settings.Add(new SettingsRow { UserId = user.Id }); db.SyncStreams.Add(new SyncStreamRow { UserId = user.Id }); await db.SaveChangesAsync();
        }
        return new Session(user.Id, name, await Authenticate(app, name));
    }
    static async Task<HttpClient> Authenticate(TestApp app, string name)
    {
        var client = app.Client(); await Token(client);
        await Json(await Send(client, HttpMethod.Post, "/api/v1/auth/login", new JsonObject { ["userName"] = name, ["password"] = PostgresFixture.Password }));
        await Token(client); return client;
    }
    static async Task<JsonObject> Bootstrap(HttpClient client, int size = 50)
    {
        var response = await client.GetAsync("/api/v1/sync/bootstrap?pageSize=" + size); var body = await Json(response); Wire.Validate(body, "BootstrapPage");
        Assert.Null(response.Headers.ETag); Assert.False(response.Headers.Contains("Idempotency-Replayed")); return body;
    }
    static string CursorPath(string resource, string cursor, string suffix = "") => "/api/v1/sync/" + resource + "?cursor=" + Uri.EscapeDataString(cursor) + suffix;
    static async Task<JsonObject> Delta(HttpClient client, string cursor, string suffix = "")
    {
        var body = await Json(await client.GetAsync(CursorPath("changes", cursor, suffix))); Wire.Validate(body, "ChangesPage"); return body;
    }
    static async Task<JsonObject> Category(HttpClient client, string? name = null, JsonObject? command = null)
        => await Json(await Send(client, HttpMethod.Post, "/api/v1/categories", command ?? new JsonObject { ["opId"] = Id(), ["id"] = Id(), ["name"] = name ?? "sync category" }), HttpStatusCode.Created);
    SyncCursor Codec => fixture.App.Services.GetRequiredService<SyncCursor>();
    async Task<SyncStreamRow> Stream(string owner) { await using var db = Db(); return await db.SyncStreams.AsNoTracking().SingleAsync(s => s.UserId == owner); }
    async Task Cleanup(string owner) { using var scope = fixture.App.Services.CreateScope(); await scope.ServiceProvider.GetRequiredService<SyncMaintenance>().Cleanup(owner, CancellationToken.None); }

    [Fact]
    public async Task EmptyBootstrapIsStableReusedAndCategoryHasIndependentSequenceAndExactReplay()
    {
        using var session = await Account(); var client = session.Client;
        var first = await Bootstrap(client, 1); Assert.Single(first["items"]!.AsArray()); Assert.Equal("settings", Wire.Str(first["items"]![0]!, "kind")); Assert.Null(first["nextPageCursor"]);
        var again = await Bootstrap(client, 1); Assert.True(JsonNode.DeepEquals(first, again));
        var before = await Stream(session.Owner); Assert.Equal(0, before.LastSequence);
        var command = new JsonObject { ["opId"] = Id(), ["id"] = Id(), ["name"] = "independent category" };
        var accepted = await Category(client, command: command);
        var replay = await Send(client, HttpMethod.Post, "/API/v1/categories/", command); Assert.Equal("true", replay.Headers.GetValues("Idempotency-Replayed").Single());
        Assert.Equal(Wire.Json(accepted), await replay.Content.ReadAsStringAsync());
        var page = await Delta(client, Wire.Str(first, "asOfCursor"), "&pageSize=1"); var change = Assert.Single(page["changes"]!.AsArray())!;
        Assert.Equal(Wire.Str(command, "opId"), Wire.Str(change, "opId")); Assert.Equal("category", Wire.Str(change["item"]!, "kind"));
        Assert.True(JsonNode.DeepEquals(accepted["category"], change["item"]!["value"]));
        Assert.True(JsonNode.DeepEquals(first["planState"], change["planState"])); Assert.False(page["hasMore"]!.GetValue<bool>());
        var repeat = await Delta(client, Wire.Str(first, "asOfCursor"), "&pageSize=1"); Assert.Equal(Wire.Str(change, "id"), Wire.Str(repeat["changes"]![0]!, "id"));
        Assert.Empty((await Delta(client, Wire.Str(page, "nextCursor")))["changes"]!.AsArray());
        Assert.Equal(1, (await Stream(session.Owner)).LastSequence);
        command["name"] = "different"; await Error(await Send(client, HttpMethod.Post, "/api/v1/categories", command), HttpStatusCode.Conflict, "idempotencyMismatch");
        Assert.Equal(1, (await Stream(session.Owner)).LastSequence);
    }

    [Fact]
    public async Task BootstrapPagesStayAtWatermarkAndDeltaHorizonExcludesLateAppend()
    {
        using var session = await Account(); var client = session.Client;
        var a = await Category(client, "A"); var b = await Category(client, "B");
        var first = await Bootstrap(client, 1); string next = Wire.Str(first, "nextPageCursor"), asOf = Wire.Str(first, "asOfCursor");
        await Category(client, "C"); var snapshotItems = new List<JsonNode> { first["items"]![0]!.DeepClone() };
        while (true)
        {
            var page = await Json(await client.GetAsync(CursorPath("bootstrap", next))); Wire.Validate(page, "BootstrapPage");
            foreach (string field in new[] { "streamId", "snapshotId", "expiresAt", "asOfCursor", "planState" }) Assert.True(JsonNode.DeepEquals(first[field], page[field]));
            snapshotItems.AddRange(page["items"]!.AsArray().Select(i => i!.DeepClone()));
            if (page["nextPageCursor"] is null) break; next = Wire.Str(page, "nextPageCursor");
        }
        Assert.Equal(3, snapshotItems.Count);
        var ids = snapshotItems.Skip(1).Select(i => Wire.Str(i["value"]!, "id")).ToArray();
        Assert.Equal(new[] { Wire.Str(a["category"]!, "id"), Wire.Str(b["category"]!, "id") }.Order(StringComparer.Ordinal), ids);
        await Category(client, "D"); await Category(client, "E");
        var delta = await Delta(client, asOf, "&pageSize=1"); Assert.True(delta["hasMore"]!.GetValue<bool>());
        string bounded = Wire.Str(delta, "nextCursor"); var captured = Codec.ReadDelta(session.Owner, bounded); Assert.NotNull(captured.Horizon);
        await Category(client, "F"); var changes = new List<JsonNode> { delta["changes"]![0]!.DeepClone() };
        await Error(await client.GetAsync(CursorPath("changes", bounded, "&pageSize=2")), HttpStatusCode.BadRequest, "invalidCursor");
        do { delta = await Delta(client, Wire.Str(delta, "nextCursor")); changes.AddRange(delta["changes"]!.AsArray().Select(c => c!.DeepClone())); } while (delta["hasMore"]!.GetValue<bool>());
        Assert.Equal(new[] { "C", "D", "E" }, changes.Select(c => Wire.Str(c["item"]!["value"]!, "name")));
        var late = await Delta(client, Wire.Str(delta, "nextCursor")); Assert.Equal("F", Wire.Str(Assert.Single(late["changes"]!.AsArray())!["item"]!["value"]!, "name"));
        var duplicate = await Delta(client, bounded); Assert.Equal(Wire.Str(changes[1], "id"), Wire.Str(duplicate["changes"]![0]!, "id"));
    }

    [Fact]
    public async Task QueryAuthenticationCursorPurposeOwnershipAndRangeErrorsStayPrivate()
    {
        using var session = await Account(); using var foreign = await Account(); var client = session.Client;
        await Category(client); var first = await Bootstrap(client, 1); string delta = Wire.Str(first, "asOfCursor"), page = Wire.Str(first, "nextPageCursor");
        using var anonymous = fixture.App.Client(); await Error(await anonymous.GetAsync(CursorPath("changes", delta)), HttpStatusCode.Unauthorized, "unauthorized");
        await Error(await foreign.Client.GetAsync(CursorPath("changes", delta)), HttpStatusCode.BadRequest, "invalidCursor");
        await Error(await foreign.Client.GetAsync(CursorPath("bootstrap", page)), HttpStatusCode.BadRequest, "invalidCursor");
        foreach (string token in new[] { "", "corrupt", new string('x', 2001), page }) await Error(await client.GetAsync(CursorPath("changes", token)), HttpStatusCode.BadRequest, "invalidCursor");
        await Error(await client.GetAsync(CursorPath("bootstrap", delta)), HttpStatusCode.BadRequest, "invalidCursor");
        foreach (string suffix in new[] { "?pageSize=0", "?pageSize=101", "?pageSize=1.01", "?pageSize=١", "?unknown=1", "?pageSize=1&pageSize=1" })
            await Error(await client.GetAsync("/api/v1/sync/bootstrap" + suffix), HttpStatusCode.BadRequest, "validationFailed");
        await Error(await client.GetAsync("/api/v1/sync/changes"), HttpStatusCode.BadRequest, "validationFailed");
        await Error(await client.GetAsync(CursorPath("bootstrap", page, "&pageSize=2")), HttpStatusCode.BadRequest, "invalidCursor");
        var get = new HttpRequestMessage(HttpMethod.Get, "/api/v1/sync/bootstrap") { Content = new StringContent("{}") };
        await Error(await client.SendAsync(get), HttpStatusCode.BadRequest, "validationFailed");
        var stream = await Stream(session.Owner);
        foreach (var invalid in new[] { new DeltaPosition(stream.StreamId, -1), new DeltaPosition(stream.StreamId, 2, 1, 1), new DeltaPosition(stream.StreamId, 0, null, 1) })
            await Error(await client.GetAsync(CursorPath("changes", Codec.Delta(session.Owner, invalid))), HttpStatusCode.BadRequest, "invalidCursor");
        foreach (var reset in new[] { new DeltaPosition(Guid.NewGuid(), 0), new DeltaPosition(stream.StreamId, stream.LastSequence + 1), new DeltaPosition(stream.StreamId, 0, stream.LastSequence + 1, 1) })
            await Error(await client.GetAsync(CursorPath("changes", Codec.Delta(session.Owner, reset))), HttpStatusCode.Gone, "syncResetRequired");
        var protector = fixture.App.Services.GetRequiredService<IDataProtectionProvider>().CreateProtector("Vibe.S1.Delta", "s1", session.Owner);
        var huge = protector.Protect("{\"StreamId\":\"" + stream.StreamId + "\",\"After\":9223372036854775808}");
        await Error(await client.GetAsync(CursorPath("changes", huge)), HttpStatusCode.BadRequest, "invalidCursor");
        client.DefaultRequestHeaders.Remove("X-CSRF-TOKEN"); await Bootstrap(client, 1); // GET has no antiforgery requirement.
        await Token(client); Assert.Equal(HttpStatusCode.NoContent, (await client.PostAsync("/api/v1/auth/logout", null)).StatusCode);
        await Error(await client.GetAsync(CursorPath("bootstrap", page)), HttpStatusCode.Unauthorized, "unauthorized");
    }
}
