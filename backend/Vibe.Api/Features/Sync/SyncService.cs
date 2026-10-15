using System.Data;
using System.Globalization;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Npgsql;
using Vibe.Api.Data;
using Vibe.Api.Features.D1;

namespace Vibe.Api.Features.Sync;

public sealed class SyncService(VibeDb db, SyncCursor cursors, TimeProvider clock, IOptions<SyncOptions> options)
{
    readonly SyncOptions limits = options.Value;
    static string Owner(HttpContext ctx) => ctx.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? throw new DomainError(401, "unauthorized");
    static int Size(int? requested, int? inherited = null)
    {
        if (requested is not null && inherited is not null && requested != inherited) throw SyncCursor.Invalid();
        return requested ?? inherited ?? 50;
    }
    static async Task<int?> Query(HttpContext ctx)
    {
        Wire.Query(ctx.Request, "cursor", "pageSize");
        if (ctx.Request.ContentLength > 0 || ctx.Request.Headers.ContainsKey("Transfer-Encoding")
            || ctx.Request.ContentLength is null && await ctx.Request.Body.ReadAsync(new byte[1], ctx.RequestAborted) != 0) Wire.Bad();
        if (!ctx.Request.Query.TryGetValue("pageSize", out var raw)) return null;
        try
        {
            if (ExactNumber.TryRead(JsonNode.Parse(raw.ToString()), out var exact) && exact.TryInt32(out int size) && size is >= 1 and <= 100) return size;
            throw new DomainError(400, "validationFailed");
        }
        catch (JsonException) { Wire.Bad(); throw; }
    }
    static DomainError Busy() => new(503, "syncBootstrapBusy");

    public async Task<ApiReply> Bootstrap(HttpContext ctx)
    {
        string owner = Owner(ctx); int? requested = await Query(ctx); var ct = ctx.RequestAborted;
        if (ctx.Request.Query.TryGetValue("cursor", out var raw))
        {
            var position = cursors.ReadPage(owner, raw.ToString()); Size(requested, position.PageSize);
            await using var read = await db.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
            var snapshot = await db.SyncSnapshots.AsNoTracking().SingleOrDefaultAsync(s => s.UserId == owner && s.Id == position.SnapshotId, ct);
            if (snapshot is null || snapshot.StreamId != position.StreamId || snapshot.ExpiresAtUtc <= clock.GetUtcNow().UtcDateTime) throw new DomainError(410, "snapshotExpired");
            if (snapshot.PageSize != position.PageSize) throw SyncCursor.Invalid();
            var page = await SnapshotPage(owner, snapshot, position.NextOrdinal, ct);
            await read.CommitAsync(ct);
            if (snapshot.ExpiresAtUtc <= clock.GetUtcNow().UtcDateTime) throw new DomainError(410, "snapshotExpired");
            return page;
        }
        int pageSize = Size(requested);
        // Real monotonic cancellation budgets cover SQL, JSON, SaveChanges and Commit.
        using var guardBudget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        guardBudget.CancelAfter(limits.GuardTimeoutMilliseconds);
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        PlanRow plan;
        try { plan = await SyncMaintenance.Guard(db, owner, guardBudget.Token); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw Busy(); }
        catch (PostgresException e) when (e.SqlState is PostgresErrorCodes.LockNotAvailable or PostgresErrorCodes.QueryCanceled) { throw Busy(); }
        using var buildBudget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        buildBudget.CancelAfter(limits.BuildTimeoutMilliseconds);
        var build = buildBudget.Token;
        try
        {
            DateTime now = Milliseconds(clock.GetUtcNow().UtcDateTime);
            await SyncMaintenance.RemoveExpiredSnapshots(db, owner, now, build);
            var stream = await db.SyncStreams.AsNoTracking().SingleAsync(s => s.UserId == owner, build);
            var reusable = await db.SyncSnapshots.AsNoTracking().Where(s => s.UserId == owner && s.StreamId == stream.StreamId
                && s.WatermarkSequence == stream.LastSequence && s.PageSize == pageSize && s.ExpiresAtUtc > now).OrderBy(s => s.CreatedAtUtc).FirstOrDefaultAsync(build);
            if (reusable is not null)
            {
                var reusedPage = await SnapshotPage(owner, reusable, 0, build);
                await tx.CommitAsync(build);
                if (reusable.ExpiresAtUtc <= clock.GetUtcNow().UtcDateTime) throw new DomainError(410, "snapshotExpired");
                return reusedPage;
            }
            if (await db.SyncSnapshots.CountAsync(s => s.UserId == owner, build) >= limits.MaxSnapshotsPerUser) throw new DomainError(429, "syncBootstrapBusy");
            var snapshot = new SyncSnapshotRow
            {
                UserId = owner, StreamId = stream.StreamId, WatermarkSequence = stream.LastSequence,
                PlanStateJson = Wire.Json(D1Service.Plan(plan)), PageSize = pageSize,
                CreatedAtUtc = now, ExpiresAtUtc = now.AddMinutes(limits.BootstrapTtlMinutes),
                AsOfCursor = cursors.Delta(owner, new DeltaPosition(stream.StreamId, stream.LastSequence))
            };
            var rows = new List<SyncSnapshotItemRow>();
            long bytes = Encoding.UTF8.GetByteCount(snapshot.PlanStateJson);
            void Add(JsonObject item)
            {
                build.ThrowIfCancellationRequested();
                if (rows.Count >= limits.MaxSnapshotItems) throw new DomainError(409, "syncSnapshotTooLarge");
                string json = Wire.Json(item); bytes = checked(bytes + Encoding.UTF8.GetByteCount(json));
                if (bytes > limits.MaxSnapshotPayloadBytes) throw new DomainError(409, "syncSnapshotTooLarge");
                rows.Add(new SyncSnapshotItemRow { UserId = owner, SnapshotId = snapshot.Id, Ordinal = rows.Count, ItemJson = json });
            }
            var settings = await db.Settings.AsNoTracking().Include(s => s.Place).SingleAsync(s => s.UserId == owner, build);
            Add(SyncProjection.Item("settings", D1Service.Settings(settings)));
            // Each query reads at most the remaining item budget + 1, never the entire account.
            await foreach (var c in db.Categories.AsNoTracking().Where(c => c.UserId == owner).OrderBy(c => c.Id).Take(limits.MaxSnapshotItems - rows.Count + 1).AsAsyncEnumerable().WithCancellation(build)) Add(SyncProjection.Item("category", D1Service.Category(c)));
            await foreach (var d in db.Definitions.AsNoTracking().Where(d => d.UserId == owner).OrderBy(d => d.Id).Take(limits.MaxSnapshotItems - rows.Count + 1).AsAsyncEnumerable().WithCancellation(build)) Add(SyncProjection.Item("definition", D1Service.Definition(d)));
            await foreach (var o in SyncProjection.Occurrences(db).AsSingleQuery().Where(o => o.UserId == owner).OrderBy(o => o.Id).Take(limits.MaxSnapshotItems - rows.Count + 1).AsAsyncEnumerable().WithCancellation(build)) Add(SyncProjection.Item("occurrence", D1Service.Occurrence(o)));
            db.SyncSnapshots.Add(snapshot); db.SyncSnapshotItems.AddRange(rows);
            await db.SaveChangesAsync(build);
            // Do not reload jsonb: size accounting and the initial page use the same compact JSON.
            var reply = Page(owner, snapshot, rows.Take(pageSize).Select(r => r.ItemJson).ToList(), rows.Count > pageSize ? pageSize : null);
            await tx.CommitAsync(build);
            return reply;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw Busy(); }
        catch (PostgresException e) when (e.SqlState is PostgresErrorCodes.LockNotAvailable or PostgresErrorCodes.QueryCanceled) { throw Busy(); }
        catch (DbUpdateException e) when (!ct.IsCancellationRequested && (build.IsCancellationRequested || e.InnerException is PostgresException { SqlState: PostgresErrorCodes.QueryCanceled })) { throw Busy(); }
    }

    async Task<ApiReply> SnapshotPage(string owner, SyncSnapshotRow snapshot, int start, CancellationToken ct)
    {
        var items = await db.SyncSnapshotItems.AsNoTracking().Where(i => i.UserId == owner && i.SnapshotId == snapshot.Id && i.Ordinal >= start)
            .OrderBy(i => i.Ordinal).Take(snapshot.PageSize + 1).ToListAsync(ct);
        if (items.Count == 0 || items[0].Ordinal != start) throw SyncCursor.Invalid();
        return Page(owner, snapshot, items.Take(snapshot.PageSize).Select(i => i.ItemJson).ToList(), items.Count > snapshot.PageSize ? checked(start + snapshot.PageSize) : null);
    }
    ApiReply Page(string owner, SyncSnapshotRow snapshot, List<string> items, int? next) => ApiReply.Json(new JsonObject
    {
        ["protocol"] = "s1", ["streamId"] = snapshot.StreamId.ToString("D"), ["snapshotId"] = snapshot.Id.ToString("D"),
        ["expiresAt"] = Instant(snapshot.ExpiresAtUtc), ["asOfCursor"] = snapshot.AsOfCursor, ["planState"] = Wire.Obj(snapshot.PlanStateJson),
        ["items"] = new JsonArray(items.Select(j => (JsonNode?)Wire.Obj(j)).ToArray()),
        ["nextPageCursor"] = next is null ? null : cursors.Page(owner, new BootstrapPosition(snapshot.StreamId, snapshot.Id, next.Value, snapshot.PageSize))
    });
    public async Task<ApiReply> Changes(HttpContext ctx)
    {
        string owner = Owner(ctx); int? requested = await Query(ctx); var ct = ctx.RequestAborted;
        if (!ctx.Request.Query.TryGetValue("cursor", out var raw)) Wire.Bad();
        var position = cursors.ReadDelta(owner, raw.ToString()); int pageSize = Size(requested, position.PageSize);
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        var stream = await db.SyncStreams.AsNoTracking().SingleAsync(s => s.UserId == owner, ct);
        if (position.StreamId != stream.StreamId || position.After < stream.PrunedThrough || position.After > stream.LastSequence || position.Horizon > stream.LastSequence)
            throw new DomainError(410, "syncResetRequired");
        long horizon = position.Horizon ?? stream.LastSequence;
        var rows = await db.SyncChanges.AsNoTracking().Where(c => c.UserId == owner && c.StreamId == stream.StreamId && c.Sequence > position.After && c.Sequence <= horizon)
            .OrderBy(c => c.Sequence).Take(pageSize + 1).ToListAsync(ct);
        var emitted = rows.Take(pageSize).ToArray(); bool more = rows.Count > pageSize;
        // A missing prefix indicates damaged/restored stream data; never advance across a hole.
        long expected = position.After;
        foreach (var row in emitted) { if (row.Sequence != checked(expected + 1)) throw new DomainError(410, "syncResetRequired"); expected = row.Sequence; }
        if (!more && expected != horizon) throw new DomainError(410, "syncResetRequired");
        var next = more ? new DeltaPosition(stream.StreamId, expected, horizon, pageSize) : new DeltaPosition(stream.StreamId, horizon);
        var reply = ApiReply.Json(new JsonObject
        {
            ["protocol"] = "s1", ["streamId"] = stream.StreamId.ToString("D"),
            ["changes"] = new JsonArray(emitted.Select(c => (JsonNode?)new JsonObject { ["id"] = c.ChangeId.ToString("D"), ["opId"] = c.OpId.ToString("D"), ["item"] = Wire.Obj(c.ItemJson), ["planState"] = Wire.Obj(c.PlanStateJson) }).ToArray()),
            ["nextCursor"] = cursors.Delta(owner, next), ["hasMore"] = more
        });
        await tx.CommitAsync(ct); return reply;
    }
    public static DateTime Milliseconds(DateTime utc) => new(utc.Ticks - utc.Ticks % TimeSpan.TicksPerMillisecond, DateTimeKind.Utc);
    public static string Instant(DateTime utc) => utc.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
}
