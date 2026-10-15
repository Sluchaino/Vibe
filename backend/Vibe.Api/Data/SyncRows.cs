using Microsoft.EntityFrameworkCore;

namespace Vibe.Api.Data;

public sealed class SyncStreamRow
{
    public string UserId { get; set; } = "";
    public Guid StreamId { get; set; } = Guid.NewGuid();
    public long LastSequence { get; set; }
    public long PrunedThrough { get; set; }
}
public sealed class SyncChangeRow
{
    public string UserId { get; set; } = "";
    public Guid StreamId { get; set; }
    public long Sequence { get; set; }
    public Guid ChangeId { get; set; } = Guid.NewGuid();
    public Guid OpId { get; set; }
    public string ItemJson { get; set; } = "{}";
    public string PlanStateJson { get; set; } = "{}";
    public DateTime RecordedAtUtc { get; set; }
}
public sealed class SyncSnapshotRow
{
    public string UserId { get; set; } = "";
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid StreamId { get; set; }
    public long WatermarkSequence { get; set; }
    public string PlanStateJson { get; set; } = "{}";
    public string AsOfCursor { get; set; } = "";
    public int PageSize { get; set; }
    public DateTime CreatedAtUtc { get; set; }
    public DateTime ExpiresAtUtc { get; set; }
}
public sealed class SyncSnapshotItemRow
{
    public string UserId { get; set; } = "";
    public Guid SnapshotId { get; set; }
    public int Ordinal { get; set; }
    public string ItemJson { get; set; } = "{}";
}
internal static class SyncModel
{
    public static void Configure(ModelBuilder b)
    {
        b.Entity<SyncStreamRow>().ToTable("SyncStreams", t => t.HasCheckConstraint("CK_SyncStream_Range", "\"LastSequence\" >= 0 AND \"PrunedThrough\" >= 0 AND \"PrunedThrough\" <= \"LastSequence\""));
        b.Entity<SyncStreamRow>().HasKey(x => x.UserId);
        b.Entity<SyncStreamRow>().HasAlternateKey(x => new { x.UserId, x.StreamId });
        b.Entity<SyncStreamRow>().HasOne<VibeUser>().WithOne().HasForeignKey<SyncStreamRow>(x => x.UserId).OnDelete(DeleteBehavior.Restrict);
        b.Entity<SyncChangeRow>().ToTable("SyncChanges", t => t.HasCheckConstraint("CK_SyncChange_PositiveSequence", "\"Sequence\" > 0"));
        b.Entity<SyncChangeRow>().HasKey(x => new { x.UserId, x.StreamId, x.Sequence });
        b.Entity<SyncChangeRow>().HasIndex(x => new { x.UserId, x.StreamId, x.ChangeId }).IsUnique();
        b.Entity<SyncChangeRow>().HasIndex(x => new { x.UserId, x.StreamId, x.OpId }).IsUnique();
        b.Entity<SyncChangeRow>().Property(x => x.ItemJson).HasColumnType("jsonb");
        b.Entity<SyncChangeRow>().Property(x => x.PlanStateJson).HasColumnType("jsonb");
        b.Entity<SyncChangeRow>().HasOne<SyncStreamRow>().WithMany().HasForeignKey(x => new { x.UserId, x.StreamId }).HasPrincipalKey(x => new { x.UserId, x.StreamId }).OnDelete(DeleteBehavior.Restrict);
        b.Entity<SyncChangeRow>().HasOne<OperationRow>().WithMany().HasForeignKey(x => new { x.UserId, x.OpId }).OnDelete(DeleteBehavior.Restrict);
        b.Entity<SyncSnapshotRow>().ToTable("SyncSnapshots", t => t.HasCheckConstraint("CK_SyncSnapshot_Range", "\"WatermarkSequence\" >= 0 AND \"PageSize\" BETWEEN 1 AND 100 AND \"ExpiresAtUtc\" > \"CreatedAtUtc\""));
        b.Entity<SyncSnapshotRow>().HasKey(x => new { x.UserId, x.Id });
        b.Entity<SyncSnapshotRow>().Property(x => x.PlanStateJson).HasColumnType("jsonb");
        b.Entity<SyncSnapshotRow>().HasIndex(x => new { x.UserId, x.ExpiresAtUtc, x.WatermarkSequence });
        b.Entity<SyncSnapshotRow>().HasOne<SyncStreamRow>().WithMany().HasForeignKey(x => new { x.UserId, x.StreamId }).HasPrincipalKey(x => new { x.UserId, x.StreamId }).OnDelete(DeleteBehavior.Restrict);
        b.Entity<SyncSnapshotItemRow>().ToTable("SyncSnapshotItems", t => t.HasCheckConstraint("CK_SyncSnapshotItem_Ordinal", "\"Ordinal\" >= 0"));
        b.Entity<SyncSnapshotItemRow>().HasKey(x => new { x.UserId, x.SnapshotId, x.Ordinal });
        b.Entity<SyncSnapshotItemRow>().Property(x => x.ItemJson).HasColumnType("jsonb");
        b.Entity<SyncSnapshotItemRow>().HasOne<SyncSnapshotRow>().WithMany().HasForeignKey(x => new { x.UserId, x.SnapshotId }).OnDelete(DeleteBehavior.Restrict);
    }
}
