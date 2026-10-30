using System.Text.Json.Nodes;

namespace Vibe.Api.Features.D1;

// Normalize COPIES only. Stored legacy fields/snapshots/feed and operation response bytes
// remain historical records; this adapter never fetches today's entity to repair old log.
public static class U1Projection
{
    public static JsonObject Constraints(JsonObject source)
    {
        var copy = source.DeepClone().AsObject();
        if (!copy.ContainsKey("workOrigin")) copy["workOrigin"] = "manual";
        return copy;
    }
    public static int? Work(JsonNode constraints) => constraints["durationPolicy"] is JsonNode duration ? Wire.Int(duration, "requiredWorkMinutes") : null;
    public static JsonObject Definition(JsonObject source) => Constraints(source);
    public static JsonObject Occurrence(JsonObject source)
    {
        var copy = source.DeepClone().AsObject();
        copy["constraintsSnapshot"] = Constraints(copy["constraintsSnapshot"]!.AsObject());
        if (!copy.ContainsKey("timeIntent")) copy["timeIntent"] = null;
        if (!copy.ContainsKey("resolvedTiming")) copy["resolvedTiming"] = null;
        if (!copy.ContainsKey("placementIssue")) copy["placementIssue"] = null;
        return copy;
    }
    public static JsonObject Rule(JsonObject source)
    {
        var copy = source.DeepClone().AsObject();
        if (!copy.ContainsKey("timeIntent")) copy["timeIntent"] = null;
        return copy;
    }
    public static JsonObject Item(JsonObject source)
    {
        var copy = source.DeepClone().AsObject(); var value = copy["value"]!.AsObject();
        copy["value"] = Wire.Str(copy, "kind") switch
        {
            "definition" => Definition(value), "occurrence" => Occurrence(value), "recurrence" => Rule(value), _ => value.DeepClone()
        };
        return copy;
    }
    public static JsonObject CheckedItem(string json)
    {
        var item = Item(Wire.Obj(json));
        try { Wire.Validate(item, "SyncItemV3"); }
        catch (DomainError) { throw new InvalidOperationException("Malformed historical sync projection."); }
        return item;
    }
}
