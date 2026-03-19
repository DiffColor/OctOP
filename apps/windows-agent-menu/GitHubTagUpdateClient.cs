using System.Net.Http;
using System.Text.Json;

sealed class GitHubTagUpdateClient
{
  private const string Owner = "DiffColor";
  private const string Repo = "OctOP";
  private const string ReleasesApiUrl = $"https://api.github.com/repos/{Owner}/{Repo}/releases?per_page=30";

  private static readonly HttpClient HttpClient = CreateHttpClient();

  public async Task<ReleaseDescriptor?> GetLatestWindowsReleaseAsync(CancellationToken cancellationToken)
  {
    return await GetLatestReleaseAsync(cancellationToken);
  }

  private static async Task<ReleaseDescriptor?> GetLatestReleaseAsync(CancellationToken cancellationToken)
  {
    using var response = await HttpClient.GetAsync(ReleasesApiUrl, cancellationToken);
    response.EnsureSuccessStatusCode();

    await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
    using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
    var candidates = new List<(SemVersion version, ReleaseDescriptor release)>();

    foreach (var item in document.RootElement.EnumerateArray())
    {
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
      var expectedAssetName = $"OctOP.WindowsAgentMenu-win-x64-{normalizedTag}.exe";
      if (!item.TryGetProperty("assets", out var assetsProperty) || assetsProperty.ValueKind != JsonValueKind.Array)
      {
        continue;
      }

      foreach (var asset in assetsProperty.EnumerateArray())
      {
        if (!asset.TryGetProperty("name", out var assetNameProperty) ||
            !asset.TryGetProperty("browser_download_url", out var downloadUrlProperty))
        {
          continue;
        }

        var assetName = assetNameProperty.GetString();
        var downloadUrl = downloadUrlProperty.GetString();
        if (!string.Equals(assetName, expectedAssetName, StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(assetName) ||
            string.IsNullOrWhiteSpace(downloadUrl) ||
            !Uri.TryCreate(downloadUrl, UriKind.Absolute, out var downloadUri))
        {
          continue;
        }

        candidates.Add((version, new ReleaseDescriptor(normalizedTag, assetName, downloadUri)));
        break;
      }
    }

    return candidates
      .OrderByDescending(static item => item.version)
      .Select(static item => item.release)
      .FirstOrDefault();
  }

  private static HttpClient CreateHttpClient()
  {
    var client = new HttpClient();
    client.DefaultRequestHeaders.UserAgent.ParseAdd("OctOPAgentMenu/1.0");
    client.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
    return client;
  }
}

sealed record ReleaseDescriptor(string Tag, string AssetName, Uri DownloadUrl);

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
