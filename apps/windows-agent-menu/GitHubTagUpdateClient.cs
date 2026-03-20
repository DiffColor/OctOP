using System.Net.Http;
using System.Text.Json;

sealed class GitHubTagUpdateClient
{
  private const string Owner = "DiffColor";
  private const string Repo = "OctOP";
  private const string TagsApiUrl = $"https://api.github.com/repos/{Owner}/{Repo}/tags?per_page=30";

  private static readonly HttpClient HttpClient = CreateHttpClient();

  public async Task<AppUpdateDescriptor?> GetLatestWindowsReleaseAsync(string currentVersionTag, CancellationToken cancellationToken)
  {
    return await GetLatestReleaseAsync(currentVersionTag, cancellationToken);
  }

  private static async Task<AppUpdateDescriptor?> GetLatestReleaseAsync(string currentVersionTag, CancellationToken cancellationToken)
  {
    if (!SemVersion.TryParse(currentVersionTag, out var currentVersion))
    {
      return null;
    }

    using var response = await HttpClient.GetAsync(TagsApiUrl, cancellationToken);
    response.EnsureSuccessStatusCode();

    await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
    using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
    var candidates = new List<(SemVersion version, AppUpdateDescriptor release)>();

    foreach (var item in document.RootElement.EnumerateArray())
    {
      if (!item.TryGetProperty("name", out var tagProperty))
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
      var downloadUrl = new Uri($"https://github.com/{Owner}/{Repo}/releases/download/{normalizedTag}/{expectedAssetName}");
      if (!await AssetExistsAsync(downloadUrl, cancellationToken))
      {
        continue;
      }

      candidates.Add((version, new AppUpdateDescriptor
      {
        Tag = normalizedTag,
        AssetName = expectedAssetName,
        DownloadUrl = downloadUrl
      }));
    }

    return candidates
      .OrderByDescending(static item => item.version)
      .Select(static item => item.release)
      .FirstOrDefault();
  }

  private static async Task<bool> AssetExistsAsync(Uri downloadUrl, CancellationToken cancellationToken)
  {
    using var request = new HttpRequestMessage(HttpMethod.Head, downloadUrl);
    using var response = await HttpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
    return response.IsSuccessStatusCode;
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
