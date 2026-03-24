using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using Microsoft.Win32;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Serialization;
using System.Windows.Forms;
using System.Windows.Forms.Integration;

sealed class AgentTrayApplicationContext : ApplicationContext
{
  private const int MaxLines = 2000;
  private static readonly string AppTitle = "OctOP Local Agent";
  private static readonly HttpClient HealthcheckClient = new()
  {
    Timeout = TimeSpan.FromSeconds(1)
  };

  private sealed class BridgeHealthStatus
  {
    public bool Ok { get; init; }
    public BridgeHealthPayload? Status { get; init; }

    public bool AppServerConnected => Status?.AppServer?.Connected == true;
    public bool AppServerInitialized => Status?.AppServer?.Initialized == true;
  }

  private sealed class BridgeHealthPayload
  {
    [JsonPropertyName("app_server")]
    public BridgeAppServerHealth? AppServer { get; init; }
  }

  private sealed class BridgeAppServerHealth
  {
    public bool Connected { get; init; }
    public bool Initialized { get; init; }
  }

  private sealed class ServiceProcessInfo
  {
    public int ProcessId { get; init; }
    public string Name { get; init; } = string.Empty;
    public string CommandLine { get; init; } = string.Empty;
  }

  private sealed class ServiceLaunchCheck
  {
    public bool Passed { get; init; }
    public string Message { get; init; } = string.Empty;
  }

  private readonly SynchronizationContext _uiContext;
  private readonly NotifyIcon _notifyIcon;
  private readonly ContextMenuStrip _menu;
  private readonly ToolStripMenuItem _titleItem;
  private readonly ToolStripMenuItem _appVersionItem;
  private readonly ToolStripMenuItem _appUpdateProgressItem;
  private readonly HighlightTextToolStripHost _runtimeVersionItem;
  private readonly ToolStripMenuItem _statusItem;
  private readonly ToolStripMenuItem _environmentItem;
  private readonly ToolStripMenuItem _pidItem;
  private readonly ToolStripMenuItem _toggleItem;
  private readonly ToolStripMenuItem _appUpdateItem;
  private readonly ToolStripMenuItem _setupItem;
  private readonly ToolStripMenuItem _exitItem;
  private readonly LogWindow _logWindow;
  private readonly SetupWindow _setupWindow;
  private readonly RuntimeInstaller _runtimeInstaller;
  private readonly WindowsAutoUpdater _autoUpdater;
  private readonly System.Threading.Timer _updateMonitorTimer;
  private OctopPaths _paths;
  private readonly Icon _colorIcon;
  private readonly Icon _grayscaleIcon;
  private readonly List<string> _lines = [];

  private RuntimeConfiguration _configuration;
  private RuntimeStatus? _runtimeStatus;
  private RuntimeUpdateDescriptor? _availableRuntimeUpdate;
  private AppUpdateDescriptor? _availableAppUpdate;
  private AgentRuntimeState _runtimeState = AgentRuntimeState.Stopped;
  private Process? _process;
  private int? _processId;
  private string? _lastError;
  private DateTimeOffset? _lastUpdatedAt;
  private bool _isExiting;
  private bool _suppressRuntimeStopOnExit;
  private bool _exitInProgress;
  private bool _stopInProgress;
  private bool _startInProgress;
  private bool _appUpdateInProgress;
  private string? _appUpdateTargetTag;
  private AppUpdateProgressInfo? _appUpdateProgress;
  private int _shutdownCleanupStarted;

  public AgentTrayApplicationContext()
  {
    _uiContext = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
    _runtimeInstaller = new RuntimeInstaller();
    _autoUpdater = new WindowsAutoUpdater();
    _paths = new OctopPaths(OctopPaths.ResolvePreferredInstallRoot());
    _configuration = _runtimeInstaller.LoadConfiguration(_paths);

    _colorIcon = CreateTrayIcon(grayscale: false);
    _grayscaleIcon = CreateTrayIcon(grayscale: true);
    _logWindow = new LogWindow(ClearLogs);
    _setupWindow = new SetupWindow(_runtimeInstaller);
    EnableModelessKeyboardInterop(_logWindow);
    EnableModelessKeyboardInterop(_setupWindow);
    _setupWindow.LoadConfiguration(_configuration);
    _setupWindow.LogsRequested += (_, _) => ShowLogs();
    _setupWindow.LogProduced += (_, message) =>
    {
      PostToUi(() =>
      {
        AppendLog(message);
        RefreshUi();
      });
    };
    _setupWindow.InstallationCompleted += (_, status) =>
    {
      PostToUi(() =>
      {
        _runtimeStatus = status;
        _ = HandleInstallationCompletedSafeAsync(status);
      });
    };

    _menu = new ContextMenuStrip();
    _menu.Opening += (_, _) => RefreshMenuState();

    _titleItem = new ToolStripMenuItem(AppTitle) { Enabled = false };
    _appVersionItem = new ToolStripMenuItem() { Enabled = false };
    _appUpdateProgressItem = new ToolStripMenuItem() { Enabled = false, Visible = false };
    _runtimeVersionItem = new HighlightTextToolStripHost();
    _statusItem = new ToolStripMenuItem() { Enabled = false };
    _environmentItem = new ToolStripMenuItem("환경 확인 중") { Enabled = false };
    _pidItem = new ToolStripMenuItem() { Enabled = false, Visible = false };
    _toggleItem = new ToolStripMenuItem("서비스 시작");
    _toggleItem.Click += (_, _) => ToggleProcess();
    _appUpdateItem = new ToolStripMenuItem("앱 업데이트");
    _appUpdateItem.Click += async (_, _) => await BeginAppUpdateAsync();
    _setupItem = new ToolStripMenuItem("환경 설정");
    _setupItem.Click += (_, _) => ShowSetup();
    _exitItem = new ToolStripMenuItem("종료");
    _exitItem.Click += async (_, _) => await ExitApplicationAsync();

    _menu.Items.AddRange(
    [
      _titleItem,
      _appVersionItem,
      _appUpdateProgressItem,
      _runtimeVersionItem,
      _statusItem,
      _environmentItem,
      _pidItem,
      new ToolStripSeparator(),
      _toggleItem,
      _appUpdateItem,
      _setupItem,
      new ToolStripSeparator(),
      _exitItem
    ]);

    _notifyIcon = new NotifyIcon
    {
      ContextMenuStrip = _menu,
      Icon = _grayscaleIcon,
      Text = AppTitle,
      Visible = true
    };
    _notifyIcon.DoubleClick += (_, _) =>
    {
      if (_runtimeStatus?.ReadyToRun == true)
      {
        ShowLogs();
        return;
      }

      ShowSetup();
    };

    AppDomain.CurrentDomain.ProcessExit += HandleCurrentProcessExit;
    AppDomain.CurrentDomain.UnhandledException += HandleCurrentUnhandledException;
    SystemEvents.SessionEnding += HandleWindowsSessionEnding;
    SystemEvents.SessionEnded += HandleWindowsSessionEnded;

    AppendLog("윈도우 트레이 앱이 시작되었습니다.");
    RefreshRuntimeStateFromSystem(logDetection: true);
    RefreshUi();
    _updateMonitorTimer = new System.Threading.Timer(
      _ =>
      {
        PostToUi(() =>
        {
          RefreshRuntimeStateFromSystem(logDetection: true);
          RefreshUi();
          _ = RefreshAvailableRuntimeUpdateAsync();
          _ = RefreshAvailableAppUpdateAsync();
        });
      },
      null,
      TimeSpan.FromSeconds(60),
      TimeSpan.FromSeconds(60));
    _ = InitializeAsync();
  }

  protected override void Dispose(bool disposing)
  {
    if (disposing)
    {
      AppDomain.CurrentDomain.ProcessExit -= HandleCurrentProcessExit;
      AppDomain.CurrentDomain.UnhandledException -= HandleCurrentUnhandledException;
      SystemEvents.SessionEnding -= HandleWindowsSessionEnding;
      SystemEvents.SessionEnded -= HandleWindowsSessionEnded;

      if (!_suppressRuntimeStopOnExit)
      {
        TryTerminateServiceProcessesForShutdown(includeStdioSessions: true);
      }

      _notifyIcon.Visible = false;
      _notifyIcon.Dispose();
      _menu.Dispose();
      _setupWindow.AllowClose = true;
      _setupWindow.Close();
      _logWindow.AllowClose = true;
      _logWindow.Close();
      _colorIcon.Dispose();
      _grayscaleIcon.Dispose();
      _updateMonitorTimer.Dispose();
      DisposeProcess();
    }

    base.Dispose(disposing);
  }

  private async Task InitializeAsync()
  {
    _autoUpdater.MarkPendingAppUpdateLaunchSucceededIfNeeded(_paths, AppendLog);
    _autoUpdater.CleanupCompletedUpdateArtifactsIfNeeded(_paths, AppendLog);

    await RefreshRuntimeStatusAsync(showSetupWhenIncomplete: true);
    await RefreshAvailableRuntimeUpdateAsync();
    await RefreshAvailableAppUpdateAsync();
    var runtimePreparedChanged = await EnsureRuntimePreparedIfNeededAsync(allowWhileRunning: true);

    var resumePendingServiceStart = ConsumePendingServiceStartRequest();
    var shouldAutoStartService =
      _runtimeStatus?.AutoStartRequested == true &&
      _runtimeState is not (AgentRuntimeState.Running or AgentRuntimeState.Starting);

    if (!resumePendingServiceStart && !shouldAutoStartService)
    {
      return;
    }

    AppendLog(resumePendingServiceStart
      ? "업데이트 후 서비스 자동 시작을 이어갑니다."
      : "자동 시작 설정에 따라 서비스 시작을 진행합니다.");
    await RefreshRuntimeStatusAsync();
    if (!HasAtomicRuntimePreparationPrerequisites())
    {
      ShowSetup();
      var completedStatus = await _setupWindow.EnsureInstalledAsync(automatic: true, showMessageBoxOnFailure: true);
      _runtimeStatus = completedStatus ?? _runtimeStatus;
      await RefreshRuntimeStatusAsync();
    }

    runtimePreparedChanged |= await EnsureRuntimePreparedIfNeededAsync(allowWhileRunning: true);
    await RefreshRuntimeStatusAsync();
    await RefreshAvailableRuntimeUpdateAsync();

    if (_runtimeStatus?.ReadyToRun == true && ShouldRunStartupRuntimeTransition(runtimePreparedChanged))
    {
      AppendLog(_runtimeState is AgentRuntimeState.Running or AgentRuntimeState.Starting
        ? "자동 시작 시 실행 중인 서비스를 재전환해 런타임 업데이트를 반영합니다."
        : "자동 시작 시 서비스 시작 전 원자적 런타임 전환을 진행합니다.");
      await StartAsync(forceRestart: runtimePreparedChanged);
    }
  }

  private async Task<bool> EnsureRuntimePreparedIfNeededAsync(bool allowWhileRunning)
  {
    if (!HasAtomicRuntimePreparationPrerequisites())
    {
      return false;
    }

    if ((!allowWhileRunning && _runtimeState is (AgentRuntimeState.Running or AgentRuntimeState.Starting)) || _stopInProgress)
    {
      return false;
    }

    var currentRuntimeRoot = _paths.ResolveActiveRuntimeRoot();
    var shouldPrepareImmediately =
      currentRuntimeRoot is null ||
      _availableRuntimeUpdate is not null;
    if (!shouldPrepareImmediately)
    {
      return false;
    }

    if (currentRuntimeRoot is null)
    {
      AppendLog("첫 시작 런타임이 없어 원자적 런타임 준비를 바로 진행합니다.");
    }
    else if (_availableRuntimeUpdate is not null)
    {
      AppendLog("앱 시작 직후 런타임 버전 불일치를 감지해 원자적 런타임 준비를 진행합니다.");
    }
    else
    {
      AppendLog("시작 직후 감지된 런타임 업데이트를 바로 반영합니다.");
    }

    var preparedRelease = await _runtimeInstaller.PrepareRuntimeReleaseAsync(
      _configuration,
      _paths,
      new Progress<string>(AppendLog),
      CancellationToken.None);

    var currentReleaseId = _paths.ReadCurrentRuntimeReleaseId();
    var runtimeChanged = !string.Equals(currentReleaseId, preparedRelease.RuntimeId, StringComparison.OrdinalIgnoreCase);
    if (runtimeChanged)
    {
      AppendLog($"새 런타임 릴리즈 준비를 완료했습니다. 활성 전환은 기동 검증 후 진행합니다. target={preparedRelease.RuntimeId}");
    }

    await RefreshRuntimeStatusAsync();
    await RefreshAvailableRuntimeUpdateAsync();
    return runtimeChanged;
  }

  private bool HasAtomicRuntimePreparationPrerequisites()
  {
    return _runtimeStatus is not null &&
      _runtimeStatus.ConfigurationSaved &&
      _runtimeStatus.NodeInstalled &&
      _runtimeStatus.CodexInstalled &&
      _runtimeStatus.CodexLoggedIn;
  }

  private bool ShouldRunStartupRuntimeTransition(bool runtimePreparedChanged)
  {
    var currentRuntimeRoot = _paths.ResolveActiveRuntimeRoot();
    return runtimePreparedChanged ||
      currentRuntimeRoot is null ||
      _availableRuntimeUpdate is not null ||
      _runtimeState is not (AgentRuntimeState.Running or AgentRuntimeState.Starting);
  }

  private async Task HandleInstallationCompletedAsync(RuntimeStatus status)
  {
    await RefreshRuntimeStatusAsync();
    if (status.AutoStartRequested &&
        _runtimeState is not AgentRuntimeState.Starting &&
        _runtimeState is not AgentRuntimeState.Stopping)
    {
      var runtimePreparedChanged = await EnsureRuntimePreparedIfNeededAsync(allowWhileRunning: true);
      await RefreshAvailableRuntimeUpdateAsync();
      await RefreshRuntimeStatusAsync();

      if (_runtimeStatus?.ReadyToRun == true && ShouldRunStartupRuntimeTransition(runtimePreparedChanged))
      {
        AppendLog("자동 설치 완료 후 원자적 런타임 전환과 서비스 시작을 이어갑니다.");
        await StartAsync(forceRestart: runtimePreparedChanged);
      }
    }
  }

  private async Task HandleInstallationCompletedSafeAsync(RuntimeStatus status)
  {
    try
    {
      await HandleInstallationCompletedAsync(status);
    }
    catch (Exception error)
    {
      AppendLog($"설치 완료 후속 처리 실패: {error.Message}");
      RefreshUi();
    }
  }

  private async Task RefreshRuntimeStatusAsync(bool showSetupWhenIncomplete = false)
  {
    try
    {
      _paths = new OctopPaths(OctopPaths.ResolvePreferredInstallRoot());
      _configuration = _runtimeInstaller.LoadConfiguration(_paths);
      _runtimeStatus = await _runtimeInstaller.InspectAsync(_paths, CancellationToken.None);
      _setupWindow.LoadConfiguration(_configuration);
      _setupWindow.UpdateStatus(_runtimeStatus);
      RefreshRuntimeStateFromSystem(logDetection: true);
      RefreshUi();

      if (showSetupWhenIncomplete && _runtimeStatus.ReadyToRun is false)
      {
        AppendLog("설치 또는 로그인이 완료되지 않아 환경설정 창을 열고 자동 설치를 진행합니다.");
        ShowSetup();
        _setupWindow.StartAutomaticInstallIfNeeded();
      }
    }
    catch (Exception error)
    {
      _runtimeStatus = null;
      _lastError = error.Message;
      AppendLog($"환경 확인 실패: {error.Message}");
      RefreshUi();
      if (showSetupWhenIncomplete)
      {
        ShowSetup();
        _setupWindow.StartAutomaticInstallIfNeeded();
      }
    }
  }

  private void ToggleProcess()
  {
    if (_stopInProgress)
    {
      return;
    }

    if (_runtimeState is AgentRuntimeState.Running or AgentRuntimeState.Starting)
    {
      Stop();
      return;
    }

    _ = StartAsync();
  }

  private async Task StartAsync(bool forceRestart = false)
  {
    if (_startInProgress || _stopInProgress)
    {
      return;
    }

    _startInProgress = true;
    try
    {
      await RefreshRuntimeStatusAsync();
      if (!HasAtomicRuntimePreparationPrerequisites())
      {
        AppendLog("실행 전 설치/설정이 필요합니다.");
        ShowSetup();
        _setupWindow.StartAutomaticInstallIfNeeded();
        return;
      }

      var runtimePreparedChanged = await EnsureRuntimePreparedIfNeededAsync(allowWhileRunning: true);
      await RefreshRuntimeStatusAsync();
      if (_runtimeStatus?.ReadyToRun != true)
      {
        AppendLog("실행 전 런타임 준비가 완료되지 않았습니다.");
        ShowSetup();
        _setupWindow.StartAutomaticInstallIfNeeded();
        return;
      }

      RefreshRuntimeStateFromSystem();
      if (!forceRestart && !runtimePreparedChanged && _runtimeState is (AgentRuntimeState.Running or AgentRuntimeState.Starting))
      {
        AppendLog("서비스가 이미 실행 중이라 시작 요청을 건너뜁니다.");
        RefreshUi();
        return;
      }

      _runtimeState = AgentRuntimeState.Starting;
      _lastError = null;
      AppendLog("서비스 시작을 요청합니다.");
      RefreshUi();

      var preparedRelease = await _runtimeInstaller.PrepareRuntimeReleaseAsync(
        _configuration,
        _paths,
        new Progress<string>(AppendLog),
        CancellationToken.None);

      await StopServiceProcessesAsync(includeStdioSessions: true, logWhenIdle: false);
      await LaunchPreparedRuntimeReleaseAsync(preparedRelease, allowRollback: true);
    }
    finally
    {
      _startInProgress = false;
    }
  }

  private async Task LaunchPreparedRuntimeReleaseAsync(PreparedRuntimeRelease preparedRelease, bool allowRollback)
  {
    var nodeExecutablePath = _paths.GetNodeExecutablePath();
    if (nodeExecutablePath is null || !File.Exists(nodeExecutablePath))
    {
      _runtimeState = AgentRuntimeState.Failed;
      _lastError = "managed node executable not found";
      AppendLog("local-agent 시작 실패: 앱 관리형 Node를 찾지 못했습니다.");
      RefreshUi();
      ShowSetup();
      return;
    }

    var environment = _runtimeInstaller.BuildToolEnvironment(_paths, _configuration.GetEnvironmentVariables(_paths));
    environment["PATH"] = string.Join(
      Path.PathSeparator,
      new[]
      {
        _paths.GetManagedNodeDirectory(),
        _paths.NpmPrefix,
        environment.TryGetValue("PATH", out var currentPath) ? currentPath : string.Empty
      }.Where(static value => !string.IsNullOrWhiteSpace(value))
    );

    var startInfo = new ProcessStartInfo
    {
      FileName = nodeExecutablePath,
      WorkingDirectory = preparedRelease.ReleaseRoot,
      UseShellExecute = false,
      RedirectStandardOutput = true,
      RedirectStandardError = true,
      CreateNoWindow = true,
      StandardOutputEncoding = Encoding.UTF8,
      StandardErrorEncoding = Encoding.UTF8
    };
    startInfo.ArgumentList.Add(Path.Combine(preparedRelease.ReleaseRoot, "scripts", "run-local-agent.mjs"));

    foreach (var entry in environment)
    {
      startInfo.Environment[entry.Key] = entry.Value;
    }

    var process = new Process
    {
      StartInfo = startInfo,
      EnableRaisingEvents = true
    };
    var processStarted = false;

    process.OutputDataReceived += (_, eventArgs) =>
    {
      if (!string.IsNullOrWhiteSpace(eventArgs.Data))
      {
        PostToUi(() =>
        {
          AppendLog(eventArgs.Data);
          RefreshUi();
        });
      }
    };

    process.ErrorDataReceived += (_, eventArgs) =>
    {
      if (!string.IsNullOrWhiteSpace(eventArgs.Data))
      {
        PostToUi(() =>
        {
          AppendLog(eventArgs.Data);
          RefreshUi();
        });
      }
    };

    process.Exited += (_, _) => PostToUi(() => HandleTermination(process));

    try
    {
      process.Start();
      processStarted = true;
      process.BeginOutputReadLine();
      process.BeginErrorReadLine();
      _process = process;
      _processId = process.Id;
      WriteAgentPidFile(process.Id);
      _runtimeState = AgentRuntimeState.Running;
      _lastUpdatedAt = DateTimeOffset.Now;
      AppendLog($"서비스가 시작되었습니다. pid={process.Id}");
      RefreshUi();

      var launchValidated = await WaitForServiceReadyAsync(process, preparedRelease.ReleaseRoot);
      if (!launchValidated)
      {
        AppendLog("새 런타임 기동 검증에 실패했습니다. 이전 런타임으로 롤백합니다.");
        await StopServiceProcessesAsync(includeStdioSessions: true, logWhenIdle: false);
        RestoreRuntimePointerAfterFailedLaunch(preparedRelease.RuntimeId);

        var rollbackRelease = ResolveRollbackPreparedRuntimeRelease(preparedRelease.RuntimeId);
        if (allowRollback && rollbackRelease is not null)
        {
          await LaunchPreparedRuntimeReleaseAsync(rollbackRelease, allowRollback: false);
          return;
        }

        _runtimeState = AgentRuntimeState.Failed;
        _lastError = "service launch validation failed";
        RefreshUi();
        return;
      }

      _runtimeInstaller.ActivateRuntimeRelease(_paths, preparedRelease, new Progress<string>(AppendLog));
      _paths = new OctopPaths(OctopPaths.ResolvePreferredInstallRoot());
      _runtimeInstaller.CleanupStaleRuntimeReleases(_paths, new Progress<string>(AppendLog));
      _ = RefreshAvailableRuntimeUpdateAsync();
    }
    catch (Exception error)
    {
      if (processStarted)
      {
        try
        {
          await StopServiceProcessesAsync(includeStdioSessions: true, logWhenIdle: false);
        }
        catch
        {
        }

        RestoreRuntimePointerAfterFailedLaunch(preparedRelease.RuntimeId);
      }

      process.Dispose();
      _runtimeState = AgentRuntimeState.Failed;
      _lastError = error.Message;
      AppendLog($"local-agent 시작 실패: {error.Message}");
      RefreshUi();
    }
  }

  private async Task RestartAsync()
  {
    RefreshRuntimeStateFromSystem();
    Stop();
    await WaitForRuntimeStopAsync();

    RefreshRuntimeStateFromSystem();
    if (_stopInProgress || _runtimeState is AgentRuntimeState.Running or AgentRuntimeState.Starting)
    {
      return;
    }

    await RefreshRuntimeStatusAsync();
    if (_runtimeStatus?.ReadyToRun != true)
    {
      AppendLog("재시작 전에 설치/설정을 마무리합니다.");
      ShowSetup();
      var completedStatus = await _setupWindow.EnsureInstalledAsync(automatic: true, showMessageBoxOnFailure: true);
      _runtimeStatus = completedStatus ?? _runtimeStatus;
      await RefreshRuntimeStatusAsync();
      if (_runtimeStatus?.ReadyToRun != true)
      {
        AppendLog("설치/설정이 완료되지 않아 서비스를 시작하지 않습니다.");
        RefreshUi();
        return;
      }
    }

    await StartAsync();
  }

  private async Task WaitForRuntimeStopAsync(int timeoutMs = 5000)
  {
    var deadline = DateTimeOffset.UtcNow.AddMilliseconds(timeoutMs);

    while (DateTimeOffset.UtcNow < deadline)
    {
      RefreshRuntimeStateFromSystem();
      if (_runtimeState is not (AgentRuntimeState.Running or AgentRuntimeState.Starting or AgentRuntimeState.Stopping) &&
          !_stopInProgress)
      {
        return;
      }

      await Task.Delay(100);
    }

    RefreshRuntimeStateFromSystem();
  }

  private void Stop()
  {
    if (_stopInProgress)
    {
      return;
    }

    _stopInProgress = true;
    _runtimeState = AgentRuntimeState.Stopping;
    _lastUpdatedAt = DateTimeOffset.Now;
    AppendLog("서비스 정지를 요청합니다.");
    RefreshUi();

    _ = StopAsync();
  }

  private async Task StopAsync()
  {
    try
    {
      await StopServiceProcessesAsync(includeStdioSessions: true, logWhenIdle: true);
    }
    catch (Exception error)
    {
      _runtimeState = AgentRuntimeState.Failed;
      _lastError = $"서비스 정지 실패: {error.Message}";
      _lastUpdatedAt = DateTimeOffset.Now;
      AppendLog($"서비스 정지 실패: {error.Message}");
    }
    finally
    {
      _stopInProgress = false;
      RefreshUi();
    }
  }

  private void ShowSetup()
  {
    _setupWindow.LoadConfiguration(_configuration);
    if (_runtimeStatus is not null)
    {
      _setupWindow.UpdateStatus(_runtimeStatus);
    }

    if (_setupWindow.Visible)
    {
      _setupWindow.BringToFront();
      return;
    }

    _setupWindow.Show();
    _setupWindow.BringToFront();
  }

  private void ShowLogs()
  {
    if (_logWindow.Visible)
    {
      _logWindow.BringToFront();
      return;
    }

    _logWindow.Show();
    _logWindow.BringToFront();
  }

  private void ClearLogs()
  {
    _lines.Clear();
    AppendLog("로그를 초기화했습니다.");
    RefreshUi();
  }

  private Task ExitApplicationAsync()
  {
    if (_exitInProgress)
    {
      return Task.CompletedTask;
    }

    _exitInProgress = true;
    _isExiting = true;

    return ExitApplicationCoreAsync();
  }

  private async Task ExitApplicationCoreAsync()
  {
    try
    {
      _setupWindow.AllowClose = true;
      _setupWindow.Close();
      _logWindow.AllowClose = true;
      _logWindow.Close();
      _notifyIcon.Visible = false;

      if (!_suppressRuntimeStopOnExit)
      {
        try
        {
          await StopServiceProcessesAsync(includeStdioSessions: true, logWhenIdle: false);
        }
        catch (Exception error)
        {
          AppendLog($"앱 종료 중 서비스 정상 정지가 완전히 끝나지 않아 강제 종료를 이어갑니다: {error.Message}");
          TryTerminateServiceProcessesForShutdown(includeStdioSessions: true);
        }
      }

      _updateMonitorTimer.Dispose();
      ExitThread();
    }
    finally
    {
      Environment.Exit(0);
    }
  }

  private void MarkPendingServiceStartRequest()
  {
    Directory.CreateDirectory(_paths.InstallRoot);
    File.WriteAllText(_paths.PendingServiceStartPath, "1", new UTF8Encoding(false));
  }

  private bool ConsumePendingServiceStartRequest()
  {
    if (!File.Exists(_paths.PendingServiceStartPath))
    {
      return false;
    }

    try
    {
      File.Delete(_paths.PendingServiceStartPath);
    }
    catch
    {
    }

    return true;
  }

  private void HandleTermination(Process terminatedProcess)
  {
    if (!ReferenceEquals(_process, terminatedProcess))
    {
      terminatedProcess.Dispose();
      return;
    }

    var exitCode = 0;

    try
    {
      exitCode = terminatedProcess.ExitCode;
    }
    catch
    {
    }

    DisposeProcess();
    DeleteAgentPidFile();

    if (_isExiting || _runtimeState == AgentRuntimeState.Stopping || exitCode == 0)
    {
      _runtimeState = AgentRuntimeState.Stopped;
      _lastError = null;
    }
    else
    {
      _runtimeState = AgentRuntimeState.Failed;
      _lastError = $"종료 코드 {exitCode}";
    }

    _lastUpdatedAt = DateTimeOffset.Now;
    AppendLog($"local-agent 종료됨. exitCode={exitCode}");
    RefreshUi();
  }

  private void DisposeProcess()
  {
    if (_process is null)
    {
      _processId = null;
      return;
    }

    _process.Dispose();
    _process = null;
    _processId = null;
  }

  private void RefreshUi()
  {
    _notifyIcon.Icon = _runtimeState is AgentRuntimeState.Running or AgentRuntimeState.Starting
      ? _colorIcon
      : _grayscaleIcon;
    _notifyIcon.Text = BuildTrayText();
    RefreshMenuState();
    _logWindow.UpdateState(
      title: AppTitle,
      status: GetRuntimeStateLabel(_runtimeState),
      statusColor: GetRuntimeColor(_runtimeState),
      lines: _lines,
      updatedAt: _lastUpdatedAt,
      lastError: _lastError
    );
  }

  private void RefreshMenuState()
  {
    _appVersionItem.Text = _appUpdateInProgress && !string.IsNullOrWhiteSpace(_appUpdateTargetTag)
      ? $"앱 버전 {AppMetadata.CurrentVersionTag} → {_appUpdateTargetTag}"
      : $"앱 버전 {AppMetadata.CurrentVersionTag}";
    _appUpdateProgressItem.Visible = _appUpdateInProgress && !string.IsNullOrWhiteSpace(_appUpdateProgress?.Summary);
    _appUpdateProgressItem.Text = _appUpdateProgress?.Summary ?? string.Empty;
    _appUpdateProgressItem.ForeColor = Color.RoyalBlue;
    _runtimeVersionItem.SetSegments(
      ResolveRuntimeVersionDisplayPrefix(),
      _availableRuntimeUpdate?.DisplayRevision);
    _statusItem.Text = GetRuntimeStateLabel(_runtimeState);
    _statusItem.ForeColor = GetRuntimeColor(_runtimeState);

    var requiresSetup = _runtimeStatus is null || _runtimeStatus.ReadyToRun != true;
    _environmentItem.Text = requiresSetup ? "환경 설정 필요" : string.Empty;
    _environmentItem.ForeColor = requiresSetup ? Color.Firebrick : SystemColors.GrayText;
    _environmentItem.Visible = requiresSetup;

    _pidItem.Text = string.Empty;
    _pidItem.Visible = false;

    var running = _runtimeState is AgentRuntimeState.Running or AgentRuntimeState.Starting;
    _toggleItem.Text = running ? "서비스 정지" : "서비스 시작";
    _toggleItem.Enabled = (_runtimeStatus?.ReadyToRun == true || running) && !_setupWindow.InstallationInProgress && !_stopInProgress;
    _appUpdateItem.Visible = (_availableAppUpdate is not null || _appUpdateInProgress) && AppMetadata.CanSelfUpdate();
    _appUpdateItem.Enabled = _availableAppUpdate is not null && !_setupWindow.InstallationInProgress && !_appUpdateInProgress;
    _appUpdateItem.Text = _appUpdateInProgress
      ? BuildAppUpdateActionText()
      : _availableAppUpdate is null
        ? "앱 업데이트"
        : $"앱 업데이트 {_availableAppUpdate.Tag}";
    _appUpdateItem.ForeColor = _availableAppUpdate is null && !_appUpdateInProgress ? SystemColors.ControlText : Color.RoyalBlue;
  }

  private string ResolveRuntimeVersionDisplayPrefix()
  {
    var buildInfo = _runtimeInstaller.LoadRuntimeBuildInfo(_paths.RuntimeRoot);
    var currentToken = buildInfo?.SourceRevision;
    if (string.IsNullOrWhiteSpace(currentToken))
    {
      currentToken = buildInfo?.SourceContentRevision;
    }

    var currentDisplay = string.IsNullOrWhiteSpace(currentToken)
      ? "미설치"
      : string.Concat(currentToken.Take(12));

    if (_availableRuntimeUpdate is null)
    {
      return $"런타임 ID {currentDisplay}";
    }

    return $"런타임 ID {currentDisplay} · 업데이트 ";
  }

  private void AppendLog(string message)
  {
    var timestamp = DateTimeOffset.Now.ToString("HH:mm:ss");
    _lines.Add($"[{timestamp}] {message}");
    if (_lines.Count > MaxLines)
    {
      _lines.RemoveRange(0, _lines.Count - MaxLines);
    }

    _lastUpdatedAt = DateTimeOffset.Now;
  }

  private string BuildTrayText()
  {
    if (_appUpdateInProgress)
    {
      var progressPercent = _appUpdateProgress?.Percent;
      var progressLabel = progressPercent is double value
        ? $"{Math.Clamp(value, 0d, 100d):0.0}%"
        : "준비 중";
      var updateText = $"{AppTitle} - 앱 업데이트 {progressLabel}";
      return updateText.Length <= 63 ? updateText : AppTitle;
    }

    var stateText = GetRuntimeStateLabel(_runtimeState);
    var suffix = _runtimeStatus?.ReadyToRun == true ? stateText : "환경설정 필요";
    var text = $"{AppTitle} - {suffix}";
    return text.Length <= 63 ? text : AppTitle;
  }

  private async Task RefreshAvailableRuntimeUpdateAsync()
  {
    try
    {
      _availableRuntimeUpdate = await _runtimeInstaller.ResolveAvailableRuntimeUpdateAsync(
        _paths,
        CancellationToken.None,
        new Progress<string>(AppendLog));
    }
    catch (Exception error)
    {
      _availableRuntimeUpdate = null;
      AppendLog($"런타임 업데이트 확인 실패: {error.Message}");
    }

    RefreshUi();
  }

  private async Task RefreshAvailableAppUpdateAsync()
  {
    try
    {
      _availableAppUpdate = await _autoUpdater.GetAvailableUpdateAsync(
        AppMetadata.CurrentVersionTag,
        CancellationToken.None);
    }
    catch (Exception error)
    {
      _availableAppUpdate = null;
      AppendLog($"앱 업데이트 확인 실패: {error.Message}");
    }

    RefreshUi();
  }

  private async Task BeginAppUpdateAsync()
  {
    if (_appUpdateInProgress)
    {
      RefreshUi();
      return;
    }

    await RefreshAvailableAppUpdateAsync();
    if (_availableAppUpdate is null)
    {
      AppendLog("적용 가능한 앱 업데이트가 없습니다.");
      return;
    }

    try
    {
      _appUpdateInProgress = true;
      _appUpdateTargetTag = _availableAppUpdate.Tag;
      UpdateAppUpdateProgress(new AppUpdateProgressInfo
      {
        Stage = "prepare",
        Summary = $"앱 업데이트 {_availableAppUpdate.Tag} 준비 중",
        Percent = 0,
        DownloadedBytes = 0,
        TotalBytes = 0,
        IsIndeterminate = true
      });
      AppendLog($"앱 업데이트를 시작합니다. target={_availableAppUpdate.Tag}");
      await StopServiceProcessesAsync(includeStdioSessions: true, logWhenIdle: false);

      var updateApplied = await _autoUpdater.TryApplyUpdateAsync(
        _availableAppUpdate,
        _paths,
        _configuration,
        AppendLog,
        progress => PostToUi(() => UpdateAppUpdateProgress(progress)),
        CancellationToken.None);
      if (!updateApplied)
      {
        AppendLog("앱 업데이트를 적용하지 않았습니다.");
        ClearAppUpdateProgress();
        return;
      }

      _suppressRuntimeStopOnExit = true;
      await ExitApplicationAsync();
    }
    catch (Exception error)
    {
      ClearAppUpdateProgress();
      AppendLog($"앱 업데이트 시작 실패: {error.Message}");
      RefreshUi();
    }
  }

  private void UpdateAppUpdateProgress(AppUpdateProgressInfo progress)
  {
    _appUpdateInProgress = true;
    _appUpdateProgress = progress;
    RefreshUi();
  }

  private void ClearAppUpdateProgress()
  {
    _appUpdateInProgress = false;
    _appUpdateTargetTag = null;
    _appUpdateProgress = null;
    RefreshUi();
  }

  private string BuildAppUpdateActionText()
  {
    var targetTag = !string.IsNullOrWhiteSpace(_appUpdateTargetTag)
      ? _appUpdateTargetTag
      : _availableAppUpdate?.Tag;
    var progressPercent = _appUpdateProgress?.Percent;
    var progressLabel = progressPercent is double value
      ? $"{Math.Clamp(value, 0d, 100d):0.0}%"
      : "준비 중";

    return string.IsNullOrWhiteSpace(targetTag)
      ? $"앱 업데이트 다운로드 중... {progressLabel}"
      : $"앱 업데이트 {targetTag} 다운로드 중... {progressLabel}";
  }

  private void PostToUi(Action action)
  {
    _uiContext.Post(static state => ((Action)state!).Invoke(), action);
  }

  private static void EnableModelessKeyboardInterop(System.Windows.Window window)
  {
    ElementHost.EnableModelessKeyboardInterop(window);
  }

  private static void CopyDirectoryRecursively(string sourceDirectory, string targetDirectory)
  {
    Directory.CreateDirectory(targetDirectory);

    foreach (var filePath in Directory.GetFiles(sourceDirectory))
    {
      File.Copy(filePath, Path.Combine(targetDirectory, Path.GetFileName(filePath)), overwrite: true);
    }

    foreach (var directoryPath in Directory.GetDirectories(sourceDirectory))
    {
      CopyDirectoryRecursively(directoryPath, Path.Combine(targetDirectory, Path.GetFileName(directoryPath)));
    }
  }

  private static string GetRuntimeStateLabel(AgentRuntimeState state) => state switch
  {
    AgentRuntimeState.Stopped => "중지됨",
    AgentRuntimeState.Starting => "시작 중",
    AgentRuntimeState.Running => "실행 중",
    AgentRuntimeState.Stopping => "중지 중",
    AgentRuntimeState.Failed => "실패",
    _ => "알 수 없음"
  };

  private static Color GetRuntimeColor(AgentRuntimeState state) => state switch
  {
    AgentRuntimeState.Running => Color.ForestGreen,
    AgentRuntimeState.Starting or AgentRuntimeState.Stopping => Color.DarkOrange,
    AgentRuntimeState.Failed => Color.Firebrick,
    _ => SystemColors.GrayText
  };

  private static Icon CreateTrayIcon(bool grayscale)
  {
    using var stream = Assembly.GetExecutingAssembly()
      .GetManifestResourceStream("OctOP.WindowsAgentMenu.Assets.icon.png");

    if (stream is null)
    {
      return SystemIcons.Application;
    }

    using var sourceBitmap = new Bitmap(stream);
    using var bitmap = new Bitmap(32, 32);
    using var graphics = Graphics.FromImage(bitmap);
    graphics.Clear(Color.Transparent);
    graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;

    if (grayscale)
    {
      using var imageAttributes = new ImageAttributes();
      imageAttributes.SetColorMatrix(new ColorMatrix(
      [
        [0.3f, 0.3f, 0.3f, 0, 0],
        [0.59f, 0.59f, 0.59f, 0, 0],
        [0.11f, 0.11f, 0.11f, 0, 0],
        [0, 0, 0, 1, 0],
        [0, 0, 0, 0, 1]
      ]));
      graphics.DrawImage(
        sourceBitmap,
        new Rectangle(0, 0, 32, 32),
        0,
        0,
        sourceBitmap.Width,
        sourceBitmap.Height,
        GraphicsUnit.Pixel,
        imageAttributes
      );
    }
    else
    {
      graphics.DrawImage(sourceBitmap, new Rectangle(0, 0, 32, 32));
    }

    var iconHandle = bitmap.GetHicon();
    try
    {
      using var icon = Icon.FromHandle(iconHandle);
      return (Icon)icon.Clone();
    }
    finally
    {
      NativeMethods.DestroyIcon(iconHandle);
    }
  }

  private void RefreshRuntimeStateFromSystem(bool logDetection = false)
  {
    if (_stopInProgress)
    {
      _lastUpdatedAt = DateTimeOffset.Now;
      return;
    }

    if (_process is not null)
    {
      try
      {
        if (!_process.HasExited)
        {
          _processId = _process.Id;
          _runtimeState = AgentRuntimeState.Running;
          _lastUpdatedAt = DateTimeOffset.Now;
          return;
        }
      }
      catch
      {
      }
    }

    var runtimeProcessIds = FindServiceProcessIds();
    var existingProcessId = FindExistingAgentProcessId() ?? runtimeProcessIds.FirstOrDefault();
    if (existingProcessId <= 0)
    {
      _processId = null;
      if (_runtimeState != AgentRuntimeState.Failed)
      {
        _runtimeState = AgentRuntimeState.Stopped;
      }

      _lastUpdatedAt = DateTimeOffset.Now;
      return;
    }

    var shouldLog = logDetection && _processId != existingProcessId;
    _processId = existingProcessId;
    _runtimeState = AgentRuntimeState.Running;
    _lastUpdatedAt = DateTimeOffset.Now;

    if (shouldLog)
    {
      AppendLog(FindExistingAgentProcessId() is not null
        ? $"기존 local-agent 프로세스를 감지했습니다. pid={existingProcessId}"
        : $"기존 local-agent 런타임 프로세스를 감지했습니다. pid={existingProcessId}");
    }
  }

  private int? FindExistingAgentProcessId()
  {
    if (TryReadPersistedAgentProcessId(out var persistedProcessId))
    {
      return persistedProcessId;
    }

    var discoveredProcessId = FindExistingAgentProcessIdViaPowerShell();
    if (discoveredProcessId is int processId)
    {
      WriteAgentPidFile(processId);
    }

    return discoveredProcessId;
  }

  private async Task StopServiceProcessesAsync(bool includeStdioSessions, bool logWhenIdle)
  {
    var servicePorts = ResolveServicePorts(_configuration);
    var allProcessIds = CollectStopTargetProcessIds(includeStdioSessions, servicePorts);
    var allProcessNames = CollectStopTargetProcessNames(includeStdioSessions, servicePorts);

    if (allProcessIds.Count == 0 && allProcessNames.Count == 0)
    {
      DeleteAgentPidFile();
      _processId = null;
      _runtimeState = AgentRuntimeState.Stopped;
      _lastError = null;
      _lastUpdatedAt = DateTimeOffset.Now;
      if (logWhenIdle)
      {
        AppendLog("중지할 서비스가 없습니다.");
      }
      return;
    }

    AppendLog(
      $"서비스 관련 프로세스를 종료합니다. pids={string.Join(",", allProcessIds)}, names={string.Join(",", allProcessNames)}");
    ForceKillProcessNames(allProcessNames);
    ForceKillProcesses(allProcessIds);
    ForceKillProcessNames(CollectStopTargetProcessNames(includeStdioSessions, servicePorts));
    await ForceKillManagedProcessesUntilExitedAsync(includeStdioSessions);
    await ForceKillListeningProcessesUntilReleasedAsync(servicePorts);

    var remainingProcessIds = CollectManagedProcessIds(includeStdioSessions);
    var remainingListeningProcessIds = FindListeningProcessIds(servicePorts);
    if (remainingProcessIds.Count > 0 || remainingListeningProcessIds.Count > 0)
    {
      throw BuildServiceStopFailure(
        remainingProcessIds,
        remainingListeningProcessIds,
        servicePorts);
    }

    DeleteAgentPidFile();
    DisposeProcess();
    _processId = null;
    _runtimeState = AgentRuntimeState.Stopped;
    _lastError = null;
    _lastUpdatedAt = DateTimeOffset.Now;
    await Task.CompletedTask;
    AppendLog("서비스와 보조 세션 종료가 완료되었습니다.");
  }

  private void StopServiceProcessesImmediatelyForExit(bool includeStdioSessions)
  {
    var deadline = DateTimeOffset.UtcNow.AddSeconds(20);
    var servicePorts = ResolveServicePorts(_configuration);

    while (DateTimeOffset.UtcNow < deadline)
    {
      var allProcessIds = CollectStopTargetProcessIds(includeStdioSessions, servicePorts);
      var allProcessNames = CollectStopTargetProcessNames(includeStdioSessions, servicePorts);
      if (allProcessNames.Count > 0)
      {
        ForceKillProcessNames(allProcessNames);
      }

      if (allProcessIds.Count > 0)
      {
        ForceKillProcesses(allProcessIds);
      }

      var remainingManagedProcessIds = CollectManagedProcessIds(includeStdioSessions);
      var listeningProcessIds = FindListeningProcessIds(servicePorts);
      var remainingProcessNames = CollectStopTargetProcessNames(includeStdioSessions, servicePorts);
      if (remainingManagedProcessIds.Count == 0 && listeningProcessIds.Count == 0 && remainingProcessNames.Count == 0)
      {
        break;
      }

      ForceKillProcessNames(remainingProcessNames);
      ForceKillProcesses(remainingManagedProcessIds.Concat(listeningProcessIds));
      Thread.Sleep(250);
    }

    DeleteAgentPidFile();
    DisposeProcess();
    _processId = null;
    _runtimeState = AgentRuntimeState.Stopped;
    _lastError = null;
    _lastUpdatedAt = DateTimeOffset.Now;
  }

  private List<int> FindServiceProcessIds()
  {
    return FindServiceProcesses()
      .Select(static process => process.ProcessId)
      .Where(static processId => processId > 0)
      .Distinct()
      .ToList();
  }

  private List<ServiceProcessInfo> FindServiceProcesses()
  {
    var command = string.Join(
      " ",
      [
        BuildServiceProcessQuery(),
        "| ForEach-Object {",
        "$commandLine = ($_.CommandLine -replace '[\\r\\n]+', ' ');",
        "Write-Output ($_.ProcessId.ToString() + \"`t\" + $_.Name + \"`t\" + $commandLine)",
        "}"
      ]);

    return RunPowerShellProcessInspectionQuery(command);
  }

  private List<int> FindStdioSessionProcessIds()
  {
    return FindStdioSessionProcesses()
      .Select(static process => process.ProcessId)
      .Where(static processId => processId > 0)
      .Distinct()
      .ToList();
  }

  private List<ServiceProcessInfo> FindStdioSessionProcesses()
  {
    var command = string.Join(
      " ",
      [
        "Get-CimInstance Win32_Process |",
        "Where-Object {",
        "$_.CommandLine -and",
        "$_.CommandLine -like '*codex*app-server*--listen*stdio://*'",
        "} |",
        "ForEach-Object {",
        "$commandLine = ($_.CommandLine -replace '[\\r\\n]+', ' ');",
        "Write-Output ($_.ProcessId.ToString() + \"`t\" + $_.Name + \"`t\" + $commandLine)",
        "}"
      ]);

    return RunPowerShellProcessInspectionQuery(command);
  }

  private void ForceKillProcesses(IEnumerable<int> processIds)
  {
    foreach (var processId in processIds.Where(static pid => pid > 0).Distinct())
    {
      TryKillProcessTree(processId);
      TryForceKillProcessTreeWithTaskKill(processId);
    }
  }

  private void ForceKillProcessNames(IEnumerable<string> processNames)
  {
    foreach (var processName in processNames
      .Select(NormalizeProcessImageName)
      .Where(static value => !string.IsNullOrWhiteSpace(value))
      .Distinct(StringComparer.OrdinalIgnoreCase))
    {
      TryKillProcessesByImageName(processName);
      TryForceKillProcessByImageNameWithTaskKill(processName);
    }
  }

  private static bool TryKillProcessTree(int processId)
  {
    try
    {
      using var process = Process.GetProcessById(processId);
      if (process.HasExited)
      {
        return true;
      }

      process.Kill(entireProcessTree: true);
      return process.WaitForExit(1000);
    }
    catch
    {
      return false;
    }
  }

  private static void TryKillProcessesByImageName(string processImageName)
  {
    try
    {
      var processName = Path.GetFileNameWithoutExtension(processImageName);
      foreach (var process in Process.GetProcessesByName(processName))
      {
        try
        {
          if (process.HasExited || process.Id == Environment.ProcessId)
          {
            continue;
          }

          process.Kill(entireProcessTree: true);
          process.WaitForExit(1000);
        }
        catch
        {
        }
        finally
        {
          process.Dispose();
        }
      }
    }
    catch
    {
    }
  }

  private static void TryForceKillProcessTreeWithTaskKill(int processId)
  {
    try
    {
      using var process = new Process
      {
        StartInfo = new ProcessStartInfo
        {
          FileName = "taskkill.exe",
          Arguments = $"/PID {processId} /T /F",
          UseShellExecute = false,
          RedirectStandardOutput = true,
          RedirectStandardError = true,
          CreateNoWindow = true,
          StandardOutputEncoding = Encoding.UTF8,
          StandardErrorEncoding = Encoding.UTF8
        }
      };

      if (!process.Start())
      {
        return;
      }

      process.WaitForExit(3000);
    }
    catch
    {
    }
  }

  private static void TryForceKillProcessByImageNameWithTaskKill(string processImageName)
  {
    try
    {
      using var process = new Process
      {
        StartInfo = new ProcessStartInfo
        {
          FileName = "taskkill.exe",
          Arguments = $"/IM \"{processImageName}\" /T /F",
          UseShellExecute = false,
          RedirectStandardOutput = true,
          RedirectStandardError = true,
          CreateNoWindow = true,
          StandardOutputEncoding = Encoding.UTF8,
          StandardErrorEncoding = Encoding.UTF8
        }
      };

      if (!process.Start())
      {
        return;
      }

      process.WaitForExit(3000);
    }
    catch
    {
    }
  }

  private List<int> FindListeningProcessIds(IReadOnlyCollection<int> ports)
  {
    if (ports.Count == 0)
    {
      return [];
    }

    var portList = string.Join(",", ports.OrderBy(static port => port));
    var command = string.Join(
      " ",
      [
        "$ports = @(" + portList + ");",
        "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |",
        "Where-Object { $ports -contains $_.LocalPort } |",
        "Select-Object -ExpandProperty OwningProcess -Unique"
      ]);

    using var process = new Process
    {
      StartInfo = new ProcessStartInfo
      {
        FileName = "powershell.exe",
        Arguments = $"-NoProfile -ExecutionPolicy Bypass -Command \"{command}\"",
        UseShellExecute = false,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        CreateNoWindow = true,
        StandardOutputEncoding = Encoding.UTF8,
        StandardErrorEncoding = Encoding.UTF8
      }
    };

    try
    {
      if (!process.Start())
      {
        return [];
      }

      var output = process.StandardOutput.ReadToEnd();
      process.WaitForExit(3000);
      if (process.ExitCode != 0)
      {
        return [];
      }

      var processIds = new HashSet<int>();

      foreach (var rawLine in output.Split(["\r\n", "\n"], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
      {
        if (!int.TryParse(rawLine, out var processId) || processId <= 0)
        {
          continue;
        }

        processIds.Add(processId);
      }

      return processIds.ToList();
    }
    catch
    {
      return [];
    }
  }

  private List<int> FindListeningPortsForProcess(int processId)
  {
    if (processId <= 0)
    {
      return [];
    }

    var command = string.Join(
      " ",
      [
        "Get-NetTCPConnection -State Listen -OwningProcess " + processId + " -ErrorAction SilentlyContinue |",
        "Select-Object -ExpandProperty LocalPort -Unique"
      ]);

    return RunPowerShellProcessQuery(command)
      .Where(static port => port is >= 1 and <= 65535)
      .Distinct()
      .ToList();
  }

  private async Task<bool> WaitForPortsReleasedAsync(IReadOnlyCollection<int> ports, int timeoutMs = 15000)
  {
    if (ports.Count == 0)
    {
      return true;
    }

    var deadline = DateTimeOffset.UtcNow.AddMilliseconds(timeoutMs);
    while (DateTimeOffset.UtcNow < deadline)
    {
      if (FindListeningProcessIds(ports).Count == 0)
      {
        return true;
      }

      await Task.Delay(250);
    }

    return false;
  }

  private async Task ForceKillListeningProcessesUntilReleasedAsync(IReadOnlyCollection<int> ports, int timeoutMs = 30000)
  {
    if (ports.Count == 0)
    {
      return;
    }

    var deadline = DateTimeOffset.UtcNow.AddMilliseconds(timeoutMs);
    while (DateTimeOffset.UtcNow < deadline)
    {
      var listeningProcessIds = FindListeningProcessIds(ports);
      if (listeningProcessIds.Count == 0)
      {
        return;
      }

      ForceKillProcessNames(listeningProcessIds
        .Select(TryResolveProcessImageName)
        .Where(static value => !string.IsNullOrWhiteSpace(value))
        .Select(static value => value!));
      ForceKillProcesses(listeningProcessIds);
      await Task.Delay(200);
    }

    var remainingProcessIds = FindListeningProcessIds(ports);
    if (remainingProcessIds.Count > 0)
    {
      AppendLog($"서비스 포트를 점유한 프로세스가 남아 있어 재강제 종료를 시도했지만 완전히 내려가지 않았습니다. pids={string.Join(",", remainingProcessIds)}");
    }
  }

  private async Task ForceKillManagedProcessesUntilExitedAsync(bool includeStdioSessions, int timeoutMs = 30000)
  {
    var servicePorts = ResolveServicePorts(_configuration);
    var deadline = DateTimeOffset.UtcNow.AddMilliseconds(timeoutMs);
    while (DateTimeOffset.UtcNow < deadline)
    {
      var remainingProcessIds = CollectManagedProcessIds(includeStdioSessions);
      if (remainingProcessIds.Count == 0)
      {
        return;
      }

      ForceKillProcessNames(CollectStopTargetProcessNames(includeStdioSessions, servicePorts));
      ForceKillProcesses(remainingProcessIds);
      await Task.Delay(250);
    }

    var finalRemainingProcessIds = CollectManagedProcessIds(includeStdioSessions);
    if (finalRemainingProcessIds.Count > 0)
    {
      AppendLog($"서비스 프로세스가 남아 있어 재강제 종료를 시도했지만 완전히 내려가지 않았습니다. pids={string.Join(",", finalRemainingProcessIds)}");
    }
  }

  private List<int> CollectManagedProcessIds(bool includeStdioSessions)
  {
    var processIds = new HashSet<int>();

    foreach (var processId in FindServiceProcessIds())
    {
      if (processId > 0)
      {
        processIds.Add(processId);
      }
    }

    if (includeStdioSessions)
    {
      foreach (var processId in FindStdioSessionProcessIds())
      {
        if (processId > 0)
        {
          processIds.Add(processId);
        }
      }
    }

    if (_processId is > 0)
    {
      processIds.Add(_processId.Value);
    }

    try
    {
      if (_process is { HasExited: false })
      {
        processIds.Add(_process.Id);
      }
    }
    catch
    {
    }

    if (TryReadPersistedAgentProcessId(out var persistedProcessId) && persistedProcessId > 0)
    {
      processIds.Add(persistedProcessId);
    }

    return processIds.ToList();
  }

  private List<int> CollectStopTargetProcessIds(bool includeStdioSessions, IReadOnlyCollection<int> servicePorts)
  {
    var processIds = new HashSet<int>(CollectManagedProcessIds(includeStdioSessions));

    foreach (var processId in FindListeningProcessIds(servicePorts))
    {
      if (processId > 0)
      {
        processIds.Add(processId);
      }
    }

    return processIds.ToList();
  }

  private List<string> CollectStopTargetProcessNames(bool includeStdioSessions, IReadOnlyCollection<int> servicePorts)
  {
    var processNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

    foreach (var process in FindServiceProcesses())
    {
      if (!string.IsNullOrWhiteSpace(process.Name))
      {
        processNames.Add(NormalizeProcessImageName(process.Name));
      }
    }

    if (includeStdioSessions)
    {
      foreach (var process in FindStdioSessionProcesses())
      {
        if (!string.IsNullOrWhiteSpace(process.Name))
        {
          processNames.Add(NormalizeProcessImageName(process.Name));
        }
      }
    }

    foreach (var processId in FindListeningProcessIds(servicePorts))
    {
      var processImageName = TryResolveProcessImageName(processId);
      if (!string.IsNullOrWhiteSpace(processImageName))
      {
        processNames.Add(processImageName);
      }
    }

    if (_processId is > 0)
    {
      var trackedProcessName = TryResolveProcessImageName(_processId.Value);
      if (!string.IsNullOrWhiteSpace(trackedProcessName))
      {
        processNames.Add(trackedProcessName);
      }
    }

    try
    {
      if (_process is { HasExited: false })
      {
        var trackedProcessName = NormalizeProcessImageName(_process.ProcessName);
        if (!string.IsNullOrWhiteSpace(trackedProcessName))
        {
          processNames.Add(trackedProcessName);
        }
      }
    }
    catch
    {
    }

    if (TryReadPersistedAgentProcessId(out var persistedProcessId) && persistedProcessId > 0)
    {
      var persistedProcessName = TryResolveProcessImageName(persistedProcessId);
      if (!string.IsNullOrWhiteSpace(persistedProcessName))
      {
        processNames.Add(persistedProcessName);
      }
    }

    return processNames.ToList();
  }

  private static string? TryResolveProcessImageName(int processId)
  {
    try
    {
      using var process = Process.GetProcessById(processId);
      if (process.HasExited)
      {
        return null;
      }

      return NormalizeProcessImageName(process.ProcessName);
    }
    catch
    {
      return null;
    }
  }

  private static string NormalizeProcessImageName(string? processName)
  {
    var trimmed = processName?.Trim();
    if (string.IsNullOrWhiteSpace(trimmed))
    {
      return string.Empty;
    }

    return trimmed.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
      ? trimmed
      : $"{trimmed}.exe";
  }

  private static InvalidOperationException BuildServiceStopFailure(
    IReadOnlyCollection<int> remainingProcessIds,
    IReadOnlyCollection<int> remainingListeningProcessIds,
    IReadOnlyCollection<int> servicePorts)
  {
    var details = new List<string>();

    if (remainingProcessIds.Count > 0)
    {
      details.Add($"remainingPids={string.Join(",", remainingProcessIds.OrderBy(static pid => pid))}");
    }

    if (remainingListeningProcessIds.Count > 0)
    {
      details.Add(
        $"remainingListeners={string.Join(",", remainingListeningProcessIds.OrderBy(static pid => pid))} on ports={string.Join(",", servicePorts.OrderBy(static port => port))}");
    }

    var suffix = details.Count == 0 ? string.Empty : $" ({string.Join("; ", details)})";
    return new InvalidOperationException($"서비스 프로세스 정리가 완료되지 않았습니다.{suffix}");
  }

  private async Task<bool> WaitForServiceReadyAsync(Process process, string expectedRuntimeRoot, int timeoutMs = 10000)
  {
    var deadline = DateTimeOffset.UtcNow.AddMilliseconds(timeoutMs);
    IReadOnlyList<ServiceLaunchCheck> lastChecks = [];

    while (DateTimeOffset.UtcNow < deadline)
    {
      try
      {
        if (process.HasExited)
        {
          LogFailedServiceLaunchChecks(lastChecks, "프로세스가 조기 종료되어");
          return false;
        }
      }
      catch
      {
        LogFailedServiceLaunchChecks(lastChecks, "프로세스 상태 확인 중 오류가 발생해");
        return false;
      }

      var checks = await BuildServiceLaunchChecksAsync(expectedRuntimeRoot);
      lastChecks = checks;
      if (checks.All(static check => check.Passed))
      {
        return true;
      }

      await Task.Delay(250);
    }

    LogFailedServiceLaunchChecks(lastChecks, "제한 시간 안에 준비되지 않아");
    return false;
  }

  private async Task<IReadOnlyList<ServiceLaunchCheck>> BuildServiceLaunchChecksAsync(string expectedRuntimeRoot)
  {
    var serviceProcesses = FindServiceProcesses();
    var currentRuntimePath = expectedRuntimeRoot.Trim();
    var localAgentProcess = serviceProcesses.FirstOrDefault(static process =>
      process.CommandLine.Contains("run-local-agent.mjs", StringComparison.OrdinalIgnoreCase));
    var bridgeLauncherProcess = serviceProcesses.FirstOrDefault(static process =>
      process.CommandLine.Contains("run-bridge.mjs", StringComparison.OrdinalIgnoreCase));
    var adapterProcess = serviceProcesses.FirstOrDefault(static process =>
      process.CommandLine.Contains(@"services\codex-adapter\src\index.js", StringComparison.OrdinalIgnoreCase));
    var wsProcesses = serviceProcesses
      .Where(IsWsAppServerProcess)
      .OrderByDescending(GetAppServerProcessPriority)
      .ToList();
    var adapterPorts = adapterProcess is null ? [] : FindListeningPortsForProcess(adapterProcess.ProcessId);
    var wsPorts = wsProcesses
      .SelectMany(process => FindListeningPortsForProcess(process.ProcessId))
      .Distinct()
      .ToList();
    var bridgeHealth = await TryReadBridgeHealthStatusAsync(_configuration, adapterPorts.FirstOrDefault());

    return
    [
      new ServiceLaunchCheck
      {
        Passed = localAgentProcess is not null,
        Message = "run-local-agent launch check"
      },
      new ServiceLaunchCheck
      {
        Passed = bridgeLauncherProcess is not null,
        Message = "run-bridge launch check"
      },
      new ServiceLaunchCheck
      {
        Passed = adapterProcess is not null,
        Message = "codex-adapter launch check"
      },
      new ServiceLaunchCheck
      {
        Passed = wsProcesses.Count > 0,
        Message = "WS app-server launch check"
      },
      new ServiceLaunchCheck
      {
        Passed = localAgentProcess is not null &&
          adapterProcess is not null &&
          localAgentProcess.CommandLine.Contains(currentRuntimePath, StringComparison.OrdinalIgnoreCase) &&
          adapterProcess.CommandLine.Contains(currentRuntimePath, StringComparison.OrdinalIgnoreCase),
        Message = "current runtime path launch check"
      },
      new ServiceLaunchCheck
      {
        Passed = adapterPorts.Count > 0,
        Message = "bridge port listen check"
      },
      new ServiceLaunchCheck
      {
        Passed = wsPorts.Count > 0,
        Message = "WS app-server port listen check"
      },
      new ServiceLaunchCheck
      {
        Passed = bridgeHealth?.AppServerConnected == true &&
          bridgeHealth.AppServerInitialized,
        Message = "WS connection check"
      },
      new ServiceLaunchCheck
      {
        Passed = bridgeHealth?.Ok == true &&
          _runtimeState == AgentRuntimeState.Running &&
          _processId is not null,
        Message = "base runtime health check"
      }
    ];
  }

  private void LogFailedServiceLaunchChecks(IReadOnlyList<ServiceLaunchCheck> checks, string reason)
  {
    if (checks.Count == 0)
    {
      AppendLog($"서비스 기동 검증이 실패했습니다. {reason} 준비 상태를 확인하지 못했습니다.");
      return;
    }

    var failedMessages = checks
      .Where(static check => !check.Passed)
      .Select(static check => check.Message)
      .ToArray();

    if (failedMessages.Length == 0)
    {
      return;
    }

    AppendLog($"서비스 기동 검증이 실패했습니다. {reason} 통과하지 못한 항목={string.Join(", ", failedMessages)}");
  }

  private PreparedRuntimeRelease? ResolveRollbackPreparedRuntimeRelease(string failedRuntimeId)
  {
    var rollbackReleaseId = _paths.ReadCurrentRuntimeReleaseId();
    if (string.IsNullOrWhiteSpace(rollbackReleaseId) ||
        string.Equals(rollbackReleaseId, failedRuntimeId, StringComparison.OrdinalIgnoreCase))
    {
      rollbackReleaseId = _paths.ReadPreviousRuntimeReleaseId();
    }

    if (string.IsNullOrWhiteSpace(rollbackReleaseId) ||
        string.Equals(rollbackReleaseId, failedRuntimeId, StringComparison.OrdinalIgnoreCase))
    {
      return null;
    }

    var rollbackRoot = _paths.GetRuntimeReleaseRoot(rollbackReleaseId);
    if (!Directory.Exists(rollbackRoot))
    {
      return null;
    }

    return new PreparedRuntimeRelease
    {
      RuntimeId = rollbackReleaseId,
      ReleaseRoot = rollbackRoot,
      BuildInfo = _runtimeInstaller.LoadRuntimeBuildInfo(rollbackRoot) ?? new RuntimeReleaseBuildInfo
      {
        RuntimeId = rollbackReleaseId
      }
    };
  }

  private void RestoreRuntimePointerAfterFailedLaunch(string failedRuntimeId)
  {
    var currentReleaseId = _paths.ReadCurrentRuntimeReleaseId();
    if (!string.Equals(currentReleaseId, failedRuntimeId, StringComparison.OrdinalIgnoreCase))
    {
      return;
    }

    if (_paths.ReadPreviousRuntimeReleaseId() is { Length: > 0 } previousReleaseId)
    {
      var previousRoot = _paths.GetRuntimeReleaseRoot(previousReleaseId);
      if (Directory.Exists(previousRoot))
      {
        _runtimeInstaller.RestoreCurrentRuntimeRelease(_paths, previousReleaseId, new Progress<string>(AppendLog));
        _paths = new OctopPaths(OctopPaths.ResolvePreferredInstallRoot());
        return;
      }
    }

    _runtimeInstaller.ClearCurrentRuntimeRelease(_paths, new Progress<string>(AppendLog));
    _paths = new OctopPaths(OctopPaths.ResolvePreferredInstallRoot());
  }

  private static IReadOnlyCollection<int> ResolveServicePorts(RuntimeConfiguration configuration)
  {
    var ports = new List<int>();

    if (int.TryParse(configuration.BridgePort?.Trim(), out var bridgePort) && bridgePort is >= 1 and <= 65535)
    {
      ports.Add(bridgePort);
    }

    if (Uri.TryCreate(configuration.AppServerWsUrl?.Trim(), UriKind.Absolute, out var appServerUrl))
    {
      var appServerPort = appServerUrl.IsDefaultPort
        ? appServerUrl.Scheme.Equals("wss", StringComparison.OrdinalIgnoreCase) ? 443 : 80
        : appServerUrl.Port;
      if (appServerPort is >= 1 and <= 65535 && !ports.Contains(appServerPort))
      {
        ports.Add(appServerPort);
      }
    }

    return ports;
  }

  private static async Task<BridgeHealthStatus?> TryReadBridgeHealthStatusAsync(RuntimeConfiguration configuration, int? bridgePortOverride = null)
  {
    var bridgePort = bridgePortOverride;
    if (bridgePort is null &&
        int.TryParse(configuration.BridgePort?.Trim(), out var configuredBridgePort) &&
        configuredBridgePort is >= 1 and <= 65535)
    {
      bridgePort = configuredBridgePort;
    }

    if (bridgePort is not >= 1 and <= 65535)
    {
      return null;
    }

    var bridgeHost = NormalizeBridgeProbeHost(configuration.BridgeHost);
    var ownerLoginId = string.IsNullOrWhiteSpace(configuration.OwnerLoginId)
      ? RuntimeConfiguration.GetCurrentUserLogin()
      : configuration.OwnerLoginId.Trim();
    var resolvedBridgePort = bridgePort.GetValueOrDefault();

    var uriBuilder = new UriBuilder(Uri.UriSchemeHttp, bridgeHost, resolvedBridgePort, "/health")
    {
      Query = $"user_id={Uri.EscapeDataString(ownerLoginId)}"
    };

    using var request = new HttpRequestMessage(HttpMethod.Get, uriBuilder.Uri);
    request.Headers.TryAddWithoutValidation("x-bridge-token", configuration.BridgeToken?.Trim() ?? string.Empty);

    try
    {
      using var response = await HealthcheckClient.SendAsync(request);
      if (!response.IsSuccessStatusCode)
      {
        return null;
      }

      await using var stream = await response.Content.ReadAsStreamAsync();
      return await JsonSerializer.DeserializeAsync<BridgeHealthStatus>(stream);
    }
    catch
    {
      return null;
    }
  }

  private static string NormalizeBridgeProbeHost(string? host)
  {
    var trimmed = host?.Trim();
    return string.IsNullOrWhiteSpace(trimmed) ||
      string.Equals(trimmed, "0.0.0.0", StringComparison.OrdinalIgnoreCase) ||
      string.Equals(trimmed, "::", StringComparison.OrdinalIgnoreCase) ||
      string.Equals(trimmed, "[::]", StringComparison.OrdinalIgnoreCase)
      ? "127.0.0.1"
      : trimmed;
  }

  private List<int> RunPowerShellProcessQuery(string command)
  {
    using var process = new Process
    {
      StartInfo = new ProcessStartInfo
      {
        FileName = "powershell.exe",
        Arguments = $"-NoProfile -ExecutionPolicy Bypass -Command \"{command}\"",
        UseShellExecute = false,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        CreateNoWindow = true,
        StandardOutputEncoding = Encoding.UTF8,
        StandardErrorEncoding = Encoding.UTF8
      }
    };

    try
    {
      if (!process.Start())
      {
        return [];
      }

      var output = process.StandardOutput.ReadToEnd();
      process.WaitForExit(3000);

      return output
        .Split(["\r\n", "\n"], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Select(static value => int.TryParse(value, out var pid) ? pid : 0)
        .Where(static pid => pid > 0 && pid != Environment.ProcessId)
        .Distinct()
        .ToList();
    }
    catch
    {
      return [];
    }
  }

  private List<ServiceProcessInfo> RunPowerShellProcessInspectionQuery(string command)
  {
    using var process = new Process
    {
      StartInfo = new ProcessStartInfo
      {
        FileName = "powershell.exe",
        Arguments = $"-NoProfile -ExecutionPolicy Bypass -Command \"{command}\"",
        UseShellExecute = false,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        CreateNoWindow = true,
        StandardOutputEncoding = Encoding.UTF8,
        StandardErrorEncoding = Encoding.UTF8
      }
    };

    try
    {
      if (!process.Start())
      {
        return [];
      }

      var output = process.StandardOutput.ReadToEnd();
      process.WaitForExit(3000);
      if (process.ExitCode != 0)
      {
        return [];
      }

      var results = new List<ServiceProcessInfo>();
      foreach (var rawLine in output.Split(["\r\n", "\n"], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
      {
        var columns = rawLine.Split('\t', 3, StringSplitOptions.None);
        if (columns.Length != 3 || !int.TryParse(columns[0], out var processId) || processId <= 0)
        {
          continue;
        }

        results.Add(new ServiceProcessInfo
        {
          ProcessId = processId,
          Name = columns[1],
          CommandLine = columns[2]
        });
      }

      return results;
    }
    catch
    {
      return [];
    }
  }

  private static int? TryParsePort(string? rawValue)
  {
    return int.TryParse(rawValue?.Trim(), out var port) && port is >= 1 and <= 65535
      ? port
      : null;
  }

  private static int? TryParsePortFromUrl(string? rawValue)
  {
    if (!Uri.TryCreate(rawValue?.Trim(), UriKind.Absolute, out var uri))
    {
      return null;
    }

    if (!uri.IsDefaultPort)
    {
      return uri.Port is >= 1 and <= 65535 ? uri.Port : null;
    }

    return uri.Scheme.ToLowerInvariant() switch
    {
      "ws" => 80,
      "wss" => 443,
      _ => null
    };
  }

  private static string EscapePowerShellLikePattern(string? value)
  {
    return (value ?? string.Empty).Replace("'", "''");
  }

  private string BuildServiceProcessQuery()
  {
    var runtimeRoots = _paths.EnumerateRuntimeProcessRoots()
      .Select(static path => path.Replace("'", "''"))
      .ToList();
    var runtimeRootCondition = runtimeRoots.Count == 0
      ? "$false"
      : "(" + string.Join(
        " -or ",
        runtimeRoots.Select(static root => "$_.CommandLine -like '*" + root + "*'")) + ")";
    var appServerListenTarget = EscapePowerShellLikePattern(_configuration.AppServerWsUrl?.Trim());
    var appServerCondition = string.IsNullOrWhiteSpace(appServerListenTarget)
      ? "$_.CommandLine -like '*codex*app-server*--listen*ws://*'"
      : "$_.CommandLine -like '*app-server*--listen*" + appServerListenTarget + "*'";

    return string.Join(
      " ",
      [
        "Get-CimInstance Win32_Process |",
        "Where-Object {",
        "$_.CommandLine -and",
        "(",
        "(($_.Name -eq 'node.exe') -and " + runtimeRootCondition + " -and $_.CommandLine -like '*run-local-agent.mjs*') -or",
        "(($_.Name -eq 'node.exe') -and " + runtimeRootCondition + " -and $_.CommandLine -like '*run-bridge.mjs*') -or",
        "(($_.Name -eq 'node.exe') -and " + runtimeRootCondition + " -and $_.CommandLine -like '*services\\codex-adapter\\src\\index.js*') -or",
        "((($_.Name -eq 'node.exe') -or ($_.Name -eq 'cmd.exe') -or ($_.Name -eq 'codex.exe')) -and (" + appServerCondition + "))",
        ")",
        "}"
      ]);
  }

  private bool IsWsAppServerProcess(ServiceProcessInfo process)
  {
    if (process.ProcessId <= 0 ||
        string.IsNullOrWhiteSpace(process.Name) ||
        string.IsNullOrWhiteSpace(process.CommandLine))
    {
      return false;
    }

    if (!string.Equals(process.Name, "node.exe", StringComparison.OrdinalIgnoreCase) &&
        !string.Equals(process.Name, "cmd.exe", StringComparison.OrdinalIgnoreCase) &&
        !string.Equals(process.Name, "codex.exe", StringComparison.OrdinalIgnoreCase))
    {
      return false;
    }

    var listenTarget = _configuration.AppServerWsUrl?.Trim();
    if (string.IsNullOrWhiteSpace(listenTarget))
    {
      return process.CommandLine.Contains("codex", StringComparison.OrdinalIgnoreCase) &&
        process.CommandLine.Contains("app-server", StringComparison.OrdinalIgnoreCase) &&
        process.CommandLine.Contains("--listen", StringComparison.OrdinalIgnoreCase) &&
        process.CommandLine.Contains("ws://", StringComparison.OrdinalIgnoreCase);
    }

    return process.CommandLine.Contains("app-server", StringComparison.OrdinalIgnoreCase) &&
      process.CommandLine.Contains("--listen", StringComparison.OrdinalIgnoreCase) &&
      process.CommandLine.Contains(listenTarget, StringComparison.OrdinalIgnoreCase);
  }

  private static int GetAppServerProcessPriority(ServiceProcessInfo process)
  {
    if (string.Equals(process.Name, "codex.exe", StringComparison.OrdinalIgnoreCase))
    {
      return 3;
    }

    if (string.Equals(process.Name, "node.exe", StringComparison.OrdinalIgnoreCase))
    {
      return 2;
    }

    if (string.Equals(process.Name, "cmd.exe", StringComparison.OrdinalIgnoreCase))
    {
      return 1;
    }

    return 0;
  }

  private bool TryReadPersistedAgentProcessId(out int processId)
  {
    processId = 0;
    if (!File.Exists(_paths.RuntimeAgentPidPath))
    {
      return false;
    }

    try
    {
      var rawValue = File.ReadAllText(_paths.RuntimeAgentPidPath, Encoding.UTF8).Trim();
      if (!int.TryParse(rawValue, out processId) || processId <= 0)
      {
        DeleteAgentPidFile();
        return false;
      }

      using var process = Process.GetProcessById(processId);
      if (process.HasExited)
      {
        DeleteAgentPidFile();
        processId = 0;
        return false;
      }

      if (!IsLocalAgentProcessId(processId))
      {
        DeleteAgentPidFile();
        processId = 0;
        return false;
      }

      return true;
    }
    catch
    {
      DeleteAgentPidFile();
      processId = 0;
      return false;
    }
  }

  private int? FindExistingAgentProcessIdViaPowerShell()
  {
    using var process = new Process
    {
      StartInfo = new ProcessStartInfo
      {
        FileName = "powershell.exe",
        Arguments = $"-NoProfile -ExecutionPolicy Bypass -Command \"{BuildLocalAgentProcessQuery()}\"",
        UseShellExecute = false,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        CreateNoWindow = true,
        StandardOutputEncoding = Encoding.UTF8,
        StandardErrorEncoding = Encoding.UTF8
      }
    };

    try
    {
      if (!process.Start())
      {
        return null;
      }

      var output = process.StandardOutput.ReadToEnd().Trim();
      process.WaitForExit(2000);
      return int.TryParse(output, out var processId) && processId > 0 ? processId : null;
    }
    catch
    {
      return null;
    }
  }

  private bool IsLocalAgentProcessId(int processId)
  {
    var command = string.Join(
      " ",
      [
        BuildLocalAgentProcessQuery(),
        $"| Where-Object {{ $_ -eq {processId} }}",
        "| Select-Object -First 1"
      ]);

    return RunPowerShellProcessQuery(command).Contains(processId);
  }

  private string BuildLocalAgentProcessQuery()
  {
    var runtimeRoots = _paths.EnumerateRuntimeProcessRoots()
      .Select(static path => path.Replace("'", "''"))
      .ToList();

    if (runtimeRoots.Count == 0)
    {
      return "Write-Output ''";
    }

    var rootConditions = string.Join(
      " -or ",
      runtimeRoots.Select(static root => "$_.CommandLine -like '*" + root + "*'"));
    return string.Join(
      " ",
      [
        "Get-CimInstance Win32_Process",
        "| Where-Object {",
        "$_.Name -eq 'node.exe' -and",
        "$_.CommandLine -and",
        "(" + rootConditions + ") -and",
        "$_.CommandLine -like '*run-local-agent.mjs*'",
        "}",
        "| Select-Object -ExpandProperty ProcessId"
      ]);
  }

  private void WriteAgentPidFile(int processId)
  {
    Directory.CreateDirectory(_paths.RuntimeStateRoot);
    File.WriteAllText(_paths.RuntimeAgentPidPath, processId.ToString(), new UTF8Encoding(false));
  }

  private void DeleteAgentPidFile()
  {
    if (File.Exists(_paths.RuntimeAgentPidPath))
    {
      File.Delete(_paths.RuntimeAgentPidPath);
    }
  }

  private void HandleCurrentProcessExit(object? sender, EventArgs e)
  {
    if (_suppressRuntimeStopOnExit)
    {
      return;
    }

    TryTerminateServiceProcessesForShutdown(includeStdioSessions: true);
  }

  private void HandleCurrentUnhandledException(object sender, UnhandledExceptionEventArgs e)
  {
    if (_suppressRuntimeStopOnExit)
    {
      return;
    }

    TryTerminateServiceProcessesForShutdown(includeStdioSessions: true);
  }

  private void HandleWindowsSessionEnding(object? sender, SessionEndingEventArgs e)
  {
    if (_suppressRuntimeStopOnExit)
    {
      return;
    }

    TryTerminateServiceProcessesForShutdown(includeStdioSessions: true);
  }

  private void HandleWindowsSessionEnded(object? sender, SessionEndedEventArgs e)
  {
    if (_suppressRuntimeStopOnExit)
    {
      return;
    }

    TryTerminateServiceProcessesForShutdown(includeStdioSessions: true);
  }

  private void TryTerminateServiceProcessesForShutdown(bool includeStdioSessions)
  {
    if (Interlocked.Exchange(ref _shutdownCleanupStarted, 1) != 0)
    {
      return;
    }

    try
    {
      StopServiceProcessesImmediatelyForExit(includeStdioSessions);
    }
    catch
    {
    }
  }
}

static partial class NativeMethods
{
  [DllImport("user32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  internal static extern bool DestroyIcon(nint handle);
}

sealed class HighlightTextToolStripHost : ToolStripControlHost
{
  private HighlightTextStripControl HighlightControl => (HighlightTextStripControl)Control;

  public HighlightTextToolStripHost()
    : base(new HighlightTextStripControl())
  {
    Enabled = false;
    AutoSize = false;
    Margin = Padding.Empty;
    Padding = Padding.Empty;
    HighlightControl.Size = HighlightControl.GetPreferredSize(Size.Empty);
    Size = HighlightControl.Size;
  }

  public void SetSegments(string prefixText, string? highlightText)
  {
    HighlightControl.SetSegments(prefixText, highlightText);
    HighlightControl.Size = HighlightControl.GetPreferredSize(Size.Empty);
    Size = HighlightControl.Size;
    Invalidate();
  }
}

sealed class HighlightTextStripControl : Control
{
  private static readonly TextFormatFlags TextFlags =
    TextFormatFlags.Left |
    TextFormatFlags.VerticalCenter |
    TextFormatFlags.SingleLine |
    TextFormatFlags.NoPrefix |
    TextFormatFlags.NoPadding;

  private const int HorizontalPadding = 2;
  private const int VerticalPadding = 3;

  private string _prefixText = string.Empty;
  private string _highlightText = string.Empty;

  public HighlightTextStripControl()
  {
    SetStyle(
      ControlStyles.AllPaintingInWmPaint |
      ControlStyles.OptimizedDoubleBuffer |
      ControlStyles.UserPaint |
      ControlStyles.SupportsTransparentBackColor,
      true);
    BackColor = Color.Transparent;
    ForeColor = SystemColors.GrayText;
    Font = SystemFonts.MenuFont;
    TabStop = false;
  }

  public void SetSegments(string prefixText, string? highlightText)
  {
    _prefixText = prefixText ?? string.Empty;
    _highlightText = highlightText ?? string.Empty;
    Invalidate();
  }

  public override Size GetPreferredSize(Size proposedSize)
  {
    var text = _prefixText + _highlightText;
    var measured = TextRenderer.MeasureText(text.Length == 0 ? " " : text, Font, Size.Empty, TextFlags);
    return new Size(
      measured.Width + (HorizontalPadding * 2),
      Math.Max(22, measured.Height + (VerticalPadding * 2)));
  }

  protected override void OnPaint(PaintEventArgs e)
  {
    var contentBounds = new Rectangle(
      HorizontalPadding,
      VerticalPadding,
      Math.Max(0, Width - (HorizontalPadding * 2)),
      Math.Max(0, Height - (VerticalPadding * 2)));

    TextRenderer.DrawText(
      e.Graphics,
      _prefixText,
      Font,
      contentBounds,
      ForeColor,
      TextFlags);

    if (_highlightText.Length == 0)
    {
      return;
    }

    var prefixWidth = TextRenderer.MeasureText(e.Graphics, _prefixText, Font, Size.Empty, TextFlags).Width;
    var highlightBounds = new Rectangle(
      contentBounds.Left + prefixWidth,
      contentBounds.Top,
      Math.Max(0, contentBounds.Width - prefixWidth),
      contentBounds.Height);

    TextRenderer.DrawText(
      e.Graphics,
      _highlightText,
      Font,
      highlightBounds,
      Color.RoyalBlue,
      TextFlags);
  }
}
