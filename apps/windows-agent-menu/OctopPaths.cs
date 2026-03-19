using System.IO;
using System.Text;

sealed class OctopPaths
{
  public string InstallRoot { get; }
  public string RuntimeRoot => Path.Combine(InstallRoot, "runtime");
  public string ToolsRoot => Path.Combine(InstallRoot, "tools");
  public string NodeRoot => Path.Combine(ToolsRoot, "node");
  public string NodeVersionMarkerPath => Path.Combine(NodeRoot, "current-version.txt");
  public string NpmPrefix => Path.Combine(ToolsRoot, "npm-global");
  public string CodexHome => Path.Combine(InstallRoot, "codex-home");
  public string StateHome => Path.Combine(InstallRoot, "state");
  public string ConfigurationPath => Path.Combine(InstallRoot, "config.json");
  public string BridgeIdPath => Path.Combine(InstallRoot, "bridge-id.txt");
  public string LegacyBridgeIdPath => Path.Combine(StateHome, "bridge-id");
  public string PendingServiceStartPath => Path.Combine(InstallRoot, "pending-service-start");
  public string RuntimePackageJsonPath => Path.Combine(RuntimeRoot, "package.json");
  public string RuntimeEnvLocalPath => Path.Combine(RuntimeRoot, ".env.local");
  public string RuntimeVersionPath => Path.Combine(RuntimeRoot, "version.txt");
  public string RuntimeAgentPidPath => Path.Combine(RuntimeRoot, "agent.pid");
  public string RuntimeAgentEntryPath => Path.Combine(RuntimeRoot, "scripts", "run-local-agent.mjs");

  public OctopPaths(string installRoot)
  {
    InstallRoot = Path.GetFullPath(installRoot);
  }

  public static string GetDefaultInstallRoot()
  {
    return Path.Combine(
      Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
      "OctOP");
  }

  public static string ResolvePreferredInstallRoot()
  {
    var pointerPath = GetPreferredInstallRootPointerPath();
    if (File.Exists(pointerPath))
    {
      var configuredRoot = File.ReadAllText(pointerPath).Trim();
      if (!string.IsNullOrWhiteSpace(configuredRoot))
      {
        return Path.GetFullPath(configuredRoot);
      }
    }

    return GetDefaultInstallRoot();
  }

  public static void SavePreferredInstallRoot(string installRoot)
  {
    Directory.CreateDirectory(GetDefaultInstallRoot());
    File.WriteAllText(
      GetPreferredInstallRootPointerPath(),
      Path.GetFullPath(installRoot),
      new UTF8Encoding(false));
  }

  private static string GetPreferredInstallRootPointerPath()
  {
    return Path.Combine(GetDefaultInstallRoot(), "install-root.txt");
  }

  public string? GetManagedNodeVersion()
  {
    if (File.Exists(NodeVersionMarkerPath))
    {
      var version = File.ReadAllText(NodeVersionMarkerPath).Trim();
      return string.IsNullOrWhiteSpace(version) ? null : version;
    }

    return null;
  }

  public string? GetManagedNodeDirectory()
  {
    var version = GetManagedNodeVersion();
    if (string.IsNullOrWhiteSpace(version))
    {
      return null;
    }

    var candidate = Path.Combine(NodeRoot, version);
    return File.Exists(Path.Combine(candidate, "node.exe")) ? candidate : null;
  }

  public string? GetNodeExecutablePath()
  {
    var nodeDirectory = GetManagedNodeDirectory();
    return nodeDirectory is null ? null : Path.Combine(nodeDirectory, "node.exe");
  }

  public string? GetNpmExecutablePath()
  {
    var nodeDirectory = GetManagedNodeDirectory();
    return nodeDirectory is null ? null : Path.Combine(nodeDirectory, "npm.cmd");
  }

  public string GetCodexBinDirectory()
  {
    return Path.Combine(NpmPrefix, "node_modules", ".bin");
  }

  public string GetCodexCommandPath()
  {
    var localShimPath = Path.Combine(GetCodexBinDirectory(), "codex.cmd");
    if (File.Exists(localShimPath))
    {
      return localShimPath;
    }

    var legacyGlobalShimPath = Path.Combine(NpmPrefix, "codex.cmd");
    return File.Exists(legacyGlobalShimPath) ? legacyGlobalShimPath : localShimPath;
  }

  public string ResolveOrCreateBridgeId()
  {
    var existing = ReadExistingBridgeId();
    if (!string.IsNullOrWhiteSpace(existing))
    {
      PersistBridgeId(existing);
      return existing;
    }

    var generated = $"bridge-{Guid.NewGuid():D}";
    PersistBridgeId(generated);
    return generated;
  }

  private string? ReadExistingBridgeId()
  {
    foreach (var path in new[] { BridgeIdPath, LegacyBridgeIdPath })
    {
      if (!File.Exists(path))
      {
        continue;
      }

      var value = File.ReadAllText(path).Trim();
      if (!string.IsNullOrWhiteSpace(value))
      {
        return value;
      }
    }

    return null;
  }

  private void PersistBridgeId(string bridgeId)
  {
    Directory.CreateDirectory(InstallRoot);
    Directory.CreateDirectory(StateHome);
    File.WriteAllText(BridgeIdPath, bridgeId, new UTF8Encoding(false));
    File.WriteAllText(LegacyBridgeIdPath, bridgeId, new UTF8Encoding(false));
  }
}
