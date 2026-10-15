using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Vibe.Api.Data;
using Vibe.Api.Features.D1;

namespace Vibe.Api.Features.Sync;

public static class SyncProjection
{
    public static JsonObject Item(string kind, JsonObject value) => new() { ["kind"] = kind, ["value"] = value };
    public static IQueryable<OccurrenceRow> Occurrences(VibeDb db) => db.Occurrences.AsNoTracking().Include(o => o.Block)
        .Include(o => o.Completions.Where(c => c.RevokedAtUtc == null));

    // Caller owns UserPlanState FOR UPDATE. Projection failure rolls back the entire command.
    public static async Task Append(VibeDb db, string owner, Guid opId, PlanRow plan, TimeProvider clock, CancellationToken ct)
    {
        db.ChangeTracker.DetectChanges();
        var roots = db.ChangeTracker.Entries().Where(e => (e.State is EntityState.Added or EntityState.Modified)
            && e.Entity is SettingsRow or CategoryRow or DefinitionRow or OccurrenceRow).ToArray();
        if (roots.Length == 0) return; // C1 canonical complete/reopen no-op.
        if (roots.Length != 1) throw new InvalidOperationException("S1 commands must change one aggregate.");
        JsonObject item = roots[0].Entity switch
        {
            SettingsRow s => Item("settings", D1Service.Settings(s)),
            CategoryRow c => Item("category", D1Service.Category(c)),
            DefinitionRow d => Item("definition", D1Service.Definition(d)),
            OccurrenceRow o => Item("occurrence", D1Service.Occurrence(o)),
            _ => throw new InvalidOperationException()
        };
        var stream = await db.SyncStreams.SingleAsync(s => s.UserId == owner, ct);
        long sequence = checked(stream.LastSequence + 1);
        string itemJson = Wire.Json(item), planJson = Wire.Json(D1Service.Plan(plan));
        db.SyncChanges.Add(new SyncChangeRow
        {
            UserId = owner, StreamId = stream.StreamId, Sequence = sequence, OpId = opId,
            ItemJson = itemJson, PlanStateJson = planJson, RecordedAtUtc = clock.GetUtcNow().UtcDateTime
        });
        stream.LastSequence = sequence;
    }
}
