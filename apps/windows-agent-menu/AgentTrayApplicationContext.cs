using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using System.Windows.Forms.Integration;

sealed class AgentTrayApplicationContext : ApplicationContext
{
  private const int MaxLines = 2000;
  private static readonly string AppTitle = "OctOP Local Agent";
  private static readonly HttpClient HealthcheckClient = new();

  private readonly SynchronizationContext _uiContext;
  private readonly NotifyIcon _notifyIcon;
  private readonly ContextMenuStrip _menu;
  private readonly ToolStripMenuItem _titleItem;
  private readonly ToolStripMenuItem _appVersionItem;
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

    AppendLog("윈도우 트레이 앱이 시작되었습니다.");
    RefreshRuntimeStateFromSystem(logDetection: true);
    RefreshUi();
    _updateMonitorTimer = new System.Threading.Timer(
      _ =>
      {
        PostToUi(() =>
        {
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
    await RefreshAvailableAppUpdateAsync(force: true);
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
      _availableRuntimeUpdate is not null ||
      _runtimeStatus?.RuntimeVersionMatches != true;
    if (!shouldPrepareImmediately)
    {
      return false;
    }

    if (currentRuntimeRoot is null)
    {
      AppendLog("첫 시작 런타임이 없어 원자적 런타임 준비를 바로 진행합니다.");
    }
    else if (_runtimeStatus?.RuntimeVersionMatches != true)
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
    if (!string.Equals(currentReleaseId, preparedRelease.RuntimeId, StringComparison.OrdinalIgnoreCase))
    {
      _runtimeInstaller.ActivateRuntimeRelease(_paths, preparedRelease, new Progress<string>(AppendLog));
      _paths = new OctopPaths(OctopPaths.ResolvePreferredInstallRoot());
    }

    _runtimeInstaller.CleanupStaleRuntimeReleases(_paths, new Progress<string>(AppendLog));
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
      _runtimeStatus.CodexLoggedIn &&
      (!_runtimeStatus.AutoStartRequested || _runtimeStatus.AutoStartConfigured);
  }

  private bool ShouldRunStartupRuntimeTransition(bool runtimePreparedChanged)
  {
    var currentRuntimeRoot = _paths.ResolveActiveRuntimeRoot();
    return runtimePreparedChanged ||
      currentRuntimeRoot is null ||
      _availableRuntimeUpdate is not null ||
      _runtimeStatus?.RuntimeVersionMatches != true ||
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
    _runtimeInstaller.ActivateRuntimeRelease(_paths, preparedRelease, new Progress<string>(AppendLog));
    _paths = new OctopPaths(OctopPaths.ResolvePreferredInstallRoot());

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
      process.BeginOutputReadLine();
      process.BeginErrorReadLine();
      _process = process;
      _processId = process.Id;
      WriteAgentPidFile(process.Id);
      _runtimeState = AgentRuntimeState.Running;
      _lastUpdatedAt = DateTimeOffset.Now;
      AppendLog($"서비스가 시작되었습니다. pid={process.Id}");
      RefreshUi();

      var launchValidated = await WaitForServiceReadyAsync(process);
      if (!launchValidated)
      {
        AppendLog("새 런타임 기동 검증에 실패했습니다. 이전 런타임으로 롤백합니다.");
        await StopServiceProcessesAsync(includeStdioSessions: true, logWhenIdle: false);

        if (allowRollback && _paths.ReadPreviousRuntimeReleaseId() is { Length: > 0 } previousReleaseId)
        {
          var previousRoot = _paths.GetRuntimeReleaseRoot(previousReleaseId);
          if (Directory.Exists(previousRoot))
          {
            await LaunchPreparedRuntimeReleaseAsync(
              new PreparedRuntimeRelease
              {
                RuntimeId = previousReleaseId,
                ReleaseRoot = previousRoot,
                BuildInfo = _runtimeInstaller.LoadRuntimeBuildInfo(previousRoot) ?? new RuntimeReleaseBuildInfo
                {
                  RuntimeId = previousReleaseId
                }
              },
              allowRollback: false);
            return;
          }
        }

        _runtimeState = AgentRuntimeState.Failed;
        _lastError = "service launch validation failed";
        RefreshUi();
        return;
      }

      _runtimeInstaller.CleanupStaleRuntimeReleases(_paths, new Progress<string>(AppendLog));
      _ = RefreshAvailableRuntimeUpdateAsync();
    }
    catch (Exception error)
    {
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
    _runtimeState = AgentRuntimeState.Stopped;
    _lastUpdatedAt = DateTimeOffset.Now;
    AppendLog("서비스 정지를 요청합니다.");
    RefreshUi();

    _ = StopAsync();
  }

  private async Task StopAsync()
  {
    try
    {
      var servicePorts = ResolveServicePorts(_configuration);
      var stopResult = await Task.Run(() =>
      {
        var targetProcessIds = CollectStopTargetProcessIds(includeStdioSessions: true, servicePorts);
        if (targetProcessIds.Count == 0)
        {
          return targetProcessIds;
        }

        ForceKillProcesses(targetProcessIds);
        return targetProcessIds;
      });

      if (stopResult.Count == 0)
      {
        DeleteAgentPidFile();
        DisposeProcess();
        _processId = null;
        _runtimeState = AgentRuntimeState.Stopped;
        _lastError = null;
        _lastUpdatedAt = DateTimeOffset.Now;
        AppendLog("중지할 서비스가 없습니다.");
        return;
      }

      AppendLog($"서비스 관련 프로세스를 강제 종료합니다. pids={string.Join(",", stopResult)}");
      await ForceKillListeningProcessesUntilReleasedAsync(servicePorts);
      DeleteAgentPidFile();
      DisposeProcess();
      _processId = null;
      _runtimeState = AgentRuntimeState.Stopped;
      _lastError = null;
      _lastUpdatedAt = DateTimeOffset.Now;
      AppendLog("서비스와 보조 세션 종료가 완료되었습니다.");
      return;
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
    ScheduleForcedProcessTermination();

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
          StopServiceProcessesImmediatelyForExit(includeStdioSessions: true);
        }
        catch
        {
        }
      }

      _updateMonitorTimer.Dispose();
      ExitThread();
    }
    finally
    {
      Environment.Exit(0);
    }

    return Task.CompletedTask;
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
    _appVersionItem.Text = $"앱 버전 {AppMetadata.CurrentVersionTag}";
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
    _appUpdateItem.Visible = _availableAppUpdate is not null && AppMetadata.CanSelfUpdate();
    _appUpdateItem.Enabled = _availableAppUpdate is not null && !_setupWindow.InstallationInProgress;
    _appUpdateItem.Text = _availableAppUpdate is null ? "앱 업데이트" : $"앱 업데이트 {_availableAppUpdate.Tag}";
    _appUpdateItem.ForeColor = _availableAppUpdate is null ? SystemColors.ControlText : Color.RoyalBlue;
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

  private async Task RefreshAvailableAppUpdateAsync(bool force = false)
  {
    try
    {
      _availableAppUpdate = await _autoUpdater.GetAvailableUpdateAsync(
        AppMetadata.CurrentVersionTag,
        CancellationToken.None,
        force);
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
    await RefreshAvailableAppUpdateAsync(force: true);
    if (_availableAppUpdate is null)
    {
      AppendLog("적용 가능한 앱 업데이트가 없습니다.");
      return;
    }

    try
    {
      AppendLog($"앱 업데이트를 시작합니다. target={_availableAppUpdate.Tag}");
      await StopServiceProcessesAsync(includeStdioSessions: true, logWhenIdle: false);

      var updateApplied = await _autoUpdater.TryApplyUpdateAsync(
        _availableAppUpdate,
        _paths,
        _configuration,
        AppendLog,
        CancellationToken.None);
      if (!updateApplied)
      {
        AppendLog("앱 업데이트를 적용하지 않았습니다.");
        return;
      }

      _suppressRuntimeStopOnExit = true;
      await ExitApplicationAsync();
    }
    catch (Exception error)
    {
      AppendLog($"앱 업데이트 시작 실패: {error.Message}");
      RefreshUi();
    }
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

    if (allProcessIds.Count == 0)
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

    AppendLog($"서비스 관련 프로세스를 종료합니다. pids={string.Join(",", allProcessIds)}");
    ForceKillProcesses(allProcessIds);
    await WaitForProcessGroupExitAsync(includeStdioSessions);
    await ForceKillListeningProcessesUntilReleasedAsync(servicePorts);
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
    var servicePorts = ResolveServicePorts(_configuration);
    var allProcessIds = CollectStopTargetProcessIds(includeStdioSessions, servicePorts);

    if (allProcessIds.Count > 0)
    {
      ForceKillProcesses(allProcessIds);
    }

    var listeningProcessIds = FindListeningProcessIds(servicePorts);
    if (listeningProcessIds.Count > 0)
    {
      ForceKillProcesses(listeningProcessIds);
    }

    DeleteAgentPidFile();
    DisposeProcess();
    _processId = null;
    _runtimeState = AgentRuntimeState.Stopped;
    _lastError = null;
    _lastUpdatedAt = DateTimeOffset.Now;
  }

  private static void ScheduleForcedProcessTermination()
  {
    var currentProcessId = Environment.ProcessId;
    _ = Task.Run(async () =>
    {
      try
      {
        await Task.Delay(1500);
        using var process = Process.GetProcessById(currentProcessId);
        if (!process.HasExited)
        {
          process.Kill(entireProcessTree: true);
        }
      }
      catch
      {
      }
    });
  }

  private List<int> FindServiceProcessIds()
  {
    var runtimeRoots = _paths.EnumerateRuntimeProcessRoots()
      .Select(static path => path.Replace("'", "''"))
      .ToList();

    if (runtimeRoots.Count == 0)
    {
      return [];
    }

    var rootConditions = string.Join(
      " -or ",
      runtimeRoots.Select(static root => "$_.CommandLine -like '*" + root + "*'"));
    var command = string.Join(
      " ",
      [
        "Get-CimInstance Win32_Process |",
        "Where-Object {",
        "$_.CommandLine -and",
        "(" + rootConditions + ") -and",
        "(",
        "$_.CommandLine -like '*run-local-agent.mjs*' -or",
        "$_.CommandLine -like '*run-bridge.mjs*' -or",
        "$_.CommandLine -like '*services\\\\codex-adapter\\\\src\\\\index.js*' -or",
        "($_.CommandLine -like '*codex*app-server*--listen*ws://*')",
        ")",
        "} |",
        "Select-Object -ExpandProperty ProcessId"
      ]);

    return RunPowerShellProcessQuery(command);
  }

  private List<int> FindStdioSessionProcessIds()
  {
    var command = string.Join(
      " ",
      [
        "Get-CimInstance Win32_Process |",
        "Where-Object {",
        "$_.CommandLine -and",
        "$_.CommandLine -like '*codex*app-server*--listen*stdio://*'",
        "} |",
        "Select-Object -ExpandProperty ProcessId"
      ]);

    return RunPowerShellProcessQuery(command);
  }

  private void ForceKillProcesses(IEnumerable<int> processIds)
  {
    foreach (var processId in processIds.Where(static pid => pid > 0).Distinct())
    {
      try
      {
        using var process = Process.GetProcessById(processId);
        if (process.HasExited)
        {
          continue;
        }

        process.Kill(entireProcessTree: true);
      }
      catch
      {
      }
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

  private async Task ForceKillListeningProcessesUntilReleasedAsync(IReadOnlyCollection<int> ports, int timeoutMs = 15000)
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

      ForceKillProcesses(listeningProcessIds);
      await Task.Delay(200);
    }

    var remainingProcessIds = FindListeningProcessIds(ports);
    if (remainingProcessIds.Count > 0)
    {
      AppendLog($"서비스 포트를 점유한 프로세스가 남아 있어 재강제 종료를 시도했지만 완전히 내려가지 않았습니다. pids={string.Join(",", remainingProcessIds)}");
    }
  }

  private async Task<bool> WaitForProcessGroupExitAsync(bool includeStdioSessions, int timeoutMs = 15000)
  {
    var deadline = DateTimeOffset.UtcNow.AddMilliseconds(timeoutMs);
    while (DateTimeOffset.UtcNow < deadline)
    {
      if (CollectManagedProcessIds(includeStdioSessions).Count == 0)
      {
        return true;
      }

      await Task.Delay(250);
    }

    return false;
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

  private async Task<bool> WaitForServiceReadyAsync(Process process, int timeoutMs = 15000)
  {
    var requiredPorts = ResolveStartupValidationPorts(_configuration);
    var deadline = DateTimeOffset.UtcNow.AddMilliseconds(timeoutMs);

    while (DateTimeOffset.UtcNow < deadline)
    {
      try
      {
        if (process.HasExited)
        {
          return false;
        }
      }
      catch
      {
        return false;
      }

      if (requiredPorts.Count == 0)
      {
        return true;
      }

      if (FindListeningProcessIds(requiredPorts).Count >= requiredPorts.Count)
      {
        return true;
      }

      await Task.Delay(500);
    }

    return false;
  }

  private static IReadOnlyCollection<int> ResolveStartupValidationPorts(RuntimeConfiguration configuration)
  {
    var ports = new List<int>();

    if (Uri.TryCreate(configuration.AppServerWsUrl?.Trim(), UriKind.Absolute, out var appServerUrl))
    {
      var appServerPort = appServerUrl.IsDefaultPort
        ? appServerUrl.Scheme.Equals("wss", StringComparison.OrdinalIgnoreCase) ? 443 : 80
        : appServerUrl.Port;
      if (appServerPort is >= 1 and <= 65535)
      {
        ports.Add(appServerPort);
      }
    }

    return ports;
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
        Arguments = "-NoProfile -ExecutionPolicy Bypass -Command \"Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*run-local-agent.mjs*' } | Select-Object -First 1 -ExpandProperty ProcessId\"",
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
