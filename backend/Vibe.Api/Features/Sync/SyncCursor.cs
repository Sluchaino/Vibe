using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Vibe.Api.Features.D1;

namespace Vibe.Api.Features.Sync;

public sealed record BootstrapPosition(Guid StreamId, Guid SnapshotId, int NextOrdinal, int PageSize);
public sealed record DeltaPosition(Guid StreamId, long After, long? Horizon = null, int? PageSize = null);

public sealed class SyncCursor(IDataProtectionProvider protection)
{
    IDataProtector Protector(string owner, bool page) => protection.CreateProtector(page ? "Vibe.S1.BootstrapPage" : "Vibe.S1.Delta", "s1", owner);
    public string Page(string owner, BootstrapPosition position) => Protector(owner, true).Protect(JsonSerializer.Serialize(position));
    public string Delta(string owner, DeltaPosition position) => Protector(owner, false).Protect(JsonSerializer.Serialize(position));
    T Read<T>(string owner, string token, bool page)
    {
        if (token.Length is < 1 or > 2000) throw Invalid();
        try { return JsonSerializer.Deserialize<T>(Protector(owner, page).Unprotect(token)) ?? throw Invalid(); }
        catch (Exception e) when (e is CryptographicException or JsonException or NotSupportedException or ArgumentException) { throw Invalid(); }
    }
    public BootstrapPosition ReadPage(string owner, string token)
    {
        var value = Read<BootstrapPosition>(owner, token, true);
        if (value.StreamId == Guid.Empty || value.SnapshotId == Guid.Empty || value.NextOrdinal < 0 || value.PageSize is < 1 or > 100) throw Invalid();
        return value;
    }
    public DeltaPosition ReadDelta(string owner, string token)
    {
        var value = Read<DeltaPosition>(owner, token, false);
        if (value.StreamId == Guid.Empty || value.After < 0 || value.Horizon < 0 || value.Horizon is not null && value.After > value.Horizon
            || (value.Horizon is null) != (value.PageSize is null) || value.PageSize is < 1 or > 100) throw Invalid();
        return value;
    }
    public static DomainError Invalid() => new(400, "invalidCursor");
}
