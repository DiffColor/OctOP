using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

sealed class AgentTrayApplicationContext : ApplicationContext
{
  private const int MaxLines = 2000;
  private static readonly string AppTitle = "OctOP Local Agent";

  private readonly SynchronizationContext _uiContext;
  private readonly NotifyIcon _notifyIcon;
  private readonly ContextMenuStrip _menu;
  private readonly ToolStripMenuItem _titleItem;
  private readonly ToolStripMenuItem _statusItem;
  private readonly ToolStripMenuItem _environmentItem;
  private readonly ToolStripMenuItem _pidItem;
  private readonly ToolStripMenuItem _toggleItem;
  private readonly ToolStripMenuItem _setupItem;
  private readonly ToolStripMenuItem _exitItem;
  private readonly LogWindow _logWindow;
  private readonly SetupWindow _setupWindow;
  private readonly RuntimeInstaller _runtimeInstaller;
  private readonly WindowsAutoUpdater _autoUpdater;
  private OctopPaths _paths;
  private readonly Icon _colorIcon;
  private readonly Icon _grayscaleIcon;
  private readonly List<string> _lines = [];

  private RuntimeConfiguration _configuration;
  private RuntimeStatus? _runtimeStatus;
  private AgentRuntimeState _runtimeState = AgentRuntimeState.Stopped;
  private Process? _process;
  private int? _processId;
  private string? _lastError;
  private DateTimeOffset? _lastUpdatedAt;
  private bool _isExiting;

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
    _setupWindow.LoadConfiguration(_configuration);
    _setupWindow.LogsRequested += (_, _) => ShowLogs();
    _setupWindow.LogProduced += (_, message) =>
    {
      AppendLog(message);
      RefreshUi();
    };
    _setupWindow.InstallationCompleted += (_, status) =>
    {
      _runtimeStatus = status;
      _ = RefreshRuntimeStatusAsync();
    };

    _menu = new ContextMenuStrip();
    _menu.Opening += (_, _) => RefreshMenuState();

    _titleItem = new ToolStripMenuItem(AppTitle) { Enabled = false };
    _statusItem = new ToolStripMenuItem() { Enabled = false };
    _environmentItem = new ToolStripMenuItem("환경 확인 중") { Enabled = false };
    _pidItem = new ToolStripMenuItem() { Enabled = false, Visible = false };
    _toggleItem = new ToolStripMenuItem("실행 시작");
    _toggleItem.Click += (_, _) => ToggleProcess();
    _setupItem = new ToolStripMenuItem("환경설정");
    _setupItem.Click += (_, _) => ShowSetup();
    _exitItem = new ToolStripMenuItem("종료");
    _exitItem.Click += (_, _) => ExitApplication();

    _menu.Items.AddRange(
    [
      _titleItem,
      _statusItem,
      _environmentItem,
      _pidItem,
      new ToolStripSeparator(),
      _toggleItem,
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
      DisposeProcess();
    }

    base.Dispose(disposing);
  }

  private async Task InitializeAsync()
  {
    if (await TryApplyAppUpdateAsync())
    {
      return;
    }

    await RefreshRuntimeStatusAsync(showSetupWhenIncomplete: true);
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
    RefreshRuntimeStateFromSystem();
    if (_runtimeState is AgentRuntimeState.Running or AgentRuntimeState.Starting or AgentRuntimeState.Stopping)
    {
      Stop();
      return;
    }

    _ = StartAsync();
  }

  private async Task StartAsync()
  {
    var runtimeProcessIds = FindRuntimeProcessIds();
    if (runtimeProcessIds.Count > 0)
    {
      _processId = runtimeProcessIds[0];
      _runtimeState = AgentRuntimeState.Running;
      _lastUpdatedAt = DateTimeOffset.Now;
      AppendLog($"기존 local-agent 런타임 프로세스를 재사용합니다. pids={string.Join(",", runtimeProcessIds)}");
      RefreshUi();
      return;
    }

    await RefreshRuntimeStatusAsync();
    if (_runtimeStatus?.ReadyToRun != true)
    {
      AppendLog("실행 전 설치/설정이 필요합니다.");
      ShowSetup();
      _setupWindow.StartAutomaticInstallIfNeeded();
      return;
    }

    _runtimeState = AgentRuntimeState.Starting;
    _lastError = null;
    AppendLog("local-agent 실행을 시작합니다.");
    RefreshUi();

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
      WorkingDirectory = _paths.RuntimeRoot,
      UseShellExecute = false,
      RedirectStandardOutput = true,
      RedirectStandardError = true,
      CreateNoWindow = true,
      StandardOutputEncoding = Encoding.UTF8,
      StandardErrorEncoding = Encoding.UTF8
    };
    startInfo.ArgumentList.Add(_paths.RuntimeAgentEntryPath);

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
      AppendLog($"local-agent가 시작되었습니다. pid={process.Id}");
      RefreshUi();
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

  private void Stop()
  {
    if (_process is null)
    {
      var runtimeProcessIds = FindRuntimeProcessIds();

      if (runtimeProcessIds.Count > 0)
      {
        _runtimeState = AgentRuntimeState.Stopping;
        _processId = runtimeProcessIds[0];
        _lastUpdatedAt = DateTimeOffset.Now;
        AppendLog($"기존 local-agent 런타임 프로세스 중지를 요청합니다. pids={string.Join(",", runtimeProcessIds)}");
        RefreshUi();
        KillRuntimeProcesses(runtimeProcessIds);
        DeleteAgentPidFile();
        _runtimeState = AgentRuntimeState.Stopped;
        _processId = null;
        _lastError = null;
        _lastUpdatedAt = DateTimeOffset.Now;
        AppendLog("local-agent 런타임 프로세스가 종료되었습니다.");
        RefreshUi();
        return;
      }

      _runtimeState = AgentRuntimeState.Stopped;
      AppendLog("중지할 local-agent 프로세스가 없습니다.");
      RefreshUi();
      return;
    }

    _runtimeState = AgentRuntimeState.Stopping;
    _lastUpdatedAt = DateTimeOffset.Now;
    AppendLog("local-agent 중지를 요청합니다.");
    RefreshUi();

    try
    {
      if (!_process.HasExited)
      {
        _process.Kill(entireProcessTree: true);
        _process.WaitForExit(3000);
      }
      else
      {
        HandleTermination(_process);
      }

      KillRuntimeProcesses(FindRuntimeProcessIds());
    }
    catch (Exception error)
    {
      _runtimeState = AgentRuntimeState.Failed;
      _lastError = error.Message;
      AppendLog($"local-agent 중지 실패: {error.Message}");
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

  private void ExitApplication()
  {
    _isExiting = true;

    if (_process is not null)
    {
      try
      {
        if (!_process.HasExited)
        {
          _process.Kill(entireProcessTree: true);
          _process.WaitForExit(3000);
        }
      }
      catch
      {
      }
    }

    KillRuntimeProcesses(FindRuntimeProcessIds());

    _setupWindow.AllowClose = true;
    _setupWindow.Close();
    _logWindow.AllowClose = true;
    _notifyIcon.Visible = false;
    ExitThread();
  }

  private async Task<bool> TryApplyAppUpdateAsync()
  {
    if (!_configuration.AutoUpdateEnabled)
    {
      AppendLog("자동 업데이트가 비활성화되어 앱 업데이트 확인을 건너뜁니다.");
      return false;
    }

    var updateApplied = await _autoUpdater.TryApplyUpdateAsync(AppendLog, CancellationToken.None);
    if (!updateApplied)
    {
      return false;
    }

    ExitApplication();
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
    _statusItem.Text = GetRuntimeStateLabel(_runtimeState);
    _statusItem.ForeColor = GetRuntimeColor(_runtimeState);

    _environmentItem.Text = _runtimeStatus is null
      ? "환경 확인 필요"
      : (_runtimeStatus.ReadyToRun ? "환경 준비됨" : "환경설정 필요");
    _environmentItem.ForeColor = _runtimeStatus?.ReadyToRun == true ? Color.ForestGreen : Color.DarkOrange;

    _pidItem.Text = _processId is int processId ? $"PID {processId}" : string.Empty;
    _pidItem.Visible = _processId is not null;

    var running = _runtimeState is AgentRuntimeState.Running or AgentRuntimeState.Starting or AgentRuntimeState.Stopping;
    _toggleItem.Text = running ? "실행 중지" : "실행 시작";
    _toggleItem.Enabled = (_runtimeStatus?.ReadyToRun == true || running) && !_setupWindow.InstallationInProgress;
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

  private void PostToUi(Action action)
  {
    _uiContext.Post(static state => ((Action)state!).Invoke(), action);
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

    var runtimeProcessIds = FindRuntimeProcessIds();
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

  private List<int> FindRuntimeProcessIds()
  {
    var runtimeRoot = _paths.RuntimeRoot.Replace("'", "''");
    var command = string.Join(
      " ",
      [
        "$runtimeRoot = '" + runtimeRoot + "';",
        "Get-CimInstance Win32_Process |",
        "Where-Object {",
        "$_.CommandLine -and",
        "$_.CommandLine -like ('*' + $runtimeRoot + '*') -and",
        "(",
        "$_.CommandLine -like '*run-local-agent.mjs*' -or",
        "$_.CommandLine -like '*run-bridge.mjs*' -or",
        "$_.CommandLine -like '*services\\\\codex-adapter\\\\src\\\\index.js*' -or",
        "$_.CommandLine -like '*codex*app-server*--listen*'",
        ")",
        "} |",
        "Select-Object -ExpandProperty ProcessId"
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

      return output
        .Split(["\r\n", "\n"], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Select(static value => int.TryParse(value, out var pid) ? pid : 0)
        .Where(static pid => pid > 0)
        .Distinct()
        .ToList();
    }
    catch
    {
      return [];
    }
  }

  private void KillRuntimeProcesses(IEnumerable<int> processIds)
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
        process.WaitForExit(3000);
      }
      catch
      {
      }
    }

    DeleteAgentPidFile();
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
    Directory.CreateDirectory(_paths.RuntimeRoot);
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
