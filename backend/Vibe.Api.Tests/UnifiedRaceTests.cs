using System.Net;
using Microsoft.EntityFrameworkCore;
using Vibe.Api.Features.D1;
using Xunit;

namespace Vibe.Api.Tests;

public sealed partial class SyncIntegrationTests
{
    [Fact]
    public async Task U1ConcurrentAutomaticCreatesSerializeFullBlocksWithoutRejectingOrLosingEitherOccurrence()
    {
        using var session = await Account(now: R1Now()); var definition = await U1Definition(session.Client, "interval"); var before = await RuleCounters(session.Owner);
        var a = U1CreateBody(definition, "2026-10-17", Intent("09:00", "11:00")); var b = U1CreateBody(definition, "2026-10-17", Intent("09:00", "11:00"));
        var replies = await Task.WhenAll(Send(session.Client, HttpMethod.Post, U1CreatePath(definition), a), Send(session.Client, HttpMethod.Post, U1CreatePath(definition), b));
        var results = await Task.WhenAll(replies.Select(r => Json(r, HttpStatusCode.Created))); Assert.Single(results, r => r["occurrence"]!["calendarBlock"] is not null); Assert.Single(results, r => r["occurrence"]!["placementIssue"]?.GetValue<string>() == "placementConflict");
        var after = await RuleCounters(session.Owner); Assert.Equal(before.Input + 2, after.Input); Assert.Equal(before.Schedule + 1, after.Schedule); Assert.Equal(before.Head + 2, after.Head);
        var replay = await Send(session.Client, HttpMethod.Post, U1CreatePath(definition), a); Assert.Equal(await replies[0].Content.ReadAsStringAsync(), await replay.Content.ReadAsStringAsync()); Assert.Equal("true", replay.Headers.GetValues("Idempotency-Replayed").Single()); Assert.Equal(after, await RuleCounters(session.Owner));
    }
    [Theory]
    [InlineData(false)] [InlineData(true)]
    public async Task U1MidGroupDatabaseFailureRollsBackAutomaticBlocksAlongsideSlotsResultsAndFeed(bool worker)
    {
        using var session = await Account(now: R1Now()); var definition = await U1Definition(session.Client, "interval"); var command = U1RuleCommand(definition, Intent("09:00", "10:00")); var rule = worker ? await CreateRule(session.Client, definition, command) : null;
        var before = await RuleCounters(session.Owner); string suffix = Guid.NewGuid().ToString("N"), function = "u1_fail_" + suffix, trigger = "u1_fail_trigger_" + suffix;
        await Sql($$"""CREATE FUNCTION "{{function}}"() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'forced U1 atomic block failure'; END $fn$; CREATE TRIGGER "{{trigger}}" BEFORE INSERT ON "SyncChanges" FOR EACH ROW WHEN (NEW."UserId" = '{{session.Owner}}' AND NEW."Ordinal" = 1) EXECUTE FUNCTION "{{function}}"();""");
        try
        {
            if (worker) { fixture.Clock.Advance(TimeSpan.FromHours(12)); await Assert.ThrowsAsync<DbUpdateException>(() => Generate(session.Owner, rule!)); }
            else Assert.Equal(HttpStatusCode.ServiceUnavailable, (await Send(session.Client, HttpMethod.Post, CreateRulePath(definition), command)).StatusCode);
            Assert.Equal(before, await RuleCounters(session.Owner)); await using var db = Db(); Assert.Equal(worker ? 31 : 0, await db.Blocks.CountAsync(b => b.UserId == session.Owner)); Assert.Equal(worker ? 31 : 0, await db.Occurrences.CountAsync(o => o.UserId == session.Owner));
            if (worker) Assert.Equal(Wire.Str(rule!["rule"]!, "serverVersion"), (await db.RecurrenceRules.SingleAsync(r => r.UserId == session.Owner)).Version);
        }
        finally { await Sql($"DROP TRIGGER \"{trigger}\" ON \"SyncChanges\"; DROP FUNCTION \"{function}\"();"); }
        try
        {
            if (worker) Assert.True(await Generate(session.Owner, rule!)); else await CreateRule(session.Client, definition, command);
            var after = await RuleCounters(session.Owner); Assert.Equal(before.Schedule + 1, after.Schedule); Assert.Equal(before.Input + 1, after.Input); Assert.Equal(before.Slots + (worker ? 1 : 31), after.Slots); await using var db = Db(); Assert.Equal(worker ? 32 : 31, await db.Blocks.CountAsync(b => b.UserId == session.Owner));
        }
        finally { fixture.Clock.Reset(); }
    }
    [Theory]
    [InlineData("2026-03-29", "02:30", "03:30", "Europe/Berlin", "invalidLocalTime")]
    [InlineData("9999-12-31", "23:00", "01:00", "Etc/UTC", "outOfRange")]
    public async Task U1GapAndRepresentabilityRefusalPersistIntentWithoutInventingDerivedWork(string date, string start, string end, string zone, string issue)
    {
        using var session = await Account(now: R1Now()); var definition = await U1Definition(session.Client, "interval"); var state = await U1Occurrence(session.Client, definition, date, Intent(start, end, issue == "outOfRange" ? 1 : 0, zone));
        Assert.Equal(issue, Wire.Str(state["occurrence"]!, "placementIssue")); Assert.Null(state["occurrence"]!["remainingWorkMinutes"]); Assert.Null(state["occurrence"]!["calendarBlock"]); Assert.Null(state["occurrence"]!["resolvedTiming"]); Assert.NotNull(state["occurrence"]!["timeIntent"]);
    }
    [Fact]
    public async Task U1OutsideAvailabilityKeepsResolvedFullVolumeAndSnapshotProtectionWithoutAHiddenBlock()
    {
        using var session = await Account(now: R1Now()); var definition = await U1Definition(session.Client, "interval");
        var body = definition["definition"]!.DeepClone().AsObject(); body.Remove("id"); body.Remove("serverVersion"); body["opId"] = Id(); body["mobilityPolicy"] = "fixedAfterPlacement";
        body["availabilityRules"] = Wire.Obj("{\"timezone\":\"Europe/Moscow\",\"windows\":[{\"daysOfWeek\":[\"saturday\"],\"startLocalTime\":\"12:00\",\"endLocalTime\":\"18:00\",\"endDayOffset\":0}],\"dateExceptions\":[]}");
        definition = await Json(await Send(session.Client, HttpMethod.Put, "/api/v1/task-definitions/" + Wire.Str(definition["definition"]!, "id"), body, ETag(definition, "definition")));
        var state = await U1Occurrence(session.Client, definition, "2026-10-17", Intent("09:00", "11:00")); Assert.Equal(120, Wire.Int(state["occurrence"]!, "remainingWorkMinutes")); Assert.NotNull(state["occurrence"]!["resolvedTiming"]); Assert.Equal("outsideAvailability", Wire.Str(state["occurrence"]!, "placementIssue")); Assert.Null(state["occurrence"]!["calendarBlock"]);
        var accepted = await U1Occurrence(session.Client, definition, "2026-10-17", Intent("12:00", "14:00")); Assert.False(accepted["occurrence"]!["calendarBlock"]!["fixed"]!.GetValue<bool>());
        await Error(await PlaceResponse(session.Client, accepted, "unplace"), HttpStatusCode.Conflict, "fixedChangeRequiresConfirmation");
    }
    [Theory]
    [InlineData("9999-12-31", "23:00", null, "Europe/Moscow")]
    [InlineData("0001-01-01", null, "01:00", "America/New_York")]
    public async Task U1LocallyUnrepresentableDerivedBoundarySavesKnownWorkAndIntentWithoutBlock(string date, string? start, string? end, string zone)
    {
        using var session = await Account(now: R1Now()); var definition = await U1Definition(session.Client, "manual", 120); var state = await U1Occurrence(session.Client, definition, date, Intent(start, end, zone: zone));
        Assert.Equal("outOfRange", Wire.Str(state["occurrence"]!, "placementIssue")); Assert.Equal(120, Wire.Int(state["occurrence"]!, "remainingWorkMinutes")); Assert.Null(state["occurrence"]!["resolvedTiming"]); Assert.Null(state["occurrence"]!["calendarBlock"]); Assert.NotNull(state["occurrence"]!["timeIntent"]);
        Assert.Equal(0, (await RuleCounters(session.Owner)).Schedule);
    }
}
