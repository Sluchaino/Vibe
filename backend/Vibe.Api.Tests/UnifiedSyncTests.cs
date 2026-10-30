using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Vibe.Api.Data;
using Vibe.Api.Features.D1;
using Vibe.Api.Features.Sync;
using Xunit;

namespace Vibe.Api.Tests;

public sealed partial class SyncIntegrationTests
{
    [Fact]
    public async Task U1S3ReadsHistoricalCopiesAndNeverSubstitutesCurrentEntitiesOrRewritesOldLog()
    {
        using var session = await Account(now: R1Now()); var client = session.Client; var start = await Bootstrap(client);
        var definition = await RuleDefinition(client); var occurrence = await NewOccurrence(client, definition);
        var rule = await CreateRule(client, definition, RuleCommand(definition, "2026-12-01"));
        var historical = new Dictionary<Guid, (string Json, string Plan, string Op, long Sequence)>();
        // Simulate the exact pre-U1 persisted log, before later edits to these same roots.
        await using (var db = Db())
        {
            foreach (var row in await db.SyncChanges.Where(c => c.UserId == session.Owner).ToArrayAsync())
            {
                var item = Wire.Obj(row.ItemJson); string kind = Wire.Str(item, "kind");
                if (kind == "definition") item["value"]!.AsObject().Remove("workOrigin");
                else if (kind == "occurrence") item["value"] = LegacyTestWire.Occurrence(item["value"]!);
                else if (kind == "recurrence") item["value"]!.AsObject().Remove("timeIntent");
                else continue;
                row.ItemJson = Wire.Json(item);
            }
            await db.SaveChangesAsync();
            foreach (var row in await db.SyncChanges.AsNoTracking().Where(c => c.UserId == session.Owner).ToArrayAsync()) historical[row.ChangeId] = (row.ItemJson, row.PlanStateJson, row.OpId.ToString("D"), row.Sequence);
        }
        var updated = await U1DefinitionEdit(client, definition, "unspecified");
        var changedOccurrence = await Json(await Send(client, HttpMethod.Put, OccPath(occurrence), U1Edit(occurrence, null, null, "unspecified"), ETag(occurrence)));
        await StopRule(client, rule);
        var page = await Delta(client, Wire.Str(start, "asOfCursor"), "&pageSize=1"); Assert.Equal("s3", Wire.Str(page, "protocol")); int oldRows = 0;
        while (true)
        {
            foreach (var change in page["changes"]!.AsArray())
            {
                Guid id = Guid.Parse(Wire.Str(change!, "id")); if (!historical.TryGetValue(id, out var old)) continue;
                var expected = U1Projection.Item(Wire.Obj(old.Json)); Assert.True(JsonNode.DeepEquals(expected, change!["item"])); Assert.True(JsonNode.DeepEquals(Wire.Obj(old.Plan), change["planState"])); Assert.Equal(old.Op, Wire.Str(change, "opId"));
                string kind = Wire.Str(change["item"]!, "kind");
                if (kind == "definition") { Assert.Equal("manual", Wire.Str(change["item"]!["value"]!, "workOrigin")); Assert.NotEqual(Wire.Str(updated["definition"]!, "serverVersion"), Wire.Str(change["item"]!["value"]!, "serverVersion")); }
                if (kind == "occurrence") { Assert.NotNull(change["item"]!["value"]!["logicalDate"]); Assert.Null(changedOccurrence["occurrence"]!["logicalDate"]); Assert.Null(change["item"]!["value"]!["timeIntent"]); }
                if (kind == "recurrence") Assert.True(change["item"]!["value"]!["enabled"]!.GetValue<bool>());
                oldRows++;
            }
            if (!page["hasMore"]!.GetValue<bool>()) break; page = await Delta(client, Wire.Str(page, "nextCursor"));
        }
        Assert.Equal(historical.Count, oldRows);
        await using var verify = Db(); foreach (var row in await verify.SyncChanges.AsNoTracking().Where(c => c.UserId == session.Owner).ToArrayAsync()) if (historical.TryGetValue(row.ChangeId, out var old)) Assert.Equal((old.Json, old.Plan, old.Op, old.Sequence), (row.ItemJson, row.PlanStateJson, row.OpId.ToString("D"), row.Sequence));
        var position = Codec.ReadDelta(session.Owner, Wire.Str(page, "nextCursor"));
        var protection = fixture.App.Services.GetRequiredService<IDataProtectionProvider>();
        string oldDelta = protection.CreateProtector("Vibe.S2.Delta", "s2", session.Owner).Protect(JsonSerializer.Serialize(position));
        await Error(await client.GetAsync(CursorPath("changes", oldDelta)), HttpStatusCode.BadRequest, "invalidCursor");
        var snapshot = await Bootstrap(client, 1);
        string oldPage = protection.CreateProtector("Vibe.S2.BootstrapPage", "s2", session.Owner).Protect(JsonSerializer.Serialize(new BootstrapPosition(position.StreamId, Guid.Parse(Wire.Str(snapshot, "snapshotId")), 1, 1)));
        await Error(await client.GetAsync(CursorPath("bootstrap", oldPage)), HttpStatusCode.BadRequest, "invalidCursor"); Assert.Equal(position.StreamId.ToString("D"), Wire.Str(snapshot, "streamId"));
    }
    [Theory]
    [InlineData("unknownKind")] [InlineData("invalidShape")]
    public async Task U1MalformedStoredProjectionFailsWithoutIssuingOrAdvancingCursor(string malformed)
    {
        using var session = await Account(now: R1Now()); var baseline = await Bootstrap(session.Client); await Category(session.Client);
        string original; await using (var db = Db()) { var row = await db.SyncChanges.SingleAsync(c => c.UserId == session.Owner); original = row.ItemJson; var item = Wire.Obj(original); if (malformed == "unknownKind") item["kind"] = "futureUnsupported"; else item["value"]!.AsObject().Remove("serverVersion"); row.ItemJson = Wire.Json(item); await db.SaveChangesAsync(); }
        var before = await RuleCounters(session.Owner); string cursor = Wire.Str(baseline, "asOfCursor");
        for (int i = 0; i < 2; i++)
        {
            var failed = await session.Client.GetAsync(CursorPath("changes", cursor)); Assert.Equal(HttpStatusCode.ServiceUnavailable, failed.StatusCode); Assert.Equal("", await failed.Content.ReadAsStringAsync());
        }
        Assert.Equal(before, await RuleCounters(session.Owner));
        await using (var db = Db()) { var row = await db.SyncChanges.SingleAsync(c => c.UserId == session.Owner); row.ItemJson = original; await db.SaveChangesAsync(); }
        Assert.Single((await Delta(session.Client, cursor))["changes"]!.AsArray());
    }
    [Fact]
    public async Task U1LegacyCompleteAndReopenReplayExactOldBytesBeforeFreshStateAndAdaptation()
    {
        using var session = await Account(now: R1Now()); var client = session.Client; var original = await NewOccurrence(client, await RuleDefinition(client));
        var completed = await Json(await Send(client, HttpMethod.Post, OccPath(original) + "/completion", new JsonObject { ["opId"] = Id() }, ETag(original)));
        var reopened = await Json(await Send(client, HttpMethod.Post, OccPath(original) + "/completion/reopen", new JsonObject { ["opId"] = Id(), ["completionId"] = Wire.Str(completed["occurrence"]!["completion"]!, "id") }, ETag(completed)));
        var saved = new List<(string Path, JsonObject Command, string Match, string Body, string ETag)>();
        foreach (bool reopen in new[] { false, true })
        {
            var legacy = (reopen ? reopened : completed).DeepClone().AsObject(); legacy["occurrence"] = LegacyTestWire.Occurrence(legacy["occurrence"]!); Wire.Validate(legacy, "OccurrenceResponse");
            string bytes = legacy.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\r\n";
            string path = OccPath(original) + (reopen ? "/completion/reopen" : "/completion"), match = ETag(reopen ? completed : original);
            var command = new JsonObject { ["opId"] = Id() }; if (reopen) command["completionId"] = Wire.Str(completed["occurrence"]!["completion"]!, "id");
            var ctx = new DefaultHttpContext(); ctx.Request.Method = "POST"; ctx.Request.Path = path; ctx.Request.Headers.IfMatch = match;
            await using var db = Db(); db.Operations.Add(new OperationRow { UserId = session.Owner, OpId = Guid.Parse(Wire.Str(command, "opId")), Fingerprint = Wire.Fingerprint(ctx.Request, command), Status = 200, Body = bytes, ETag = ETag(legacy), Location = path }); await db.SaveChangesAsync(); saved.Add((path, command, match, bytes, ETag(legacy)));
        }
        var fresh = await Json(await Send(client, HttpMethod.Put, OccPath(reopened), U1Edit(reopened, null, null, "unspecified"), ETag(reopened))); var before = await RuleCounters(session.Owner);
        foreach (var old in saved)
        {
            var replay = await Send(client, HttpMethod.Post, old.Path, old.Command, old.Match); Assert.Equal(HttpStatusCode.OK, replay.StatusCode); Assert.Equal(old.Body, await replay.Content.ReadAsStringAsync()); Assert.Equal(old.ETag, replay.Headers.ETag!.ToString()); Assert.Equal(old.Path, replay.Headers.Location!.ToString()); Assert.Equal("true", replay.Headers.GetValues("Idempotency-Replayed").Single()); Wire.Validate(Wire.Obj(old.Body), "OccurrenceMutationResponseU1");
        }
        Assert.Equal(before, await RuleCounters(session.Owner)); Assert.True(JsonNode.DeepEquals(fresh["occurrence"], (await Json(await client.GetAsync(OccPath(fresh))))["occurrence"]));
    }
}
