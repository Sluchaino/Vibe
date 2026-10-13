using System.Security.Claims;
using System.Security.Cryptography.X509Certificates;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Vibe.Api.Data;
using Vibe.Api.Features.D1;

var builder = WebApplication.CreateBuilder(args);
string? localConfig = null;
if (builder.Environment.IsDevelopment())
{
    localConfig = Environment.GetEnvironmentVariable("VIBE_LOCAL_CONFIG");
    if (localConfig is null || !Path.IsPathFullyQualified(localConfig) || !File.Exists(localConfig))
        throw new InvalidOperationException("Development requires an absolute VIBE_LOCAL_CONFIG path to private configuration.");
    builder.Configuration.AddJsonFile(localConfig, optional: false, reloadOnChange: false);
    builder.Configuration.AddCommandLine(args);
    string certificate = builder.Configuration["LocalHttps:CertificatePath"] ?? throw new InvalidOperationException("Local HTTPS certificate is required.");
    string key = builder.Configuration["LocalHttps:KeyPath"] ?? throw new InvalidOperationException("Local HTTPS key is required.");
    using var pem = X509Certificate2.CreateFromPemFile(certificate, key);
    var tls = X509CertificateLoader.LoadPkcs12(pem.Export(X509ContentType.Pfx), null);
    builder.WebHost.ConfigureKestrel(k =>
    {
        k.Listen(System.Net.IPAddress.Loopback, 5080);
        k.ListenLocalhost(5443, endpoint => endpoint.UseHttps(tls));
        k.Limits.MaxRequestBodySize = 1024 * 1024;
    });
}
builder.Services.AddDbContext<VibeDb>(options => options.UseNpgsql(builder.Configuration.GetConnectionString("Vibe") ?? throw new InvalidOperationException("PostgreSQL configuration is required.")));
builder.Services.AddScoped<D1Service>();
builder.Services.AddIdentity<VibeUser, IdentityRole>(options =>
{
    options.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(builder.Configuration.GetValue("Auth:LockoutMinutes", 15));
    options.Lockout.MaxFailedAccessAttempts = builder.Configuration.GetValue("Auth:MaxFailedAccessAttempts", 5);
    options.Lockout.AllowedForNewUsers = true;
}).AddEntityFrameworkStores<VibeDb>().AddDefaultTokenProviders();
builder.Services.ConfigureApplicationCookie(options =>
{
    options.Cookie.Name = "__Host-Vibe.Session";
    options.Cookie.HttpOnly = true;
    options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
    options.Cookie.SameSite = SameSiteMode.Strict;
    options.Cookie.Path = "/";
    options.ExpireTimeSpan = TimeSpan.FromHours(builder.Configuration.GetValue("Auth:SessionHours", 24));
    options.SlidingExpiration = false;
    options.Events.OnRedirectToLogin = c => Error(c.HttpContext, 401, "unauthorized");
    options.Events.OnRedirectToAccessDenied = c => Error(c.HttpContext, 403, "forbidden");
});
builder.Services.AddAuthorization();
builder.Services.AddAntiforgery(options =>
{
    options.HeaderName = "X-CSRF-TOKEN";
    options.Cookie.Name = "__Host-Vibe.Antiforgery";
    options.Cookie.HttpOnly = true;
    options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
    options.Cookie.SameSite = SameSiteMode.Strict;
    options.Cookie.Path = "/";
});
var dataProtection = builder.Services.AddDataProtection().SetApplicationName("Vibe.D1");
if (builder.Environment.IsEnvironment("Testing")) dataProtection.UseEphemeralDataProtectionProvider();
if (localConfig is not null)
{
    dataProtection.PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(Path.GetDirectoryName(localConfig)!, "data-protection")));
    if (OperatingSystem.IsWindows()) dataProtection.ProtectKeysWithDpapi();
}
builder.Logging.AddFilter("Microsoft.EntityFrameworkCore.Database.Command", LogLevel.Warning);
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
var app = builder.Build();

if (app.Environment.IsDevelopment() || app.Environment.IsEnvironment("Testing"))
{
    await using var scope = app.Services.CreateAsyncScope();
    var db = scope.ServiceProvider.GetRequiredService<VibeDb>();
    if (app.Environment.IsDevelopment() && app.Configuration.GetValue("LocalDevelopment:ApplyMigrations", false)) await db.Database.MigrateAsync();
    var seedSection = app.Configuration.GetSection(app.Environment.IsEnvironment("Testing") ? "Testing:SeedUsers" : "LocalDevelopment:SeedUsers");
    var users = scope.ServiceProvider.GetRequiredService<UserManager<VibeUser>>();
    foreach (var seed in seedSection.GetChildren())
    {
        string name = seed["UserName"] ?? throw new InvalidOperationException("Seed username is required.");
        var user = await users.FindByNameAsync(name);
        if (user is null)
        {
            user = new VibeUser { UserName = name };
            var created = await users.CreateAsync(user, seed["Password"] ?? throw new InvalidOperationException("Seed password is required."));
            if (!created.Succeeded) throw new InvalidOperationException("Local account creation failed validation.");
        }
        if (!await db.Plans.AnyAsync(x => x.UserId == user.Id)) db.Plans.Add(new PlanRow { UserId = user.Id });
        if (!await db.Settings.AnyAsync(x => x.UserId == user.Id))
        {
            string timezone = seed["Timezone"] ?? "Europe/Moscow"; TimeRules.Zone(timezone);
            db.Settings.Add(new SettingsRow { UserId = user.Id, Timezone = timezone });
        }
        await db.SaveChangesAsync();
    }
}
app.Use(async (ctx, next) =>
{
    if (!ctx.Request.Path.StartsWithSegments("/api", StringComparison.OrdinalIgnoreCase)) { await next(ctx); return; }
    ctx.Response.Headers.CacheControl = "no-store";
    ctx.Response.Headers["X-Correlation-ID"] = ctx.TraceIdentifier;
    try
    {
        if (!ctx.Request.IsHttps) throw new DomainError(403, "forbidden");
        await next(ctx);
    }
    catch (DomainError e) { await new ApiReply(e.Status, Wire.Json(Wire.Problem(ctx, e)), e.ETag).ExecuteAsync(ctx); }
    catch (OperationCanceledException) when (ctx.RequestAborted.IsCancellationRequested) { }
    catch (Exception)
    {
        // Transport failure is retryable and not a domain result. Do not expose request headers or private config.
        app.Logger.LogError("D1 infrastructure failure; correlation {CorrelationId}", ctx.TraceIdentifier);
        ctx.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
    }
});
app.UseAuthentication();
app.UseAuthorization();
app.Use(async (ctx, next) =>
{
    if (ctx.Request.Path.StartsWithSegments("/api/v1", StringComparison.OrdinalIgnoreCase) && ctx.Request.Method is "POST" or "PUT")
    {
        bool login = Wire.ResolvedPath(ctx.Request) == "/api/v1/auth/login";
        if (!login && ctx.User.Identity?.IsAuthenticated != true) throw new DomainError(401, "unauthorized");
        try { await ctx.RequestServices.GetRequiredService<IAntiforgery>().ValidateRequestAsync(ctx); }
        catch (AntiforgeryValidationException) { throw new DomainError(403, "invalidAntiforgery"); }
    }
    await next(ctx);
});
app.MapGet("/health", () => Results.Json(new { status = "ok" }));
var api = app.MapGroup("/api/v1");
api.MapGet("/auth/antiforgery", (HttpContext c, IAntiforgery antiforgery) =>
{
    Wire.Query(c.Request);
    var tokens = antiforgery.GetAndStoreTokens(c);
    return ApiReply.Json(new System.Text.Json.Nodes.JsonObject { ["requestToken"] = tokens.RequestToken, ["headerName"] = "X-CSRF-TOKEN" });
});
api.MapPost("/auth/login", async (HttpContext c, SignInManager<VibeUser> signIn, UserManager<VibeUser> users) =>
{
    Wire.Query(c.Request); var body = await Wire.Parse(c.Request, c.RequestAborted); Wire.Validate(body, "LoginRequest");
    var name = Wire.Str(body, "userName");
    var result = await signIn.PasswordSignInAsync(name, Wire.Str(body, "password"), isPersistent: false, lockoutOnFailure: true);
    if (!result.Succeeded) throw new DomainError(401, "invalidCredentials");
    var user = (await users.FindByNameAsync(name))!;
    return ApiReply.Json(new System.Text.Json.Nodes.JsonObject { ["userId"] = user.Id, ["userName"] = user.UserName });
});
api.MapPost("/auth/logout", async (HttpContext c, SignInManager<VibeUser> signIn) =>
{
    Wire.Query(c.Request);
    if (c.Request.ContentLength > 0 || c.Request.Headers.ContainsKey("Transfer-Encoding")) Wire.Bad();
    if (c.Request.ContentLength is null && await c.Request.Body.ReadAsync(new byte[1], c.RequestAborted) != 0) Wire.Bad();
    await signIn.SignOutAsync(); return new ApiReply(204, "");
}).RequireAuthorization();
api.MapGet("/me", (HttpContext c) =>
{
    Wire.Query(c.Request);
    return ApiReply.Json(new System.Text.Json.Nodes.JsonObject { ["userId"] = c.User.FindFirstValue(ClaimTypes.NameIdentifier), ["userName"] = c.User.Identity!.Name });
}).RequireAuthorization();
var domain = api.MapGroup("").RequireAuthorization();
domain.MapGet("/settings", (HttpContext c, D1Service d) => d.Read(c, "settings"));
domain.MapPut("/settings", (HttpContext c, D1Service d) => d.Mutate(c, "settings"));
domain.MapGet("/categories", (HttpContext c, D1Service d) => d.Read(c, "categories"));
domain.MapPost("/categories", (HttpContext c, D1Service d) => d.Mutate(c, "category"));
domain.MapGet("/task-definitions", (HttpContext c, D1Service d) => d.Read(c, "definitions"));
domain.MapPost("/task-definitions", (HttpContext c, D1Service d) => d.Mutate(c, "createDefinition"));
domain.MapGet("/task-definitions/{id}", (HttpContext c, D1Service d, string id) => d.Read(c, "definition", id));
domain.MapPut("/task-definitions/{id}", (HttpContext c, D1Service d, string id) => d.Mutate(c, "updateDefinition", id));
domain.MapPost("/task-definitions/{id}/occurrences", (HttpContext c, D1Service d, string id) => d.Mutate(c, "createOccurrence", id));
domain.MapGet("/occurrences", (HttpContext c, D1Service d) => d.Read(c, "occurrences"));
domain.MapGet("/occurrences/{id}", (HttpContext c, D1Service d, string id) => d.Read(c, "occurrence", id));
domain.MapPut("/occurrences/{id}", (HttpContext c, D1Service d, string id) => d.Mutate(c, "updateOccurrence", id));
domain.MapPost("/occurrences/{id}/placement", (HttpContext c, D1Service d, string id) => d.Mutate(c, "placement", id));
domain.MapGet("/calendar", (HttpContext c, D1Service d) => d.Read(c, "calendar"));
app.MapFallback("/api/{**path}", (HttpContext c) => new ApiReply(404, Wire.Json(Wire.Problem(c, new DomainError(404, "notFound")))).ExecuteAsync(c));
app.Run();

static Task Error(HttpContext c, int status, string code) => new ApiReply(status, Wire.Json(Wire.Problem(c, new DomainError(status, code)))).ExecuteAsync(c);
public partial class Program { }
