using System.Security.Cryptography;
using System.Text;

static class WindowsSecretStore
{
  private const string CodexApiKeyFileName = "codex-api-key.bin";

  public static void SaveCodexApiKey(OctopPaths paths, string apiKey)
  {
    Directory.CreateDirectory(paths.InstallRoot);
    var normalized = (apiKey ?? string.Empty).Trim();
    if (normalized.Length == 0)
    {
      DeleteCodexApiKey(paths);
      return;
    }

    var protectedBytes = ProtectedData.Protect(
      Encoding.UTF8.GetBytes(normalized),
      GetEntropy(paths),
      DataProtectionScope.CurrentUser);
    File.WriteAllBytes(GetCodexApiKeyPath(paths), protectedBytes);
  }

  public static string? ReadCodexApiKey(OctopPaths paths)
  {
    var path = GetCodexApiKeyPath(paths);
    if (!File.Exists(path))
    {
      return null;
    }

    var protectedBytes = File.ReadAllBytes(path);
    if (protectedBytes.Length == 0)
    {
      return null;
    }

    var plainBytes = ProtectedData.Unprotect(
      protectedBytes,
      GetEntropy(paths),
      DataProtectionScope.CurrentUser);
    var value = Encoding.UTF8.GetString(plainBytes).Trim();
    return value.Length == 0 ? null : value;
  }

  public static void DeleteCodexApiKey(OctopPaths paths)
  {
    var path = GetCodexApiKeyPath(paths);
    if (File.Exists(path))
    {
      File.Delete(path);
    }
  }

  private static byte[] GetEntropy(OctopPaths paths)
  {
    return Encoding.UTF8.GetBytes($"OctOP.WindowsAgentMenu|{paths.InstallRoot}");
  }

  private static string GetCodexApiKeyPath(OctopPaths paths)
  {
    return Path.Combine(paths.InstallRoot, CodexApiKeyFileName);
  }
}
