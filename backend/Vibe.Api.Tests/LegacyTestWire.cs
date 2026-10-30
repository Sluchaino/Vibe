using System.Text.Json.Nodes;

namespace Vibe.Api.Tests;

// Keep regression requests genuinely legacy/closed even when their base came from a U1 GET.
internal static class LegacyTestWire
{
    public static JsonObject Constraints(JsonNode source)
    {
        var copy = source.DeepClone().AsObject(); copy.Remove("workOrigin"); return copy;
    }
    public static JsonObject Occurrence(JsonNode source)
    {
        var copy = source.DeepClone().AsObject(); copy.Remove("timeIntent"); copy.Remove("resolvedTiming"); copy.Remove("placementIssue");
        copy["constraintsSnapshot"] = Constraints(copy["constraintsSnapshot"]!); return copy;
    }
}
