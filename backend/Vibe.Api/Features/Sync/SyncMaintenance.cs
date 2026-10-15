using System.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Vibe.Api.Data;

namespace Vibe.Api.Features.Sync;

public sealed class SyncMaintenance(VibeDb db, TimeProvider clock, IOptions<SyncOptions> options)
{
    public static Task<PlanRow> Guard(VibeDb db, string owner, CancellationToken ct) => db.Plans
        .FromSqlInterpolated($"SELECT * FROM \"UserPlanState\" WHERE \"UserId\" = {owner} FOR UPDATE").SingleAsync(ct);

    public static async Task RemoveExpiredSnapshots(VibeDb db, string owner, DateTime now, CancellationToken ct)
    {
        var expired = db.SyncSnapshots.Where(s => s.UserId == owner && s.ExpiresAtUtc <= now);
        await db.SyncSnapshotItems.Where(i => i.UserId == owner && expired.Any(s => s.Id == i.SnapshotId)).ExecuteDeleteAsync(ct);
        await expired.ExecuteDeleteAsync(ct);
    }
    public async Task Cleanup(string owner, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await Guard(db, owner, ct);
        DateTime now = clock.GetUtcNow().UtcDateTime;
        await RemoveExpiredSnapshots(db, owner, now, ct);
        var stream = await db.SyncStreams.SingleAsync(s => s.UserId == owner, ct);
        long pin = await db.SyncSnapshots.Where(s => s.UserId == owner && s.StreamId == stream.StreamId && s.ExpiresAtUtc > now)
            .Select(s => (long?)s.WatermarkSequence).MinAsync(ct) ?? stream.LastSequence;
        DateTime cutoff = now.AddDays(-options.Value.FeedRetentionDays);
        // Stop at the FIRST still-young row, even if later timestamps moved backwards.
        long? firstYoung = await db.SyncChanges.Where(c => c.UserId == owner && c.StreamId == stream.StreamId
            && c.Sequence > stream.PrunedThrough && c.Sequence <= pin && c.RecordedAtUtc > cutoff)
            .OrderBy(c => c.Sequence).Select(c => (long?)c.Sequence).FirstOrDefaultAsync(ct);
        long prune = firstYoung is null ? pin : firstYoung.Value - 1;
        if (prune > stream.PrunedThrough)
        {
            await db.SyncChanges.Where(c => c.UserId == owner && c.StreamId == stream.StreamId && c.Sequence <= prune).ExecuteDeleteAsync(ct);
            stream.PrunedThrough = prune;
            await db.SaveChangesAsync(ct);
        }
        await tx.CommitAsync(ct);
    }

    // Operator-only, with the API stopped after restore. No domain table or dedup/history
    // is deleted. ExecuteUpdate also avoids treating a tracked alternate key as mutable.
    public async Task ResetStream(string owner, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await Guard(db, owner, ct);
        await db.SyncSnapshotItems.Where(i => i.UserId == owner).ExecuteDeleteAsync(ct);
        await db.SyncSnapshots.Where(s => s.UserId == owner).ExecuteDeleteAsync(ct);
        await db.SyncChanges.Where(c => c.UserId == owner).ExecuteDeleteAsync(ct);
        Guid replacement = Guid.NewGuid();
        int updated = await db.SyncStreams.Where(s => s.UserId == owner).ExecuteUpdateAsync(u => u
            .SetProperty(s => s.StreamId, replacement).SetProperty(s => s.LastSequence, 0L).SetProperty(s => s.PrunedThrough, 0L), ct);
        if (updated != 1) throw new InvalidOperationException("The account has no initialized S1 stream.");
        await tx.CommitAsync(ct);
        db.ChangeTracker.Clear();
    }
}

public sealed class SyncCleanupWorker(IServiceScopeFactory scopes, IOptions<SyncOptions> options, ILogger<SyncCleanupWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(options.Value.CleanupIntervalSeconds));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                try { await Pass(stoppingToken); }
                catch (Exception) when (!stoppingToken.IsCancellationRequested)
                {
                    // A transient inventory/database failure must not stop the API host.
                    logger.LogWarning("S1 maintenance inventory deferred; retry on the next pass.");
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
    async Task Pass(CancellationToken stoppingToken)
    {
                // Account inventory is paged; each user gets its own short transaction/guard.
                string? after = null;
                while (!stoppingToken.IsCancellationRequested)
                {
                    using var inventory = scopes.CreateScope();
                    var db = inventory.ServiceProvider.GetRequiredService<VibeDb>();
                    var users = await db.SyncStreams.AsNoTracking().Where(s => after == null || string.Compare(s.UserId, after) > 0)
                        .OrderBy(s => s.UserId).Select(s => s.UserId).Take(100).ToListAsync(stoppingToken);
                    if (users.Count == 0) break;
                    foreach (string owner in users)
                    {
                        try
                        {
                            using var budget = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                            budget.CancelAfter(TimeSpan.FromSeconds(5));
                            using var scope = scopes.CreateScope();
                            await scope.ServiceProvider.GetRequiredService<SyncMaintenance>().Cleanup(owner, budget.Token);
                        }
                        catch (Exception) when (!stoppingToken.IsCancellationRequested)
                        {
                            logger.LogWarning("S1 cleanup deferred; retry on the next maintenance pass.");
                        }
                    }
                    after = users[^1];
                }
    }
}
