using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Vibe.Api.Data;

namespace Vibe.Api.Features.Recurrence;

public sealed class RecurrenceOptions
{
    public int PollIntervalSeconds { get; set; } = 30;
    public int MaxRulesPerPass { get; set; } = 100;
    public int TransactionTimeoutSeconds { get; set; } = 5;
}

public sealed class RecurrenceWorker(IServiceScopeFactory scopes, IOptions<RecurrenceOptions> options, ILogger<RecurrenceWorker> logger) : BackgroundService
{
    string? afterOwner;
    Guid afterRule;
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(options.Value.PollIntervalSeconds));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                try { await Pass(stoppingToken); }
                catch (Exception) when (!stoppingToken.IsCancellationRequested) { logger.LogWarning("R1 generation deferred; retry on the next pass."); }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
    async Task Pass(CancellationToken ct)
    {
        using var inventory = scopes.CreateScope(); var db = inventory.ServiceProvider.GetRequiredService<VibeDb>();
        var rules = await db.RecurrenceRules.AsNoTracking().Where(r => r.Enabled && (afterOwner == null || string.Compare(r.UserId, afterOwner) > 0
            || r.UserId == afterOwner && r.Id.CompareTo(afterRule) > 0)).OrderBy(r => r.UserId).ThenBy(r => r.Id)
            .Select(r => new { r.UserId, r.Id }).Take(options.Value.MaxRulesPerPass).ToListAsync(ct);
        if (rules.Count == 0) { afterOwner = null; afterRule = default; return; }
        foreach (var rule in rules)
        {
            try
            {
                using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct); budget.CancelAfter(TimeSpan.FromSeconds(options.Value.TransactionTimeoutSeconds));
                using var scope = scopes.CreateScope(); await scope.ServiceProvider.GetRequiredService<RecurrenceService>().Generate(rule.UserId, rule.Id, budget.Token);
            }
            catch (Exception) when (!ct.IsCancellationRequested) { logger.LogWarning("R1 user generation deferred; retry on the next pass."); }
            afterOwner = rule.UserId; afterRule = rule.Id;
            // A transaction is released between rules/backlog chunks so stop and edits can win.
            await Task.Yield();
        }
        if (rules.Count < options.Value.MaxRulesPerPass) { afterOwner = null; afterRule = default; }
    }
}
