using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Vibe.Api.Data;
using Vibe.Api.Features.D1;
using Xunit;

namespace Vibe.Api.Tests;

public sealed partial class SyncIntegrationTests
{
    static string ETag(JsonObject response, string key = "occurrence") => ApiReply.Quote(Wire.Str(response[key]!, "serverVersion"));
    static string OccPath(JsonObject response) => "/api/v1/occurrences/" + Wire.Str(response["occurrence"]!, "id");
    static JsonObject Placement(JsonObject state, string action, bool allow = false)
    {
        var command = new JsonObject { ["opId"] = Id(), ["action"] = action, ["baseScheduleVersion"] = Wire.Str(state["planState"]!, "scheduleVersion"), ["allowFixedChange"] = allow };
        if (action is "place" or "move") { command["localStart"] = action == "place" ? "2026-10-16T10:00:00" : "2026-10-16T13:00:00"; command["timezone"] = "Europe/Moscow"; command["utcOffset"] = "+03:00"; }
        if (action == "setFixed") command["fixed"] = true;
        return command;
    }
    static async Task<JsonObject> Place(HttpClient client, JsonObject state, string action, bool allow = false)
        => await Json(await Send(client, HttpMethod.Post, OccPath(state) + "/placement", Placement(state, action, allow), ETag(state)));
    static JsonObject DefinitionCommand(string place, string? category = null) => new()
    {
        ["opId"] = Id(), ["id"] = Id(), ["title"] = "sync definition", ["description"] = "", ["categoryId"] = category,
        ["importance"] = "normal", ["difficulty"] = "medium", ["executionPriority"] = 3,
        ["durationPolicy"] = new JsonObject { ["mode"] = "fixedWork", ["requiredWorkMinutes"] = 90 },
        ["splitAllowed"] = false, ["mobilityPolicy"] = "movable", ["requiredRestMinutes"] = 0, ["placeId"] = place,
        ["availabilityRules"] = Wire.Obj("{\"timezone\":\"Europe/Moscow\",\"windows\":[],\"dateExceptions\":[]}")
    };
    static async Task<string> SetupPlace(HttpClient client)
    {
        var response = await client.GetAsync("/api/v1/settings"); var current = await Json(response);
        string place = Id();
        await Json(await Send(client, HttpMethod.Put, "/api/v1/settings", new JsonObject
        {
            ["opId"] = Id(), ["timezone"] = "Europe/Moscow", ["weekStartsOn"] = "monday",
            ["place"] = new JsonObject { ["id"] = place, ["name"] = "Дом" }
        }, response.Headers.ETag!.ToString()));
        return place;
    }
    static async Task<JsonObject> NewOccurrence(HttpClient client, JsonObject definition)
        => await Json(await Send(client, HttpMethod.Post, "/api/v1/task-definitions/" + Wire.Str(definition["definition"]!, "id") + "/occurrences",
            new JsonObject { ["opId"] = Id(), ["id"] = Id(), ["definitionVersion"] = Wire.Str(definition["definition"]!, "serverVersion"), ["logicalDate"] = "2026-10-15" }), HttpStatusCode.Created);

    [Fact]
    public async Task EveryDomainWriterPublishesFreshAggregateWhileC1NoopsErrorsAndHistoryRemainUnchanged()
    {
        using var session = await Account(); var client = session.Client; var initial = await Bootstrap(client);
        string place = await SetupPlace(client); var category = await Category(client);
        var create = DefinitionCommand(place, Wire.Str(category["category"]!, "id"));
        var definition = await Json(await Send(client, HttpMethod.Post, "/api/v1/task-definitions", create), HttpStatusCode.Created);
        var update = create.DeepClone().AsObject(); update.Remove("id"); update["opId"] = Id(); update["title"] = "updated metadata";
        definition = await Json(await Send(client, HttpMethod.Put, "/api/v1/task-definitions/" + Wire.Str(definition["definition"]!, "id"), update, ETag(definition, "definition")));
        var occurrence = await NewOccurrence(client, definition); string path = OccPath(occurrence);
        var edit = new JsonObject { ["opId"] = Id(), ["logicalDate"] = "2026-10-16", ["constraintsSnapshot"] = occurrence["occurrence"]!["constraintsSnapshot"]!.DeepClone(), ["allowFixedChange"] = false };
        occurrence = await Json(await Send(client, HttpMethod.Put, path, edit, ETag(occurrence)));
        occurrence = await Place(client, occurrence, "place"); occurrence = await Place(client, occurrence, "setFixed");
        string fixedBlock = Wire.Json(occurrence["occurrence"]!["calendarBlock"]!); var completedCommand = new JsonObject { ["opId"] = Id() };
        occurrence = await Json(await Send(client, HttpMethod.Post, path + "/completion", completedCommand, ETag(occurrence)));
        string completion = Wire.Str(occurrence["occurrence"]!["completion"]!, "id"); long completedHead = (await Stream(session.Owner)).LastSequence;
        var noOp = await Json(await Send(client, HttpMethod.Post, path + "/completion", new JsonObject { ["opId"] = Id() }, ETag(occurrence)));
        Assert.True(JsonNode.DeepEquals(occurrence, noOp)); Assert.Equal(completedHead, (await Stream(session.Owner)).LastSequence);
        var invalid = Placement(occurrence, "unplace", true);
        var failed = await Send(client, HttpMethod.Post, path + "/placement", invalid, ETag(occurrence));
        string failedBytes = await failed.Content.ReadAsStringAsync(); await Error(failed, HttpStatusCode.Conflict, "occurrenceCompleted");
        var failedReplay = await Send(client, HttpMethod.Post, path + "/placement", invalid, ETag(occurrence));
        Assert.Equal(failedBytes, await failedReplay.Content.ReadAsStringAsync()); Assert.Equal("true", failedReplay.Headers.GetValues("Idempotency-Replayed").Single());
        Assert.Equal(completedHead, (await Stream(session.Owner)).LastSequence);
        var reopenBody = new JsonObject { ["opId"] = Id(), ["completionId"] = completion };
        occurrence = await Json(await Send(client, HttpMethod.Post, path + "/completion/reopen", reopenBody, ETag(occurrence)));
        var reopened = occurrence.DeepClone();
        await Json(await Send(client, HttpMethod.Post, path + "/completion/reopen", new JsonObject { ["opId"] = Id(), ["completionId"] = completion }, ETag(occurrence)));
        occurrence = await Place(client, occurrence, "move", true); occurrence = await Place(client, occurrence, "unplace", true);
        var delta = await Delta(client, Wire.Str(initial, "asOfCursor"), "&pageSize=100"); var changes = delta["changes"]!.AsArray();
        Assert.Equal(12, changes.Count); Assert.Equal(12, (await Stream(session.Owner)).LastSequence);
        Assert.Equal(new[] { "settings", "category", "definition", "definition", "occurrence", "occurrence", "occurrence", "occurrence", "occurrence", "occurrence", "occurrence", "occurrence" }, changes.Select(c => Wire.Str(c!["item"]!, "kind")));
        Assert.Equal("sync definition", Wire.Str(changes[2]!["item"]!["value"]!, "title")); Assert.Equal("updated metadata", Wire.Str(changes[3]!["item"]!["value"]!, "title"));
        Assert.Equal("input_1", Wire.Str(changes[1]!["planState"]!, "planningInputRevision"));
        var completed = changes[8]!["item"]!["value"]!; var revoked = changes[9]!["item"]!["value"]!;
        Assert.Equal(0, Wire.Int(completed, "remainingWorkMinutes")); Assert.Equal(90, Wire.Int(revoked, "remainingWorkMinutes")); Assert.Null(revoked["completion"]);
        Assert.True(JsonNode.DeepEquals(Wire.Obj(fixedBlock), completed["calendarBlock"])); Assert.True(JsonNode.DeepEquals(Wire.Obj(fixedBlock), revoked["calendarBlock"]));
        Assert.True(JsonNode.DeepEquals(reopened!["occurrence"], revoked)); Assert.Null(changes[11]!["item"]!["value"]!["calendarBlock"]);
        Assert.Equal("2026-10-16T10:00:00Z", Wire.Str(changes[10]!["item"]!["value"]!["calendarBlock"]!, "startInstant")); // move is 13:00 Moscow.
        Assert.True(JsonNode.DeepEquals(occurrence["occurrence"], changes[11]!["item"]!["value"]));
        await using var db = Db(); var fact = await db.Completions.SingleAsync(c => c.UserId == session.Owner);
        Assert.NotNull(fact.RevokedAtUtc); Assert.Contains("constraintsSnapshot", fact.OccurrenceSnapshotJson);
        foreach (var change in changes) Assert.DoesNotContain("occurrenceSnapshotJson", Wire.Json(change!));
    }

    [Fact]
    public async Task ConcurrentSameOperationAndSeparateCommandsCommitOneOrderedChangeEach()
    {
        using var session = await Account(); var client = session.Client; var before = await Bootstrap(client);
        var same = new JsonObject { ["opId"] = Id(), ["id"] = Id(), ["name"] = "same" };
        var duplicates = await Task.WhenAll(Send(client, HttpMethod.Post, "/api/v1/categories", same), Send(client, HttpMethod.Post, "/api/v1/categories", same));
        Assert.Equal(await duplicates[0].Content.ReadAsStringAsync(), await duplicates[1].Content.ReadAsStringAsync());
        Assert.Single(duplicates, r => r.Headers.GetValues("Idempotency-Replayed").Single() == "true");
        await Task.WhenAll(Enumerable.Range(0, 8).Select(i => Category(client, "parallel " + i)));
        var delta = await Delta(client, Wire.Str(before, "asOfCursor")); Assert.Equal(9, delta["changes"]!.AsArray().Count);
        await using var db = Db(); var sequence = await db.SyncChanges.Where(c => c.UserId == session.Owner).OrderBy(c => c.Sequence).Select(c => c.Sequence).ToArrayAsync();
        Assert.Equal(Enumerable.Range(1, 9).Select(i => (long)i), sequence);
        Assert.Equal(9, await db.Operations.CountAsync(o => o.UserId == session.Owner)); Assert.Equal(0, (await db.Plans.SingleAsync(p => p.UserId == session.Owner)).InputRevision);
    }

    async Task Sql(string sql)
    {
        await using var connection = new NpgsqlConnection(fixture.Connection); await connection.OpenAsync();
        await using var command = new NpgsqlCommand(sql, connection); await command.ExecuteNonQueryAsync();
    }
    [Fact]
    public async Task PostgreSqlInsertFailureRollsBackDomainResultSequenceAndCanRetryOriginalOperation()
    {
        using var session = await Account(); var client = session.Client;
        string suffix = Guid.NewGuid().ToString("N"); string function = "sync_fail_" + suffix, trigger = "sync_fail_trigger_" + suffix;
        await Sql($$"""CREATE FUNCTION "{{function}}"() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'forced test insert failure'; END $fn$; CREATE TRIGGER "{{trigger}}" BEFORE INSERT ON "SyncChanges" FOR EACH ROW WHEN (NEW."UserId" = '{{session.Owner}}') EXECUTE FUNCTION "{{function}}"();""");
        var command = new JsonObject { ["opId"] = Id(), ["id"] = Id(), ["name"] = "rollback" };
        try
        {
            Assert.Equal(HttpStatusCode.ServiceUnavailable, (await Send(client, HttpMethod.Post, "/api/v1/categories", command)).StatusCode);
            await using var db = Db(); Assert.Equal(0, (await Stream(session.Owner)).LastSequence);
            Assert.False(await db.Categories.AnyAsync(c => c.UserId == session.Owner)); Assert.False(await db.Operations.AnyAsync(o => o.UserId == session.Owner)); Assert.False(await db.SyncChanges.AnyAsync(c => c.UserId == session.Owner));
        }
        finally { await Sql($"DROP TRIGGER \"{trigger}\" ON \"SyncChanges\"; DROP FUNCTION \"{function}\"();"); }
        await Category(client, command: command); Assert.Equal(1, (await Stream(session.Owner)).LastSequence);
    }

    [Fact]
    public async Task SequenceOverflowRollsBackWithoutWrappingOrSavingOperationResult()
    {
        using var session = await Account();
        await using (var db = Db()) await db.SyncStreams.Where(s => s.UserId == session.Owner).ExecuteUpdateAsync(u => u.SetProperty(s => s.LastSequence, long.MaxValue));
        var command = new JsonObject { ["opId"] = Id(), ["id"] = Id(), ["name"] = "overflow" };
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await Send(session.Client, HttpMethod.Post, "/api/v1/categories", command)).StatusCode);
        await using var actual = Db(); Assert.Equal(long.MaxValue, (await Stream(session.Owner)).LastSequence);
        Assert.False(await actual.Categories.AnyAsync(c => c.UserId == session.Owner)); Assert.False(await actual.Operations.AnyAsync(o => o.UserId == session.Owner));
    }
}
