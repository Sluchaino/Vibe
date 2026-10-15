namespace Vibe.Api.Features.Sync;

// Local resource limits, not a change to domain limits or a production SLA.
public sealed class SyncOptions
{
    public int FeedRetentionDays { get; set; } = 7;
    public int BootstrapTtlMinutes { get; set; } = 15;
    public int MaxSnapshotsPerUser { get; set; } = 4;
    public int MaxSnapshotItems { get; set; } = 5000;
    public long MaxSnapshotPayloadBytes { get; set; } = 16 * 1024 * 1024;
    public int GuardTimeoutMilliseconds { get; set; } = 2000;
    public int BuildTimeoutMilliseconds { get; set; } = 5000;
    public int CleanupIntervalSeconds { get; set; } = 60;
}
