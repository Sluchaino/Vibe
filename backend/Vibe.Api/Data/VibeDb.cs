using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Vibe.Api.Data;

public class VibeUser : IdentityUser { }
public class SettingsRow
{
    public string UserId { get; set; } = "";
    public string Timezone { get; set; } = "Europe/Moscow";
    public string Version { get; set; } = Versions.New();
    public PlaceRow? Place { get; set; }
}
public class PlaceRow
{
    public string UserId { get; set; } = "";
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string Version { get; set; } = Versions.New();
}
public class PlanRow
{
    public string UserId { get; set; } = "";
    public long InputRevision { get; set; }
    public long ScheduleRevision { get; set; }
}
public class CategoryRow
{
    public string UserId { get; set; } = "";
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string Version { get; set; } = Versions.New();
}
public class DefinitionRow
{
    public string UserId { get; set; } = "";
    public Guid Id { get; set; }
    public Guid? CategoryId { get; set; }
    public Guid PlaceId { get; set; }
    public string FieldsJson { get; set; } = "{}";
    public string Version { get; set; } = Versions.New();
}
public class OccurrenceRow
{
    public string UserId { get; set; } = "";
    public Guid Id { get; set; }
    public Guid DefinitionId { get; set; }
    public Guid PlaceId { get; set; }
    public DateOnly LogicalDate { get; set; }
    public string SourceDefinitionVersion { get; set; } = "";
    public string SnapshotJson { get; set; } = "{}";
    public string Version { get; set; } = Versions.New();
    public BlockRow? Block { get; set; }
}
public class BlockRow
{
    public string UserId { get; set; } = "";
    public Guid Id { get; set; }
    public Guid OccurrenceId { get; set; }
    public DateTime Start { get; set; }
    public DateTime End { get; set; }
    public bool Fixed { get; set; }
    public string Version { get; set; } = Versions.New();
}
public class OperationRow
{
    public string UserId { get; set; } = "";
    public Guid OpId { get; set; }
    public string Fingerprint { get; set; } = "";
    public int Status { get; set; }
    public string Body { get; set; } = "";
    public string? ETag { get; set; }
    public string? Location { get; set; }
}
public static class Versions { public static string New() => Guid.NewGuid().ToString("N"); }

public class VibeDb(DbContextOptions<VibeDb> options) : IdentityDbContext<VibeUser>(options)
{
    public DbSet<SettingsRow> Settings => Set<SettingsRow>();
    public DbSet<PlaceRow> Places => Set<PlaceRow>();
    public DbSet<PlanRow> Plans => Set<PlanRow>();
    public DbSet<CategoryRow> Categories => Set<CategoryRow>();
    public DbSet<DefinitionRow> Definitions => Set<DefinitionRow>();
    public DbSet<OccurrenceRow> Occurrences => Set<OccurrenceRow>();
    public DbSet<BlockRow> Blocks => Set<BlockRow>();
    public DbSet<OperationRow> Operations => Set<OperationRow>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        base.OnModelCreating(b);
        b.Entity<SettingsRow>().ToTable("UserSettings").HasKey(x => x.UserId);
        b.Entity<SettingsRow>().HasOne<VibeUser>().WithOne().HasForeignKey<SettingsRow>(x => x.UserId).OnDelete(DeleteBehavior.Restrict);
        b.Entity<PlanRow>().ToTable("UserPlanState").HasKey(x => x.UserId);
        b.Entity<PlanRow>().HasOne<VibeUser>().WithOne().HasForeignKey<PlanRow>(x => x.UserId).OnDelete(DeleteBehavior.Restrict);
        b.Entity<PlaceRow>().ToTable("Places").HasKey(x => new { x.UserId, x.Id });
        b.Entity<PlaceRow>().HasIndex(x => x.UserId).IsUnique();
        b.Entity<SettingsRow>().HasOne(x => x.Place).WithOne().HasForeignKey<PlaceRow>(x => x.UserId).OnDelete(DeleteBehavior.Restrict);
        b.Entity<CategoryRow>().ToTable("Categories").HasKey(x => new { x.UserId, x.Id });
        b.Entity<CategoryRow>().HasOne<VibeUser>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Restrict);
        b.Entity<DefinitionRow>().ToTable("TaskDefinitions").HasKey(x => new { x.UserId, x.Id });
        b.Entity<DefinitionRow>().Property(x => x.FieldsJson).HasColumnType("jsonb");
        b.Entity<DefinitionRow>().HasOne<CategoryRow>().WithMany().HasForeignKey(x => new { x.UserId, x.CategoryId }).OnDelete(DeleteBehavior.Restrict);
        b.Entity<DefinitionRow>().HasOne<PlaceRow>().WithMany().HasForeignKey(x => new { x.UserId, x.PlaceId }).OnDelete(DeleteBehavior.Restrict);
        b.Entity<OccurrenceRow>().ToTable("TaskOccurrences").HasKey(x => new { x.UserId, x.Id });
        b.Entity<OccurrenceRow>().Property(x => x.SnapshotJson).HasColumnType("jsonb");
        b.Entity<OccurrenceRow>().HasOne<DefinitionRow>().WithMany().HasForeignKey(x => new { x.UserId, x.DefinitionId }).OnDelete(DeleteBehavior.Restrict);
        b.Entity<OccurrenceRow>().HasOne<PlaceRow>().WithMany().HasForeignKey(x => new { x.UserId, x.PlaceId }).OnDelete(DeleteBehavior.Restrict);
        b.Entity<BlockRow>().ToTable("CalendarBlocks", t => t.HasCheckConstraint("CK_Block_Positive", "\"End\" > \"Start\""));
        b.Entity<BlockRow>().HasKey(x => new { x.UserId, x.Id });
        b.Entity<BlockRow>().HasIndex(x => new { x.UserId, x.OccurrenceId }).IsUnique();
        b.Entity<BlockRow>().HasIndex(x => new { x.UserId, x.Start, x.End });
        b.Entity<OccurrenceRow>().HasOne(x => x.Block).WithOne().HasForeignKey<BlockRow>(x => new { x.UserId, x.OccurrenceId }).OnDelete(DeleteBehavior.Restrict);
        b.Entity<OperationRow>().ToTable("OperationResults").HasKey(x => new { x.UserId, x.OpId });
        b.Entity<OperationRow>().HasOne<VibeUser>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Restrict);
    }
}

public class VibeDbFactory : IDesignTimeDbContextFactory<VibeDb>
{
    public VibeDb CreateDbContext(string[] args)
    {
        // A schema-only design connection; migration creation never reads development secrets.
        var connection = Environment.GetEnvironmentVariable("VIBE_MIGRATION_CONNECTION")
            ?? "Host=127.0.0.1;Port=54329;Database=vibe;Username=vibe";
        return new VibeDb(new DbContextOptionsBuilder<VibeDb>().UseNpgsql(connection).Options);
    }
}
