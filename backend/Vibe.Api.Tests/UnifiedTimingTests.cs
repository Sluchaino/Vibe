using System.Text.Json.Nodes;
using Vibe.Api.Features.D1;
using Xunit;

namespace Vibe.Api.Tests;

public sealed class UnifiedTimingTests
{
    internal static JsonObject Constraints(string origin = "interval", int? minutes = null) => new()
    {
        ["durationPolicy"] = minutes is int n ? new JsonObject { ["mode"] = "fixedWork", ["requiredWorkMinutes"] = n } : null,
        ["workOrigin"] = origin, ["splitAllowed"] = false, ["mobilityPolicy"] = "movable", ["requiredRestMinutes"] = 0,
        ["placeId"] = "10000000-0000-4000-8000-000000000001", ["availabilityRules"] = Wire.Obj("{\"timezone\":\"Europe/Berlin\",\"windows\":[],\"dateExceptions\":[]}")
    };
    internal static JsonObject Intent(string? start, string? end = null, int offset = 0, string zone = "Europe/Berlin", string? startChoice = null, string? endChoice = null)
        => new() { ["timezone"] = zone, ["startLocalTime"] = start, ["endLocalTime"] = end, ["endDayOffset"] = offset, ["startDisambiguation"] = startChoice, ["endDisambiguation"] = endChoice };
    [Theory]
    [InlineData("earlier", 120, "2026-10-25T00:30:00Z")]
    [InlineData("later", 60, "2026-10-25T01:30:00Z")]
    public void FoldPreferenceSelectsElapsedVolumeWithoutChangingInput(string choice, int minutes, string start)
    {
        var constraints = Constraints(); var intent = Intent("02:30", "03:30", startChoice: choice); string input = Wire.Json(constraints);
        var result = TimingRules.Resolve(constraints, new DateOnly(2026, 10, 25), intent, true);
        Assert.Equal(minutes, U1Projection.Work(result.Constraints)); Assert.Equal(start, Wire.Str(result.Timing!, "startInstant")); Assert.Null(result.Issue); Assert.Equal(input, Wire.Json(constraints));
    }
    [Theory]
    [InlineData(3, 29, "invalidLocalTime")]
    [InlineData(10, 25, "ambiguousLocalTime")]
    public void MissingDstResolutionKeepsUnknownIntervalVolumeAndManualVolume(int month, int day, string issue)
    {
        var intent = Intent("02:30", "03:30"); var date = new DateOnly(2026, month, day);
        foreach (bool manual in new[] { false, true })
        {
            var result = TimingRules.Resolve(manual ? Constraints("manual", 90) : Constraints(), date, intent, true);
            Assert.Equal(issue, result.Issue); Assert.Null(result.Timing); Assert.Equal(manual ? 90 : null, U1Projection.Work(result.Constraints));
        }
    }
    [Theory]
    [InlineData(true, "2026-10-24T23:30:00Z", "2026-10-25T01:30:00Z")]
    [InlineData(false, "2026-10-25T00:00:00Z", "2026-10-25T02:00:00Z")]
    public void SingleBoundaryAndManualWorkUseUtcArithmeticAcrossFold(bool start, string expectedStart, string expectedEnd)
    {
        var result = TimingRules.Resolve(Constraints("manual", 120), new DateOnly(2026, 10, 25), start ? Intent("01:30") : Intent(null, "03:00"), true);
        Assert.Equal(expectedStart, Wire.Str(result.Timing!, "startInstant")); Assert.Equal(expectedEnd, Wire.Str(result.Timing!, "endInstant")); Assert.Equal(120, U1Projection.Work(result.Constraints));
    }
    [Theory]
    [InlineData("interval", null)]
    [InlineData("unspecified", null)]
    [InlineData("manual", 90)]
    public void InitialContradictionRejectsAndFutureContradictionKeepsProvenance(string origin, int? work)
    {
        var intent = Intent("09:00", "11:00"); if (origin == "interval") intent["endLocalTime"] = "08:00";
        Assert.Equal("validationFailed", Assert.Throws<DomainError>(() => TimingRules.Resolve(Constraints(origin, work), new DateOnly(2026, 10, 17), intent, true)).Code);
        var future = TimingRules.Resolve(Constraints(origin, work), new DateOnly(2026, 10, 17), intent, false);
        Assert.Equal("workMismatch", future.Issue); Assert.Null(future.Timing); Assert.Equal(work, U1Projection.Work(future.Constraints));
    }
    [Theory]
    [InlineData("09:00", null)]
    [InlineData(null, "11:00")]
    public void UnknownPartialIntentDoesNotInventWorkOrBoundary(string? start, string? end)
    {
        var result = TimingRules.Resolve(Constraints("unspecified"), new DateOnly(2026, 10, 17), Intent(start, end), true);
        Assert.Null(result.Timing); Assert.Null(result.Issue); Assert.Null(U1Projection.Work(result.Constraints));
    }
    [Fact]
    public void OvernightRequiresExplicitDayAndBoundsNeverLoseKnownWork()
    {
        var date = new DateOnly(2026, 10, 17);
        Assert.Throws<DomainError>(() => TimingRules.Resolve(Constraints(), date, Intent("23:00", "01:00"), true));
        Assert.Equal(120, U1Projection.Work(TimingRules.Resolve(Constraints(), date, Intent("23:00", "01:00", 1), true).Constraints));
        var outside = TimingRules.Resolve(Constraints("manual", 90), DateOnly.MaxValue, Intent("23:00", zone: "Etc/UTC"), true);
        Assert.Equal("outOfRange", outside.Issue); Assert.Equal(90, U1Projection.Work(outside.Constraints));
        var before = TimingRules.Resolve(Constraints("manual", 90), DateOnly.MinValue, Intent("00:00", zone: "Asia/Dubai"), true);
        Assert.Equal("outOfRange", before.Issue); Assert.Equal(90, U1Projection.Work(before.Constraints));
        var large = TimingRules.Resolve(Constraints("manual", int.MaxValue), DateOnly.MinValue, Intent("12:00", zone: "Etc/UTC"), true);
        Assert.NotNull(large.Timing); Assert.Equal(int.MaxValue, U1Projection.Work(large.Constraints));
    }
    [Fact]
    public void StrictInputsRejectReadonlyIntervalNNullDateAndEmptyOrMalformedIntent()
    {
        Assert.Throws<DomainError>(() => Wire.Validate(Constraints("interval", 90), "ConstraintsInputU1"));
        Assert.Throws<DomainError>(() => TimingRules.Resolve(Constraints("manual", 90), null, Intent("09:00"), true));
        foreach (var intent in new[] { Intent(null), Intent("09:00\n"), Intent("٠٩:٠٠"), Intent("09:00", offset: 1), Intent(null, "11:00", startChoice: "earlier") })
            Assert.Throws<DomainError>(() => TimingRules.ValidateIntent(intent));
        Assert.Throws<DomainError>(() => TimingRules.Resolve(Constraints(), new DateOnly(2026, 10, 17), null, true));
        Assert.Equal("workMismatch", TimingRules.Resolve(Constraints(), new DateOnly(2026, 10, 17), null, false).Issue);
    }
    [Theory]
    [InlineData("9999-12-31", "23:00", null, "Europe/Moscow")]
    [InlineData("0001-01-01", null, "01:00", "America/New_York")]
    public void DerivedBoundaryMustFitLocalCalendarEvenWhenBothUtcInstantsFit(string date, string? start, string? end, string zone)
    {
        var result = TimingRules.Resolve(Constraints("manual", 120), TimeRules.Date(date), Intent(start, end, zone: zone), true);
        Assert.Equal("outOfRange", result.Issue); Assert.Null(result.Timing); Assert.Equal(120, U1Projection.Work(result.Constraints));
    }
}
