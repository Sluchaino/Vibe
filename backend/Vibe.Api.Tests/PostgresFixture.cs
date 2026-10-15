using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Vibe.Api.Data;
using Xunit;

namespace Vibe.Api.Tests;

public sealed class TestClock : TimeProvider
{
    long ticks;
    long frozen;
    int fixedClock;
    public override DateTimeOffset GetUtcNow() => (Volatile.Read(ref fixedClock) == 1 ? new DateTimeOffset(Interlocked.Read(ref frozen), TimeSpan.Zero) : DateTimeOffset.UtcNow).AddTicks(Interlocked.Read(ref ticks));
    public void Advance(TimeSpan value) => Interlocked.Add(ref ticks, value.Ticks);
    public void SetUtcNow(DateTimeOffset value)
    {
        Interlocked.Exchange(ref frozen, value.UtcTicks); Interlocked.Exchange(ref ticks, 0);
        Volatile.Write(ref fixedClock, 1);
    }
    public void Reset() { Interlocked.Exchange(ref ticks, 0); Volatile.Write(ref fixedClock, 0); }
}
public sealed class TestApp(string connection, TestClock clock, IReadOnlyDictionary<string, string?>? overrides = null) : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.ConfigureAppConfiguration((_, config) =>
        {
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
            ["ConnectionStrings:Vibe"] = connection,
            ["Testing:SeedUsers:0:UserName"] = "anna",
            ["Testing:SeedUsers:0:Password"] = PostgresFixture.Password,
            ["Testing:SeedUsers:1:UserName"] = "boris",
            ["Testing:SeedUsers:1:Password"] = PostgresFixture.Password,
            ["Testing:SeedUsers:2:UserName"] = "lockout-user",
            ["Testing:SeedUsers:2:Password"] = PostgresFixture.Password,
            ["Auth:SessionHours"] = "24", ["Auth:MaxFailedAccessAttempts"] = "5", ["Auth:LockoutMinutes"] = "15"
            });
            if (overrides is not null) config.AddInMemoryCollection(overrides);
        });
        builder.ConfigureServices(s =>
        {
            s.AddSingleton<TimeProvider>(clock);
            s.Configure<CookieAuthenticationOptions>(IdentityConstants.ApplicationScheme, o => o.TimeProvider = clock);
        });
    }
    public HttpClient Client() => CreateClient(new WebApplicationFactoryClientOptions { BaseAddress = new Uri("https://localhost"), AllowAutoRedirect = false, HandleCookies = true });
}
public sealed class PostgresFixture : IAsyncLifetime
{
    // This credential belongs exclusively to disposable test accounts; never to local development accounts.
    public const string Password = "Testing-only!Password1";
    public string Connection { get; private set; } = "";
    public string Schema { get; } = "vibe_test_" + Guid.NewGuid().ToString("N");
    public TestClock Clock { get; } = new();
    public TestApp App { get; private set; } = null!;
    string adminConnection = "";
    public async Task InitializeAsync()
    {
        adminConnection = Environment.GetEnvironmentVariable("VIBE_TEST_CONNECTION") ?? throw new InvalidOperationException("Set VIBE_TEST_CONNECTION to the dedicated vibe_d1_tests PostgreSQL database.");
        var builder = new NpgsqlConnectionStringBuilder(adminConnection);
        if (builder.Database != "vibe_d1_tests" || !Schema.StartsWith("vibe_test_", StringComparison.Ordinal) || !System.Text.RegularExpressions.Regex.IsMatch(Schema, "^vibe_test_[a-f0-9]{32}$")) throw new InvalidOperationException("Unsafe test database/schema.");
        builder.SearchPath = Schema; Connection = builder.ConnectionString;
        await using (var conn = new NpgsqlConnection(adminConnection))
        {
            await conn.OpenAsync();
            await using var command = new NpgsqlCommand("CREATE SCHEMA \"" + Schema + "\"", conn); await command.ExecuteNonQueryAsync();
        }
        await using (var db = new VibeDb(new DbContextOptionsBuilder<VibeDb>().UseNpgsql(Connection).Options))
        {
            // Disposable isolated model schema. Real development uses migrations, not EnsureCreated.
            await db.Database.ExecuteSqlRawAsync(db.Database.GenerateCreateScript());
        }
        App = new TestApp(Connection, Clock);
        using var client = App.Client(); await client.GetAsync("/health");
    }
    public async Task DisposeAsync()
    {
        if (App is not null) await App.DisposeAsync();
        var builder = new NpgsqlConnectionStringBuilder(adminConnection);
        if (builder.Database != "vibe_d1_tests" || !System.Text.RegularExpressions.Regex.IsMatch(Schema, "^vibe_test_[a-f0-9]{32}$")) throw new InvalidOperationException("Unsafe cleanup target.");
        await using var connection = new NpgsqlConnection(adminConnection); await connection.OpenAsync();
        await using var command = new NpgsqlCommand("DROP SCHEMA \"" + Schema + "\" CASCADE", connection); await command.ExecuteNonQueryAsync();
    }
}
