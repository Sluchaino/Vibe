using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Vibe.Api.Data;
using Vibe.Api.Features.D1;
using Vibe.Api.Features.Recurrence;

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
            && e.Entity is SettingsRow or CategoryRow or DefinitionRow or OccurrenceRow or RecurrenceRuleRow).Select(e => e.Entity).ToArray();
        if (roots.Length == 0) return; // C1 canonical complete/reopen no-op.
        if (roots.Length > 1 && (roots.Length > 32 || roots.Count(r => r is RecurrenceRuleRow) != 1 || roots.Any(r => r is not (RecurrenceRuleRow or OccurrenceRow))))
            throw new InvalidOperationException("Only an R1 generation group may change multiple aggregates.");
        // A committed R1 group always emits rule first, then occurrences by stable slot date.
        roots = roots.OrderBy(r => r is RecurrenceRuleRow ? 0 : 1).ThenBy(r => r is OccurrenceRow o ? o.LogicalDate : DateOnly.MinValue)
            .ThenBy(r => r is OccurrenceRow o ? o.Id : Guid.Empty).ToArray();
        var stream = await db.SyncStreams.SingleAsync(s => s.UserId == owner, ct);
        long finalSequence = checked(stream.LastSequence + roots.Length);
        string planJson = Wire.Json(D1Service.Plan(plan));
        for (int ordinal = 0; ordinal < roots.Length; ordinal++)
        {
        JsonObject item = roots[ordinal] switch
        {
            RecurrenceRuleRow r => Item("recurrence", RecurrenceService.Rule(r)),
            SettingsRow s => Item("settings", D1Service.Settings(s)),
            CategoryRow c => Item("category", D1Service.Category(c)),
            DefinitionRow d => Item("definition", D1Service.Definition(d)),
            OccurrenceRow o => Item("occurrence", D1Service.Occurrence(o)),
            _ => throw new InvalidOperationException()
        };
        db.SyncChanges.Add(new SyncChangeRow
        {
            UserId = owner, StreamId = stream.StreamId, Sequence = checked(stream.LastSequence + ordinal + 1), OpId = opId, Ordinal = ordinal,
            ItemJson = Wire.Json(item), PlanStateJson = planJson, RecordedAtUtc = clock.GetUtcNow().UtcDateTime
        });
        }
        stream.LastSequence = finalSequence;
    }
}
