namespace OctOP.Gateway.Voice;

internal static class OpenAiApiUrlResolver
{
  private const string DefaultBaseUrl = "https://api.openai.com";

  public static string ResolveBaseUrl()
  {
    var configuredBaseUrl = Environment.GetEnvironmentVariable("OCTOP_OPENAI_API_BASE_URL");
    var normalizedBaseUrl = string.IsNullOrWhiteSpace(configuredBaseUrl)
      ? DefaultBaseUrl
      : configuredBaseUrl.Trim().TrimEnd('/');

    return normalizedBaseUrl.EndsWith("/v1", StringComparison.OrdinalIgnoreCase)
      ? normalizedBaseUrl[..^3]
      : normalizedBaseUrl;
  }

  public static string ResolveApiUrl(string path)
  {
    var normalizedPath = string.IsNullOrWhiteSpace(path) ? "/" : path.Trim();
    normalizedPath = normalizedPath.StartsWith("/") ? normalizedPath : $"/{normalizedPath}";

    if (normalizedPath.StartsWith("/v1/", StringComparison.OrdinalIgnoreCase) || string.Equals(normalizedPath, "/v1", StringComparison.OrdinalIgnoreCase))
    {
      return $"{ResolveBaseUrl()}{normalizedPath}";
    }

    return $"{ResolveBaseUrl()}/v1{normalizedPath}";
  }
}
