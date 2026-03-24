using System.Net.Http;
using System.Net;
using System.Globalization;
using System.Text.Json;

sealed class GitHubTagUpdateClient
{
  private const string Owner = "DiffColor";
  private const string Repo = "OctOP";
  private const string ReleasesApiUrl = $"https://api.github.com/repos/{Owner}/{Repo}/releases?per_page=20";
  private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(15);
  private static readonly TimeSpan MinimumRateLimitBackoff = TimeSpan.FromMinutes(20);

  private static readonly HttpClient HttpClient = CreateHttpClient();
  private static readonly object ReleaseStateSync = new();
  private static readonly Dictionary<string, (DateTimeOffset CheckedAt, AppUpdateDescriptor? Descriptor)> CachedReleaseByTag = new(StringComparer.OrdinalIgnoreCase);
  private static DateTimeOffset _rateLimitBlockUntil = DateTimeOffset.MinValue;

  public async Task<AppUpdateDescriptor?> GetLatestWindowsReleaseAsync(string currentVersionTag, CancellationToken cancellationToken)
  {
    return await GetLatestReleaseAsync(currentVersionTag, cancellationToken);
  }

  private static async Task<AppUpdateDescriptor?> GetLatestReleaseAsync(string currentVersionTag, CancellationToken cancellationToken)
  {
    var now = DateTimeOffset.UtcNow;

    if (TryGetCachedRelease(currentVersionTag, now, out var cachedDescriptor))
    {
      return cachedDescriptor;
    }

    lock (ReleaseStateSync)
    {
      if (now < _rateLimitBlockUntil)
      {
        return null;
      }
    }

    if (!SemVersion.TryParse(currentVersionTag, out var currentVersion))
    {
      return null;
    }

    try
    {
      using var response = await HttpClient.GetAsync(ReleasesApiUrl, cancellationToken);

      if (response.StatusCode == HttpStatusCode.Forbidden &&
          TryResolveRateLimitReset(response, out var resetAt))
      {
        var nextCheck = resetAt > now ? resetAt : now.Add(MinimumRateLimitBackoff);
        lock (ReleaseStateSync)
        {
          _rateLimitBlockUntil = nextCheck;
        }

        if (TryGetCachedRelease(currentVersionTag, DateTimeOffset.UtcNow, out cachedDescriptor))
        {
          return cachedDescriptor;
        }

        throw new InvalidOperationException(
          $"GitHub API rate limit exceeded. 다음 확인 가능 시각(UTC): {nextCheck:yyyy-MM-dd HH:mm:ss} (현재 UTC={now:yyyy-MM-dd HH:mm:ss}).");
      }

      response.EnsureSuccessStatusCode();

      await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
      using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
      var candidates = new List<(SemVersion version, AppUpdateDescriptor release)>();
      var includePrerelease = !string.IsNullOrWhiteSpace(currentVersion.Suffix);

      foreach (var item in document.RootElement.EnumerateArray())
      {
        if (item.TryGetProperty("draft", out var draftProperty) && draftProperty.ValueKind == JsonValueKind.True)
        {
          continue;
        }

        if (!includePrerelease &&
            item.TryGetProperty("prerelease", out var prereleaseProperty) &&
            prereleaseProperty.ValueKind == JsonValueKind.True)
        {
          continue;
        }

        if (!item.TryGetProperty("tag_name", out var tagProperty))
        {
          continue;
        }

        var rawTag = tagProperty.GetString();
        if (string.IsNullOrWhiteSpace(rawTag))
        {
          continue;
        }

        if (!SemVersion.TryParse(rawTag, out var version))
        {
          continue;
        }

        var normalizedTag = AppMetadata.NormalizeVersionTag(rawTag);
        if (version.CompareTo(currentVersion) <= 0)
        {
          continue;
        }

        var expectedAssetName = $"OctOP.WindowsAgentMenu-win-x64-{normalizedTag}.exe";
        if (!TryResolveReleaseAsset(item, expectedAssetName, out var assetName, out var downloadUrl))
        {
          continue;
        }

        candidates.Add((version, new AppUpdateDescriptor
        {
          Tag = normalizedTag,
          AssetName = assetName,
          DownloadUrl = downloadUrl
        }));
      }

      var selected = candidates
        .OrderByDescending(static item => item.version)
        .Select(static item => item.release)
        .FirstOrDefault();

      lock (ReleaseStateSync)
      {
        CachedReleaseByTag[currentVersionTag] = (DateTimeOffset.UtcNow, selected);
        _rateLimitBlockUntil = DateTimeOffset.MinValue;
      }

      return selected;
    }
    catch (HttpRequestException) when (TryGetCachedRelease(currentVersionTag, DateTimeOffset.UtcNow, out cachedDescriptor))
    {
      return cachedDescriptor;
    }
    catch (JsonException) when (TryGetCachedRelease(currentVersionTag, DateTimeOffset.UtcNow, out cachedDescriptor))
    {
      return cachedDescriptor;
    }
  }

  private static bool TryGetCachedRelease(string currentVersionTag, DateTimeOffset now, out AppUpdateDescriptor? descriptor)
  {
    lock (ReleaseStateSync)
    {
      if (!CachedReleaseByTag.TryGetValue(currentVersionTag, out var cached) ||
          now - cached.CheckedAt > CacheTtl)
      {
        descriptor = null;
        return false;
      }

      descriptor = cached.Descriptor;
      return true;
    }
  }

  private static bool TryResolveRateLimitReset(HttpResponseMessage response, out DateTimeOffset resetAt)
  {
    resetAt = DateTimeOffset.UtcNow;

    if (!response.Headers.TryGetValues("X-RateLimit-Reset", out var values) ||
        values is null)
    {
      return false;
    }

    var rawReset = values.FirstOrDefault();
    if (string.IsNullOrWhiteSpace(rawReset))
    {
      return false;
    }

    if (!long.TryParse(rawReset, NumberStyles.Integer, CultureInfo.InvariantCulture, out var epochSeconds))
    {
      return false;
    }

    resetAt = DateTimeOffset.FromUnixTimeSeconds(epochSeconds);
    return true;
  }

  private static bool TryResolveReleaseAsset(
    JsonElement release,
    string expectedAssetName,
    out string assetName,
    out Uri downloadUrl)
  {
    assetName = string.Empty;
    downloadUrl = new Uri("https://example.com");

    if (!release.TryGetProperty("assets", out var assetsProperty) || assetsProperty.ValueKind != JsonValueKind.Array)
    {
      return false;
    }

    JsonElement? fallbackAsset = null;

    foreach (var asset in assetsProperty.EnumerateArray())
    {
      if (!asset.TryGetProperty("name", out var assetNameProperty))
      {
        continue;
      }

      var candidateName = assetNameProperty.GetString();
      if (string.IsNullOrWhiteSpace(candidateName))
      {
        continue;
      }

      if (string.Equals(candidateName, expectedAssetName, StringComparison.Ordinal))
      {
        return TryBuildDescriptor(asset, candidateName, out assetName, out downloadUrl);
      }

      if (fallbackAsset is null &&
          candidateName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) &&
          candidateName.Contains("OctOP.WindowsAgentMenu-win-x64", StringComparison.OrdinalIgnoreCase))
      {
        fallbackAsset = asset;
      }
    }

    return fallbackAsset is JsonElement fallback &&
      fallback.TryGetProperty("name", out var fallbackNameProperty) &&
      !string.IsNullOrWhiteSpace(fallbackNameProperty.GetString()) &&
      TryBuildDescriptor(fallback, fallbackNameProperty.GetString()!, out assetName, out downloadUrl);
  }

  private static bool TryBuildDescriptor(
    JsonElement asset,
    string resolvedAssetName,
    out string assetName,
    out Uri downloadUrl)
  {
    assetName = string.Empty;
    downloadUrl = new Uri("https://example.com");

    if (!asset.TryGetProperty("browser_download_url", out var downloadUrlProperty))
    {
      return false;
    }

    var rawDownloadUrl = downloadUrlProperty.GetString();
    if (string.IsNullOrWhiteSpace(rawDownloadUrl) ||
        !Uri.TryCreate(rawDownloadUrl, UriKind.Absolute, out var resolvedDownloadUrl))
    {
      return false;
    }

    downloadUrl = resolvedDownloadUrl;
    assetName = resolvedAssetName;
    return true;
  }

  private static HttpClient CreateHttpClient()
  {
    var client = new HttpClient();
    client.DefaultRequestHeaders.UserAgent.ParseAdd("OctOPAgentMenu/1.0");
    client.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
    return client;
  }
}

readonly record struct SemVersion(int Major, int Minor, int Patch, string? Suffix) : IComparable<SemVersion>
{
  public int CompareTo(SemVersion other)
  {
    var majorComparison = Major.CompareTo(other.Major);
    if (majorComparison != 0)
    {
      return majorComparison;
    }

    var minorComparison = Minor.CompareTo(other.Minor);
    if (minorComparison != 0)
    {
      return minorComparison;
    }

    var patchComparison = Patch.CompareTo(other.Patch);
    if (patchComparison != 0)
    {
      return patchComparison;
    }

    var thisStable = string.IsNullOrWhiteSpace(Suffix);
    var otherStable = string.IsNullOrWhiteSpace(other.Suffix);
    if (thisStable && !otherStable)
    {
      return 1;
    }

    if (!thisStable && otherStable)
    {
      return -1;
    }

    return string.Compare(Suffix, other.Suffix, StringComparison.OrdinalIgnoreCase);
  }

  public static bool TryParse(string rawValue, out SemVersion version)
  {
    version = default;
    var normalized = rawValue.Trim();
    if (normalized.StartsWith("v", StringComparison.OrdinalIgnoreCase))
    {
      normalized = normalized[1..];
    }

    normalized = normalized.Split('+', 2)[0];
    var parts = normalized.Split('-', 2);
    var numericParts = parts[0].Split('.', StringSplitOptions.TrimEntries);
    if (numericParts.Length < 3)
    {
      return false;
    }

    if (!int.TryParse(numericParts[0], out var major) ||
      !int.TryParse(numericParts[1], out var minor) ||
      !int.TryParse(numericParts[2], out var patch))
    {
      return false;
    }

    version = new SemVersion(major, minor, patch, parts.Length > 1 ? parts[1] : null);
    return true;
  }
}
