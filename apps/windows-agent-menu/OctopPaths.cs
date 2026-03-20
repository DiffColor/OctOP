using System.IO;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;

sealed class OctopPaths
{
  private static readonly HashSet<string> DummyFingerprintValues = new(StringComparer.OrdinalIgnoreCase)
  {
    string.Empty,
    "0",
    "00",
    "000",
    "0000",
    "00000000",
    "unknown",
    "none",
    "default",
    "n/a",
    "android",
    "alps",
    "generic",
    "goldfish",
    "default string"
  };

  public string InstallRoot { get; }
  public string LegacyRuntimeRoot => Path.Combine(InstallRoot, "runtime");
  public string RuntimeReleasesRoot => Path.Combine(InstallRoot, "runtime-releases");
  public string RuntimeSourceCacheRoot => Path.Combine(InstallRoot, "runtime-source-cache");
  public string RuntimeRepositoryCacheRoot => Path.Combine(RuntimeSourceCacheRoot, "octop-repo");
  public string RuntimeCurrentPointerPath => Path.Combine(InstallRoot, "runtime-current.txt");
  public string RuntimePreviousPointerPath => Path.Combine(InstallRoot, "runtime-previous.txt");
  public string RuntimeStateRoot => Path.Combine(InstallRoot, "runtime-state");
  public string RuntimeAgentPidPath => Path.Combine(RuntimeStateRoot, "agent.pid");
  public string RuntimeRoot => ResolveActiveRuntimeRoot() ?? LegacyRuntimeRoot;
  public string ToolsRoot => Path.Combine(InstallRoot, "tools");
  public string NodeRoot => Path.Combine(ToolsRoot, "node");
  public string NodeVersionMarkerPath => Path.Combine(NodeRoot, "current-version.txt");
  public string NpmPrefix => Path.Combine(ToolsRoot, "npm-global");
  public string CodexHome => Path.Combine(InstallRoot, "codex-home");
  public string StateHome => Path.Combine(InstallRoot, "state");
  public string ConfigurationPath => Path.Combine(InstallRoot, "config.json");
  public string BridgeIdPath => Path.Combine(InstallRoot, "bridge-id.txt");
  public string LegacyBridgeIdPath => Path.Combine(StateHome, "bridge-id");
  public string PendingLoginPath => Path.Combine(InstallRoot, "pending-login.json");
  public string PendingServiceStartPath => Path.Combine(InstallRoot, "pending-service-start");
  public string PendingAppUpdateStatePath => Path.Combine(InstallRoot, "app-update-status.json");
  public string AppUpdateLaunchMarkerPath => Path.Combine(InstallRoot, "app-update-launch-confirmed");
  public string RuntimePackageJsonPath => Path.Combine(RuntimeRoot, "package.json");
  public string RuntimeEnvLocalPath => Path.Combine(RuntimeRoot, ".env.local");
  public string RuntimeVersionPath => Path.Combine(RuntimeRoot, "version.txt");
  public string RuntimeBuildInfoPath => Path.Combine(RuntimeRoot, "build-info.json");
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
    var derived = ResolveStableBridgeId();
    if (!string.IsNullOrWhiteSpace(derived))
    {
      PersistBridgeId(derived);
      return derived;
    }

    var existing = ReadExistingBridgeId();
    if (!string.IsNullOrWhiteSpace(existing))
    {
      PersistBridgeId(existing);
      return existing;
    }

    var fallbackSource = $"{Environment.MachineName}|{Environment.OSVersion.VersionString}";
    var fallback = $"bridge-{ComputeSha256HexUpper(fallbackSource).ToLowerInvariant()}";
    PersistBridgeId(fallback);
    return fallback;
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

  private static string? ResolveStableBridgeId()
  {
    var normalized = CollectWindowsFingerprintSources()
      .Select(NormalizeFingerprintValue)
      .Where(static value => !string.IsNullOrWhiteSpace(value))
      .Distinct(StringComparer.Ordinal)
      .OrderBy(static value => value, StringComparer.Ordinal)
      .ToArray();

    if (normalized.Length == 0)
    {
      return null;
    }

    return $"bridge-{ComputeSha256HexUpper(string.Join("|", normalized)).ToLowerInvariant()}";
  }

  private static IEnumerable<string> CollectWindowsFingerprintSources()
  {
    yield return ReadRegistryMachineGuid();
    yield return QueryHardwareValue("Win32_Processor", "ProcessorId");
    yield return QueryHardwareValue("Win32_BaseBoard", "SerialNumber");
    yield return QueryHardwareValue("Win32_BIOS", "SerialNumber");
    yield return QueryHardwareValue("Win32_DiskDrive", "SerialNumber");
    yield return QueryHardwareValue("Win32_ComputerSystemProduct", "UUID");
  }

  private static string ReadRegistryMachineGuid()
  {
    return RunProcess(
      "reg.exe",
      [
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
        "/v",
        "MachineGuid"
      ],
      output => output
        .Split(["\r\n", "\n"], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .FirstOrDefault(static line => line.StartsWith("MachineGuid", StringComparison.OrdinalIgnoreCase))
        ?.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .LastOrDefault() ?? string.Empty);
  }

  private static string QueryHardwareValue(string className, string propertyName)
  {
    var escapedClass = EscapePowerShellLiteral(className);
    var escapedProperty = EscapePowerShellLiteral(propertyName);
    var script = string.Join(" ", [
      "$value = ''",
      $"try {{ $value = Get-CimInstance -ClassName '{escapedClass}' | Select-Object -First 1 -ExpandProperty '{escapedProperty}' }} catch {{",
      $"  try {{ $value = Get-WmiObject -Class '{escapedClass}' | Select-Object -First 1 -ExpandProperty '{escapedProperty}' }} catch {{ }}",
      "}",
      "if ($null -ne $value) { [Console]::Write($value.ToString()) }"
    ]);

    return RunProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      static output => output);
  }

  private static string RunProcess(
    string fileName,
    IEnumerable<string> arguments,
    Func<string, string> normalizeOutput)
  {
    try
    {
      var startInfo = new ProcessStartInfo
      {
        FileName = fileName,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        UseShellExecute = false,
        CreateNoWindow = true
      };

      foreach (var argument in arguments)
      {
        startInfo.ArgumentList.Add(argument);
      }

      using var process = Process.Start(startInfo);
      if (process is null)
      {
        return string.Empty;
      }

      var output = process.StandardOutput.ReadToEnd();
      process.WaitForExit();
      return normalizeOutput(output ?? string.Empty).Trim();
    }
    catch
    {
      return string.Empty;
    }
  }

  private static string EscapePowerShellLiteral(string value)
  {
    return (value ?? string.Empty).Replace("'", "''", StringComparison.Ordinal);
  }

  private static string NormalizeFingerprintValue(string value)
  {
    if (string.IsNullOrWhiteSpace(value))
    {
      return string.Empty;
    }

    var normalized = value.Trim().ToLowerInvariant();

    if (DummyFingerprintValues.Contains(normalized) || normalized.All(static ch => ch == '0'))
    {
      return string.Empty;
    }

    return normalized;
  }

  private static string ComputeSha256HexUpper(string value)
  {
    var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value ?? string.Empty));
    return Convert.ToHexString(bytes);
  }

  public string GetRuntimeReleaseRoot(string runtimeReleaseId)
  {
    return Path.Combine(RuntimeReleasesRoot, runtimeReleaseId);
  }

  public string? ResolveActiveRuntimeRoot()
  {
    var currentReleaseId = ReadRuntimePointer(RuntimeCurrentPointerPath);
    if (string.IsNullOrWhiteSpace(currentReleaseId))
    {
      return null;
    }

    var candidate = GetRuntimeReleaseRoot(currentReleaseId);
    return Directory.Exists(candidate) ? candidate : null;
  }

  public string? ResolvePreviousRuntimeRoot()
  {
    var previousReleaseId = ReadRuntimePointer(RuntimePreviousPointerPath);
    if (string.IsNullOrWhiteSpace(previousReleaseId))
    {
      return null;
    }

    var candidate = GetRuntimeReleaseRoot(previousReleaseId);
    return Directory.Exists(candidate) ? candidate : null;
  }

  public string? ReadCurrentRuntimeReleaseId() => ReadRuntimePointer(RuntimeCurrentPointerPath);

  public string? ReadPreviousRuntimeReleaseId() => ReadRuntimePointer(RuntimePreviousPointerPath);

  public IReadOnlyList<string> EnumerateRuntimeProcessRoots()
  {
    var roots = new List<string>();

    var activeRoot = ResolveActiveRuntimeRoot();
    if (!string.IsNullOrWhiteSpace(activeRoot))
    {
      roots.Add(activeRoot);
    }

    var previousRoot = ResolvePreviousRuntimeRoot();
    if (!string.IsNullOrWhiteSpace(previousRoot) &&
        !roots.Contains(previousRoot, StringComparer.OrdinalIgnoreCase))
    {
      roots.Add(previousRoot);
    }

    if (Directory.Exists(RuntimeReleasesRoot))
    {
      foreach (var releaseRoot in Directory.GetDirectories(RuntimeReleasesRoot))
      {
        var normalized = Path.GetFullPath(releaseRoot);
        if (!roots.Contains(normalized, StringComparer.OrdinalIgnoreCase))
        {
          roots.Add(normalized);
        }
      }
    }

    if (Directory.Exists(LegacyRuntimeRoot))
    {
      var legacyRoot = Path.GetFullPath(LegacyRuntimeRoot);
      if (!roots.Contains(legacyRoot, StringComparer.OrdinalIgnoreCase))
      {
        roots.Add(legacyRoot);
      }
    }

    return roots;
  }

  private static string? ReadRuntimePointer(string pointerPath)
  {
    if (!File.Exists(pointerPath))
    {
      return null;
    }

    var releaseId = File.ReadAllText(pointerPath).Trim();
    return string.IsNullOrWhiteSpace(releaseId) ? null : releaseId;
  }
}
