using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Vibe.Api.Features.D1;
using Vibe.Api.Features.Sync;
using Xunit;

namespace Vibe.Api.Tests;

public sealed partial class SyncIntegrationTests
{
    [Fact]
    public async Task R1S2PageSizeOneSplitsGroupAtFixedHeadThenTerminalCursorAcceptsFutureWrites()
    {
        using var session = await Account(now: R1Now()); var client = session.Client; var definition = await RuleDefinition(client); var baseline = await Bootstrap(client);
        var command = RuleCommand(definition); var rule = await CreateRule(client, definition, command); long groupHead = (await Stream(session.Owner)).LastSequence;
        var first = await Delta(client, Wire.Str(baseline, "asOfCursor"), "&pageSize=1"); Assert.Equal("s3", Wire.Str(first, "protocol")); Assert.True(first["hasMore"]!.GetValue<bool>());
        var position = Codec.ReadDelta(session.Owner, Wire.Str(first, "nextCursor")); Assert.Equal(groupHead, position.Horizon); Assert.Equal("recurrence", Wire.Str(first["changes"]![0]!["item"]!, "kind"));
        await Category(client, "append after group horizon"); var changes = new List<JsonNode> { first["changes"]![0]!.DeepClone() }; var page = first;
        while (page["hasMore"]!.GetValue<bool>()) { page = await Delta(client, Wire.Str(page, "nextCursor")); changes.AddRange(page["changes"]!.AsArray().Select(c => c!.DeepClone())); }
        Assert.Equal(32, changes.Count); Assert.All(changes, c => Assert.Equal(Wire.Str(command, "opId"), Wire.Str(c, "opId")));
        var tail = Codec.ReadDelta(session.Owner, Wire.Str(page, "nextCursor")); Assert.Null(tail.Horizon); Assert.Null(tail.PageSize); Assert.Equal(groupHead, tail.After);
        var future = await Delta(client, Wire.Str(page, "nextCursor")); Assert.Equal("append after group horizon", Wire.Str(Assert.Single(future["changes"]!.AsArray())!["item"]!["value"]!, "name"));
        var stopped = await StopRule(client, rule); var snapshot = await Bootstrap(client, 100); var items = snapshot["items"]!.AsArray();
        Assert.Equal("recurrence", Wire.Str(items.Last()!, "kind")); Assert.True(JsonNode.DeepEquals(stopped["rule"], items.Last()!["value"]));
        Assert.Equal(31, items.Count(i => Wire.Str(i!, "kind") == "occurrence"));
        var provider = fixture.App.Services.GetRequiredService<IDataProtectionProvider>();
        string oldDelta = provider.CreateProtector("Vibe.S1.Delta", "s1", session.Owner).Protect(JsonSerializer.Serialize(tail));
        string oldPage = provider.CreateProtector("Vibe.S1.BootstrapPage", "s1", session.Owner).Protect(JsonSerializer.Serialize(new BootstrapPosition(Guid.Parse(Wire.Str(snapshot, "streamId")), Guid.Parse(Wire.Str(snapshot, "snapshotId")), 1, 100)));
        await Error(await client.GetAsync(CursorPath("changes", oldDelta)), HttpStatusCode.BadRequest, "invalidCursor");
        await Error(await client.GetAsync(CursorPath("bootstrap", oldPage)), HttpStatusCode.BadRequest, "invalidCursor");
        Assert.Equal(tail.StreamId.ToString("D"), Wire.Str(snapshot, "streamId")); // protocol upgrade itself does not reset the stream.
    }

    [Fact]
    public async Task R1BootstrapItemCapIncludesStoppedAndFutureRulesWithoutDroppingHistory()
    {
        await using var app = new TestApp(fixture.Connection, fixture.Clock, new Dictionary<string, string?> { ["Sync:MaxSnapshotItems"] = "4" });
        using var session = await Account(app, now: R1Now()); var client = session.Client; var definition = await RuleDefinition(client);
        var rule = await CreateRule(client, definition, RuleCommand(definition, "2026-12-01")); await StopRule(client, rule); await Category(client);
        var snapshot = await Bootstrap(client, 100); Assert.Equal(4, snapshot["items"]!.AsArray().Count); Assert.Equal("recurrence", Wire.Str(snapshot["items"]!.AsArray().Last()!, "kind"));
        await Category(client); await Error(await client.GetAsync("/api/v1/sync/bootstrap"), HttpStatusCode.Conflict, "syncSnapshotTooLarge");
        await using var actual = Db(); Assert.Single(await actual.RecurrenceRules.Where(r => r.UserId == session.Owner).ToListAsync()); Assert.Equal(2, await actual.Categories.CountAsync(c => c.UserId == session.Owner)); Assert.Single(await actual.SyncSnapshots.Where(s => s.UserId == session.Owner).ToListAsync());
    }
}
