using System.Data;
using System.Globalization;
using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Vibe.Api.Data;

namespace Vibe.Api.Features.D1;

public sealed record ApiReply(int Status, string Body, string? ETag = null, string? Location = null, bool? Replayed = null) : IResult
{
    public async Task ExecuteAsync(HttpContext context)
    {
        context.Response.StatusCode = Status;
        context.Response.Headers.CacheControl = "no-store";
        if (ETag is not null) context.Response.Headers.ETag = ETag;
        if (Location is not null) context.Response.Headers.Location = Location;
        if (Replayed is not null) context.Response.Headers["Idempotency-Replayed"] = Replayed.Value ? "true" : "false";
        if (Status == 204) return;
        context.Response.ContentType = Status >= 400 ? "application/problem+json" : "application/json";
        await context.Response.WriteAsync(Body, context.RequestAborted);
    }
    public static ApiReply Json(JsonObject body, int status = 200, string? version = null, string? location = null) => new(status, Wire.Json(body), version is null ? null : Quote(version), location);
    public static string Quote(string version) => "\"" + version + "\"";
}

public sealed class D1Service(VibeDb db, IDataProtectionProvider protection, TimeProvider clock)
{
    static readonly string[] ConstraintKeys = ["durationPolicy", "splitAllowed", "mobilityPolicy", "availabilityRules", "placeId", "requiredRestMinutes"];
    static string Owner(HttpContext c) => c.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? throw new DomainError(401, "unauthorized");
    static JsonObject Plan(PlanRow p) => new() { ["planningInputRevision"] = "input_" + p.InputRevision.ToString("x", CultureInfo.InvariantCulture), ["scheduleVersion"] = "schedule_" + p.ScheduleRevision.ToString("x", CultureInfo.InvariantCulture) };
    public static JsonObject Settings(SettingsRow s) => new() { ["timezone"] = s.Timezone, ["weekStartsOn"] = "monday", ["place"] = s.Place is null ? null : new JsonObject { ["id"] = s.Place.Id.ToString("D"), ["name"] = s.Place.Name, ["serverVersion"] = s.Place.Version }, ["serverVersion"] = s.Version };
    static JsonObject Category(CategoryRow c) => new() { ["id"] = c.Id.ToString("D"), ["name"] = c.Name, ["serverVersion"] = c.Version };
    public static JsonObject Definition(DefinitionRow d) { var result = Wire.Obj(d.FieldsJson); result["id"] = d.Id.ToString("D"); result["serverVersion"] = d.Version; return result; }
    public static JsonObject Block(BlockRow b) => new() { ["id"] = b.Id.ToString("D"), ["occurrenceId"] = b.OccurrenceId.ToString("D"), ["kind"] = "task", ["startInstant"] = TimeRules.Instant(b.Start), ["endInstant"] = TimeRules.Instant(b.End), ["fixed"] = b.Fixed, ["serverVersion"] = b.Version };
    static CompletionRow? Active(OccurrenceRow o) => o.Completions.SingleOrDefault(c => c.RevokedAtUtc is null);
    static string FactInstant(DateTime value) => value.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
    public static JsonObject Completion(CompletionRow c) => new()
    {
        ["id"] = c.Id.ToString("D"), ["occurrenceId"] = c.OccurrenceId.ToString("D"),
        ["completedAt"] = FactInstant(c.CompletedAtUtc),
        ["revokedAt"] = c.RevokedAtUtc is DateTime revoked ? JsonValue.Create(FactInstant(revoked)) : null,
        ["source"] = c.Source, ["serverVersion"] = c.Version
    };
    public static JsonObject Occurrence(OccurrenceRow o)
    {
        var snapshot = Wire.Obj(o.SnapshotJson);
        var active = Active(o);
        return new JsonObject { ["id"] = o.Id.ToString("D"), ["definitionId"] = o.DefinitionId.ToString("D"), ["logicalDate"] = o.LogicalDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), ["sourceDefinitionVersion"] = o.SourceDefinitionVersion, ["constraintsSnapshot"] = snapshot, ["remainingWorkMinutes"] = active is null ? Wire.Int(snapshot["durationPolicy"]!, "requiredWorkMinutes") : 0, ["placementStatus"] = o.Block is null ? "unplanned" : "planned", ["calendarBlock"] = o.Block is null ? null : Block(o.Block), ["serverVersion"] = o.Version, ["completionStatus"] = active is null ? "incomplete" : "completed", ["completion"] = active is null ? null : Completion(active) };
    }
    static JsonObject Envelope(string key, JsonObject value, PlanRow p) => new() { [key] = value, ["planState"] = Plan(p) };
    static Guid RouteId(string? value) { if (!Wire.TryUuid(value, out var id)) Wire.Bad(); return id; }
    static void Name(JsonNode node, string key) { if (string.IsNullOrWhiteSpace(Wire.Str(node, key))) Wire.Bad(); }
    static JsonObject Snapshot(JsonNode fields) { var result = new JsonObject(); foreach (var key in ConstraintKeys) result[key] = fields[key]!.DeepClone(); return result; }
    static JsonObject Fields(JsonObject body) { var fields = body.DeepClone().AsObject(); fields.Remove("opId"); fields.Remove("id"); return fields; }
    static void Match(HttpContext c, string version, string field, JsonObject current)
    {
        var raw = c.Request.Headers["If-Match"];
        if (raw.Count == 0) throw new DomainError(428, "preconditionRequired");
        if (raw.Count != 1 || !Wire.Pattern(raw[0]!, "^\"[A-Za-z0-9_-]{1,200}\"$")) Wire.Bad();
        if (raw[0] != ApiReply.Quote(version)) throw new DomainError(412, "staleEntity", new JsonObject { ["currentServerVersion"] = version, [field] = current }, ApiReply.Quote(version));
    }
    async Task<SettingsRow> UserSettings(string owner, CancellationToken ct) => await db.Settings.Include(x => x.Place).SingleAsync(x => x.UserId == owner, ct);
    async Task<DefinitionRow> FindDefinition(string owner, Guid id, CancellationToken ct, string errorCode = "notFound") => await db.Definitions.SingleOrDefaultAsync(x => x.UserId == owner && x.Id == id, ct) ?? throw new DomainError(404, errorCode);
    IQueryable<OccurrenceRow> CurrentOccurrences() => db.Occurrences.Include(x => x.Block).Include(x => x.Completions.Where(c => c.RevokedAtUtc == null));
    async Task<OccurrenceRow> FindOccurrence(string owner, Guid id, CancellationToken ct) => await CurrentOccurrences().SingleOrDefaultAsync(x => x.UserId == owner && x.Id == id, ct) ?? throw new DomainError(404, "notFound");
    static DomainError CompletionConflict(string code, OccurrenceRow o) => new(409, code, new JsonObject { ["currentServerVersion"] = o.Version, ["currentOccurrence"] = Occurrence(o) }, ApiReply.Quote(o.Version));
    DateTime AcceptedAt()
    {
        var utc = clock.GetUtcNow().UtcDateTime;
        return new DateTime(utc.Ticks - utc.Ticks % TimeSpan.TicksPerMillisecond, DateTimeKind.Utc);
    }
    async Task<ApiReply> ToggleCompletion(string owner, OccurrenceRow o, PlanRow p, JsonObject body, string kind, CancellationToken ct)
    {
        var active = Active(o);
        if (kind == "complete")
        {
            if (active is null)
            {
                var context = new JsonObject { ["logicalDate"] = o.LogicalDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), ["sourceDefinitionVersion"] = o.SourceDefinitionVersion, ["constraintsSnapshot"] = Wire.Obj(o.SnapshotJson) };
                var fact = new CompletionRow { UserId = owner, Id = Guid.NewGuid(), OccurrenceId = o.Id, CompletedAtUtc = AcceptedAt(), OccurrenceSnapshotJson = Wire.Json(context) };
                db.Completions.Add(fact);
                if (!o.Completions.Contains(fact)) o.Completions.Add(fact);
                o.Version = Versions.New(); p.InputRevision++;
            }
        }
        else
        {
            var completionId = Wire.Id(body, "completionId");
            var target = await db.Completions.SingleOrDefaultAsync(c => c.UserId == owner && c.OccurrenceId == o.Id && c.Id == completionId, ct)
                ?? throw new DomainError(404, "referenceNotFound");
            if (target.RevokedAtUtc is not null)
            {
                if (active is not null) throw CompletionConflict("completionMismatch", o);
            }
            else
            {
                target.RevokedAtUtc = AcceptedAt(); target.Version = Versions.New();
                o.Version = Versions.New(); p.InputRevision++;
            }
        }
        return ApiReply.Json(Envelope("occurrence", Occurrence(o), p), version: o.Version);
    }
    async Task References(string owner, JsonNode fields, bool definition, CancellationToken ct)
    {
        var place = Wire.Id(fields, "placeId");
        if (!await db.Places.AnyAsync(x => x.UserId == owner && x.Id == place, ct)) throw new DomainError(404, "referenceNotFound");
        if (definition && fields["categoryId"] is not null)
        {
            var category = Wire.Id(fields, "categoryId");
            if (!await db.Categories.AnyAsync(x => x.UserId == owner && x.Id == category, ct)) throw new DomainError(404, "referenceNotFound");
        }
        TimeRules.ValidateAvailability(fields["availabilityRules"]!);
    }
    public async Task<ApiReply> Mutate(HttpContext ctx, string kind, string? route = null)
    {
        string owner = Owner(ctx); var ct = ctx.RequestAborted;
        var body = await Wire.Parse(ctx.Request, ct);
        if (body["opId"] is not JsonValue op || !op.TryGetValue<string>(out var raw) || !Wire.TryUuid(raw, out _)) Wire.Bad();
        Guid operationId = Guid.Parse(body["opId"]!.GetValue<string>());
        string fingerprint = Wire.Fingerprint(ctx.Request, body);
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        var plan = await db.Plans.FromSqlInterpolated($"SELECT * FROM \"UserPlanState\" WHERE \"UserId\" = {owner} FOR UPDATE").SingleAsync(ct);
        var previous = await db.Operations.SingleOrDefaultAsync(x => x.UserId == owner && x.OpId == operationId, ct);
        if (previous is not null)
        {
            await transaction.CommitAsync(ct);
            if (previous.Fingerprint != fingerprint) return ApiReply.Json(Wire.Problem(ctx, new DomainError(409, "idempotencyMismatch")), 409) with { Replayed = false };
            return new ApiReply(previous.Status, previous.Body, previous.ETag, previous.Location, true);
        }
        ApiReply reply;
        try
        {
            Wire.Query(ctx.Request);
            string schema = kind switch { "settings" => "UpdateSettingsRequest", "category" => "CreateCategoryRequest", "createDefinition" => "CreateDefinitionRequest", "updateDefinition" => "UpdateDefinitionRequest", "createOccurrence" => "CreateOccurrenceRequest", "updateOccurrence" => "UpdateOccurrenceRequest", "placement" => "PlacementCommand", "complete" => "CompleteOccurrenceRequest", "reopen" => "ReopenOccurrenceRequest", _ => throw new InvalidOperationException() };
            Wire.Validate(body, schema);
            // PostgreSQL jsonb has narrower exponent syntax than mathematical JSON numbers.
            // All approved numeric fields are Int32; persist their exact value after fingerprinting.
            Wire.NormalizeIntegers(body);
            reply = await Apply(ctx, owner, plan, body, kind, route, ct);
        }
        catch (DomainError error)
        {
            // Domain validation precedes tracked modifications. An error never persists partial entities/revisions.
            db.ChangeTracker.Clear();
            reply = new ApiReply(error.Status, Wire.Json(Wire.Problem(ctx, error)), error.ETag);
        }
        db.Operations.Add(new OperationRow { UserId = owner, OpId = operationId, Fingerprint = fingerprint, Status = reply.Status, Body = reply.Body, ETag = reply.ETag, Location = reply.Location });
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        return reply with { Replayed = false };
    }
    async Task<ApiReply> Apply(HttpContext ctx, string owner, PlanRow p, JsonObject b, string kind, string? route, CancellationToken ct)
    {
        if (kind == "settings")
        {
            var s = await UserSettings(owner, ct); var place = b["place"]!;
            Name(place, "name"); TimeRules.Zone(Wire.Str(b, "timezone"));
            Guid id = Wire.Id(place, "id");
            if (s.Place is not null && s.Place.Id != id)
                Wire.Bad("unsupportedConstraint");
            Match(ctx, s.Version, "currentSettings", Settings(s));
            s.Place ??= new PlaceRow { UserId = owner, Id = id };
            s.Place.Name = Wire.Str(place, "name"); s.Place.Version = Versions.New();
            s.Timezone = Wire.Str(b, "timezone"); s.Version = Versions.New(); p.InputRevision++;
            return ApiReply.Json(Envelope("settings", Settings(s), p), version: s.Version);
        }
        if (kind == "category")
        {
            Name(b, "name"); var id = Wire.Id(b, "id");
            if (await db.Categories.AnyAsync(x => x.UserId == owner && x.Id == id, ct)) throw new DomainError(409, "idUnavailable");
            var c = new CategoryRow { UserId = owner, Id = id, Name = Wire.Str(b, "name") }; db.Categories.Add(c);
            return ApiReply.Json(Envelope("category", Category(c), p), 201, c.Version);
        }
        if (kind is "createDefinition" or "updateDefinition")
        {
            Name(b, "title"); await References(owner, b, true, ct);
            Guid id = kind == "createDefinition" ? Wire.Id(b, "id") : RouteId(route);
            DefinitionRow d;
            if (kind == "createDefinition")
            {
                if (await db.Definitions.AnyAsync(x => x.UserId == owner && x.Id == id, ct)) throw new DomainError(409, "idUnavailable");
                d = new DefinitionRow { UserId = owner, Id = id }; db.Definitions.Add(d);
            }
            else { d = await FindDefinition(owner, id, ct); Match(ctx, d.Version, "currentDefinition", Definition(d)); }
            d.CategoryId = b["categoryId"] is null ? null : Wire.Id(b, "categoryId"); d.PlaceId = Wire.Id(b, "placeId");
            d.FieldsJson = Wire.Json(Fields(b)); d.Version = Versions.New(); p.InputRevision++;
            return ApiReply.Json(Envelope("definition", Definition(d), p), kind == "createDefinition" ? 201 : 200, d.Version, kind == "createDefinition" ? "/api/v1/task-definitions/" + id.ToString("D") : null);
        }
        if (kind == "createOccurrence")
        {
            var d = await FindDefinition(owner, RouteId(route), ct); var date = TimeRules.Date(Wire.Str(b, "logicalDate"));
            if (d.Version != Wire.Str(b, "definitionVersion")) throw new DomainError(412, "staleDefinition", new JsonObject { ["currentServerVersion"] = d.Version, ["currentDefinition"] = Definition(d) }, ApiReply.Quote(d.Version));
            var id = Wire.Id(b, "id"); if (await db.Occurrences.AnyAsync(x => x.UserId == owner && x.Id == id, ct)) throw new DomainError(409, "idUnavailable");
            var occurrence = new OccurrenceRow { UserId = owner, Id = id, DefinitionId = d.Id, PlaceId = d.PlaceId, LogicalDate = date, SourceDefinitionVersion = d.Version, SnapshotJson = Wire.Json(Snapshot(Wire.Obj(d.FieldsJson))) };
            db.Occurrences.Add(occurrence); p.InputRevision++;
            return ApiReply.Json(Envelope("occurrence", Occurrence(occurrence), p), 201, occurrence.Version, "/api/v1/occurrences/" + id.ToString("D"));
        }
        var o = await FindOccurrence(owner, RouteId(route), ct);
        if (kind is "complete" or "reopen")
        {
            Match(ctx, o.Version, "currentOccurrence", Occurrence(o));
            return await ToggleCompletion(owner, o, p, b, kind, ct);
        }
        if (Active(o) is not null)
        {
            Match(ctx, o.Version, "currentOccurrence", Occurrence(o));
            throw CompletionConflict("occurrenceCompleted", o);
        }
        if (kind == "updateOccurrence")
        {
            var snapshot = b["constraintsSnapshot"]!;
            await References(owner, snapshot, false, ct); var date = TimeRules.Date(Wire.Str(b, "logicalDate"));
            Match(ctx, o.Version, "currentOccurrence", Occurrence(o));
            if (o.Block is not null)
            {
                var old = Wire.Obj(o.SnapshotJson);
                if (Wire.Str(old, "mobilityPolicy") == "fixedAfterPlacement" && Wire.Str(snapshot, "mobilityPolicy") == "movable" && !Wire.Bool(b, "allowFixedChange")) throw new DomainError(409, "fixedChangeRequiresConfirmation");
                if ((o.Block.End - o.Block.Start).TotalMinutes != Wire.Int(snapshot["durationPolicy"]!, "requiredWorkMinutes")) throw new DomainError(409, "invalidExistingPlacement");
                try { TimeRules.CheckAvailability(snapshot["availabilityRules"]!, o.Block.Start, o.Block.End, ct); }
                catch (DomainError) { throw new DomainError(409, "invalidExistingPlacement"); }
            }
            o.LogicalDate = date; o.PlaceId = Wire.Id(snapshot, "placeId"); o.SnapshotJson = Wire.Json(snapshot); o.Version = Versions.New(); p.InputRevision++;
            return ApiReply.Json(Envelope("occurrence", Occurrence(o), p), version: o.Version);
        }
        Match(ctx, o.Version, "currentOccurrence", Occurrence(o));
        if (Wire.Str(b, "baseScheduleVersion") != Wire.Str(Plan(p), "scheduleVersion")) throw new DomainError(409, "staleSchedule", new JsonObject { ["currentPlanState"] = Plan(p) });
        string action = Wire.Str(b, "action"); var block = o.Block;
        if (action == "place" ? block is not null : block is null) throw new DomainError(409, "invalidPlacementState");
        var saved = Wire.Obj(o.SnapshotJson);
        bool effectiveFixed = block is not null && (block.Fixed || Wire.Str(saved, "mobilityPolicy") == "fixedAfterPlacement");
        if (!Wire.Bool(b, "allowFixedChange") && ((action is "move" or "unplace") && effectiveFixed || action == "setFixed" && block!.Fixed && !Wire.Bool(b, "fixed"))) throw new DomainError(409, "fixedChangeRequiresConfirmation");
        if (action is "place" or "move")
        {
            var start = TimeRules.Resolve(TimeRules.Local(Wire.Str(b, "localStart")), TimeRules.Zone(Wire.Str(b, "timezone")), Wire.Str(b, "utcOffset"));
            DateTime end; try { end = start.AddMinutes(Wire.Int(saved["durationPolicy"]!, "requiredWorkMinutes")); } catch (ArgumentOutOfRangeException) { Wire.Bad(); throw; }
            TimeRules.CheckAvailability(saved["availabilityRules"]!, start, end, ct);
            var conflicts = await db.Blocks.Where(x => x.UserId == owner && x.OccurrenceId != o.Id && x.Start < end && x.End > start).Select(x => x.Id).ToArrayAsync(ct);
            if (conflicts.Length != 0) throw new DomainError(409, "placementConflict", new JsonObject { ["conflictingBlockIds"] = new JsonArray(conflicts.Select(id => (JsonNode?)JsonValue.Create(id.ToString("D"))).ToArray()) });
            if (block is null) { block = new BlockRow { UserId = owner, Id = Guid.NewGuid(), OccurrenceId = o.Id }; db.Blocks.Add(block); o.Block = block; }
            block.Start = start; block.End = end; block.Version = Versions.New();
        }
        else if (action == "setFixed") { block!.Fixed = Wire.Bool(b, "fixed"); block.Version = Versions.New(); }
        else { db.Blocks.Remove(block!); o.Block = null; }
        o.Version = Versions.New(); p.InputRevision++; p.ScheduleRevision++;
        return ApiReply.Json(Envelope("occurrence", Occurrence(o), p), version: o.Version);
    }
    public async Task<ApiReply> Read(HttpContext ctx, string kind, string? route = null)
    {
        string owner = Owner(ctx); var ct = ctx.RequestAborted;
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        var plan = await db.Plans.AsNoTracking().SingleAsync(x => x.UserId == owner, ct);
        ApiReply reply;
        if (kind == "settings") { Wire.Query(ctx.Request); var s = await UserSettings(owner, ct); reply = ApiReply.Json(Envelope("settings", Settings(s), plan), version: s.Version); }
        else if (kind == "definition") { Wire.Query(ctx.Request); var d = await FindDefinition(owner, RouteId(route), ct); reply = ApiReply.Json(Envelope("definition", Definition(d), plan), version: d.Version); }
        else if (kind == "occurrence") { Wire.Query(ctx.Request); var o = await FindOccurrence(owner, RouteId(route), ct); reply = ApiReply.Json(Envelope("occurrence", Occurrence(o), plan), version: o.Version); }
        else if (kind == "calendar")
        {
            Wire.Query(ctx.Request, "from", "to");
            if (!ctx.Request.Query.ContainsKey("from") || !ctx.Request.Query.ContainsKey("to")) Wire.Bad();
            var from = TimeRules.Utc(ctx.Request.Query["from"].ToString()); var to = TimeRules.Utc(ctx.Request.Query["to"].ToString());
            var settings = await UserSettings(owner, ct); TimeRules.CalendarRange(from, to, settings.Timezone);
            var blocks = await db.Blocks.Where(x => x.UserId == owner && x.Start < to && x.End > from).OrderBy(x => x.Start).ThenBy(x => x.Id).ToArrayAsync(ct);
            var ids = blocks.Select(x => x.OccurrenceId).ToArray();
            var occurrences = await CurrentOccurrences().Where(x => x.UserId == owner && ids.Contains(x.Id)).OrderBy(x => x.Id).ToArrayAsync(ct);
            var definitionIds = occurrences.Select(x => x.DefinitionId).Distinct().ToArray();
            var definitions = await db.Definitions.Where(x => x.UserId == owner && definitionIds.Contains(x.Id)).OrderBy(x => x.Id).ToArrayAsync(ct);
            reply = ApiReply.Json(new JsonObject { ["from"] = TimeRules.Instant(from), ["to"] = TimeRules.Instant(to), ["blocks"] = Array(blocks.Select(Block)), ["occurrences"] = Array(occurrences.Select(Occurrence)), ["definitions"] = Array(definitions.Select(Definition)), ["planState"] = Plan(plan) });
        }
        else reply = await Page(ctx, kind, owner, plan, ct);
        await tx.CommitAsync(ct); return reply;
    }
    static JsonArray Array(IEnumerable<JsonObject> objects) => new(objects.Select(o => (JsonNode?)o).ToArray());
    async Task<ApiReply> Page(HttpContext ctx, string kind, string owner, PlanRow plan, CancellationToken ct)
    {
        var q = ctx.Request.Query;
        if (kind == "occurrences") Wire.Query(ctx.Request, "pageSize", "cursor", "definitionId", "logicalDateFrom", "logicalDateTo", "placementStatus", "completionStatus");
        else Wire.Query(ctx.Request, "pageSize", "cursor");
        int size = 50;
        if (q.ContainsKey("pageSize") && (!int.TryParse(q["pageSize"], NumberStyles.None, CultureInfo.InvariantCulture, out size) || size < 1 || size > 100)) Wire.Bad();
        string filter = JsonSerializer.Serialize(q.Where(x => x.Key != "cursor").OrderBy(x => x.Key).Select(x => new { x.Key, value = x.Value.ToString() }));
        var protector = protection.CreateProtector("Vibe.D1.Cursor", owner, kind, filter);
        Guid? after = null;
        if (q.ContainsKey("cursor"))
        {
            try { if (q["cursor"].ToString().Length > 2000) throw new FormatException(); after = Guid.ParseExact(protector.Unprotect(q["cursor"].ToString()), "D"); }
            catch (Exception ex) when (ex is System.Security.Cryptography.CryptographicException or FormatException or ArgumentException) { throw new DomainError(400, "invalidCursor"); }
        }
        JsonObject[] items; Guid[] ids;
        if (kind == "categories")
        {
            var query = db.Categories.Where(x => x.UserId == owner); if (after is Guid a) query = query.Where(x => x.Id.CompareTo(a) > 0);
            var rows = await query.OrderBy(x => x.Id).Take(size + 1).ToArrayAsync(ct); ids = rows.Select(x => x.Id).ToArray(); items = rows.Select(Category).ToArray();
        }
        else if (kind == "definitions")
        {
            var query = db.Definitions.Where(x => x.UserId == owner); if (after is Guid a) query = query.Where(x => x.Id.CompareTo(a) > 0);
            var rows = await query.OrderBy(x => x.Id).Take(size + 1).ToArrayAsync(ct); ids = rows.Select(x => x.Id).ToArray(); items = rows.Select(Definition).ToArray();
        }
        else
        {
            var query = CurrentOccurrences().Where(x => x.UserId == owner);
            if (q.ContainsKey("definitionId")) { var id = RouteId(q["definitionId"]); await FindDefinition(owner, id, ct, "referenceNotFound"); query = query.Where(x => x.DefinitionId == id); }
            DateOnly? from = q.ContainsKey("logicalDateFrom") ? TimeRules.Date(q["logicalDateFrom"].ToString()) : null;
            DateOnly? to = q.ContainsKey("logicalDateTo") ? TimeRules.Date(q["logicalDateTo"].ToString()) : null;
            if (from >= to) Wire.Bad();
            if (from is DateOnly f) query = query.Where(x => x.LogicalDate >= f);
            if (to is DateOnly t) query = query.Where(x => x.LogicalDate < t);
            if (q.ContainsKey("placementStatus")) { string status = q["placementStatus"].ToString(); if (status is not ("planned" or "unplanned")) Wire.Bad(); query = status == "planned" ? query.Where(x => x.Block != null) : query.Where(x => x.Block == null); }
            if (q.ContainsKey("completionStatus"))
            {
                string status = q["completionStatus"].ToString();
                if (status is not ("completed" or "incomplete")) Wire.Bad();
                query = status == "completed" ? query.Where(x => x.Completions.Any(c => c.RevokedAtUtc == null)) : query.Where(x => !x.Completions.Any(c => c.RevokedAtUtc == null));
            }
            if (after is Guid a) query = query.Where(x => x.Id.CompareTo(a) > 0);
            var rows = await query.OrderBy(x => x.Id).Take(size + 1).ToArrayAsync(ct); ids = rows.Select(x => x.Id).ToArray(); items = rows.Select(Occurrence).ToArray();
        }
        string? cursor = items.Length > size ? protector.Protect(ids[size - 1].ToString("D")) : null;
        return ApiReply.Json(new JsonObject { ["items"] = Array(items.Take(size)), ["nextCursor"] = cursor, ["planState"] = Plan(plan) });
    }
}
