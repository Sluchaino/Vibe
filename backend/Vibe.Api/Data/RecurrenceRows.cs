using Microsoft.EntityFrameworkCore;

namespace Vibe.Api.Data;

public sealed class RecurrenceRuleRow
{
    public string UserId { get; set; } = "";
    public Guid Id { get; set; }
    public Guid DefinitionId { get; set; }
    public int DaysMask { get; set; }
    public string Pattern { get; set; } = "weekly";
    public int? IntervalDays { get; set; }
    public DateOnly? AnchorDate { get; set; }
    public string? TimeIntentJson { get; set; }
    public string Timezone { get; set; } = "";
    public DateOnly StartDate { get; set; }
    public DateOnly? EndDate { get; set; }
    // Fixed local lower bound: a backdated start never backfills before rule creation.
    public DateOnly GenerationStartDate { get; set; }
    public bool Enabled { get; set; } = true;
    public DateOnly? GeneratedThrough { get; set; }
    public string Version { get; set; } = Versions.New();
}

public sealed class RecurrenceSlotRow
{
    public string UserId { get; set; } = "";
    public Guid RuleId { get; set; }
    public DateOnly SlotDate { get; set; }
    public Guid OccurrenceId { get; set; }
}

internal static class RecurrenceModel
{
    public static void Configure(ModelBuilder b)
    {
        b.Entity<RecurrenceRuleRow>().ToTable("RecurrenceRules", t =>
        {
            t.HasCheckConstraint("CK_RecurrenceRule_Days", "(\"Pattern\" = 'weekly' AND \"DaysMask\" BETWEEN 1 AND 127 AND \"IntervalDays\" IS NULL AND \"AnchorDate\" IS NULL) OR (\"Pattern\" = 'interval' AND \"DaysMask\" = 0 AND \"IntervalDays\" > 0 AND \"IntervalDays\" IS NOT NULL AND \"AnchorDate\" IS NOT NULL AND \"StartDate\" = \"AnchorDate\")");
            t.HasCheckConstraint("CK_RecurrenceRule_Dates", "(\"EndDate\" IS NULL OR \"EndDate\" >= \"StartDate\") AND \"GenerationStartDate\" >= \"StartDate\" AND (\"GeneratedThrough\" IS NULL OR (\"GeneratedThrough\" >= \"GenerationStartDate\" AND (\"EndDate\" IS NULL OR \"GeneratedThrough\" <= \"EndDate\")))");
        });
        b.Entity<RecurrenceRuleRow>().HasKey(r => new { r.UserId, r.Id });
        b.Entity<RecurrenceRuleRow>().Property(r => r.Pattern).HasDefaultValue("weekly");
        b.Entity<RecurrenceRuleRow>().Property(r => r.TimeIntentJson).HasColumnType("jsonb");
        b.Entity<RecurrenceRuleRow>().HasIndex(r => new { r.UserId, r.DefinitionId }).IsUnique();
        b.Entity<RecurrenceRuleRow>().HasIndex(r => new { r.UserId, r.Enabled, r.Id });
        b.Entity<RecurrenceRuleRow>().HasOne<DefinitionRow>().WithMany().HasForeignKey(r => new { r.UserId, r.DefinitionId }).OnDelete(DeleteBehavior.Restrict);
        b.Entity<RecurrenceSlotRow>().ToTable("RecurrenceSlots");
        b.Entity<RecurrenceSlotRow>().HasKey(s => new { s.UserId, s.RuleId, s.SlotDate });
        b.Entity<RecurrenceSlotRow>().HasIndex(s => new { s.UserId, s.OccurrenceId }).IsUnique();
        b.Entity<RecurrenceSlotRow>().HasOne<RecurrenceRuleRow>().WithMany().HasForeignKey(s => new { s.UserId, s.RuleId }).OnDelete(DeleteBehavior.Restrict);
        b.Entity<RecurrenceSlotRow>().HasOne<OccurrenceRow>().WithMany().HasForeignKey(s => new { s.UserId, s.OccurrenceId }).OnDelete(DeleteBehavior.Restrict);
    }
}
