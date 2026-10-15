using System.Text.Json.Nodes;
using Vibe.Api.Data;
using Vibe.Api.Features.D1;
using Xunit;

namespace Vibe.Api.Tests;

public class CompletionSchemaTests
{
    static JsonObject State(bool completed, bool planned)
    {
        var id = Guid.NewGuid();
        var o = new OccurrenceRow { UserId = "test-owner", Id = id, DefinitionId = Guid.NewGuid(), LogicalDate = new DateOnly(2026, 10, 14), SourceDefinitionVersion = "definition_v1", SnapshotJson = "{\"durationPolicy\":{\"mode\":\"fixedWork\",\"requiredWorkMinutes\":90},\"splitAllowed\":false,\"mobilityPolicy\":\"movable\",\"availabilityRules\":{\"timezone\":\"Europe/Moscow\",\"windows\":[],\"dateExceptions\":[]},\"placeId\":\"10000000-0000-4000-8000-000000000001\",\"requiredRestMinutes\":0}" };
        if (planned) o.Block = new BlockRow { Id = Guid.NewGuid(), UserId = o.UserId, OccurrenceId = id, Start = TimeRules.Utc("2026-10-14T12:00:00Z"), End = TimeRules.Utc("2026-10-14T13:30:00Z") };
        if (completed) o.Completions.Add(new CompletionRow { Id = Guid.NewGuid(), UserId = o.UserId, OccurrenceId = id, CompletedAtUtc = TimeRules.Utc("2026-10-14T12:00:00Z").AddMilliseconds(123) });
        return D1Service.Occurrence(o);
    }
    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void CurrentOccurrenceProjectionSatisfiesConditionalCompletionAndPlacementSchemas(bool completed, bool planned)
    {
        var state = State(completed, planned); Wire.Validate(state, "TaskOccurrence");
        Assert.Equal(completed ? 0 : 90, Wire.Int(state, "remainingWorkMinutes"));
        if (completed) Wire.Validate(state["completion"], "ActiveCompletion");
    }
    [Fact]
    public void ConditionalAndAllOfValidationRejectInconsistentOrRevokedActiveProjection()
    {
        Action<JsonObject>[] invalid =
        [
            o => o["completion"] = null,
            o => o["remainingWorkMinutes"] = 90,
            o => o["completionStatus"] = "incomplete",
            o => o["completion"]!["revokedAt"] = "2026-10-14T11:00:00.000Z",
            o => o["completion"]!["completedAt"] = "2026-10-14T12:00:00.123Z\n",
            o => o["calendarBlock"] = null,
            o => o["placementStatus"] = "unplanned"
        ];
        foreach (var mutate in invalid)
        {
            var state = State(true, true); mutate(state);
            Assert.Equal("validationFailed", Assert.Throws<DomainError>(() => Wire.Validate(state, "TaskOccurrence")).Code);
        }
        var incomplete = State(false, false); incomplete["remainingWorkMinutes"] = 0;
        Assert.Throws<DomainError>(() => Wire.Validate(incomplete, "TaskOccurrence"));
        var legacy = State(false, false); legacy.Remove("completion"); legacy.Remove("completionStatus");
        Assert.Throws<DomainError>(() => Wire.Validate(legacy, "TaskOccurrence")); Wire.Validate(legacy, "TaskOccurrenceLegacyD1");
    }
}
