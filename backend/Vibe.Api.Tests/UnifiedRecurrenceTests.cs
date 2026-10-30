using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Vibe.Api.Features.D1;
using Xunit;

namespace Vibe.Api.Tests;

public sealed partial class SyncIntegrationTests
{
    static JsonObject U1RuleCommand(JsonObject definition, JsonObject? intent, string start = "2026-10-17", int? every = null, string zone = "Europe/Moscow", string? end = null)
    {
        var body = RuleCommand(definition, start, end: end, timezone: zone); body["timeIntent"] = intent?.DeepClone();
        if (every is int n) { body.Remove("daysOfWeek"); body["pattern"] = "interval"; body["intervalDays"] = n; body["anchorDate"] = start; }
        return body;
    }
    static async Task<JsonObject> U1DefinitionEdit(HttpClient client, JsonObject definition, string origin, int? minutes = null)
    {
        var body = definition["definition"]!.DeepClone().AsObject(); body.Remove("id"); body.Remove("serverVersion"); body["opId"] = Id(); body["workOrigin"] = origin; body["durationPolicy"] = Duration(minutes);
        return await Json(await Send(client, HttpMethod.Put, "/api/v1/task-definitions/" + Wire.Str(definition["definition"]!, "id"), body, ETag(definition, "definition")));
    }
    [Theory]
    [InlineData(1)] [InlineData(2)] [InlineData(3)] [InlineData(int.MaxValue)]
    public async Task U1EveryNPreservesBackdatedAnchorPhaseAcrossBoundedCatchupWithoutBackfill(int every)
    {
        using var session = await Account(now: R1Now()); var definition = await U1Definition(session.Client);
        var anchor = new DateOnly(2026, 10, 10); var first = new DateOnly(2026, 10, 17);
        var rule = await CreateRule(session.Client, definition, U1RuleCommand(definition, null, "2026-10-10", every));
        try
        {
            fixture.Clock.Advance(TimeSpan.FromDays(63)); int chunks = 0;
            while (await Generate(session.Owner, rule)) Assert.InRange(++chunks, 1, 3);
            await using var db = Db(); var stored = await db.RecurrenceRules.SingleAsync(r => r.UserId == session.Owner);
            Assert.Equal(anchor, stored.AnchorDate); Assert.Equal(first, stored.GenerationStartDate); Assert.Equal(first.AddDays(93), stored.GeneratedThrough);
            var dates = await db.RecurrenceSlots.Where(s => s.UserId == session.Owner).OrderBy(s => s.SlotDate).Select(s => s.SlotDate).ToArrayAsync();
            Assert.Equal(Enumerable.Range(0, 94).Select(i => first.AddDays(i)).Where(d => ((long)d.DayNumber - anchor.DayNumber) % every == 0), dates);
            Assert.False(await db.Blocks.AnyAsync(b => b.UserId == session.Owner)); Assert.All(await db.Occurrences.Where(o => o.UserId == session.Owner).ToArrayAsync(), o => Assert.Null(U1Projection.Work(Wire.Obj(o.SnapshotJson))));
        }
        finally { fixture.Clock.Reset(); }
    }
    [Theory]
    [InlineData(false)] [InlineData(true)]
    public async Task U1SeriesResolvesPerDateAutomaticWorkAndKeepsManualWorkOnDstMismatch(bool manual)
    {
        using var session = await Account(now: R1Now("2026-10-24T12:00:00Z")); var definition = await U1Definition(session.Client, manual ? "manual" : "interval", manual ? 60 : null);
        var rule = await CreateRule(session.Client, definition, U1RuleCommand(definition, Intent("02:30", "03:30", zone: "Europe/Berlin", startChoice: "earlier"), "2026-10-24", zone: "Europe/Berlin", end: "2026-10-26"));
        await using var db = Db(); var rows = await db.Occurrences.Include(o => o.Block).Where(o => o.UserId == session.Owner).OrderBy(o => o.LogicalDate).ToArrayAsync(); Assert.Equal(3, rows.Length);
        Assert.Equal(60, U1Projection.Work(Wire.Obj(rows[0].SnapshotJson))); Assert.NotNull(rows[0].Block);
        Assert.Equal(manual ? 60 : 120, U1Projection.Work(Wire.Obj(rows[1].SnapshotJson))); Assert.Equal(manual ? "workMismatch" : null, rows[1].PlacementIssue); Assert.Equal(!manual, rows[1].Block is not null);
        Assert.NotNull(rows[2].Block); Assert.Equal(1, (await RuleCounters(session.Owner)).Schedule);
        var before = await RuleCounters(session.Owner); await StopRule(session.Client, rule); Assert.Equal(before.Schedule, (await RuleCounters(session.Owner)).Schedule); Assert.Equal(manual ? 2 : 3, await db.Blocks.CountAsync(b => b.UserId == session.Owner));
    }
    [Fact]
    public async Task U1BatchChecksAlreadyTrackedBlocksAndNeverRetriesAnOldRefusedSlot()
    {
        using var session = await Account(now: R1Now()); var definition = await U1Definition(session.Client, "interval");
        var rule = await CreateRule(session.Client, definition, U1RuleCommand(definition, Intent("09:00", "09:00", 2)));
        await using (var db = Db())
        {
            var rows = await db.Occurrences.Include(o => o.Block).Where(o => o.UserId == session.Owner).OrderBy(o => o.LogicalDate).ToArrayAsync(); Assert.Equal(31, rows.Length);
            for (int i = 0; i < rows.Length; i++) { Assert.Equal(2880, U1Projection.Work(Wire.Obj(rows[i].SnapshotJson))); Assert.Equal(i % 2 == 0, rows[i].Block is not null); Assert.Equal(i % 2 == 0 ? null : "placementConflict", rows[i].PlacementIssue); }
            var first = await Json(await session.Client.GetAsync("/api/v1/occurrences/" + rows[0].Id)); await Place(session.Client, first, "unplace");
            string failedVersion = rows[1].Version; Assert.False(await Generate(session.Owner, rule));
            var failed = await Json(await session.Client.GetAsync("/api/v1/occurrences/" + rows[1].Id)); Assert.Equal(failedVersion, Wire.Str(failed["occurrence"]!, "serverVersion")); Assert.Null(failed["occurrence"]!["calendarBlock"]); Assert.Equal("placementConflict", Wire.Str(failed["occurrence"]!, "placementIssue"));
        }
        Assert.Equal(2, (await RuleCounters(session.Owner)).Schedule); // one batch placement, one explicit unplace.
    }
    [Theory]
    [InlineData(false)] [InlineData(true)]
    public async Task U1DefinitionProvenanceChangeCannotTrapExistingRuleInAnInfiniteFailedChunk(bool hadIntent)
    {
        using var session = await Account(now: R1Now()); var definition = await U1Definition(session.Client, "manual", 90);
        var rule = await CreateRule(session.Client, definition, hadIntent ? U1RuleCommand(definition, Intent("09:00", "10:30")) : RuleCommand(definition));
        await using var read = Db(); var oldRows = await read.Occurrences.AsNoTracking().Where(o => o.UserId == session.Owner).OrderBy(o => o.LogicalDate).ToArrayAsync(); var oldSnapshots = oldRows.ToDictionary(o => o.Id, o => (o.SnapshotJson, o.Version));
        definition = await U1DefinitionEdit(session.Client, definition, hadIntent ? "unspecified" : "interval");
        try
        {
            fixture.Clock.Advance(TimeSpan.FromHours(12)); Assert.True(await Generate(session.Owner, rule)); Assert.False(await Generate(session.Owner, rule));
            var newest = await read.Occurrences.AsNoTracking().Where(o => o.UserId == session.Owner).OrderByDescending(o => o.LogicalDate).FirstAsync();
            Assert.Equal(new DateOnly(2026, 11, 17), newest.LogicalDate); Assert.Null(U1Projection.Work(Wire.Obj(newest.SnapshotJson))); Assert.Equal("workMismatch", newest.PlacementIssue); Assert.Null(newest.ResolvedTimingJson); Assert.False(await read.Blocks.AnyAsync(b => b.UserId == session.Owner && b.OccurrenceId == newest.Id));
            Assert.Equal(Wire.Str(definition["definition"]!, "serverVersion"), newest.SourceDefinitionVersion);
            foreach (var prior in await read.Occurrences.AsNoTracking().Where(o => o.UserId == session.Owner && o.Id != newest.Id).ToArrayAsync()) Assert.Equal(oldSnapshots[prior.Id], (prior.SnapshotJson, prior.Version));
            Assert.Equal(hadIntent ? 31 : 0, await read.Blocks.CountAsync(b => b.UserId == session.Owner));
        }
        finally { fixture.Clock.Reset(); }
    }
    [Fact]
    public async Task U1InitialRuleMismatchAndInvalidAnchorOrZoneRejectBeforeAnySlotAndReplayExactly()
    {
        using var session = await Account(now: R1Now()); var definition = await U1Definition(session.Client, "manual", 90); var before = await RuleCounters(session.Owner);
        foreach (string error in new[] { "work", "anchor", "zone" })
        {
            var command = U1RuleCommand(definition, Intent("09:00", "10:30"), every: 2);
            if (error == "work") command["timeIntent"]!["endLocalTime"] = "11:00";
            if (error == "anchor") command["anchorDate"] = "2026-10-16";
            if (error == "zone") command["timezone"] = "Etc/UTC";
            var response = await Send(session.Client, HttpMethod.Post, CreateRulePath(definition), command); string bytes = await response.Content.ReadAsStringAsync(); await Error(response, HttpStatusCode.BadRequest, "validationFailed");
            var replay = await Send(session.Client, HttpMethod.Post, CreateRulePath(definition), command); Assert.Equal(bytes, await replay.Content.ReadAsStringAsync()); Assert.Equal("true", replay.Headers.GetValues("Idempotency-Replayed").Single());
        }
        var after = await RuleCounters(session.Owner); Assert.Equal(before.Input, after.Input); Assert.Equal(before.Schedule, after.Schedule); Assert.Equal(before.Head, after.Head); Assert.Equal(0, after.Slots);
        await using var db = Db(); Assert.False(await db.RecurrenceRules.AnyAsync(r => r.UserId == session.Owner));
    }
}
