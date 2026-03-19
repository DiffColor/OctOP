using System.Diagnostics;
using System.IO;
using System.Reflection;

static class AppMetadata
{
  public static string CurrentVersionTag => NormalizeVersionTag(ResolveVersion());

  public static string CurrentVersionDisplay => CurrentVersionTag.TrimStart('v');

  public static string? CurrentExecutablePath =>
    Environment.ProcessPath is { Length: > 0 } value ? Path.GetFullPath(value) : null;

  public static bool CanSelfUpdate()
  {
    var executablePath = CurrentExecutablePath;
    return executablePath is not null &&
      File.Exists(executablePath) &&
      string.Equals(Path.GetExtension(executablePath), ".exe", StringComparison.OrdinalIgnoreCase);
  }

  private static string ResolveVersion()
  {
    var informationalVersion = Assembly.GetExecutingAssembly()
      .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
      .InformationalVersion;
    if (!string.IsNullOrWhiteSpace(informationalVersion))
    {
      return informationalVersion;
    }

    var executablePath = CurrentExecutablePath;
    if (executablePath is not null && File.Exists(executablePath))
    {
      var productVersion = FileVersionInfo.GetVersionInfo(executablePath).ProductVersion;
      if (!string.IsNullOrWhiteSpace(productVersion))
      {
        return productVersion;
      }
    }

    return "0.0.0-dev";
  }

  public static string NormalizeVersionTag(string value)
  {
    var trimmed = value.Trim();
    if (trimmed.Length == 0)
    {
      return "v0.0.0-dev";
    }

    var sanitized = trimmed.Split('+', 2)[0];
    return sanitized.StartsWith("v", StringComparison.OrdinalIgnoreCase) ? sanitized : $"v{sanitized}";
  }
}
