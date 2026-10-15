using System.Net;
using System.Text.Json.Nodes;
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
    public async Task RetentionPrunesOnlyOldPrefixAcrossClockCorrectionAndPersistsEmptyLogFloor()
    {
        using var session = await Account(); var client = session.Client; var now = DateTimeOffset.UtcNow;
        try
        {
            fixture.Clock.SetUtcNow(now.AddDays(-8)); await Category(client, "old first");
            fixture.Clock.SetUtcNow(now); await Category(client, "young middle");
            fixture.Clock.SetUtcNow(now.AddDays(-8)); await Category(client, "old later");
            fixture.Clock.SetUtcNow(now); var stream = await Stream(session.Owner);
            string Token(long after) => Codec.Delta(session.Owner, new DeltaPosition(stream.StreamId, after));
            await Cleanup(session.Owner); var pruned = await Stream(session.Owner); Assert.Equal(1, pruned.PrunedThrough); Assert.Equal(3, pruned.LastSequence);
            await Error(await client.GetAsync(CursorPath("changes", Token(0))), HttpStatusCode.Gone, "syncResetRequired");
            var atFloor = await Delta(client, Token(1)); Assert.Equal(new[] { "young middle", "old later" }, atFloor["changes"]!.AsArray().Select(c => Wire.Str(c!["item"]!["value"]!, "name")));
            await using (var old = Db()) await old.SyncChanges.Where(c => c.UserId == session.Owner).ExecuteUpdateAsync(u => u.SetProperty(c => c.RecordedAtUtc, now.AddDays(-8).UtcDateTime));
            await Cleanup(session.Owner); await Cleanup(session.Owner);
            var empty = await Stream(session.Owner); Assert.Equal(3, empty.PrunedThrough); Assert.Equal(3, empty.LastSequence);
            Assert.Empty((await Delta(client, Token(3)))["changes"]!.AsArray());
            await Error(await client.GetAsync(CursorPath("changes", Token(2))), HttpStatusCode.Gone, "syncResetRequired");
            await using var actual = Db(); Assert.False(await actual.SyncChanges.AnyAsync(c => c.UserId == session.Owner));
            Assert.Equal(3, await actual.Operations.CountAsync(o => o.UserId == session.Owner));
        }
        finally { fixture.Clock.Reset(); }
    }

    [Fact]
    public async Task ActiveSnapshotPinsWatermarkWhileBoundedDeltaWithoutPinCanExpireBetweenPages()
    {
        using var session = await Account(); var client = session.Client; var now = DateTimeOffset.UtcNow;
        try
        {
            fixture.Clock.SetUtcNow(now.AddDays(-8)); await Category(client, "one");
            fixture.Clock.SetUtcNow(now); var snapshot = await Bootstrap(client, 1); // W=1, expires in 15 min.
            fixture.Clock.SetUtcNow(now.AddDays(-8)); await Category(client, "two"); await Category(client, "three");
            fixture.Clock.SetUtcNow(now);
            var delta = await Delta(client, Wire.Str(snapshot, "asOfCursor"), "&pageSize=1"); Assert.True(delta["hasMore"]!.GetValue<bool>());
            await Cleanup(session.Owner); Assert.Equal(1, (await Stream(session.Owner)).PrunedThrough);
            Assert.Single((await Delta(client, Wire.Str(delta, "nextCursor")))["changes"]!.AsArray());
            fixture.Clock.Advance(TimeSpan.FromMinutes(16)); await Cleanup(session.Owner);
            Assert.Equal(3, (await Stream(session.Owner)).PrunedThrough);
            await Error(await client.GetAsync(CursorPath("changes", Wire.Str(delta, "nextCursor"))), HttpStatusCode.Gone, "syncResetRequired");
            await Error(await client.GetAsync(CursorPath("bootstrap", Wire.Str(snapshot, "nextPageCursor"))), HttpStatusCode.Gone, "snapshotExpired");
            await using var actual = Db(); Assert.False(await actual.SyncSnapshots.AnyAsync(s => s.UserId == session.Owner)); Assert.False(await actual.SyncSnapshotItems.AnyAsync(i => i.UserId == session.Owner));
        }
        finally { fixture.Clock.Reset(); }
    }

    [Fact]
    public async Task ControlledEpochResetPreservesDomainHistoryAndLegacyResultButInvalidatesOldCursors()
    {
        using var session = await Account(); var client = session.Client; string place = await SetupPlace(client);
        var definition = await Json(await Send(client, HttpMethod.Post, "/api/v1/task-definitions", DefinitionCommand(place)), HttpStatusCode.Created);
        var occurrence = await NewOccurrence(client, definition); var complete = new JsonObject { ["opId"] = Id() };
        string oldVersion = ETag(occurrence), path = OccPath(occurrence);
        var reply = await Send(client, HttpMethod.Post, path + "/completion", complete, oldVersion); string bytes = await reply.Content.ReadAsStringAsync();
        var active = await Json(reply); var snapshot = await Bootstrap(client, 1); var before = await Stream(session.Owner);
        string context, occurrenceVersion, completionVersion; long input, schedule, results;
        await using (var stored = Db())
        {
            var fact = await stored.Completions.SingleAsync(c => c.UserId == session.Owner); context = fact.OccurrenceSnapshotJson; completionVersion = fact.Version;
            occurrenceVersion = (await stored.Occurrences.SingleAsync(o => o.UserId == session.Owner)).Version;
            var plan = await stored.Plans.SingleAsync(p => p.UserId == session.Owner); input = plan.InputRevision; schedule = plan.ScheduleRevision;
            results = await stored.Operations.LongCountAsync(o => o.UserId == session.Owner);
        }
        using (var scope = fixture.App.Services.CreateScope()) await scope.ServiceProvider.GetRequiredService<SyncMaintenance>().ResetStream(session.Owner, CancellationToken.None);
        var after = await Stream(session.Owner); Assert.NotEqual(before.StreamId, after.StreamId); Assert.Equal(0, after.LastSequence); Assert.Equal(0, after.PrunedThrough);
        await Error(await client.GetAsync(CursorPath("changes", Wire.Str(snapshot, "asOfCursor"))), HttpStatusCode.Gone, "syncResetRequired");
        await Error(await client.GetAsync(CursorPath("bootstrap", Wire.Str(snapshot, "nextPageCursor"))), HttpStatusCode.Gone, "snapshotExpired");
        var replay = await Send(client, HttpMethod.Post, path + "/completion", complete, oldVersion);
        Assert.Equal(bytes, await replay.Content.ReadAsStringAsync()); Assert.Equal("true", replay.Headers.GetValues("Idempotency-Replayed").Single());
        var newSnapshot = await Bootstrap(client, 100); Assert.Equal(after.StreamId.ToString("D"), Wire.Str(newSnapshot, "streamId"));
        Assert.True(JsonNode.DeepEquals(active["occurrence"], newSnapshot["items"]!.AsArray().Single(i => Wire.Str(i!, "kind") == "occurrence")!["value"]));
        await using var actual = Db(); var factAfter = await actual.Completions.SingleAsync(c => c.UserId == session.Owner);
        Assert.Equal(context, factAfter.OccurrenceSnapshotJson); Assert.Equal(completionVersion, factAfter.Version); Assert.Null(factAfter.RevokedAtUtc);
        Assert.Equal(occurrenceVersion, (await actual.Occurrences.SingleAsync(o => o.UserId == session.Owner)).Version);
        var planAfter = await actual.Plans.SingleAsync(p => p.UserId == session.Owner); Assert.Equal(input, planAfter.InputRevision); Assert.Equal(schedule, planAfter.ScheduleRevision);
        Assert.Equal(results, await actual.Operations.LongCountAsync(o => o.UserId == session.Owner)); Assert.False(await actual.SyncChanges.AnyAsync(c => c.UserId == session.Owner));
        await Category(client, "new epoch"); Assert.Equal(1, (await Stream(session.Owner)).LastSequence);
    }

    [Fact]
    public async Task RegisteredBackgroundWorkerActuallyPrunesOldFeedWithoutAnySyncRequest()
    {
        await using var app = new TestApp(fixture.Connection, fixture.Clock, new Dictionary<string, string?> { ["Sync:CleanupIntervalSeconds"] = "1" });
        using var session = await Account(app, "ffffffff-ffff-ffff-ffff-ffffffffffff"); var now = DateTimeOffset.UtcNow;
        try
        {
            // Put the affected account after the inventory's first100 rows, so the real
            // background pass must execute the translated string.Compare continuation.
            await using (var seed = Db())
            {
                for (int i = 1; i <= 110; i++)
                {
                    string owner = "00000000-0000-0000-0000-" + i.ToString("x12");
                    seed.Users.Add(new VibeUser { Id = owner }); seed.Plans.Add(new PlanRow { UserId = owner });
                    seed.Settings.Add(new SettingsRow { UserId = owner }); seed.SyncStreams.Add(new SyncStreamRow { UserId = owner });
                }
                await seed.SaveChangesAsync();
            }
            fixture.Clock.SetUtcNow(now.AddDays(-8)); await Category(session.Client); fixture.Clock.SetUtcNow(now);
            using var budget = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            while ((await Stream(session.Owner)).PrunedThrough != 1) await Task.Delay(100, budget.Token);
            Assert.Equal(1, (await Stream(session.Owner)).LastSequence);
            await using var actual = Db(); Assert.False(await actual.SyncChanges.AnyAsync(c => c.UserId == session.Owner)); Assert.Single(await actual.Operations.Where(o => o.UserId == session.Owner).ToListAsync());
        }
        finally { fixture.Clock.Reset(); }
    }
}
