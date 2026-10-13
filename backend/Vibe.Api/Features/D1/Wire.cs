using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;

namespace Vibe.Api.Features.D1;

public sealed class DomainError(int status, string code, JsonObject? extras = null, string? etag = null) : Exception(code)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
    public JsonObject? Extras { get; } = extras;
    public string? ETag { get; } = etag;
}

public static class Wire
{
    static readonly JsonObject Schemas = JsonNode.Parse(typeof(Wire).Assembly.GetManifestResourceStream("Vibe.D1.Contract")!)!["components"]!["schemas"]!.AsObject();
    public static string Str(JsonNode n, string key) => n[key]!.GetValue<string>();
    public static Guid Id(JsonNode n, string key) => Guid.Parse(Str(n, key));
    public static bool Bool(JsonNode n, string key) => n[key]!.GetValue<bool>();
    public static int Int(JsonNode n, string key)
    {
        if (!ExactNumber.TryRead(n[key], out var number) || !number.TryInt32(out var value)) throw new DomainError(400, "validationFailed");
        return value;
    }
    public static bool TryUuid(string? value, out Guid id) { id = default; return value?.Length == 36 && Guid.TryParseExact(value, "D", out id); }
    public static bool Pattern(string value, string pattern)
    {
        // JSON Schema uses ASCII decimal digits; .NET's default \d also matches other scripts.
        pattern = pattern.Replace(@"\d", "[0-9]", StringComparison.Ordinal);
        if (pattern.EndsWith('$')) pattern = pattern[..^1] + @"\z";
        return Regex.IsMatch(value, pattern, RegexOptions.CultureInvariant);
    }
    public static string Json(JsonNode n) => n.ToJsonString();
    public static JsonObject Obj(string json) => JsonNode.Parse(json)!.AsObject();
    public static void Bad(string code = "validationFailed") => throw new DomainError(400, code);

    public static async Task<JsonObject> Parse(HttpRequest request, CancellationToken ct)
    {
        if (!request.HasJsonContentType()) Bad();
        try
        {
            using var doc = await JsonDocument.ParseAsync(request.Body, new JsonDocumentOptions { MaxDepth = 64 }, ct);
            Duplicates(doc.RootElement);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) Bad();
            return Obj(doc.RootElement.GetRawText());
        }
        catch (JsonException) { Bad(); throw; }
    }
    static void Duplicates(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var p in element.EnumerateObject()) { if (!names.Add(p.Name)) Bad(); Duplicates(p.Value); }
        }
        else if (element.ValueKind == JsonValueKind.Array) foreach (var e in element.EnumerateArray()) Duplicates(e);
    }
    public static void Validate(JsonNode? node, string schemaName)
    {
        Unsupported(node);
        if (!Matches(node, Schemas[schemaName]!)) Bad();
    }
    public static void NormalizeIntegers(JsonNode node)
    {
        if (node is JsonObject obj)
        {
            foreach (var (key, value) in obj.ToArray())
            {
                if (ExactNumber.TryRead(value, out var exact))
                {
                    if (!exact.TryInt32(out int number)) Bad();
                    obj[key] = number;
                }
                else if (value is not null) NormalizeIntegers(value);
            }
        }
        else if (node is JsonArray array)
        {
            for (int i = 0; i < array.Count; i++)
            {
                if (ExactNumber.TryRead(array[i], out var exact))
                {
                    if (!exact.TryInt32(out int number)) Bad();
                    array[i] = number;
                }
                else if (array[i] is JsonNode value) NormalizeIntegers(value);
            }
        }
    }
    static void Unsupported(JsonNode? node)
    {
        if (node is JsonObject obj)
        {
            foreach (var (key, value) in obj)
            {
                if (key is "recurrence" or "recurrenceRule" or "recurrenceRules" or "repeat" or "repeatRule" or "weeklyGoal" or "weeklyGoals" or "goal" or "goals" or "template" or "templates" or "templateId") Bad("unsupportedConstraint");
                if (key == "mode" && value is JsonValue && value.ToJsonString() == "\"flexible\"") Bad("unsupportedConstraint");
                if (key == "splitAllowed" && value?.ToJsonString() == "true") Bad("unsupportedConstraint");
                if (key == "requiredRestMinutes" && ExactNumber.TryRead(value, out var number) && number.TryInt32(out var rest) && rest > 0) Bad("unsupportedConstraint");
                Unsupported(value);
            }
        }
        else if (node is JsonArray a) foreach (var n in a) Unsupported(n);
    }
    static bool Matches(JsonNode? n, JsonNode schema)
    {
        if (schema["$ref"] is JsonNode reference) return Matches(n, Schemas[reference.GetValue<string>().Split('/').Last()]!);
        if (schema["anyOf"] is JsonArray any) return any.Any(s => Matches(n, s!));
        if (schema["oneOf"] is JsonArray one) return one.Count(s => Matches(n, s!)) == 1;
        if (schema["const"] is JsonNode constant && Canonical(n) != Canonical(constant)) return false;
        if (schema["enum"] is JsonArray choices && !choices.Any(s => Canonical(n) == Canonical(s))) return false;
        var type = schema["type"]?.GetValue<string>();
        if (type == "null") return n is null;
        if (n is null) return false;
        if (type == "object")
        {
            if (n is not JsonObject o) return false;
            if (schema["required"] is JsonArray required && required.Any(k => !o.ContainsKey(k!.GetValue<string>()))) return false;
            var props = schema["properties"]?.AsObject();
            foreach (var (key, value) in o)
            {
                if (props?.TryGetPropertyValue(key, out var child) == true) { if (!Matches(value, child!)) return false; }
                else if (schema["additionalProperties"]?.ToJsonString() == "false") return false;
            }
            return true;
        }
        if (type == "array")
        {
            if (n is not JsonArray a) return false;
            if (schema["minItems"] is JsonNode min && a.Count < min.GetValue<int>()) return false;
            if (schema["maxItems"] is JsonNode max && a.Count > max.GetValue<int>()) return false;
            if (schema["uniqueItems"]?.ToJsonString() == "true" && a.Select(x => Canonical(x)).Distinct().Count() != a.Count) return false;
            return a.All(x => Matches(x, schema["items"]!));
        }
        if (n is not JsonValue v) return false;
        if (type == "string")
        {
            if (!v.TryGetValue<string>(out var s)) return false;
            int length = s.EnumerateRunes().Count();
            if (schema["minLength"] is JsonNode min && length < min.GetValue<int>()) return false;
            if (schema["maxLength"] is JsonNode max && length > max.GetValue<int>()) return false;
            if (schema["pattern"] is JsonNode pattern && !Pattern(s, pattern.GetValue<string>())) return false;
            if (schema["format"]?.GetValue<string>() == "uuid" && !TryUuid(s, out _)) return false;
            if (schema["format"]?.GetValue<string>() == "date" && !DateOnly.TryParseExact(s, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _)) return false;
            return true;
        }
        if (type == "boolean") return v.TryGetValue<bool>(out _);
        if (type == "integer")
        {
            if (!ExactNumber.TryRead(v, out var exact) || !exact.TryInt32(out int number)) return false;
            if (schema["minimum"] is JsonNode min && number < min.GetValue<int>()) return false;
            if (schema["maximum"] is JsonNode max && number > max.GetValue<int>()) return false;
            return true;
        }
        return true;
    }
    // Exact decimal normalization: never passes numeric tokens through a floating-point value.
    public static string Canonical(JsonNode? node)
    {
        if (node is null) return "null";
        if (node is JsonObject o) return "{" + string.Join(',', o.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => JsonSerializer.Serialize(p.Key) + ":" + Canonical(p.Value))) + "}";
        if (node is JsonArray a) return "[" + string.Join(',', a.Select(Canonical)) + "]";
        return ExactNumber.TryRead(node, out var number) ? number.Canonical : node.ToJsonString();
    }
    public static string ResolvedPath(HttpRequest request)
    {
        if (request.HttpContext.GetEndpoint() is RouteEndpoint endpoint)
        {
            return "/" + string.Join('/', endpoint.RoutePattern.PathSegments.Select(segment => string.Concat(segment.Parts.Select(part => part switch
            {
                RoutePatternLiteralPart literal => literal.Content,
                RoutePatternSeparatorPart separator => separator.Content,
                RoutePatternParameterPart parameter => NormalizeParameter(request.RouteValues[parameter.Name]?.ToString() ?? ""),
                _ => throw new InvalidOperationException("Unexpected route pattern.")
            }))));
        }
        return request.Path.Value!.TrimEnd('/').ToLowerInvariant();
    }
    static string NormalizeParameter(string value) => TryUuid(value, out var id) ? id.ToString("D") : value;
    public static string Fingerprint(HttpRequest request, JsonObject body)
    {
        var copy = body.DeepClone().AsObject(); copy.Remove("opId");
        var query = request.Query.OrderBy(x => x.Key, StringComparer.Ordinal).Select(x => new { key = x.Key, values = x.Value.ToArray() });
        string path = ResolvedPath(request);
        string text = request.Method + "\n" + path + "\n" + JsonSerializer.Serialize(query) + "\n" + (request.Headers.ContainsKey("If-Match") ? JsonSerializer.Serialize(request.Headers["If-Match"].ToArray()) : "absent") + "\n" + Canonical(copy);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
    }
    public static void Query(HttpRequest request, params string[] allowed)
    {
        foreach (var q in request.Query) if (!allowed.Contains(q.Key, StringComparer.Ordinal) || q.Value.Count != 1) Bad();
    }
    public static JsonObject Problem(HttpContext ctx, DomainError error)
    {
        var result = new JsonObject { ["type"] = "about:blank", ["title"] = error.Code, ["status"] = error.Status, ["detail"] = "Запрос не может быть выполнен. Проверьте данные и текущую версию ресурса.", ["instance"] = ctx.Request.Path.Value, ["code"] = error.Code, ["correlationId"] = ctx.TraceIdentifier };
        if (error.Code == "validationFailed") result["fieldErrors"] = new JsonObject { ["request"] = new JsonArray("Неверное поле, тип или обязательное значение.") };
        if (error.Extras is not null) foreach (var p in error.Extras) result[p.Key] = p.Value?.DeepClone();
        return result;
    }
}
