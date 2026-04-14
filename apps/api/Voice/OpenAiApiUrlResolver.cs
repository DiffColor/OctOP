namespace OctOP.Gateway.Voice;

internal static class OpenAiApiUrlResolver
{
  private const string DefaultBaseUrl = "https://api.openai.com";
  private static readonly HashSet<string> RealtimeUnsupportedRegionalHosts = new(StringComparer.OrdinalIgnoreCase)
  {
    "au.api.openai.com",
    "ca.api.openai.com",
    "jp.api.openai.com",
    "in.api.openai.com",
    "sg.api.openai.com",
    "kr.api.openai.com",
    "gb.api.openai.com",
    "ae.api.openai.com"
  };

  public static string ResolveBaseUrl()
  {
    var configuredBaseUrl = Environment.GetEnvironmentVariable("OCTOP_OPENAI_API_BASE_URL");
    return NormalizeConfiguredBaseUrl(configuredBaseUrl);
  }

  public static string ResolveRealtimeBaseUrl()
  {
    var explicitRealtimeBaseUrl = NormalizeOptionalConfiguredBaseUrl(
      Environment.GetEnvironmentVariable("OCTOP_OPENAI_REALTIME_API_BASE_URL"));

    if (!string.IsNullOrWhiteSpace(explicitRealtimeBaseUrl))
    {
      return explicitRealtimeBaseUrl;
    }

    var sharedBaseUrl = ResolveBaseUrl();

    if (!Uri.TryCreate(sharedBaseUrl, UriKind.Absolute, out var uri))
    {
      return sharedBaseUrl;
    }

    if (RealtimeUnsupportedRegionalHosts.Contains(uri.Host))
    {
      return DefaultBaseUrl;
    }

    return sharedBaseUrl;
  }

  public static string ResolveApiUrl(string path)
  {
    return ResolveApiUrl(path, ResolveBaseUrl());
  }

  public static string ResolveRealtimeApiUrl(string path)
  {
    return ResolveApiUrl(path, ResolveRealtimeBaseUrl());
  }

  private static string ResolveApiUrl(string path, string baseUrl)
  {
    var normalizedPath = string.IsNullOrWhiteSpace(path) ? "/" : path.Trim();
    normalizedPath = normalizedPath.StartsWith("/") ? normalizedPath : $"/{normalizedPath}";

    if (normalizedPath.StartsWith("/v1/", StringComparison.OrdinalIgnoreCase) || string.Equals(normalizedPath, "/v1", StringComparison.OrdinalIgnoreCase))
    {
      return $"{baseUrl}{normalizedPath}";
    }

    return $"{baseUrl}/v1{normalizedPath}";
  }

  private static string NormalizeConfiguredBaseUrl(string? configuredBaseUrl)
  {
    var normalizedBaseUrl = string.IsNullOrWhiteSpace(configuredBaseUrl)
      ? DefaultBaseUrl
      : configuredBaseUrl.Trim().TrimEnd('/');

    return normalizedBaseUrl.EndsWith("/v1", StringComparison.OrdinalIgnoreCase)
      ? normalizedBaseUrl[..^3]
      : normalizedBaseUrl;
  }

  private static string? NormalizeOptionalConfiguredBaseUrl(string? configuredBaseUrl)
  {
    if (string.IsNullOrWhiteSpace(configuredBaseUrl))
    {
      return null;
    }

    return NormalizeConfiguredBaseUrl(configuredBaseUrl);
  }
}
