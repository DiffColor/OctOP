using System.Diagnostics;
using System.IO.Compression;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

sealed class RuntimeInstaller
{
  private sealed class PreparedCodexAdapterSource
  {
    public string SourceRoot { get; init; } = string.Empty;
    public string? SourceRevision { get; init; }
  }

  private sealed class PendingLoginState
  {
    public string LoginId { get; init; } = string.Empty;
    public DateTimeOffset StartedAt { get; init; } = DateTimeOffset.UtcNow;
  }

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
    ["OctOP.WindowsAgentMenu.Runtime.services.codex-adapter.package.json"] = "services/codex-adapter/package.json",
    ["OctOP.WindowsAgentMenu.Runtime.services.codex-adapter.src.index.js"] = "services/codex-adapter/src/index.js",
    ["OctOP.WindowsAgentMenu.Runtime.services.codex-adapter.src.domain.js"] = "services/codex-adapter/src/domain.js",
    ["OctOP.WindowsAgentMenu.Runtime.packages.domain.src.index.js"] = "packages/domain/src/index.js"
  };

  private readonly Assembly _assembly = Assembly.GetExecutingAssembly();

  private static string RuntimeRepositoryRemoteUrl =>
    Environment.GetEnvironmentVariable("OCTOP_WINDOWS_RUNTIME_REPO_URL")?.Trim() is { Length: > 0 } value
      ? value
      : "https://github.com/DiffColor/OctOP.git";

  private static string RuntimeRepositoryBranch =>
    Environment.GetEnvironmentVariable("OCTOP_WINDOWS_RUNTIME_REPO_BRANCH")?.Trim() is { Length: > 0 } value
      ? value
      : "main";

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
    var runtimeBundlePresent = RequiredRuntimeFiles(paths).All(File.Exists);
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
      var accountStatus = await ReadCodexAccountStatusAsync(paths, cancellationToken);
      accountStatus = await RecoverPendingLoginIfNeededAsync(paths, accountStatus, cancellationToken);
      codexLoggedIn = accountStatus.LoggedIn;
      loginStatus = accountStatus.Summary;
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
    Directory.CreateDirectory(paths.RuntimeReleasesRoot);
    Directory.CreateDirectory(paths.RuntimeStateRoot);
    Directory.CreateDirectory(paths.StateHome);

    await EnsureNodeAsync(paths, progress, cancellationToken);
    SaveConfiguration(configuration, paths);
    EnsureAutoStartAtLogin(configuration, progress);
    await EnsureCodexAsync(paths, progress, cancellationToken);
    await EnsureCodexLoginAsync(configuration, paths, progress, cancellationToken);

    var preparedRelease = await PrepareRuntimeReleaseAsync(configuration, paths, progress, cancellationToken);
    ActivateRuntimeRelease(paths, preparedRelease, progress);

    return await InspectAsync(paths, cancellationToken);
  }

  public void WriteEnvironmentFile(RuntimeConfiguration configuration, OctopPaths paths, string runtimeRoot)
  {
    Directory.CreateDirectory(runtimeRoot);
    var env = configuration.GetEnvironmentVariables(paths);
    var builder = new StringBuilder();

    foreach (var entry in env.OrderBy(static entry => entry.Key, StringComparer.OrdinalIgnoreCase))
    {
      builder.Append(entry.Key).Append('=').AppendLine(entry.Value);
    }

    File.WriteAllText(Path.Combine(runtimeRoot, ".env.local"), builder.ToString(), new UTF8Encoding(false));
  }

  public void WriteEnvironmentFile(RuntimeConfiguration configuration, OctopPaths paths)
  {
    WriteEnvironmentFile(configuration, paths, paths.RuntimeRoot);
  }

  public void WriteRuntimeVersion(string runtimeRoot)
  {
    Directory.CreateDirectory(runtimeRoot);
    File.WriteAllText(Path.Combine(runtimeRoot, "version.txt"), AppMetadata.CurrentVersionTag, new UTF8Encoding(false));
  }

  public async Task LoginWithBrowserSelectionAsync(OctopPaths paths, IProgress<string> progress, CancellationToken cancellationToken, bool logoutFirst)
  {
    var codexCommandPath = paths.GetCodexCommandPath();
    if (!File.Exists(codexCommandPath))
    {
      throw new InvalidOperationException($"Codex 실행 파일을 찾지 못했습니다: {codexCommandPath}");
    }

    var browser = await BrowserSelection.SelectBrowserAsync()
      ?? throw new InvalidOperationException("로그인에 사용할 브라우저 선택이 취소되었습니다.");

    await LoginWithSelectedBrowserAsync(paths, browser, progress, cancellationToken, logoutFirst);
  }

  public async Task LoginWithSelectedBrowserAsync(
    OctopPaths paths,
    BrowserOption browser,
    IProgress<string> progress,
    CancellationToken cancellationToken,
    bool logoutFirst)
  {
    var codexCommandPath = paths.GetCodexCommandPath();
    if (!File.Exists(codexCommandPath))
    {
      throw new InvalidOperationException($"Codex 실행 파일을 찾지 못했습니다: {codexCommandPath}");
    }

    progress.Report($"브라우저 선택: {browser.DisplayName}");
    progress.Report($"{browser.DisplayName} 브라우저로 로그인을 시작합니다.");

    await using var session = await CodexAppServerSession.StartAsync(
      codexCommandPath,
      paths.InstallRoot,
      BuildToolEnvironment(paths),
      progress.Report,
      cancellationToken);

    if (logoutFirst)
    {
      progress.Report("현재 로그인 계정을 로그아웃합니다.");
      await session.LogoutAsync(cancellationToken);
      ClearPendingLogin(paths);
    }

    var loginStart = await session.StartChatGptLoginAsync(cancellationToken);
    SavePendingLogin(paths, loginStart.LoginId);
    BrowserSelection.Open(browser, loginStart.AuthUri.AbsoluteUri);
    progress.Report("브라우저에서 인증을 완료해 주세요.");
    await session.WaitForLoginCompletedAsync(loginStart.LoginId, cancellationToken);
    await session.WaitForAccountUpdatedAsync("chatgpt", cancellationToken);
    ClearPendingLogin(paths);
    var accountStatus = await session.ReadAccountAsync(cancellationToken);
    progress.Report($"Codex 로그인 반영: {accountStatus.Summary}");
  }

  public async Task LogoutCodexAsync(OctopPaths paths, IProgress<string> progress, CancellationToken cancellationToken)
  {
    var codexCommandPath = paths.GetCodexCommandPath();
    if (!File.Exists(codexCommandPath))
    {
      progress.Report("Codex CLI가 아직 설치되지 않아 로그아웃을 건너뜁니다.");
      return;
    }

    await using var session = await CodexAppServerSession.StartAsync(
      codexCommandPath,
      paths.InstallRoot,
      BuildToolEnvironment(paths),
      progress.Report,
      cancellationToken);
    await session.LogoutAsync(cancellationToken);
    ClearPendingLogin(paths);

    progress.Report("Codex 로그아웃을 완료했습니다.");
  }

  private static PendingLoginState? LoadPendingLogin(OctopPaths paths)
  {
    if (!File.Exists(paths.PendingLoginPath))
    {
      return null;
    }

    try
    {
      return JsonSerializer.Deserialize<PendingLoginState>(
        File.ReadAllText(paths.PendingLoginPath, Encoding.UTF8),
        new JsonSerializerOptions(JsonSerializerDefaults.Web));
    }
    catch
    {
      return null;
    }
  }

  private static void SavePendingLogin(OctopPaths paths, string loginId)
  {
    Directory.CreateDirectory(paths.InstallRoot);
    var json = JsonSerializer.Serialize(
      new PendingLoginState
      {
        LoginId = loginId,
        StartedAt = DateTimeOffset.UtcNow
      },
      new JsonSerializerOptions(JsonSerializerDefaults.Web)
      {
        WriteIndented = true
      });
    File.WriteAllText(paths.PendingLoginPath, json, new UTF8Encoding(false));
  }

  private static void ClearPendingLogin(OctopPaths paths)
  {
    try
    {
      if (File.Exists(paths.PendingLoginPath))
      {
        File.Delete(paths.PendingLoginPath);
      }
    }
    catch
    {
    }
  }

  private async Task<CodexAppServerSession.AccountStatus> RecoverPendingLoginIfNeededAsync(
    OctopPaths paths,
    CodexAppServerSession.AccountStatus accountStatus,
    CancellationToken cancellationToken)
  {
    if (accountStatus.LoggedIn)
    {
      ClearPendingLogin(paths);
      return accountStatus;
    }

    var pendingLogin = LoadPendingLogin(paths);
    if (pendingLogin is null || string.IsNullOrWhiteSpace(pendingLogin.LoginId))
    {
      return accountStatus;
    }

    try
    {
      await using var session = await CodexAppServerSession.StartAsync(
        paths.GetCodexCommandPath(),
        paths.InstallRoot,
        BuildToolEnvironment(paths),
        null,
        cancellationToken);
      await session.CancelLoginAsync(pendingLogin.LoginId, cancellationToken);
    }
    catch
    {
    }

    ClearPendingLogin(paths);
    return new CodexAppServerSession.AccountStatus
    {
      LoggedIn = false,
      RequiresOpenAiAuth = accountStatus.RequiresOpenAiAuth,
      Summary = "미로그인"
    };
  }

  private static IEnumerable<string> RequiredRuntimeFiles(OctopPaths paths)
  {
    yield return paths.RuntimeAgentEntryPath;
    yield return Path.Combine(paths.RuntimeRoot, "scripts", "run-bridge.mjs");
    yield return Path.Combine(paths.RuntimeRoot, "scripts", "shared-env.mjs");
    yield return Path.Combine(paths.RuntimeRoot, "services", "codex-adapter", "package.json");
    yield return Path.Combine(paths.RuntimeRoot, "services", "codex-adapter", "src", "index.js");
    yield return Path.Combine(paths.RuntimeRoot, "services", "codex-adapter", "src", "domain.js");
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
      ? $"로그인 시 자동 실행을 등록했습니다. exe={executablePath}"
      : $"로그인 시 자동 실행을 해제했습니다. exe={executablePath}");
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
    environment["CODEX_HOME"] = ResolvePreferredCodexHome();

    if (extra is not null)
    {
      foreach (var entry in extra)
      {
        environment[entry.Key] = entry.Value;
      }
    }

    return environment;
  }

  private static string ResolvePreferredCodexHome()
  {
    var candidates = new[]
    {
      Environment.GetEnvironmentVariable("CODEX_HOME")?.Trim(),
      Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex")
    }
      .Where(static value => !string.IsNullOrWhiteSpace(value))
      .Select(static value => Path.GetFullPath(value!))
      .Distinct(StringComparer.OrdinalIgnoreCase)
      .ToArray();

    var authenticated = candidates.FirstOrDefault(HasCodexAuthenticationData);
    if (!string.IsNullOrWhiteSpace(authenticated))
    {
      return authenticated;
    }

    var existing = candidates.FirstOrDefault(Directory.Exists);
    if (!string.IsNullOrWhiteSpace(existing))
    {
      return existing;
    }

    return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
  }

  private static bool HasCodexAuthenticationData(string codexHome)
  {
    var authPath = Path.Combine(codexHome, "auth.json");
    return File.Exists(authPath) && new FileInfo(authPath).Length > 0;
  }

  public async Task<PreparedRuntimeRelease> PrepareRuntimeReleaseAsync(
    RuntimeConfiguration configuration,
    OctopPaths paths,
    IProgress<string> progress,
    CancellationToken cancellationToken)
  {
    Directory.CreateDirectory(paths.RuntimeReleasesRoot);
    Directory.CreateDirectory(paths.RuntimeSourceCacheRoot);

    progress.Report("윈도우 서비스 런타임 후보를 준비합니다.");

    var preparedSource = await ResolvePreparedCodexAdapterSourceAsync(paths, progress, cancellationToken);
    var sourceHash = await ComputeEmbeddedRuntimeSourceHashAsync(cancellationToken);
    var sourceContentRevision = ComputeCodexAdapterContentHash(preparedSource.SourceRoot);
    var sourceRevision = preparedSource.SourceRevision;
    var configurationHash = ComputeConfigurationHash(configuration, paths);
    var runtimeReleaseId = BuildRuntimeReleaseId(sourceRevision, sourceContentRevision, configurationHash);
    var releaseRoot = paths.GetRuntimeReleaseRoot(runtimeReleaseId);
    var canReuseExistingRelease = IsPreparedRuntimeReleaseReusable(releaseRoot, sourceHash);

    if (!canReuseExistingRelease)
    {
      var stagingRoot = Path.Combine(paths.RuntimeReleasesRoot, $"{runtimeReleaseId}.staging-{Guid.NewGuid():N}");
      if (Directory.Exists(stagingRoot))
      {
        Directory.Delete(stagingRoot, recursive: true);
      }

      Directory.CreateDirectory(stagingRoot);

      try
      {
        await WriteRuntimeBundleAsync(stagingRoot, progress, cancellationToken);
        OverlayCodexAdapterSource(preparedSource.SourceRoot, stagingRoot);
        WriteEnvironmentFile(configuration, paths, stagingRoot);
        WriteRuntimeVersion(stagingRoot);

        var buildInfo = new RuntimeReleaseBuildInfo
        {
          RuntimeId = runtimeReleaseId,
          SourceHash = sourceHash,
          ConfigurationHash = configurationHash,
          SourceRevision = sourceRevision,
          SourceContentRevision = sourceContentRevision,
          AppVersion = AppMetadata.CurrentVersionTag,
          CreatedAt = DateTimeOffset.UtcNow
        };
        WriteRuntimeBuildInfo(stagingRoot, buildInfo);
        await EnsureRuntimeDependenciesAsync(paths, stagingRoot, progress, cancellationToken);
        ValidatePreparedRuntimeRelease(stagingRoot);

        if (Directory.Exists(releaseRoot))
        {
          Directory.Delete(releaseRoot, recursive: true);
        }

        Directory.Move(stagingRoot, releaseRoot);
        progress.Report($"런타임 릴리즈를 준비했습니다. id={runtimeReleaseId}");
      }
      catch
      {
        try
        {
          if (Directory.Exists(stagingRoot))
          {
            Directory.Delete(stagingRoot, recursive: true);
          }
        }
        catch
        {
        }

        throw;
      }
    }
    else
    {
      progress.Report($"기존 런타임 릴리즈를 재사용합니다. id={runtimeReleaseId}");
    }

    return new PreparedRuntimeRelease
    {
      RuntimeId = runtimeReleaseId,
      ReleaseRoot = releaseRoot,
      BuildInfo = LoadRuntimeBuildInfo(releaseRoot) ?? new RuntimeReleaseBuildInfo
      {
        RuntimeId = runtimeReleaseId,
        SourceHash = sourceHash,
        ConfigurationHash = configurationHash,
        SourceRevision = sourceRevision,
        SourceContentRevision = sourceContentRevision,
        AppVersion = AppMetadata.CurrentVersionTag,
        CreatedAt = DateTimeOffset.UtcNow
      },
      ReusedExistingRelease = canReuseExistingRelease
    };
  }

  public void ActivateRuntimeRelease(OctopPaths paths, PreparedRuntimeRelease preparedRelease, IProgress<string>? progress = null)
  {
    Directory.CreateDirectory(paths.InstallRoot);
    var currentReleaseId = paths.ReadCurrentRuntimeReleaseId();
    if (!string.IsNullOrWhiteSpace(currentReleaseId) &&
        !string.Equals(currentReleaseId, preparedRelease.RuntimeId, StringComparison.OrdinalIgnoreCase))
    {
      File.WriteAllText(paths.RuntimePreviousPointerPath, currentReleaseId, new UTF8Encoding(false));
    }

    File.WriteAllText(paths.RuntimeCurrentPointerPath, preparedRelease.RuntimeId, new UTF8Encoding(false));
    progress?.Report($"활성 런타임 포인터를 전환했습니다. current={preparedRelease.RuntimeId}");
  }

  public void CleanupStaleRuntimeReleases(OctopPaths paths, IProgress<string>? progress = null, int retentionLimit = 3)
  {
    if (!Directory.Exists(paths.RuntimeReleasesRoot))
    {
      return;
    }

    var protectedReleaseIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    if (paths.ReadCurrentRuntimeReleaseId() is { Length: > 0 } currentReleaseId)
    {
      protectedReleaseIds.Add(currentReleaseId);
    }

    if (paths.ReadPreviousRuntimeReleaseId() is { Length: > 0 } previousReleaseId)
    {
      protectedReleaseIds.Add(previousReleaseId);
    }

    var releaseDirectories = Directory.GetDirectories(paths.RuntimeReleasesRoot)
      .Select(static path => new DirectoryInfo(path))
      .OrderByDescending(static directory => directory.LastWriteTimeUtc)
      .ToList();

    foreach (var directory in releaseDirectories.Take(retentionLimit))
    {
      protectedReleaseIds.Add(directory.Name);
    }

    foreach (var directory in releaseDirectories)
    {
      if (protectedReleaseIds.Contains(directory.Name))
      {
        continue;
      }

      try
      {
        directory.Delete(recursive: true);
        progress?.Report($"오래된 런타임 릴리즈를 정리했습니다. id={directory.Name}");
      }
      catch (Exception error)
      {
        progress?.Report($"오래된 런타임 릴리즈 정리 실패: id={directory.Name} message={error.Message}");
      }
    }
  }

  public RuntimeReleaseBuildInfo? LoadRuntimeBuildInfo(string runtimeRoot)
  {
    var buildInfoPath = Path.Combine(runtimeRoot, "build-info.json");
    if (!File.Exists(buildInfoPath))
    {
      return null;
    }

    return JsonSerializer.Deserialize<RuntimeReleaseBuildInfo>(
      File.ReadAllText(buildInfoPath, Encoding.UTF8),
      new JsonSerializerOptions(JsonSerializerDefaults.Web));
  }

  public async Task<RuntimeUpdateDescriptor?> ResolveAvailableRuntimeUpdateAsync(
    OctopPaths paths,
    CancellationToken cancellationToken,
    IProgress<string>? progress = null)
  {
    var preparedSource = await ResolvePreparedCodexAdapterSourceAsync(paths, progress, cancellationToken);
    var remoteContentRevision = ComputeCodexAdapterContentHash(preparedSource.SourceRoot);
    var currentRoot = paths.ResolveActiveRuntimeRoot();
    var currentBuildInfo = currentRoot is null ? null : LoadRuntimeBuildInfo(currentRoot);
    var currentContentRevision = currentRoot is null ? null : ComputeCurrentRuntimeCodexAdapterContentHash(currentRoot);

    if (string.Equals(remoteContentRevision, currentContentRevision, StringComparison.OrdinalIgnoreCase))
    {
      return null;
    }

    return new RuntimeUpdateDescriptor
    {
      SourceRevision = preparedSource.SourceRevision ?? remoteContentRevision,
      SourceContentRevision = remoteContentRevision,
      CurrentSourceRevision = currentBuildInfo?.SourceRevision,
      CurrentSourceContentRevision = currentContentRevision
    };
  }

  private async Task WriteRuntimeBundleAsync(string runtimeRoot, IProgress<string> progress, CancellationToken cancellationToken)
  {
    progress.Report("런타임 번들을 설치 디렉터리에 복사합니다.");

    foreach (var mapping in RuntimeResources)
    {
      cancellationToken.ThrowIfCancellationRequested();
      var relativePath = mapping.Value.Replace('/', Path.DirectorySeparatorChar);
      var targetPath = Path.Combine(runtimeRoot, relativePath);
      Directory.CreateDirectory(Path.GetDirectoryName(targetPath)!);

      await using var resourceStream = _assembly.GetManifestResourceStream(mapping.Key)
        ?? throw new InvalidOperationException($"런타임 리소스를 찾을 수 없습니다: {mapping.Key}");
      await using var fileStream = File.Create(targetPath);
      await resourceStream.CopyToAsync(fileStream, cancellationToken);
    }

    await File.WriteAllTextAsync(Path.Combine(runtimeRoot, "package.json"), RuntimePackageJson, new UTF8Encoding(false), cancellationToken);
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

  private async Task EnsureRuntimeDependenciesAsync(OctopPaths paths, string runtimeRoot, IProgress<string> progress, CancellationToken cancellationToken)
  {
    progress.Report("OctOP bridge 런타임 의존성을 설치합니다.");
    var npmPath = paths.GetNpmExecutablePath() ?? throw new InvalidOperationException("Node npm 경로를 찾을 수 없습니다.");

    var result = await RunCommandAsync(
      CreateCmdWrapperStartInfo(
        npmPath,
        ["install", "--omit=dev", "--no-audit", "--no-fund"],
        runtimeRoot,
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

  private async Task<PreparedCodexAdapterSource> ResolvePreparedCodexAdapterSourceAsync(
    OctopPaths paths,
    IProgress<string>? progress,
    CancellationToken cancellationToken)
  {
    var overrideRoot = Environment.GetEnvironmentVariable("OCTOP_WINDOWS_RUNTIME_CODEX_ADAPTER_SOURCE")?.Trim();
    if (!string.IsNullOrWhiteSpace(overrideRoot))
    {
      var fullOverrideRoot = Path.GetFullPath(overrideRoot);
      if (!Directory.Exists(fullOverrideRoot))
      {
        throw new DirectoryNotFoundException($"codex-adapter override 경로를 찾지 못했습니다: {fullOverrideRoot}");
      }

      progress?.Report($"codex-adapter override 경로를 사용합니다. path={fullOverrideRoot}");
      return new PreparedCodexAdapterSource
      {
        SourceRoot = fullOverrideRoot,
        SourceRevision = await ReadPathRevisionIfAvailableAsync(fullOverrideRoot, cancellationToken)
      };
    }

    await RefreshRuntimeRepositoryCacheAsync(paths, progress, cancellationToken);
    var sourceRoot = Path.Combine(paths.RuntimeRepositoryCacheRoot, "services", "codex-adapter");
    if (!File.Exists(Path.Combine(sourceRoot, "package.json")))
    {
      throw new InvalidOperationException("캐시 저장소에서 codex-adapter 소스를 찾지 못했습니다.");
    }

    return new PreparedCodexAdapterSource
    {
      SourceRoot = sourceRoot,
      SourceRevision = await ReadRepositoryRevisionForPathAsync(paths.RuntimeRepositoryCacheRoot, sourceRoot, cancellationToken)
    };
  }

  private async Task RefreshRuntimeRepositoryCacheAsync(
    OctopPaths paths,
    IProgress<string>? progress,
    CancellationToken cancellationToken)
  {
    Directory.CreateDirectory(paths.RuntimeSourceCacheRoot);

    if (!Directory.Exists(Path.Combine(paths.RuntimeRepositoryCacheRoot, ".git")))
    {
      if (Directory.Exists(paths.RuntimeRepositoryCacheRoot))
      {
        Directory.Delete(paths.RuntimeRepositoryCacheRoot, recursive: true);
      }

      progress?.Report("윈도우 런타임 원본 저장소를 clone 합니다.");
      await RunGitCommandAsync(
        paths.RuntimeSourceCacheRoot,
        ["clone", "--depth", "1", "--branch", RuntimeRepositoryBranch, RuntimeRepositoryRemoteUrl, paths.RuntimeRepositoryCacheRoot],
        cancellationToken);
      return;
    }

    progress?.Report("윈도우 런타임 원본 저장소를 최신으로 갱신합니다.");
    await RunGitCommandAsync(paths.RuntimeRepositoryCacheRoot, ["fetch", "--depth", "1", "origin", RuntimeRepositoryBranch], cancellationToken);
    await RunGitCommandAsync(paths.RuntimeRepositoryCacheRoot, ["reset", "--hard", "FETCH_HEAD"], cancellationToken);
  }

  private static async Task<string?> ReadRepositoryHeadAsync(string repositoryRoot, CancellationToken cancellationToken)
  {
    var result = await RunCommandAsync(
      new ProcessStartInfo
      {
        FileName = "git",
        WorkingDirectory = repositoryRoot,
        UseShellExecute = false,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        CreateNoWindow = true,
        StandardOutputEncoding = Encoding.UTF8,
        StandardErrorEncoding = Encoding.UTF8,
        Arguments = "rev-parse HEAD"
      },
      cancellationToken: cancellationToken);

    if (result.ExitCode != 0)
    {
      return null;
    }

    var revision = result.StandardOutput.Trim();
    return string.IsNullOrWhiteSpace(revision) ? null : revision;
  }

  private static async Task<string?> ReadPathRevisionIfAvailableAsync(string sourceRoot, CancellationToken cancellationToken)
  {
    var repositoryRoot = await ResolveRepositoryRootAsync(sourceRoot, cancellationToken);
    if (string.IsNullOrWhiteSpace(repositoryRoot))
    {
      return null;
    }

    return await ReadRepositoryRevisionForPathAsync(repositoryRoot, sourceRoot, cancellationToken);
  }

  private static async Task<string?> ResolveRepositoryRootAsync(string workingDirectory, CancellationToken cancellationToken)
  {
    var result = await RunCommandAsync(
      new ProcessStartInfo
      {
        FileName = "git",
        WorkingDirectory = workingDirectory,
        UseShellExecute = false,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        CreateNoWindow = true,
        StandardOutputEncoding = Encoding.UTF8,
        StandardErrorEncoding = Encoding.UTF8,
        Arguments = "rev-parse --show-toplevel"
      },
      cancellationToken: cancellationToken);

    if (result.ExitCode != 0)
    {
      return null;
    }

    var repositoryRoot = result.StandardOutput.Trim();
    return string.IsNullOrWhiteSpace(repositoryRoot) ? null : repositoryRoot;
  }

  private static async Task<string?> ReadRepositoryRevisionForPathAsync(string repositoryRoot, string targetPath, CancellationToken cancellationToken)
  {
    var relativePath = Path.GetRelativePath(repositoryRoot, targetPath)
      .Replace('\\', '/');

    if (relativePath.StartsWith("..", StringComparison.Ordinal))
    {
      return null;
    }

    if (string.IsNullOrWhiteSpace(relativePath))
    {
      relativePath = ".";
    }

    var result = await RunCommandAsync(
      new ProcessStartInfo
      {
        FileName = "git",
        WorkingDirectory = repositoryRoot,
        UseShellExecute = false,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        CreateNoWindow = true,
        StandardOutputEncoding = Encoding.UTF8,
        StandardErrorEncoding = Encoding.UTF8,
        Arguments = $"log -1 --format=%H -- {QuoteArgument(relativePath)}"
      },
      cancellationToken: cancellationToken);

    if (result.ExitCode != 0)
    {
      return null;
    }

    var revision = result.StandardOutput.Trim();
    return string.IsNullOrWhiteSpace(revision) ? null : revision;
  }

  private static string QuoteArgument(string value)
  {
    if (string.IsNullOrEmpty(value))
    {
      return "\"\"";
    }

    return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
  }

  private static async Task RunGitCommandAsync(string workingDirectory, IReadOnlyList<string> arguments, CancellationToken cancellationToken)
  {
    var startInfo = new ProcessStartInfo
    {
      FileName = "git",
      WorkingDirectory = workingDirectory,
      UseShellExecute = false,
      RedirectStandardOutput = true,
      RedirectStandardError = true,
      CreateNoWindow = true,
      StandardOutputEncoding = Encoding.UTF8,
      StandardErrorEncoding = Encoding.UTF8
    };

    foreach (var argument in arguments)
    {
      startInfo.ArgumentList.Add(argument);
    }

    var result = await RunCommandAsync(startInfo, cancellationToken: cancellationToken);
    if (result.ExitCode != 0)
    {
      throw new InvalidOperationException($"git 명령 실패: {result.GetSummary()}");
    }
  }

  private static string ComputeConfigurationHash(RuntimeConfiguration configuration, OctopPaths paths)
  {
    var env = configuration.GetEnvironmentVariables(paths);
    var builder = new StringBuilder();
    foreach (var entry in env.OrderBy(static entry => entry.Key, StringComparer.OrdinalIgnoreCase))
    {
      builder.Append(entry.Key).Append('=').Append(entry.Value).Append('\n');
    }

    return ComputeHash(builder.ToString());
  }

  private async Task<string> ComputeEmbeddedRuntimeSourceHashAsync(CancellationToken cancellationToken)
  {
    var builder = new StringBuilder();
    foreach (var mapping in RuntimeResources.OrderBy(static entry => entry.Value, StringComparer.Ordinal))
    {
      await using var resourceStream = _assembly.GetManifestResourceStream(mapping.Key)
        ?? throw new InvalidOperationException($"런타임 리소스를 찾을 수 없습니다: {mapping.Key}");
      using var reader = new StreamReader(resourceStream, Encoding.UTF8, leaveOpen: false);
      var contents = await reader.ReadToEndAsync(cancellationToken);
      builder.Append(mapping.Value).Append('\n').Append(contents).Append('\n');
    }

    builder.Append(RuntimePackageJson);
    return ComputeHash(builder.ToString());
  }

  private static string ComputeCurrentRuntimeCodexAdapterContentHash(string runtimeRoot)
  {
    var codexAdapterRoot = Path.Combine(runtimeRoot, "services", "codex-adapter");
    return ComputeCodexAdapterContentHash(codexAdapterRoot);
  }

  private static string ComputeCodexAdapterContentHash(string codexAdapterRoot)
  {
    if (!Directory.Exists(codexAdapterRoot))
    {
      return string.Empty;
    }

    var builder = new StringBuilder();
    foreach (var filePath in Directory
      .EnumerateFiles(codexAdapterRoot, "*", SearchOption.AllDirectories)
      .Where(static path =>
      {
        var fileName = Path.GetFileName(path);
        if (string.Equals(fileName, "package-lock.json", StringComparison.OrdinalIgnoreCase))
        {
          return false;
        }

        return !path.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
          .Any(static segment => string.Equals(segment, "node_modules", StringComparison.OrdinalIgnoreCase));
      })
      .OrderBy(static path => path, StringComparer.OrdinalIgnoreCase))
    {
      builder.Append(Path.GetRelativePath(codexAdapterRoot, filePath).Replace('\\', '/')).Append('\n');
      builder.Append(File.ReadAllText(filePath, Encoding.UTF8)).Append('\n');
    }

    return ComputeHash(builder.ToString());
  }

  private static void OverlayCodexAdapterSource(string sourceRoot, string runtimeRoot)
  {
    var targetRoot = Path.Combine(runtimeRoot, "services", "codex-adapter");
    if (Directory.Exists(targetRoot))
    {
      Directory.Delete(targetRoot, recursive: true);
    }

    CopyDirectory(sourceRoot, targetRoot);
  }

  private static string BuildRuntimeReleaseId(string? sourceRevision, string sourceContentRevision, string configurationHash)
  {
    var sourceToken = string.IsNullOrWhiteSpace(sourceRevision) ? sourceContentRevision : sourceRevision;
    sourceToken = sourceToken.Length > 12 ? sourceToken[..12] : sourceToken;
    var configurationToken = configurationHash.Length > 12 ? configurationHash[..12] : configurationHash;
    return $"runtime-{sourceToken}-{configurationToken}";
  }

  private static void WriteRuntimeBuildInfo(string runtimeRoot, RuntimeReleaseBuildInfo buildInfo)
  {
    var json = JsonSerializer.Serialize(buildInfo, new JsonSerializerOptions(JsonSerializerDefaults.Web)
    {
      WriteIndented = true
    });
    File.WriteAllText(Path.Combine(runtimeRoot, "build-info.json"), json, new UTF8Encoding(false));
  }

  private static string ComputeHash(string value)
  {
    using var sha = SHA256.Create();
    var hash = sha.ComputeHash(Encoding.UTF8.GetBytes(value));
    return Convert.ToHexString(hash).ToLowerInvariant();
  }

  private static void ValidatePreparedRuntimeRelease(string runtimeRoot)
  {
    var requiredPaths = new[]
    {
      Path.Combine(runtimeRoot, "scripts", "run-local-agent.mjs"),
      Path.Combine(runtimeRoot, "scripts", "run-bridge.mjs"),
      Path.Combine(runtimeRoot, "scripts", "shared-env.mjs"),
      Path.Combine(runtimeRoot, "services", "codex-adapter", "package.json"),
      Path.Combine(runtimeRoot, "services", "codex-adapter", "src", "index.js"),
      Path.Combine(runtimeRoot, "services", "codex-adapter", "src", "domain.js"),
      Path.Combine(runtimeRoot, "packages", "domain", "src", "index.js"),
      Path.Combine(runtimeRoot, ".env.local"),
      Path.Combine(runtimeRoot, "version.txt"),
      Path.Combine(runtimeRoot, "build-info.json")
    };

    foreach (var requiredPath in requiredPaths)
    {
      if (!File.Exists(requiredPath))
      {
        throw new InvalidOperationException($"준비된 런타임 릴리즈 검증 실패: 필수 파일이 없습니다. path={requiredPath}");
      }
    }
  }

  private static bool IsPreparedRuntimeReleaseReusable(string releaseRoot, string expectedSourceHash)
  {
    if (!Directory.Exists(releaseRoot))
    {
      return false;
    }

    var buildInfoPath = Path.Combine(releaseRoot, "build-info.json");
    if (!File.Exists(buildInfoPath))
    {
      return false;
    }

    RuntimeReleaseBuildInfo? buildInfo;
    try
    {
      buildInfo = JsonSerializer.Deserialize<RuntimeReleaseBuildInfo>(
        File.ReadAllText(buildInfoPath, Encoding.UTF8),
        new JsonSerializerOptions(JsonSerializerDefaults.Web));
    }
    catch
    {
      return false;
    }

    if (buildInfo is null ||
        !string.Equals(buildInfo.SourceHash, expectedSourceHash, StringComparison.OrdinalIgnoreCase) ||
        !string.Equals(buildInfo.AppVersion, AppMetadata.CurrentVersionTag, StringComparison.OrdinalIgnoreCase))
    {
      return false;
    }

    try
    {
      ValidatePreparedRuntimeRelease(releaseRoot);
    }
    catch
    {
      return false;
    }

    return File.Exists(Path.Combine(releaseRoot, "node_modules", "nats", "package.json")) &&
      File.Exists(Path.Combine(releaseRoot, "node_modules", "ws", "package.json"));
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
    await LoginWithBrowserSelectionAsync(paths, progress, cancellationToken, logoutFirst: false);
  }

  private async Task<CodexAppServerSession.AccountStatus> ReadCodexAccountStatusAsync(
    OctopPaths paths,
    CancellationToken cancellationToken)
  {
    await using var session = await CodexAppServerSession.StartAsync(
      paths.GetCodexCommandPath(),
      paths.InstallRoot,
      BuildToolEnvironment(paths),
      null,
      cancellationToken);
    return await session.ReadAccountAsync(cancellationToken);
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
