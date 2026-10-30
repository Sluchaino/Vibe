using System.Data;
using System.Globalization;
using System.Security.Claims;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Vibe.Api.Data;
using Vibe.Api.Features.D1;
using Vibe.Api.Features.Sync;

namespace Vibe.Api.Features.Recurrence;

public sealed class RecurrenceService(VibeDb db, TimeProvider clock)
{
    public static readonly string[] Weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
    public static string Date(DateOnly date) => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
    public static JsonObject Rule(RecurrenceRuleRow rule)
    {
        var result = new JsonObject
        {
        ["id"] = rule.Id.ToString("D"), ["definitionId"] = rule.DefinitionId.ToString("D"), ["pattern"] = rule.Pattern,
        ["timezone"] = rule.Timezone, ["startDate"] = Date(rule.StartDate), ["endDate"] = rule.EndDate is DateOnly end ? JsonValue.Create(Date(end)) : null,
        ["enabled"] = rule.Enabled, ["generatedThrough"] = rule.GeneratedThrough is DateOnly through ? JsonValue.Create(Date(through)) : null,
        ["serverVersion"] = rule.Version, ["timeIntent"] = rule.TimeIntentJson is null ? null : Wire.Obj(rule.TimeIntentJson)
        };
        if (rule.Pattern == "weekly") result["daysOfWeek"] = new JsonArray(Weekdays.Where((_, i) => (rule.DaysMask & (1 << i)) != 0).Select(d => (JsonNode?)JsonValue.Create(d)).ToArray());
        else { result["intervalDays"] = rule.IntervalDays; result["anchorDate"] = Date(rule.AnchorDate!.Value); }
        return result;
    }
    public static ApiReply Reply(RecurrenceRuleRow rule, PlanRow plan, int status = 200, string? location = null)
        => ApiReply.Json(new JsonObject { ["rule"] = Rule(rule), ["planState"] = D1Service.Plan(plan) }, status, rule.Version, location);
    static Guid Route(string? value) => Wire.TryUuid(value, out var id) ? id : throw new DomainError(400, "validationFailed");
    static DateOnly Today(DateTime utc, string timezone) => DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(utc, TimeRules.Zone(timezone)));
    static void Match(HttpContext ctx, RecurrenceRuleRow rule)
    {
        var raw = ctx.Request.Headers.IfMatch;
        if (raw.Count == 0) throw new DomainError(428, "preconditionRequired");
        if (raw.Count != 1 || !Wire.Pattern(raw[0]!, "^\"[A-Za-z0-9_-]{1,200}\"$")) Wire.Bad();
        if (raw[0] != ApiReply.Quote(rule.Version)) throw new DomainError(412, "staleEntity", new JsonObject { ["currentServerVersion"] = rule.Version }, ApiReply.Quote(rule.Version));
    }
    public async Task<ApiReply> Apply(HttpContext ctx, string owner, PlanRow plan, JsonObject body, string kind, string? route, CancellationToken ct)
    {
        if (kind == "createRecurrence")
        {
            Guid definitionId = Route(route);
            var definition = await db.Definitions.SingleOrDefaultAsync(d => d.UserId == owner && d.Id == definitionId, ct) ?? throw new DomainError(404, "notFound");
            if (definition.Version != Wire.Str(body, "definitionVersion")) throw new DomainError(412, "staleDefinition",
                new JsonObject { ["currentServerVersion"] = definition.Version, ["currentDefinition"] = D1Service.Definition(definition) }, ApiReply.Quote(definition.Version));
            DateOnly start = TimeRules.Date(Wire.Str(body, "startDate"));
            DateOnly? end = body["endDate"] is null ? null : TimeRules.Date(Wire.Str(body, "endDate"));
            string zone = Wire.Str(body, "timezone"); TimeRules.Zone(zone);
            if (end < start) Wire.Bad();
            var intent = body["timeIntent"]?.AsObject(); TimingRules.ValidateIntent(intent);
            if (intent is not null && Wire.Str(intent, "timezone") != zone) Wire.Bad();
            string pattern = Wire.Str(body, "pattern");
            DateOnly? anchor = pattern == "interval" ? TimeRules.Date(Wire.Str(body, "anchorDate")) : null;
            if (anchor is not null && anchor != start) Wire.Bad();
            TimingRules.Resolve(D1Service.Snapshot(Wire.Obj(definition.FieldsJson)), start, intent, true);
            Guid id = Wire.Id(body, "id");
            if (await db.RecurrenceRules.AnyAsync(r => r.UserId == owner && r.Id == id, ct)) throw new DomainError(409, "idUnavailable");
            if (await db.RecurrenceRules.AnyAsync(r => r.UserId == owner && r.DefinitionId == definitionId, ct)) throw new DomainError(409, "recurrenceAlreadyExists");
            DateTime now = clock.GetUtcNow().UtcDateTime; DateOnly today = Today(now, zone);
            int mask = pattern == "weekly" ? body["daysOfWeek"]!.AsArray().Aggregate(0, (m, d) => m | (1 << Array.IndexOf(Weekdays, d!.GetValue<string>()))) : 0;
            var rule = new RecurrenceRuleRow { UserId = owner, Id = id, DefinitionId = definitionId, DaysMask = mask, Timezone = zone,
                StartDate = start, EndDate = end, GenerationStartDate = start > today ? start : today, Pattern = pattern,
                IntervalDays = pattern == "interval" ? Wire.Int(body, "intervalDays") : null, AnchorDate = anchor, TimeIntentJson = intent is null ? null : Wire.Json(intent) };
            db.RecurrenceRules.Add(rule);
            var generated = await Scan(rule, definition, now, ct);
            plan.InputRevision = checked(plan.InputRevision + 1);
            if (generated?.Blocks > 0) plan.ScheduleRevision = checked(plan.ScheduleRevision + 1);
            return Reply(rule, plan, 201, "/api/v1/recurrence-rules/" + id.ToString("D"));
        }
        Guid ruleId = Route(route);
        var existing = await db.RecurrenceRules.SingleOrDefaultAsync(r => r.UserId == owner && r.Id == ruleId, ct) ?? throw new DomainError(404, "notFound");
        Match(ctx, existing);
        if (existing.Enabled) { existing.Enabled = false; existing.Version = Versions.New(); plan.InputRevision = checked(plan.InputRevision + 1); }
        return Reply(existing, plan);
    }
    public async Task<ApiReply> Read(HttpContext ctx, string route)
    {
        string owner = ctx.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? throw new DomainError(401, "unauthorized");
        Wire.Query(ctx.Request);
        if (ctx.Request.ContentLength > 0 || ctx.Request.Headers.ContainsKey("Transfer-Encoding")
            || ctx.Request.ContentLength is null && await ctx.Request.Body.ReadAsync(new byte[1], ctx.RequestAborted) != 0) Wire.Bad();
        Guid id = Route(route); var ct = ctx.RequestAborted;
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        var rule = await db.RecurrenceRules.AsNoTracking().SingleOrDefaultAsync(r => r.UserId == owner && r.Id == id, ct) ?? throw new DomainError(404, "notFound");
        var plan = await db.Plans.AsNoTracking().SingleAsync(p => p.UserId == owner, ct);
        var reply = Reply(rule, plan); await tx.CommitAsync(ct); return reply;
    }

    // Caller holds the user guard. A null result is a genuine no-op (no cursor movement).
    public sealed record Generation(int Occurrences, int Blocks);
    public async Task<Generation?> Scan(RecurrenceRuleRow rule, DefinitionRow definition, DateTime now, CancellationToken ct)
    {
        if (!rule.Enabled || rule.GeneratedThrough == DateOnly.MaxValue) return null;
        DateOnly today = Today(now, rule.Timezone);
        int target = Math.Min(DateOnly.MaxValue.DayNumber, today.DayNumber + 30);
        if (rule.EndDate is DateOnly end) target = Math.Min(target, end.DayNumber);
        int first = rule.GeneratedThrough is DateOnly previous ? previous.DayNumber + 1 : rule.GenerationStartDate.DayNumber;
        if (first > target) return null;
        int last = Math.Min(first + 30, target);
        var existing = await db.RecurrenceSlots.Where(s => s.UserId == rule.UserId && s.RuleId == rule.Id && s.SlotDate >= DateOnly.FromDayNumber(first)
            && s.SlotDate <= DateOnly.FromDayNumber(last)).Select(s => s.SlotDate).ToListAsync(ct);
        var occupied = existing.ToHashSet();
        var snapshot = D1Service.Snapshot(Wire.Obj(definition.FieldsJson)); var intent = rule.TimeIntentJson is null ? null : Wire.Obj(rule.TimeIntentJson);
        int created = 0, blocks = 0;
        for (int day = first; day <= last; day++)
        {
            ct.ThrowIfCancellationRequested(); var date = DateOnly.FromDayNumber(day); int weekday = ((int)date.DayOfWeek + 6) % 7;
            bool matches = rule.Pattern == "weekly" ? (rule.DaysMask & (1 << weekday)) != 0 : ((long)date.DayNumber - rule.AnchorDate!.Value.DayNumber) % rule.IntervalDays!.Value == 0;
            if (!matches || occupied.Contains(date)) continue;
            var occurrence = new OccurrenceRow { UserId = rule.UserId, Id = Guid.NewGuid(), DefinitionId = definition.Id, PlaceId = definition.PlaceId,
                LogicalDate = date, SourceDefinitionVersion = definition.Version };
            var timing = TimingRules.Resolve(snapshot, date, intent, false); TimingRules.Store(occurrence, intent, timing);
            db.Occurrences.Add(occurrence);
            if (await TimingRules.AutoPlace(db, occurrence, timing, ct)) blocks++;
            db.RecurrenceSlots.Add(new RecurrenceSlotRow { UserId = rule.UserId, RuleId = rule.Id, SlotDate = date, OccurrenceId = occurrence.Id });
            created++;
        }
        rule.GeneratedThrough = DateOnly.FromDayNumber(last); rule.Version = Versions.New(); return new(created, blocks);
    }
    public async Task<bool> Generate(string owner, Guid ruleId, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        var plan = await SyncMaintenance.Guard(db, owner, ct);
        var rule = await db.RecurrenceRules.SingleOrDefaultAsync(r => r.UserId == owner && r.Id == ruleId, ct);
        if (rule is null || !rule.Enabled) { await tx.CommitAsync(ct); return false; }
        var definition = await db.Definitions.SingleAsync(d => d.UserId == owner && d.Id == rule.DefinitionId, ct);
        string before = rule.Version; var created = await Scan(rule, definition, clock.GetUtcNow().UtcDateTime, ct);
        if (created is null) { await tx.CommitAsync(ct); return false; }
        if (created.Occurrences > 0) plan.InputRevision = checked(plan.InputRevision + 1);
        if (created.Blocks > 0) plan.ScheduleRevision = checked(plan.ScheduleRevision + 1);
        var reply = Reply(rule, plan); Guid opId = Guid.NewGuid();
        // This literal cannot equal an HTTP SHA-256 fingerprint. Clients cannot impersonate a job.
        db.Operations.Add(new OperationRow { UserId = owner, OpId = opId, Fingerprint = "internal:R1:recurrence:" + rule.Id.ToString("D") + ":" + before,
            Status = 200, Body = reply.Body, ETag = reply.ETag });
        await SyncProjection.Append(db, owner, opId, plan, clock, ct);
        await db.SaveChangesAsync(ct); await tx.CommitAsync(ct); return true;
    }
}
