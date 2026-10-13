using System.Text.Json.Nodes;
using Vibe.Api.Features.D1;
using Xunit;

namespace Vibe.Api.Tests;

public class TimeRulesTests
{
    static JsonObject Rules(string windows, string exceptions = "[]") => Wire.Obj("{\"timezone\":\"Europe/Berlin\",\"windows\":" + windows + ",\"dateExceptions\":" + exceptions + "}");
    static DateTime U(string value) => TimeRules.Utc(value);
    [Fact]
    public void GapNeverShiftsAndOverlapRequiresValidSelectedOffset()
    {
        var zone = TimeRules.Zone("Europe/Berlin");
        Assert.Equal("invalidLocalTime", Assert.Throws<DomainError>(() => TimeRules.Resolve(TimeRules.Local("2026-03-29T02:30:00"), zone, "+01:00")).Code);
        Assert.Equal(U("2026-10-25T00:30:00Z"), TimeRules.Resolve(TimeRules.Local("2026-10-25T02:30:00"), zone, "+02:00"));
        Assert.Equal(U("2026-10-25T01:30:00Z"), TimeRules.Resolve(TimeRules.Local("2026-10-25T02:30:00"), zone, "+01:00"));
        Assert.Equal("invalidUtcOffset", Assert.Throws<DomainError>(() => TimeRules.Resolve(TimeRules.Local("2026-10-25T02:30:00"), zone, "+03:00")).Code);
    }
    [Fact]
    public void NinetyMinutesCannotFitSixtyAndAdjacentWindowsFormUnion()
    {
        var rules = Rules("[{\"daysOfWeek\":[\"monday\"],\"startLocalTime\":\"18:00\",\"endLocalTime\":\"19:00\",\"endDayOffset\":0}]");
        Assert.Equal("outsideAvailability", Assert.Throws<DomainError>(() => TimeRules.CheckAvailability(rules, U("2026-10-12T16:00:00Z"), U("2026-10-12T17:30:00Z"), default)).Code);
        rules["windows"]!.AsArray().Add(Wire.Obj("{\"daysOfWeek\":[\"monday\"],\"startLocalTime\":\"19:00\",\"endLocalTime\":\"20:00\",\"endDayOffset\":0}"));
        TimeRules.CheckAvailability(rules, U("2026-10-12T16:00:00Z"), U("2026-10-12T17:30:00Z"), default);
    }
    [Fact]
    public void NightWindowBelongsToStartDateAndExceptionReplacesThatWindow()
    {
        var rules = Rules("[{\"daysOfWeek\":[\"friday\"],\"startLocalTime\":\"22:00\",\"endLocalTime\":\"02:00\",\"endDayOffset\":1}]");
        TimeRules.CheckAvailability(rules, U("2026-10-16T23:00:00Z"), U("2026-10-17T00:00:00Z"), default);
        rules["dateExceptions"]!.AsArray().Add(Wire.Obj("{\"localDate\":\"2026-10-17\",\"windows\":[]}"));
        TimeRules.CheckAvailability(rules, U("2026-10-16T23:00:00Z"), U("2026-10-17T00:00:00Z"), default);
        rules["dateExceptions"]!.AsArray().Add(Wire.Obj("{\"localDate\":\"2026-10-16\",\"windows\":[]}"));
        Assert.Equal("outsideAvailability", Assert.Throws<DomainError>(() => TimeRules.CheckAvailability(rules, U("2026-10-16T23:00:00Z"), U("2026-10-17T00:00:00Z"), default)).Code);
    }
    [Fact]
    public void UndefinedBoundaryNeedsExceptionButIrrelevantUndefinedWindowDoesNotBlock()
    {
        var rules = Rules("[{\"daysOfWeek\":[\"sunday\"],\"startLocalTime\":\"02:00\",\"endLocalTime\":\"04:00\",\"endDayOffset\":0}]");
        Assert.Equal("ambiguousAvailabilityBoundary", Assert.Throws<DomainError>(() => TimeRules.CheckAvailability(rules, U("2026-10-25T00:30:00Z"), U("2026-10-25T02:00:00Z"), default)).Code);
        rules["dateExceptions"]!.AsArray().Add(Wire.Obj("{\"localDate\":\"2026-10-25\",\"windows\":[{\"startLocalTime\":\"02:00\",\"endLocalTime\":\"04:00\",\"endDayOffset\":0,\"startUtcOffset\":\"+02:00\",\"endUtcOffset\":\"+01:00\"}]}"));
        TimeRules.ValidateAvailability(rules);
        TimeRules.CheckAvailability(rules, U("2026-10-25T00:30:00Z"), U("2026-10-25T02:00:00Z"), default);
        rules["dateExceptions"] = new JsonArray();
        rules["windows"]!.AsArray().Add(Wire.Obj("{\"daysOfWeek\":[\"sunday\"],\"startLocalTime\":\"06:00\",\"endLocalTime\":\"08:00\",\"endDayOffset\":0}"));
        TimeRules.CheckAvailability(rules, U("2026-10-25T05:00:00Z"), U("2026-10-25T06:30:00Z"), default);
    }
    [Fact]
    public void CalendarCountsLocalDaysAcrossSpringAndFallDst()
    {
        TimeRules.CalendarRange(U("2026-03-01T23:00:00Z"), U("2026-04-01T22:00:00Z"), "Europe/Berlin");
        TimeRules.CalendarRange(U("2026-09-30T22:00:00Z"), U("2026-10-31T23:00:00Z"), "Europe/Berlin");
        Assert.Equal("rangeTooLarge", Assert.Throws<DomainError>(() => TimeRules.CalendarRange(U("2026-09-30T22:00:00Z"), U("2026-10-31T23:01:00Z"), "Europe/Berlin")).Code);
    }
    [Fact]
    public void CanonicalFingerprintPreservesBigNumbersAndNormalizesIntegralRepresentations()
    {
        Assert.Equal(Wire.Canonical(JsonNode.Parse("{\"a\":1.0,\"b\":9007199254740993}")), Wire.Canonical(JsonNode.Parse("{\"b\":9007199254740993,\"a\":1e0}")));
        Assert.NotEqual(Wire.Canonical(JsonNode.Parse("9007199254740993")), Wire.Canonical(JsonNode.Parse("9007199254740992")));
        Assert.Throws<DomainError>(() => Wire.Validate(Wire.Obj("{\"mode\":\"fixedWork\",\"requiredWorkMinutes\":9007199254740993}"), "FixedWorkDuration"));
        Assert.Throws<DomainError>(() => Wire.Validate(Wire.Obj("{\"mode\":\"fixedWork\",\"requiredWorkMinutes\":\"90\"}"), "FixedWorkDuration"));
        Wire.Validate(Wire.Obj("{\"mode\":\"fixedWork\",\"requiredWorkMinutes\":90.0}"), "FixedWorkDuration");
        Wire.Validate(Wire.Obj("{\"durationPolicy\":{\"mode\":\"fixedWork\",\"requiredWorkMinutes\":90e0},\"splitAllowed\":false,\"mobilityPolicy\":\"movable\",\"availabilityRules\":{\"timezone\":\"Europe/Moscow\",\"windows\":[],\"dateExceptions\":[]},\"placeId\":\"10000000-0000-4000-8000-000000000001\",\"requiredRestMinutes\":0e0}"), "ConstraintsSnapshot");
        Wire.Validate(JsonValue.Create(string.Concat(Enumerable.Repeat("😀", 100))), "Name");
        Assert.Throws<DomainError>(() => Wire.Validate(JsonValue.Create(string.Concat(Enumerable.Repeat("😀", 101))), "Name"));
    }
    [Fact]
    public void IntegerValidationAndNumericConstantsRemainExactForArbitraryExponents()
    {
        const string huge = "999999999999999999999999999999999999";
        var fractional = Wire.Obj("{\"mode\":\"fixedWork\",\"requiredWorkMinutes\":1.0000000000000000000000000000001}");
        Assert.Equal("validationFailed", Assert.Throws<DomainError>(() => Wire.Validate(fractional, "FixedWorkDuration")).Code);
        Assert.Equal("validationFailed", Assert.Throws<DomainError>(() => Wire.Int(fractional, "requiredWorkMinutes")).Code);
        Assert.Equal(1, Wire.Int(Wire.Obj("{\"n\":1000e-3}"), "n"));
        Assert.Equal(int.MaxValue, Wire.Int(Wire.Obj("{\"n\":2147483647.000000000000000000000000000000}"), "n"));
        Assert.Equal(int.MinValue, Wire.Int(Wire.Obj("{\"n\":-2147483648e0}"), "n"));
        foreach (string zero in new[] { "-0", "-0.000e-" + huge, "0e" + huge })
        {
            Assert.Equal("0", Wire.Canonical(JsonNode.Parse(zero)));
            Assert.Equal(0, Wire.Int(Wire.Obj("{\"n\":" + zero + "}"), "n"));
            var window = Wire.Obj("{\"daysOfWeek\":[\"monday\"],\"startLocalTime\":\"18:00\",\"endLocalTime\":\"19:00\",\"endDayOffset\":" + zero + "}");
            Wire.Validate(window, "AvailabilityWindow");
            Wire.NormalizeIntegers(window); Assert.Equal(0, window["endDayOffset"]!.GetValue<int>());
        }
        var invalid = Wire.Obj("{\"daysOfWeek\":[\"monday\"],\"startLocalTime\":\"18:00\",\"endLocalTime\":\"19:00\",\"endDayOffset\":1e" + huge + "}");
        Assert.Equal("validationFailed", Assert.Throws<DomainError>(() => Wire.Validate(invalid, "AvailabilityWindow")).Code);
        Assert.Equal("1e999999999999999999999999999999999996", Wire.Canonical(JsonNode.Parse("1.000e999999999999999999999999999999999996")));
    }
    [Fact]
    public void CanonicalTrailingZerosAllocateInProportionToInputSize()
    {
        var inputs = new[] { 1000, 2000, 4000 }.Select(count => (Count: count, Node: JsonNode.Parse("1" + new string('0', count))!)).ToArray();
        foreach (var input in inputs) for (int i = 0; i < 8; i++) Assert.Equal("1e" + input.Count, Wire.Canonical(input.Node));
        long[] allocations = new long[inputs.Length];
        for (int sample = 0; sample < inputs.Length; sample++)
        {
            long before = GC.GetAllocatedBytesForCurrentThread();
            for (int i = 0; i < 8; i++) Wire.Canonical(inputs[sample].Node);
            allocations[sample] = GC.GetAllocatedBytesForCurrentThread() - before;
        }
        Assert.True(allocations[0] > 0);
        Assert.True(allocations[2] <= allocations[0] * 6, $"Allocated {string.Join(", ", allocations)} bytes for 1000/2000/4000 zeros; expected bounded linear growth.");
    }
    [Fact]
    public void RepresentableBlocksRemainValidWhenWindowBoundariesExceedDateRange()
    {
        var dubai = Rules("[{\"daysOfWeek\":[\"monday\"],\"startLocalTime\":\"00:00\",\"endLocalTime\":\"23:00\",\"endDayOffset\":0}]");
        dubai["timezone"] = "Asia/Dubai";
        var start = TimeRules.Resolve(TimeRules.Local("0001-01-01T12:00:00"), TimeRules.Zone("Asia/Dubai"), "+04:00");
        TimeRules.CheckAvailability(dubai, start, start.AddMinutes(60), default);
        var utc = Rules("[{\"daysOfWeek\":[\"friday\"],\"startLocalTime\":\"09:00\",\"endLocalTime\":\"18:00\",\"endDayOffset\":0},{\"daysOfWeek\":[\"friday\"],\"startLocalTime\":\"22:00\",\"endLocalTime\":\"02:00\",\"endDayOffset\":1}]");
        utc["timezone"] = "Etc/UTC";
        TimeRules.CheckAvailability(utc, U("9999-12-31T10:00:00Z"), U("9999-12-31T11:00:00Z"), default);
        TimeRules.CheckAvailability(utc, U("9999-12-31T22:30:00Z"), U("9999-12-31T23:30:00Z"), default);
    }
    [Theory]
    [InlineData("18:00\n", "+03:00")]
    [InlineData("18:0٠", "+03:00")]
    [InlineData("18:00", "+03:00\n")]
    [InlineData("18:00", "+03:0٠")]
    public void ClockAndOffsetFieldsRejectTrailingLfAndNonAsciiDigits(string time, string offset)
    {
        var rules = Rules("[]");
        rules["windows"]!.AsArray().Add(new JsonObject { ["daysOfWeek"] = new JsonArray("monday"), ["startLocalTime"] = time, ["endLocalTime"] = "19:00", ["endDayOffset"] = 0 });
        if (time != "18:00") Assert.Equal("validationFailed", Assert.Throws<DomainError>(() => TimeRules.ValidateAvailability(rules)).Code);
        if (offset != "+03:00") Assert.Equal("validationFailed", Assert.Throws<DomainError>(() => TimeRules.Offset(offset)).Code);
        Assert.Throws<DomainError>(() => Wire.Validate(JsonValue.Create("validVersion\n"), "ServerVersion"));
        Assert.False(Wire.TryUuid(" 10000000-0000-4000-8000-000000000001 ", out _));
    }
}
