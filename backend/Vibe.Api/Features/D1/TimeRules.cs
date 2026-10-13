using System.Diagnostics;
using System.Globalization;
using System.Text.Json.Nodes;

namespace Vibe.Api.Features.D1;

public static class TimeRules
{
    public static TimeZoneInfo Zone(string id)
    {
        if (id.Length > 100 || !TimeZoneInfo.TryConvertIanaIdToWindowsId(id, out _)) Wire.Bad();
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch (TimeZoneNotFoundException) { Wire.Bad(); throw; }
        catch (InvalidTimeZoneException) { Wire.Bad(); throw; }
    }
    public static DateOnly Date(string value)
    {
        DateOnly date = default;
        if (!Wire.Pattern(value, @"^\d{4}-\d{2}-\d{2}$") || !DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out date)) Wire.Bad();
        return date;
    }
    public static DateTime Local(string value)
    {
        DateTime local = default;
        if (!Wire.Pattern(value, @"^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:00$") || !DateTime.TryParseExact(value, "yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture, DateTimeStyles.None, out local)) Wire.Bad();
        return DateTime.SpecifyKind(local, DateTimeKind.Unspecified);
    }
    public static DateTime Utc(string value)
    {
        DateTime utc = default;
        if (!Wire.Pattern(value, @"^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:00Z$") || !DateTime.TryParseExact(value, "yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out utc)) Wire.Bad();
        return utc;
    }
    public static string Instant(DateTime utc) => utc.ToString("yyyy-MM-dd'T'HH:mm:00'Z'", CultureInfo.InvariantCulture);
    public static TimeSpan Offset(string value)
    {
        if (!Wire.Pattern(value, @"^[+-](?:0\d|1[0-4]):[0-5]\d$") || value == "-00:00") Wire.Bad();
        int hours = 0, minutes = 0;
        if (!int.TryParse(value.AsSpan(1, 2), NumberStyles.None, CultureInfo.InvariantCulture, out hours) || !int.TryParse(value.AsSpan(4, 2), NumberStyles.None, CultureInfo.InvariantCulture, out minutes) || hours == 14 && minutes != 0) Wire.Bad();
        return TimeSpan.FromMinutes((hours * 60 + minutes) * (value[0] == '-' ? -1 : 1));
    }
    public static string OffsetText(TimeSpan offset) => (offset < TimeSpan.Zero ? "-" : "+") + offset.Duration().ToString(@"hh\:mm", CultureInfo.InvariantCulture);
    public static TimeSpan[] Offsets(TimeZoneInfo zone, DateTime local) => zone.IsInvalidTime(local) ? [] : zone.IsAmbiguousTime(local) ? zone.GetAmbiguousTimeOffsets(local).OrderByDescending(x => x).ToArray() : [zone.GetUtcOffset(local)];
    public static DateTime Resolve(DateTime local, TimeZoneInfo zone, string selected)
    {
        long ticks = ResolveBoundary(local.Ticks, zone, selected);
        if (ticks < DateTime.MinValue.Ticks || ticks > DateTime.MaxValue.Ticks) Wire.Bad();
        return new DateTime(ticks, DateTimeKind.Utc);
    }
    // Window boundaries may extend beyond the representable instant range. Evaluate their exact
    // ticks without constructing an overflowing DateTimeOffset; the candidate block itself stays representable.
    static long ResolveBoundary(long localTicks, TimeZoneInfo zone, string selected)
    {
        var offsets = BoundaryOffsets(zone, localTicks);
        if (offsets.Length == 0) throw new DomainError(400, "invalidLocalTime");
        var offset = Offset(selected);
        if (!offsets.Contains(offset)) throw new DomainError(400, "invalidUtcOffset", new JsonObject { ["validUtcOffsets"] = new JsonArray(offsets.Select(o => (JsonNode?)JsonValue.Create(OffsetText(o))).ToArray()) });
        return localTicks - offset.Ticks;
    }
    static DateTime OffsetSample(long localTicks) => new(Math.Clamp(localTicks, DateTime.MinValue.Ticks, DateTime.MaxValue.Ticks), DateTimeKind.Unspecified);
    static TimeSpan[] BoundaryOffsets(TimeZoneInfo zone, long localTicks) => Offsets(zone, OffsetSample(localTicks));
    public static void ValidateAvailability(JsonNode rules)
    {
        var zone = Zone(Wire.Str(rules, "timezone"));
        foreach (var window in rules["windows"]!.AsArray()) ValidateWindow(window!);
        var dates = new HashSet<DateOnly>();
        foreach (var exception in rules["dateExceptions"]!.AsArray())
        {
            var date = Date(Wire.Str(exception!, "localDate"));
            if (!dates.Add(date)) Wire.Bad();
            foreach (var window in exception!["windows"]!.AsArray())
            {
                ValidateWindow(window!);
                var (start, end) = LocalBounds(date, window!);
                var s = ResolveBoundary(start, zone, Wire.Str(window!, "startUtcOffset"));
                var e = ResolveBoundary(end, zone, Wire.Str(window!, "endUtcOffset"));
                if (s >= e) Wire.Bad();
            }
        }
    }
    static void ValidateWindow(JsonNode window)
    {
        var start = Time(Wire.Str(window, "startLocalTime"));
        var end = Time(Wire.Str(window, "endLocalTime"));
        int offset = Wire.Int(window, "endDayOffset");
        if (offset == 0 && start >= end || offset == 1 && end > start) Wire.Bad();
    }
    static TimeOnly Time(string value)
    {
        TimeOnly time = default;
        if (!Wire.Pattern(value, @"^(?:[01]\d|2[0-3]):[0-5]\d$") || !TimeOnly.TryParseExact(value, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out time)) Wire.Bad();
        return time;
    }
    static (long Start, long End) LocalBounds(DateOnly date, JsonNode window) =>
        ((long)date.DayNumber * TimeSpan.TicksPerDay + Time(Wire.Str(window, "startLocalTime")).Ticks,
         ((long)date.DayNumber + Wire.Int(window, "endDayOffset")) * TimeSpan.TicksPerDay + Time(Wire.Str(window, "endLocalTime")).Ticks);
    static readonly string[] Weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    public static void CheckAvailability(JsonNode rules, DateTime start, DateTime end, CancellationToken cancellation)
    {
        var windows = rules["windows"]!.AsArray();
        var exceptions = rules["dateExceptions"]!.AsArray().ToDictionary(x => Date(Wire.Str(x!, "localDate")), x => x!["windows"]!.AsArray());
        if (windows.Count == 0 && exceptions.Count == 0) return;
        var zone = Zone(Wire.Str(rules, "timezone"));
        var first = DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(start, zone));
        var last = DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(end.AddTicks(-1), zone));
        if (first > DateOnly.MinValue) first = first.AddDays(-1);
        var known = new List<(long Start, long End)>();
        var possible = new List<(long Start, long End)>();
        var budget = Stopwatch.StartNew();
        for (var date = first; date <= last;)
        {
            cancellation.ThrowIfCancellationRequested();
            // A resource timeout is infrastructure failure, never a stored domain rejection or truncated work.
            if (budget.ElapsedMilliseconds > 1500) throw new TimeoutException("Availability evaluation budget exceeded.");
            if (exceptions.TryGetValue(date, out var explicitWindows))
            {
                foreach (var w in explicitWindows)
                {
                    var (s, e) = LocalBounds(date, w!);
                    known.Add((ResolveBoundary(s, zone, Wire.Str(w!, "startUtcOffset")), ResolveBoundary(e, zone, Wire.Str(w!, "endUtcOffset"))));
                }
            }
            else if (windows.Count == 0)
            {
                long midnight = (long)date.DayNumber * TimeSpan.TicksPerDay;
                known.Add((DayBoundary(midnight, zone), DayBoundary(midnight + TimeSpan.TicksPerDay, zone)));
            }
            else
            {
                foreach (var w in windows.Where(w => w!["daysOfWeek"]!.AsArray().Any(d => d!.GetValue<string>() == Weekdays[(int)date.DayOfWeek])))
                {
                    var (s, e) = LocalBounds(date, w!);
                    var so = BoundaryOffsets(zone, s); var eo = BoundaryOffsets(zone, e);
                    if (so.Length == 1 && eo.Length == 1) known.Add((s - so[0].Ticks, e - eo[0].Ticks));
                    else
                    {
                        // Envelope only determines whether an undefined boundary is relevant; it never admits a block.
                        var sc = so.Length == 0 ? new[] { zone.GetUtcOffset(OffsetSample(s - 3 * TimeSpan.TicksPerHour)), zone.GetUtcOffset(OffsetSample(s + 3 * TimeSpan.TicksPerHour)) } : so;
                        var ec = eo.Length == 0 ? new[] { zone.GetUtcOffset(OffsetSample(e - 3 * TimeSpan.TicksPerHour)), zone.GetUtcOffset(OffsetSample(e + 3 * TimeSpan.TicksPerHour)) } : eo;
                        possible.Add((s - sc.Max().Ticks, e - ec.Min().Ticks));
                    }
                }
            }
            if (date == last || date == DateOnly.MaxValue) break;
            date = date.AddDays(1);
        }
        if (Covers(known, start.Ticks, end.Ticks)) return;
        if (Covers(known.Concat(possible), start.Ticks, end.Ticks)) throw new DomainError(400, "ambiguousAvailabilityBoundary");
        throw new DomainError(400, "outsideAvailability");
    }
    static long DayBoundary(long localTicks, TimeZoneInfo zone)
    {
        for (int minutes = 0; BoundaryOffsets(zone, localTicks).Length == 0 && minutes < 1440; minutes++) localTicks += TimeSpan.TicksPerMinute;
        var offsets = BoundaryOffsets(zone, localTicks);
        if (offsets.Length == 0) throw new DomainError(400, "ambiguousAvailabilityBoundary");
        return localTicks - offsets.Max().Ticks;
    }
    static bool Covers(IEnumerable<(long Start, long End)> intervals, long start, long end)
    {
        long covered = start;
        foreach (var interval in intervals.OrderBy(x => x.Start))
        {
            if (interval.End <= covered) continue;
            if (interval.Start > covered) return false;
            covered = interval.End;
            if (covered >= end) return true;
        }
        return false;
    }
    public static void CalendarRange(DateTime from, DateTime to, string timezone)
    {
        if (from >= to) Wire.Bad();
        var zone = Zone(timezone);
        int first = DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(from, zone)).DayNumber;
        int last = DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(to.AddTicks(-1), zone)).DayNumber;
        if (last - first + 1 > 31) throw new DomainError(400, "rangeTooLarge");
    }
}
