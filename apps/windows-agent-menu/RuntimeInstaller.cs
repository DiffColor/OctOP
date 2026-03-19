using System.Diagnostics;
using System.IO.Compression;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

sealed class RuntimeInstaller
{
  private const string NodeIndexUrl = "https://nodejs.org/dist/index.json";
  private const string RuntimePackageJson = """
  {
    "name": "octop-local-agent-runtime",
    "private": true,
    "type": "module",
    "dependencies": {
      "nats": "^2.29.3",
      "ws": "^8.19.0"
    }
  }
  """;

  private static readonly HttpClient HttpClient = new();
  private static readonly Regex AnsiEscapePattern = new(@"\x1B\[[0-9;]*[A-Za-z]", RegexOptions.Compiled);

  private static readonly IReadOnlyDictionary<string, string> RuntimeResources = new Dictionary<string, string>
  {
    ["OctOP.WindowsAgentMenu.Runtime.scripts.shared-env.mjs"] = "scripts/shared-env.mjs",
    ["OctOP.WindowsAgentMenu.Runtime.scripts.run-local-agent.mjs"] = "scripts/run-local-agent.mjs",
    ["OctOP.WindowsAgentMenu.Runtime.scripts.run-bridge.mjs"] = "scripts/run-bridge.mjs",
    ["OctOP.WindowsAgentMenu.Runtime.services.codex-adapter.src.index.js"] = "services/codex-adapter/src/index.js",
    ["OctOP.WindowsAgentMenu.Runtime.packages.domain.src.index.js"] = "packages/domain/src/index.js"
  };

  private readonly Assembly _assembly = Assembly.GetExecutingAssembly();

  public RuntimeConfiguration LoadConfiguration(OctopPaths paths)
  {
    if (!File.Exists(paths.ConfigurationPath))
    {
      var defaultConfiguration = new RuntimeConfiguration { InstallRoot = paths.InstallRoot };
      defaultConfiguration.Normalize();
      return defaultConfiguration;
    }

    var configuration = JsonSerializer.Deserialize<RuntimeConfiguration>(
      File.ReadAllText(paths.ConfigurationPath, Encoding.UTF8),
      new JsonSerializerOptions(JsonSerializerDefaults.Web)
    );

    var resolvedConfiguration = configuration ?? new RuntimeConfiguration { InstallRoot = paths.InstallRoot };
    resolvedConfiguration.InstallRoot = paths.InstallRoot;
    resolvedConfiguration.Normalize();
    return resolvedConfiguration;
  }

  public void SaveConfiguration(RuntimeConfiguration configuration, OctopPaths paths)
  {
    Directory.CreateDirectory(paths.InstallRoot);
    configuration.InstallRoot = paths.InstallRoot;
    OctopPaths.SavePreferredInstallRoot(paths.InstallRoot);
    var json = JsonSerializer.Serialize(configuration, new JsonSerializerOptions(JsonSerializerDefaults.Web)
    {
      WriteIndented = true
    });
    File.WriteAllText(paths.ConfigurationPath, json, new UTF8Encoding(false));
  }

  public async Task<RuntimeStatus> InspectAsync(OctopPaths paths, CancellationToken cancellationToken)
  {
    var configuration = LoadConfiguration(paths);
    var runtimeBundlePresent = File.Exists(paths.RuntimeAgentEntryPath);
    var configurationSaved = File.Exists(paths.ConfigurationPath) && File.Exists(paths.RuntimeEnvLocalPath);
    var runtimeVersionFileExists = File.Exists(paths.RuntimeVersionPath);
    var runtimeVersion = runtimeVersionFileExists
      ? File.ReadAllText(paths.RuntimeVersionPath, Encoding.UTF8).Trim()
      : string.Empty;
    var runtimeVersionMatches = runtimeVersionFileExists && string.Equals(
      AppMetadata.NormalizeVersionTag(runtimeVersion),
      AppMetadata.CurrentVersionTag,
      StringComparison.OrdinalIgnoreCase);
    var nodeVersion = paths.GetManagedNodeVersion();
    var nodeInstalled = File.Exists(paths.GetNodeExecutablePath());
    var runtimeDependenciesInstalled =
      File.Exists(Path.Combine(paths.RuntimeRoot, "node_modules", "nats", "package.json")) &&
      File.Exists(Path.Combine(paths.RuntimeRoot, "node_modules", "ws", "package.json"));
    var codexInstalled = File.Exists(paths.GetCodexCommandPath());

    var codexLoggedIn = false;
    var loginStatus = codexInstalled ? "미로그인" : "Codex 미설치";

    if (codexInstalled)
    {
      var result = await RunCommandAsync(
        CreateCmdWrapperStartInfo(
          paths.GetCodexCommandPath(),
          ["login", "status"],
          paths.InstallRoot,
          BuildToolEnvironment(paths)
        ),
        cancellationToken: cancellationToken
      );

      var combined = string.Join("\n", new[] { result.StandardOutput, result.StandardError }.Where(static value => !string.IsNullOrWhiteSpace(value))).Trim();
      codexLoggedIn = result.ExitCode == 0;
      loginStatus = string.IsNullOrWhiteSpace(combined)
        ? (codexLoggedIn ? "로그인됨" : "미로그인")
        : StripAnsi(combined).Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).LastOrDefault() ?? "확인 실패";
    }

    var autoStartConfigured = AppMetadata.CurrentExecutablePath is { Length: > 0 } executablePath &&
      WindowsStartupManager.IsEnabled(executablePath);

    return new RuntimeStatus
    {
      RuntimeBundlePresent = runtimeBundlePresent,
      ConfigurationSaved = configurationSaved,
      RuntimeVersionMatches = runtimeVersionMatches,
      RuntimeVersion = string.IsNullOrWhiteSpace(runtimeVersion) ? "unknown" : runtimeVersion,
      NodeInstalled = nodeInstalled,
      NodeVersion = nodeVersion,
      RuntimeDependenciesInstalled = runtimeDependenciesInstalled,
      CodexInstalled = codexInstalled,
      CodexLoggedIn = codexLoggedIn,
      CodexLoginStatus = loginStatus,
      AutoStartRequested = configuration.AutoStartAtLogin,
      AutoStartConfigured = autoStartConfigured
    };
  }

  public async Task<RuntimeStatus> InstallOrUpdateAsync(
    RuntimeConfiguration configuration,
    IProgress<string> progress,
    CancellationToken cancellationToken)
  {
    var paths = new OctopPaths(configuration.InstallRoot);
    progress.Report($"설치 루트 준비: {paths.InstallRoot}");
    Directory.CreateDirectory(paths.InstallRoot);
    Directory.CreateDirectory(paths.ToolsRoot);
    Directory.CreateDirectory(paths.RuntimeRoot);
    Directory.CreateDirectory(paths.CodexHome);
    Directory.CreateDirectory(paths.StateHome);

    await WriteRuntimeBundleAsync(paths, progress, cancellationToken);
    await EnsureNodeAsync(paths, progress, cancellationToken);
    SaveConfiguration(configuration, paths);
    WriteEnvironmentFile(configuration, paths);
    WriteRuntimeVersion(paths);
    EnsureAutoStartAtLogin(configuration, progress);
    await EnsureRuntimeDependenciesAsync(paths, progress, cancellationToken);
    await EnsureCodexAsync(paths, progress, cancellationToken);
    await EnsureCodexLoginAsync(configuration, paths, progress, cancellationToken);

    return await InspectAsync(paths, cancellationToken);
  }

  public void WriteEnvironmentFile(RuntimeConfiguration configuration, OctopPaths paths)
  {
    Directory.CreateDirectory(paths.RuntimeRoot);
    var env = configuration.GetEnvironmentVariables(paths);
    var builder = new StringBuilder();

    foreach (var entry in env.OrderBy(static entry => entry.Key, StringComparer.OrdinalIgnoreCase))
    {
      builder.Append(entry.Key).Append('=').AppendLine(entry.Value);
    }

    File.WriteAllText(paths.RuntimeEnvLocalPath, builder.ToString(), new UTF8Encoding(false));
  }

  public void WriteRuntimeVersion(OctopPaths paths)
  {
    Directory.CreateDirectory(paths.RuntimeRoot);
    File.WriteAllText(paths.RuntimeVersionPath, AppMetadata.CurrentVersionTag, new UTF8Encoding(false));
  }

  public void EnsureAutoStartAtLogin(RuntimeConfiguration configuration, IProgress<string> progress)
  {
    if (AppMetadata.CurrentExecutablePath is not { Length: > 0 } executablePath)
    {
      progress.Report("현재 실행 파일 경로를 확인하지 못해 로그인 시 자동 실행 설정을 건너뜁니다.");
      return;
    }

    WindowsStartupManager.SetEnabled(configuration.AutoStartAtLogin, executablePath);
    progress.Report(configuration.AutoStartAtLogin
      ? "로그인 시 자동 실행을 등록했습니다."
      : "로그인 시 자동 실행을 해제했습니다.");
  }

  public Dictionary<string, string> BuildToolEnvironment(OctopPaths paths, IReadOnlyDictionary<string, string>? extra = null)
  {
    var environment = Environment.GetEnvironmentVariables()
      .Cast<System.Collections.DictionaryEntry>()
      .ToDictionary(
        static entry => Convert.ToString(entry.Key) ?? string.Empty,
        static entry => Convert.ToString(entry.Value) ?? string.Empty,
        StringComparer.OrdinalIgnoreCase
      );

    var pathEntries = new List<string>();
    if (paths.GetManagedNodeDirectory() is { } nodeDirectory)
    {
      pathEntries.Add(nodeDirectory);
    }

    pathEntries.Add(paths.GetCodexBinDirectory());
    pathEntries.Add(paths.NpmPrefix);

    if (environment.TryGetValue("PATH", out var currentPath) && !string.IsNullOrWhiteSpace(currentPath))
    {
      pathEntries.Add(currentPath);
    }

    environment["PATH"] = string.Join(Path.PathSeparator, pathEntries.Where(static value => !string.IsNullOrWhiteSpace(value)));
    environment["CODEX_HOME"] = paths.CodexHome;

    if (extra is not null)
    {
      foreach (var entry in extra)
      {
        environment[entry.Key] = entry.Value;
      }
    }

    return environment;
  }

  private async Task WriteRuntimeBundleAsync(OctopPaths paths, IProgress<string> progress, CancellationToken cancellationToken)
  {
    progress.Report("런타임 번들을 설치 디렉터리에 복사합니다.");

    foreach (var mapping in RuntimeResources)
    {
      cancellationToken.ThrowIfCancellationRequested();
      var relativePath = mapping.Value.Replace('/', Path.DirectorySeparatorChar);
      var targetPath = Path.Combine(paths.RuntimeRoot, relativePath);
      Directory.CreateDirectory(Path.GetDirectoryName(targetPath)!);

      await using var resourceStream = _assembly.GetManifestResourceStream(mapping.Key)
        ?? throw new InvalidOperationException($"런타임 리소스를 찾을 수 없습니다: {mapping.Key}");
      await using var fileStream = File.Create(targetPath);
      await resourceStream.CopyToAsync(fileStream, cancellationToken);
    }

    await File.WriteAllTextAsync(paths.RuntimePackageJsonPath, RuntimePackageJson, new UTF8Encoding(false), cancellationToken);
  }

  private async Task EnsureNodeAsync(OctopPaths paths, IProgress<string> progress, CancellationToken cancellationToken)
  {
    if (File.Exists(paths.GetNodeExecutablePath()))
    {
      progress.Report($"Node 재사용: {paths.GetManagedNodeVersion() ?? "unknown"}");
      return;
    }

    progress.Report("Node 포터블 런타임 정보를 조회합니다.");
    var nodeVersion = await ResolveLatestLtsNodeVersionAsync(cancellationToken);
    var targetDirectory = Path.Combine(paths.NodeRoot, nodeVersion);
    var nodeExecutablePath = Path.Combine(targetDirectory, "node.exe");

    if (File.Exists(nodeExecutablePath))
    {
      Directory.CreateDirectory(paths.NodeRoot);
      await File.WriteAllTextAsync(paths.NodeVersionMarkerPath, nodeVersion, new UTF8Encoding(false), cancellationToken);
      progress.Report($"Node 설치 재사용: {nodeVersion}");
      return;
    }

    Directory.CreateDirectory(paths.NodeRoot);
    var archiveUrl = $"https://nodejs.org/dist/{nodeVersion}/node-{nodeVersion}-win-x64.zip";
    var archivePath = Path.Combine(paths.NodeRoot, $"{nodeVersion}.zip");
    var extractRoot = Path.Combine(paths.NodeRoot, $"extract-{Guid.NewGuid():N}");

    progress.Report($"Node 다운로드: {archiveUrl}");
    await using (var response = await HttpClient.GetStreamAsync(archiveUrl, cancellationToken))
    await using (var fileStream = File.Create(archivePath))
    {
      await response.CopyToAsync(fileStream, cancellationToken);
    }

    progress.Report("Node 압축을 풉니다.");
    Directory.CreateDirectory(extractRoot);
    ZipFile.ExtractToDirectory(archivePath, extractRoot, overwriteFiles: true);
    var extractedDirectory = Directory.GetDirectories(extractRoot).FirstOrDefault()
      ?? throw new InvalidOperationException("다운로드한 Node 압축에서 설치 폴더를 찾지 못했습니다.");

    if (Directory.Exists(targetDirectory))
    {
      Directory.Delete(targetDirectory, recursive: true);
    }

    CopyDirectory(extractedDirectory, targetDirectory);
    await File.WriteAllTextAsync(paths.NodeVersionMarkerPath, nodeVersion, new UTF8Encoding(false), cancellationToken);
    File.Delete(archivePath);
    Directory.Delete(extractRoot, recursive: true);
    progress.Report($"Node 설치 완료: {nodeVersion}");
  }

  private async Task EnsureRuntimeDependenciesAsync(OctopPaths paths, IProgress<string> progress, CancellationToken cancellationToken)
  {
    progress.Report("OctOP bridge 런타임 의존성을 설치합니다.");
    var npmPath = paths.GetNpmExecutablePath() ?? throw new InvalidOperationException("Node npm 경로를 찾을 수 없습니다.");

    var result = await RunCommandAsync(
      CreateCmdWrapperStartInfo(
        npmPath,
        ["install", "--omit=dev", "--no-audit", "--no-fund"],
        paths.RuntimeRoot,
        BuildToolEnvironment(paths)
      ),
      static line => { },
      progress.Report,
      cancellationToken);

    if (result.ExitCode != 0)
    {
      throw new InvalidOperationException($"bridge 의존성 설치 실패: {result.GetSummary()}");
    }
  }

  private async Task EnsureCodexAsync(OctopPaths paths, IProgress<string> progress, CancellationToken cancellationToken)
  {
    progress.Report("Codex CLI를 앱 전용 위치에 설치합니다.");
    Directory.CreateDirectory(paths.NpmPrefix);

    var npmPath = paths.GetNpmExecutablePath() ?? throw new InvalidOperationException("Node npm 경로를 찾을 수 없습니다.");
    var result = await RunCommandAsync(
      CreateCmdWrapperStartInfo(
        npmPath,
        ["install", "--prefix", paths.NpmPrefix, "--no-audit", "--no-fund", "@openai/codex@latest"],
        paths.InstallRoot,
        BuildToolEnvironment(paths)
      ),
      static line => { },
      progress.Report,
      cancellationToken);

    if (result.ExitCode != 0)
    {
      throw new InvalidOperationException($"Codex 설치 실패: {result.GetSummary()}");
    }

    var codexCommandPath = paths.GetCodexCommandPath();
    if (!File.Exists(codexCommandPath))
    {
      throw new InvalidOperationException(
        $"Codex 설치 후 실행 파일을 찾지 못했습니다: {codexCommandPath}");
    }
  }

  private async Task EnsureCodexLoginAsync(
    RuntimeConfiguration configuration,
    OctopPaths paths,
    IProgress<string> progress,
    CancellationToken cancellationToken)
  {
    var status = await InspectAsync(paths, cancellationToken);
    if (status.CodexLoggedIn)
    {
      progress.Report($"Codex 로그인 재사용: {status.CodexLoginStatus}");
      return;
    }

    progress.Report("ChatGPT 로그인을 시작합니다.");
    var loginResult = await RunCommandAsync(
      CreateCmdWrapperStartInfo(
        paths.GetCodexCommandPath(),
        ["login"],
        paths.InstallRoot,
        BuildToolEnvironment(paths)
      ),
      line =>
      {
        var sanitized = StripAnsi(line);
        if (sanitized.Length == 0)
        {
          return;
        }

        progress.Report(sanitized);
      },
      progress.Report,
      cancellationToken);

    if (loginResult.ExitCode != 0)
    {
      throw new InvalidOperationException($"Codex 로그인 실패: {loginResult.GetSummary()}");
    }
  }

  private async Task<string> ResolveLatestLtsNodeVersionAsync(CancellationToken cancellationToken)
  {
    await using var stream = await HttpClient.GetStreamAsync(NodeIndexUrl, cancellationToken);
    using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

    foreach (var item in document.RootElement.EnumerateArray())
    {
      var lts = item.GetProperty("lts");
      var isLts = lts.ValueKind == JsonValueKind.String || (lts.ValueKind == JsonValueKind.True);
      if (!isLts)
      {
        continue;
      }

      var hasWindowsZip = item.GetProperty("files")
        .EnumerateArray()
        .Select(static entry => entry.GetString())
        .Any(static entry => string.Equals(entry, "win-x64-zip", StringComparison.Ordinal));

      if (!hasWindowsZip)
      {
        continue;
      }

      var version = item.GetProperty("version").GetString();
      if (!string.IsNullOrWhiteSpace(version))
      {
        return version;
      }
    }

    throw new InvalidOperationException("Node 공식 배포 인덱스에서 설치 가능한 Windows LTS 버전을 찾지 못했습니다.");
  }

  private static string StripAnsi(string value)
  {
    return AnsiEscapePattern.Replace(value ?? string.Empty, string.Empty).Trim();
  }

  private static void CopyDirectory(string sourceDirectory, string targetDirectory)
  {
    Directory.CreateDirectory(targetDirectory);

    foreach (var filePath in Directory.GetFiles(sourceDirectory))
    {
      File.Copy(filePath, Path.Combine(targetDirectory, Path.GetFileName(filePath)), overwrite: true);
    }

    foreach (var directoryPath in Directory.GetDirectories(sourceDirectory))
    {
      CopyDirectory(directoryPath, Path.Combine(targetDirectory, Path.GetFileName(directoryPath)));
    }
  }

  private static ProcessStartInfo CreateCmdWrapperStartInfo(
    string commandPath,
    IEnumerable<string> arguments,
    string workingDirectory,
    IReadOnlyDictionary<string, string> environment)
  {
    var invocation = new StringBuilder();
    invocation.Append(QuoteForCmd(commandPath));

    foreach (var argument in arguments)
    {
      invocation.Append(' ').Append(QuoteForCmd(argument));
    }

    var startInfo = new ProcessStartInfo
    {
      FileName = "cmd.exe",
      WorkingDirectory = workingDirectory,
      UseShellExecute = false,
      RedirectStandardOutput = true,
      RedirectStandardError = true,
      RedirectStandardInput = true,
      CreateNoWindow = true,
      StandardOutputEncoding = Encoding.UTF8,
      StandardErrorEncoding = Encoding.UTF8,
      Arguments = $"/d /s /c \"{invocation}\""
    };

    foreach (var entry in environment)
    {
      startInfo.Environment[entry.Key] = entry.Value;
    }

    return startInfo;
  }

  private static string QuoteForCmd(string value)
  {
    return $"\"{value.Replace("\"", "\"\"")}\"";
  }

  private static async Task<ProcessResult> RunCommandAsync(
    ProcessStartInfo startInfo,
    Action<string>? onStdout = null,
    Action<string>? onStderr = null,
    CancellationToken cancellationToken = default,
    string? standardInput = null)
  {
    using var process = new Process
    {
      StartInfo = startInfo,
      EnableRaisingEvents = true
    };

    var outputLines = new List<string>();
    var errorLines = new List<string>();
    var completionSource = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);

    process.OutputDataReceived += (_, eventArgs) =>
    {
      if (eventArgs.Data is null)
      {
        return;
      }

      outputLines.Add(eventArgs.Data);
      onStdout?.Invoke(eventArgs.Data);
    };

    process.ErrorDataReceived += (_, eventArgs) =>
    {
      if (eventArgs.Data is null)
      {
        return;
      }

      errorLines.Add(eventArgs.Data);
      onStderr?.Invoke(eventArgs.Data);
    };

    process.Exited += (_, _) => completionSource.TrySetResult(process.ExitCode);

    if (!process.Start())
    {
      throw new InvalidOperationException($"프로세스를 시작하지 못했습니다: {startInfo.FileName}");
    }

    process.BeginOutputReadLine();
    process.BeginErrorReadLine();

    if (!string.IsNullOrEmpty(standardInput))
    {
      await process.StandardInput.WriteAsync(standardInput);
      await process.StandardInput.FlushAsync();
      process.StandardInput.Close();
    }

    using var registration = cancellationToken.Register(() =>
    {
      try
      {
        if (!process.HasExited)
        {
          process.Kill(entireProcessTree: true);
        }
      }
      catch
      {
      }
    });

    await completionSource.Task.WaitAsync(cancellationToken);

    return new ProcessResult
    {
      ExitCode = process.ExitCode,
      StandardOutput = string.Join(Environment.NewLine, outputLines),
      StandardError = string.Join(Environment.NewLine, errorLines)
    };
  }

  private sealed class ProcessResult
  {
    public int ExitCode { get; init; }
    public string StandardOutput { get; init; } = string.Empty;
    public string StandardError { get; init; } = string.Empty;

    public string GetSummary()
    {
      var payload = string.Join(
        Environment.NewLine,
        new[] { StandardOutput, StandardError }.Where(static value => !string.IsNullOrWhiteSpace(value))
      ).Trim();

      return payload.Length == 0 ? $"exitCode={ExitCode}" : payload;
    }
  }
}
