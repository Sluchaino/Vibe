using System.Globalization;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Vibe.Api.Data;

namespace Vibe.Api.Features.D1;

public sealed record TimingResolution(JsonObject Constraints, JsonObject? Timing, string? Issue);

public static class TimingRules
{
    public static void ValidateIntent(JsonObject? intent)
    {
        if (intent is null) return;
        Wire.Validate(intent, "TimeIntent"); TimeRules.Zone(Wire.Str(intent, "timezone"));
    }
    public static TimingResolution Resolve(JsonObject source, DateOnly? date, JsonObject? intent, bool initial)
    {
        var constraints = U1Projection.Constraints(source); string origin = Wire.Str(constraints, "workOrigin");
        int? work = U1Projection.Work(constraints);
        ValidateIntent(intent);
        if (intent is not null && date is null) Wire.Bad();
        bool hasStart = intent?["startLocalTime"] is not null, hasEnd = intent?["endLocalTime"] is not null;
        TimingResolution Mismatch()
        {
            if (initial) throw new DomainError(400, "validationFailed");
            return new TimingResolution(constraints, null, "workMismatch");
        }
        if (origin == "interval")
        {
            // Derived N is always computed afresh; it is never a client supplied input.
            constraints["durationPolicy"] = null; work = null;
            if (!hasStart || !hasEnd) return Mismatch();
        }
        if (origin == "unspecified" && hasStart && hasEnd) return Mismatch();
        if (intent is null || work is null && !(hasStart && hasEnd)) return new(constraints, null, null);
        var zone = TimeRules.Zone(Wire.Str(intent, "timezone"));
        string? issue = null;
        DateTime? Boundary(string timeKey, string choiceKey, int dayOffset)
        {
            long day = (long)date!.Value.DayNumber + dayOffset;
            if (day < 0 || day > DateOnly.MaxValue.DayNumber) { issue ??= "outOfRange"; return null; }
            string text = Wire.Str(intent, timeKey);
            if (!TimeOnly.TryParseExact(text, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out var time)) throw new DomainError(400, "validationFailed");
            DateTime local = DateOnly.FromDayNumber((int)day).ToDateTime(time, DateTimeKind.Unspecified);
            var offsets = TimeRules.Offsets(zone, local);
            if (offsets.Length == 0) { issue ??= "invalidLocalTime"; return null; }
            string? choice = intent[choiceKey]?.GetValue<string>();
            if (offsets.Length > 1 && choice is null) { issue ??= "ambiguousLocalTime"; return null; }
            var offset = choice == "later" ? offsets[^1] : offsets[0];
            long ticks = local.Ticks - offset.Ticks;
            if (ticks < DateTime.MinValue.Ticks || ticks > DateTime.MaxValue.Ticks) { issue ??= "outOfRange"; return null; }
            return new DateTime(ticks, DateTimeKind.Utc);
        }
        DateTime? start = hasStart ? Boundary("startLocalTime", "startDisambiguation", 0) : null;
        DateTime? end = hasEnd ? Boundary("endLocalTime", "endDisambiguation", Wire.Int(intent, "endDayOffset")) : null;
        if (issue is not null) return new(constraints, null, issue);
        if (start is null && work is int back && end is DateTime ending)
        {
            long ticks = ending.Ticks - (long)back * TimeSpan.TicksPerMinute;
            if (ticks < DateTime.MinValue.Ticks) return new(constraints, null, "outOfRange");
            start = new DateTime(ticks, DateTimeKind.Utc);
        }
        if (end is null && work is int forward && start is DateTime beginning)
        {
            long ticks = beginning.Ticks + (long)forward * TimeSpan.TicksPerMinute;
            if (ticks > DateTime.MaxValue.Ticks) return new(constraints, null, "outOfRange");
            end = new DateTime(ticks, DateTimeKind.Utc);
        }
        if (start is null || end is null) return new(constraints, null, null);
        // A representable UTC instant can still fall outside years 1..9999 in the
        // intent's zone. ConvertTimeFromUtc clamps at the boundaries, so check the
        // actual local ticks before publishing either derived boundary.
        bool LocalFits(DateTime instant)
        {
            long localTicks = checked(instant.Ticks + zone.GetUtcOffset(instant).Ticks);
            return localTicks >= DateTime.MinValue.Ticks && localTicks <= DateTime.MaxValue.Ticks;
        }
        if (!LocalFits(start.Value) || !LocalFits(end.Value)) return new(constraints, null, "outOfRange");
        long duration = end.Value.Ticks - start.Value.Ticks;
        if (duration <= 0 || duration % TimeSpan.TicksPerMinute != 0 || duration / TimeSpan.TicksPerMinute > int.MaxValue) return Mismatch();
        int minutes = (int)(duration / TimeSpan.TicksPerMinute);
        if (work is int manual && manual != minutes) return Mismatch();
        if (origin == "interval") constraints["durationPolicy"] = new JsonObject { ["mode"] = "fixedWork", ["requiredWorkMinutes"] = minutes };
        return new(constraints, new JsonObject { ["startInstant"] = TimeRules.Instant(start.Value), ["endInstant"] = TimeRules.Instant(end.Value) }, null);
    }
    public static void Store(OccurrenceRow occurrence, JsonObject? intent, TimingResolution resolution)
    {
        occurrence.SnapshotJson = Wire.Json(resolution.Constraints);
        occurrence.TimeIntentJson = intent is null ? null : Wire.Json(intent);
        occurrence.ResolvedTimingJson = resolution.Timing is null ? null : Wire.Json(resolution.Timing);
        occurrence.PlacementIssue = resolution.Issue;
    }
    public static async Task<bool> AutoPlace(VibeDb db, OccurrenceRow occurrence, TimingResolution resolution, CancellationToken ct)
    {
        if (resolution.Timing is null || resolution.Issue is not null) return false;
        DateTime start = TimeRules.Utc(Wire.Str(resolution.Timing, "startInstant")), end = TimeRules.Utc(Wire.Str(resolution.Timing, "endInstant"));
        try { TimeRules.CheckAvailability(resolution.Constraints["availabilityRules"]!, start, end, ct); }
        catch (DomainError e) when (e.Status == 400) { occurrence.PlacementIssue = "outsideAvailability"; return false; }
        bool tracked = db.ChangeTracker.Entries<BlockRow>().Any(e => (e.State is EntityState.Added or EntityState.Modified)
            && e.Entity.UserId == occurrence.UserId && e.Entity.OccurrenceId != occurrence.Id && e.Entity.Start < end && e.Entity.End > start);
        if (tracked || await db.Blocks.AnyAsync(b => b.UserId == occurrence.UserId && b.OccurrenceId != occurrence.Id && b.Start < end && b.End > start, ct))
        { occurrence.PlacementIssue = "placementConflict"; return false; }
        var block = new BlockRow { UserId = occurrence.UserId, Id = Guid.NewGuid(), OccurrenceId = occurrence.Id, Start = start, End = end, Fixed = false };
        db.Blocks.Add(block); occurrence.Block = block; occurrence.PlacementIssue = null; return true;
    }
}
