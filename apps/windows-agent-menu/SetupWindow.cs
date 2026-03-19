using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using Button = System.Windows.Controls.Button;
using ComboBox = System.Windows.Controls.ComboBox;
using Forms = System.Windows.Forms;
using MessageBox = System.Windows.MessageBox;
using Orientation = System.Windows.Controls.Orientation;
using ProgressBar = System.Windows.Controls.ProgressBar;
using TextBox = System.Windows.Controls.TextBox;
using WpfColor = System.Windows.Media.Color;
using WpfCursors = System.Windows.Input.Cursors;

sealed class SetupWindow : Window
{
  private readonly RuntimeInstaller _installer;
  private readonly Dictionary<string, DiagnosticRowView> _diagnosticRows = [];
  private TextBox _natsUrlTextBox = null!;
  private TextBox _bridgeHostTextBox = null!;
  private TextBox _bridgePortTextBox = null!;
  private PasswordBox _bridgeTokenPasswordBox = null!;
  private TextBox _deviceNameTextBox = null!;
  private TextBox _ownerLoginIdTextBox = null!;
  private TextBox _workspaceRootTextBox = null!;
  private TextBox _appServerWsUrlTextBox = null!;
  private ComboBox _codexModelComboBox = null!;
  private ComboBox _reasoningComboBox = null!;
  private ComboBox _approvalComboBox = null!;
  private ComboBox _sandboxComboBox = null!;
  private TextBox _watchdogTextBox = null!;
  private TextBox _staleTextBox = null!;
  private MacToggleSwitch _autoStartCheckBox = null!;
  private MacToggleSwitch _autoUpdateCheckBox = null!;
  private TextBlock _savedAtTextBlock = null!;
  private TextBlock _codexLoginStatusTextBlock = null!;
  private Button _logButton = null!;
  private Button _installButton = null!;
  private Button _saveButton = null!;
  private Button _codexLoginButton = null!;
  private TextBlock _activityTitleTextBlock = null!;
  private TextBlock _activityHintTextBlock = null!;
  private ProgressBar _activityProgressBar = null!;

  private Task? _activeInstallTask;
  private string _currentInstallRoot;
  private string _latestActivityMessage = "설치를 시작하면 여기에서 진행 상태를 확인할 수 있습니다.";
  private RuntimeStatus? _lastKnownStatus;
  private bool _codexLoggedIn;

  public bool AllowClose { get; set; }
  public bool InstallationInProgress => _activeInstallTask is { IsCompleted: false };
  public bool Visible => IsVisible;

  public event EventHandler<RuntimeStatus>? InstallationCompleted;
  public event EventHandler? LogsRequested;
  public event EventHandler<string>? LogProduced;

  public SetupWindow(RuntimeInstaller installer)
  {
    _installer = installer;
    _currentInstallRoot = OctopPaths.ResolvePreferredInstallRoot();

    Title = "환경설정";
    MinWidth = 520;
    MinHeight = 680;
    Width = 540;
    Height = 760;
    WindowStartupLocation = WindowStartupLocation.CenterScreen;
    Background = CreateWindowBackground();
    FontFamily = new System.Windows.Media.FontFamily("Segoe UI");
    FontSize = 13;

    Closing += OnClosing;

    var scrollViewer = new ScrollViewer
    {
      VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
      HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
      Content = BuildContent()
    };

    Content = scrollViewer;
  }

  public void LoadConfiguration(RuntimeConfiguration configuration)
  {
    _currentInstallRoot = configuration.InstallRoot;
    _natsUrlTextBox.Text = configuration.NatsUrl;
    _bridgeHostTextBox.Text = configuration.BridgeHost;
    _bridgePortTextBox.Text = configuration.BridgePort;
    _bridgeTokenPasswordBox.Password = configuration.BridgeToken;
    _deviceNameTextBox.Text = configuration.DeviceName;
    _ownerLoginIdTextBox.Text = configuration.OwnerLoginId;
    _workspaceRootTextBox.Text = configuration.GetWorkspaceRoots().FirstOrDefault() ?? string.Empty;
    _appServerWsUrlTextBox.Text = configuration.AppServerWsUrl;
    SelectComboValue(_codexModelComboBox, configuration.CodexModel);
    SelectComboValue(_reasoningComboBox, configuration.CodexReasoningEffort);
    SelectComboValue(_approvalComboBox, configuration.CodexApprovalPolicy);
    SelectComboValue(_sandboxComboBox, configuration.CodexSandbox);
    _watchdogTextBox.Text = configuration.WatchdogIntervalMs;
    _staleTextBox.Text = configuration.StaleMs;
    _autoStartCheckBox.IsChecked = configuration.AutoStartAtLogin;
    _autoUpdateCheckBox.IsChecked = configuration.AutoUpdateEnabled;
    UpdateSavedAt(configuration.InstallRoot);
  }

  public void UpdateStatus(RuntimeStatus status)
  {
    _lastKnownStatus = status;
    UpdateDiagnostic("runtimeBundle", status.RuntimeBundlePresent ? DiagnosticState.Ok : DiagnosticState.Missing, status.RuntimeBundlePresent ? "정상" : "누락");
    UpdateDiagnostic("configuration", status.ConfigurationSaved ? DiagnosticState.Ok : DiagnosticState.Missing, status.ConfigurationSaved ? "정상" : "누락");
    UpdateDiagnostic("runtimeVersion", status.RuntimeVersionMatches ? DiagnosticState.Ok : DiagnosticState.Warning, status.RuntimeVersionMatches ? status.RuntimeVersion : "업데이트 필요");
    UpdateDiagnostic("node", status.NodeInstalled ? DiagnosticState.Ok : DiagnosticState.Missing, status.NodeInstalled ? (status.NodeVersion ?? "정상") : "누락");
    UpdateDiagnostic("dependencies", status.RuntimeDependenciesInstalled ? DiagnosticState.Ok : DiagnosticState.Missing, status.RuntimeDependenciesInstalled ? "정상" : "누락");
    UpdateDiagnostic("codex", status.CodexInstalled ? DiagnosticState.Ok : DiagnosticState.Missing, status.CodexInstalled ? "정상" : "누락");
    UpdateDiagnostic("login", status.CodexLoggedIn ? DiagnosticState.Ok : DiagnosticState.Warning, status.CodexLoggedIn ? "정상" : status.CodexLoginStatus);
    _codexLoggedIn = status.CodexLoggedIn;
    _codexLoginStatusTextBlock.Text = status.CodexLoginStatus;
    UpdateCodexLoginButton();
    UpdateDiagnostic(
      "autostart",
      status.AutoStartRequested
        ? (status.AutoStartConfigured ? DiagnosticState.Ok : DiagnosticState.Warning)
        : DiagnosticState.Warning,
      status.AutoStartRequested
        ? (status.AutoStartConfigured ? "정상" : "설정 필요")
        : "꺼짐");
  }

  public void StartAutomaticInstallIfNeeded()
  {
    if (InstallationInProgress)
    {
      return;
    }

    UpdateActivityState(
      busy: true,
      installing: true,
      title: "초기 설치를 준비하고 있습니다.",
      hint: "창을 닫지 않아도 설치는 계속 진행됩니다. 진행 상태를 여기에서 바로 확인하실 수 있습니다.");
    Dispatcher.BeginInvoke(
      new Action(() => _ = RunInstallAsync(clearProgress: false, showMessageBoxOnFailure: false, automatic: true)),
      DispatcherPriority.Background);
  }

  public async Task<RuntimeStatus?> EnsureInstalledAsync(bool automatic, bool showMessageBoxOnFailure)
  {
    if (InstallationInProgress)
    {
      if (_activeInstallTask is not null)
      {
        await _activeInstallTask;
      }

      return _lastKnownStatus;
    }

    await RunInstallAsync(clearProgress: false, showMessageBoxOnFailure: showMessageBoxOnFailure, automatic: automatic);
    return _lastKnownStatus;
  }

  public void BringToFront()
  {
    Activate();
    Topmost = true;
    Topmost = false;
    Focus();
  }

  private UIElement BuildContent()
  {
    var content = new StackPanel
    {
      Orientation = Orientation.Vertical,
      Margin = new Thickness(18)
    };

    content.Children.Add(CreateActivityCard());
    content.Children.Add(CreateDiagnosticsCard());
    content.Children.Add(CreateBasicInfoCard());
    content.Children.Add(CreateConnectionCard());
    content.Children.Add(CreateExecutionPolicyCard());
    content.Children.Add(CreateActionRow());

    return content;
  }

  private Border CreateDiagnosticsCard()
  {
    var stack = new StackPanel
    {
      Orientation = Orientation.Vertical
    };

    AddDiagnosticRow(stack, "runtimeBundle", "런타임 번들");
    AddDiagnosticRow(stack, "configuration", "설정 파일");
    AddDiagnosticRow(stack, "runtimeVersion", "런타임 버전");
    AddDiagnosticRow(stack, "node", "Node.js");
    AddDiagnosticRow(stack, "dependencies", "bridge 의존성");
    AddDiagnosticRow(stack, "codex", "Codex CLI");
    AddDiagnosticRow(stack, "login", "Codex 로그인");
    AddDiagnosticRow(stack, "autostart", "로그인 시 자동 실행");

    return CreateCard("설치 진단", stack);
  }

  private Border CreateActivityCard()
  {
    var stack = new StackPanel
    {
      Orientation = Orientation.Vertical
    };

    _activityTitleTextBlock = new TextBlock
    {
      Text = "설치 대기 중",
      FontSize = 15,
      FontWeight = FontWeights.SemiBold,
      Foreground = CreateBrush(0x17, 0x17, 0x17)
    };
    _activityHintTextBlock = new TextBlock
    {
      Text = _latestActivityMessage,
      Margin = new Thickness(0, 8, 0, 0),
      Foreground = CreateBrush(0x52, 0x52, 0x52),
      TextWrapping = TextWrapping.Wrap
    };
    _activityProgressBar = new ProgressBar
    {
      Height = 6,
      Margin = new Thickness(0, 14, 0, 0),
      IsIndeterminate = false,
      Minimum = 0,
      Maximum = 100,
      Value = 0,
      Visibility = Visibility.Collapsed,
      Foreground = CreateBrush(0x17, 0x17, 0x17),
      Background = CreateBrush(0xE5, 0xE7, 0xEB)
    };

    stack.Children.Add(_activityTitleTextBlock);
    stack.Children.Add(_activityHintTextBlock);
    stack.Children.Add(_activityProgressBar);

    return CreateCard("설치 상태", stack);
  }

  private Border CreateBasicInfoCard()
  {
    var stack = CreateSectionStack();
    stack.Children.Add(CreateLabeledTextField("로그인 ID", _ownerLoginIdTextBox = CreateIdentityTextBox()));
    stack.Children.Add(CreateLabeledTextField("디바이스 이름", _deviceNameTextBox = CreateIdentityTextBox()));
    stack.Children.Add(CreateFolderField("워크스페이스 루트", _workspaceRootTextBox = CreateTextBox(readOnly: true), HandleBrowseWorkspaceRootClick));
    return CreateCard("기본 정보", stack);
  }

  private Border CreateConnectionCard()
  {
    var fields = CreateSectionStack();
    fields.Children.Add(CreateLabeledTextField("NATS URL", _natsUrlTextBox = CreateTextBox()));
    fields.Children.Add(CreateLabeledTextField("Bridge Host", _bridgeHostTextBox = CreateTextBox()));
    fields.Children.Add(CreateLabeledTextField("Bridge Port", _bridgePortTextBox = CreateTextBox()));
    fields.Children.Add(CreateLabeledPasswordField("Bridge Token", _bridgeTokenPasswordBox = CreatePasswordBox()));
    fields.Children.Add(CreateLabeledValueField("App Server Mode", "ws-local"));
    fields.Children.Add(CreateLabeledTextField("App Server WS URL", _appServerWsUrlTextBox = CreateTextBox()));

    var expander = new Expander
    {
      Header = new TextBlock
      {
        Text = "연결 값",
        FontSize = 13,
        FontWeight = FontWeights.SemiBold,
        Foreground = CreateBrush(0x17, 0x17, 0x17)
      },
      IsExpanded = false,
      Margin = new Thickness(0, 2, 0, 0),
      Content = new Border
      {
        Padding = new Thickness(0, 12, 0, 0),
        Child = fields
      }
    };

    return CreateCard("연결 설정", expander);
  }

  private Border CreateExecutionPolicyCard()
  {
    var stack = CreateSectionStack();
    stack.Children.Add(CreateLabeledComboField("모델", _codexModelComboBox = CreateComboBox(["gpt-5.4", "gpt-5.4-mini", "gpt-5.2", "gpt-5.2-codex", "gpt-5.1-codex-mini"])));
    stack.Children.Add(CreateLabeledComboField("Reasoning", _reasoningComboBox = CreateComboBox(["none", "low", "medium", "high", "xhigh"])));
    stack.Children.Add(CreateLabeledComboField("Approval", _approvalComboBox = CreateComboBox(["never", "on-request", "untrusted"])));
    stack.Children.Add(CreateLabeledComboField("Sandbox", _sandboxComboBox = CreateComboBox(["workspace-write", "read-only", "danger-full-access"])));
    stack.Children.Add(CreateCodexLoginField());
    stack.Children.Add(CreateLabeledTextField("Watchdog (ms)", _watchdogTextBox = CreateTextBox()));
    stack.Children.Add(CreateLabeledTextField("Stale (ms)", _staleTextBox = CreateTextBox()));
    stack.Children.Add(CreateToggleField("로그인 시 자동 실행", _autoStartCheckBox = CreateToggleSwitch()));
    stack.Children.Add(CreateToggleField("자동 업데이트", _autoUpdateCheckBox = CreateToggleSwitch()));
    return CreateCard("Codex 실행 정책", stack);
  }

  private UIElement CreateCodexLoginField()
  {
    var stack = new StackPanel
    {
      Orientation = Orientation.Vertical,
      Margin = new Thickness(0, 0, 0, 12)
    };

    stack.Children.Add(new TextBlock
    {
      Text = "Codex 로그인",
      FontSize = 12,
      Foreground = CreateBrush(0x6B, 0x72, 0x80),
      Margin = new Thickness(0, 0, 0, 4)
    });

    _codexLoginStatusTextBlock = new TextBlock
    {
      Text = "확인 전",
      Foreground = CreateBrush(0x17, 0x17, 0x17),
      Margin = new Thickness(0, 0, 0, 8),
      TextWrapping = TextWrapping.Wrap
    };
    stack.Children.Add(_codexLoginStatusTextBlock);

    var buttons = new StackPanel
    {
      Orientation = Orientation.Horizontal
    };

    _codexLoginButton = CreateSecondaryButton("로그인");
    _codexLoginButton.Click += async (_, _) => await HandleCodexLoginClickAsync(logoutFirst: _codexLoggedIn);
    UpdateCodexLoginButton();

    buttons.Children.Add(_codexLoginButton);
    stack.Children.Add(buttons);

    return stack;
  }

  private UIElement CreateActionRow()
  {
    var row = new DockPanel
    {
      LastChildFill = false,
      Margin = new Thickness(0, 2, 0, 0)
    };

    _savedAtTextBlock = new TextBlock
    {
      VerticalAlignment = VerticalAlignment.Center,
      Foreground = CreateBrush(0x6B, 0x72, 0x80),
      FontSize = 12,
      Margin = new Thickness(0, 0, 12, 0)
    };
    DockPanel.SetDock(_savedAtTextBlock, Dock.Right);

    var buttons = new StackPanel
    {
      Orientation = Orientation.Horizontal,
      HorizontalAlignment = System.Windows.HorizontalAlignment.Right
    };
    DockPanel.SetDock(buttons, Dock.Right);

    _logButton = CreateSecondaryButton("로그 보기");
    _logButton.Click += (_, _) => LogsRequested?.Invoke(this, EventArgs.Empty);

    _installButton = CreateSecondaryButton("런타임 다시 설치");
    _installButton.Click += HandleInstallClick;

    _saveButton = CreatePrimaryButton("설정 저장");
    _saveButton.Click += HandleSaveClick;

    buttons.Children.Add(_logButton);
    buttons.Children.Add(_installButton);
    buttons.Children.Add(_saveButton);

    row.Children.Add(buttons);
    row.Children.Add(_savedAtTextBlock);
    return row;
  }

  private RuntimeConfiguration GatherConfiguration()
  {
    return new RuntimeConfiguration
    {
      InstallRoot = string.IsNullOrWhiteSpace(_currentInstallRoot)
        ? OctopPaths.GetDefaultInstallRoot()
        : _currentInstallRoot,
      NatsUrl = _natsUrlTextBox.Text.Trim(),
      BridgeHost = _bridgeHostTextBox.Text.Trim(),
      BridgePort = _bridgePortTextBox.Text.Trim(),
      BridgeToken = _bridgeTokenPasswordBox.Password.Trim(),
      DeviceName = _deviceNameTextBox.Text.Trim(),
      OwnerLoginId = _ownerLoginIdTextBox.Text.Trim(),
      WorkspaceRootsText = _workspaceRootTextBox.Text.Trim(),
      AppServerMode = "ws-local",
      AppServerWsUrl = _appServerWsUrlTextBox.Text.Trim(),
      CodexModel = Convert.ToString(_codexModelComboBox.SelectedItem) ?? "gpt-5.4",
      CodexReasoningEffort = Convert.ToString(_reasoningComboBox.SelectedItem) ?? "high",
      CodexApprovalPolicy = Convert.ToString(_approvalComboBox.SelectedItem) ?? "never",
      CodexSandbox = Convert.ToString(_sandboxComboBox.SelectedItem) ?? "workspace-write",
      WatchdogIntervalMs = _watchdogTextBox.Text.Trim(),
      StaleMs = _staleTextBox.Text.Trim(),
      AutoStartAtLogin = _autoStartCheckBox.IsChecked == true,
      AutoUpdateEnabled = _autoUpdateCheckBox.IsChecked == true,
      AuthMode = CodexAuthMode.ChatGptDeviceAuth
    };
  }

  private void HandleInstallClick(object? sender, RoutedEventArgs eventArgs)
  {
    _ = RunInstallAsync(clearProgress: false, showMessageBoxOnFailure: true, automatic: false);
  }

  private async void HandleSaveClick(object? sender, RoutedEventArgs eventArgs)
  {
    try
    {
      SetBusy(true, installing: false);
      await Dispatcher.Yield(DispatcherPriority.Background);
      var configuration = GatherConfiguration();
      var paths = new OctopPaths(configuration.InstallRoot);
      _installer.SaveConfiguration(configuration, paths);
      _installer.WriteEnvironmentFile(configuration, paths);
      _installer.EnsureAutoStartAtLogin(configuration, new Progress<string>(ReportProgress));
      var status = await _installer.InspectAsync(paths, CancellationToken.None);
      UpdateStatus(status);
      UpdateSavedAt(paths.InstallRoot);
      ReportProgress("설정을 저장했습니다.");
      UpdateActivityState(
        busy: false,
        installing: false,
        title: "설정 저장 완료",
        hint: "변경된 로그인 ID와 디바이스 이름은 서비스 재시작 후 반영됩니다.");
    }
    catch (Exception error)
    {
      ReportProgress($"설정 저장 실패: {error.Message}");
      UpdateActivityState(
        busy: false,
        installing: false,
        title: "설정 저장 실패",
        hint: error.Message);
      MessageBox.Show(this, error.Message, "설정 저장 실패", MessageBoxButton.OK, MessageBoxImage.Error);
    }
    finally
    {
      SetBusy(false, installing: false);
    }
  }

  private async Task RunInstallAsync(bool clearProgress, bool showMessageBoxOnFailure, bool automatic)
  {
    if (InstallationInProgress)
    {
      return;
    }

    _activeInstallTask = RunInstallCoreAsync(clearProgress, showMessageBoxOnFailure, automatic);
    await _activeInstallTask;
  }

  private async Task RunInstallCoreAsync(bool clearProgress, bool showMessageBoxOnFailure, bool automatic)
  {
    try
    {
      SetBusy(true, installing: true);
      if (clearProgress)
      {
        ReportProgress("로그를 초기화했습니다.");
      }

      if (string.IsNullOrWhiteSpace(_workspaceRootTextBox.Text))
      {
        throw new InvalidOperationException("워크스페이스 루트를 폴더 브라우저에서 선택해 주세요.");
      }

      var configuration = GatherConfiguration();
      if (automatic)
      {
        ReportProgress("앱 시작 시 설치 상태를 점검했고 자동 설치를 시작합니다.");
      }

      await Dispatcher.Yield(DispatcherPriority.Background);
      var progress = new Progress<string>(ReportProgress);
      var status = await _installer.InstallOrUpdateAsync(configuration, progress, CancellationToken.None);
      UpdateStatus(status);
      UpdateSavedAt(configuration.InstallRoot);
      ReportProgress("설치 완료");
      UpdateActivityState(
        busy: false,
        installing: false,
        title: "설치 완료",
        hint: "이제 서비스 시작 또는 재시작으로 바로 연결하실 수 있습니다.");
      InstallationCompleted?.Invoke(this, status);
    }
    catch (Exception error)
    {
      ReportProgress($"설치 실패: {error.Message}");
      UpdateActivityState(
        busy: false,
        installing: false,
        title: "설치 실패",
        hint: error.Message);
      if (showMessageBoxOnFailure)
      {
        MessageBox.Show(this, error.Message, "설치 실패", MessageBoxButton.OK, MessageBoxImage.Error);
      }
    }
    finally
    {
      SetBusy(false, installing: false);
      _activeInstallTask = null;
    }
  }

  private void HandleBrowseWorkspaceRootClick(object? sender, RoutedEventArgs eventArgs)
  {
    using var dialog = CreateFolderBrowser("local agent가 접근할 기본 워크스페이스 루트를 선택해 주세요.");
    if (!string.IsNullOrWhiteSpace(_workspaceRootTextBox.Text))
    {
      dialog.SelectedPath = _workspaceRootTextBox.Text;
    }

    if (dialog.ShowDialog() != Forms.DialogResult.OK || string.IsNullOrWhiteSpace(dialog.SelectedPath))
    {
      return;
    }

    _workspaceRootTextBox.Text = dialog.SelectedPath;
  }

  private async Task HandleCodexLoginClickAsync(bool logoutFirst)
  {
    try
    {
      SetBusy(true, installing: false);
      await Dispatcher.Yield(DispatcherPriority.Background);

      var configuration = GatherConfiguration();
      var paths = new OctopPaths(configuration.InstallRoot);
      _installer.SaveConfiguration(configuration, paths);
      _installer.WriteEnvironmentFile(configuration, paths);
      var progress = new Progress<string>(ReportProgress);
      await _installer.LoginWithBrowserSelectionAsync(paths, progress, CancellationToken.None, logoutFirst);
      var status = await _installer.InspectAsync(paths, CancellationToken.None);
      UpdateStatus(status);
      UpdateSavedAt(paths.InstallRoot);
      UpdateActivityState(
        busy: false,
        installing: false,
        title: logoutFirst ? "계정 전환 완료" : "로그인 완료",
        hint: "선택한 브라우저에서 인증한 계정이 반영되었습니다.");
    }
    catch (Exception error)
    {
      ReportProgress($"{(logoutFirst ? "계정 전환" : "로그인")} 실패: {error.Message}");
      UpdateActivityState(
        busy: false,
        installing: false,
        title: logoutFirst ? "계정 전환 실패" : "로그인 실패",
        hint: error.Message);
      MessageBox.Show(this, error.Message, logoutFirst ? "계정 전환 실패" : "로그인 실패", MessageBoxButton.OK, MessageBoxImage.Error);
    }
    finally
    {
      SetBusy(false, installing: false);
    }
  }

  private void ReportProgress(string message)
  {
    _latestActivityMessage = message;
    UpdateActivityState(
      busy: InstallationInProgress,
      installing: InstallationInProgress,
      title: InstallationInProgress ? "설치 중..." : "최근 작업",
      hint: message);
    LogProduced?.Invoke(this, message);
  }

  private void UpdateCodexLoginButton()
  {
    if (_codexLoginButton is null)
    {
      return;
    }

    _codexLoginButton.Content = _codexLoggedIn ? "계정 전환" : "로그인";
    _codexLoginButton.ToolTip = _codexLoggedIn
      ? "현재 로그인 계정을 로그아웃한 뒤 다른 계정으로 다시 로그인합니다."
      : "브라우저를 선택해 Codex 계정을 로그인합니다.";
  }

  private void SetBusy(bool busy, bool installing)
  {
    _installButton.IsEnabled = !busy;
    _saveButton.IsEnabled = !busy;
    _logButton.IsEnabled = true;
    if (_codexLoginButton is not null)
    {
      _codexLoginButton.IsEnabled = !busy;
    }
    _installButton.Content = installing ? "설치 중..." : "런타임 다시 설치";
    System.Windows.Input.Mouse.OverrideCursor = busy ? WpfCursors.Wait : null;
    UpdateActivityState(
      busy: busy,
      installing: installing,
      title: busy
        ? (installing ? "설치 중..." : "설정을 저장하는 중입니다.")
        : "설치 대기 중",
      hint: busy
        ? _latestActivityMessage
        : "설치를 시작하면 여기에서 진행 상태를 확인할 수 있습니다.");
  }

  private void UpdateActivityState(bool busy, bool installing, string title, string hint)
  {
    if (_activityTitleTextBlock is null || _activityHintTextBlock is null || _activityProgressBar is null)
    {
      return;
    }

    _activityTitleTextBlock.Text = title;
    _activityHintTextBlock.Text = string.IsNullOrWhiteSpace(hint)
      ? "설치를 시작하면 여기에서 진행 상태를 확인할 수 있습니다."
      : hint;
    _activityProgressBar.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
    _activityProgressBar.IsIndeterminate = busy;
  }

  private void OnClosing(object? sender, CancelEventArgs eventArgs)
  {
    if (AllowClose)
    {
      return;
    }

    eventArgs.Cancel = true;
    Hide();
  }

  private void UpdateSavedAt(string installRoot)
  {
    var paths = new OctopPaths(installRoot);
    if (!File.Exists(paths.ConfigurationPath))
    {
      _savedAtTextBlock.Text = string.Empty;
      return;
    }

    var savedAt = File.GetLastWriteTime(paths.ConfigurationPath);
    _savedAtTextBlock.Text = savedAt.ToString("HH:mm:ss");
  }

  private void AddDiagnosticRow(System.Windows.Controls.Panel parent, string key, string title)
  {
    var row = new Grid
    {
      Margin = new Thickness(0, 0, 0, 10)
    };
    row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
    row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
    row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
    row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

    var dot = new Border
    {
      Width = 10,
      Height = 10,
      CornerRadius = new CornerRadius(999),
      Background = CreateBrush(0xD1, 0xD5, 0xDB),
      Margin = new Thickness(0, 0, 10, 0),
      VerticalAlignment = VerticalAlignment.Center
    };

    var titleBlock = new TextBlock
    {
      Text = title,
      FontSize = 13,
      FontWeight = FontWeights.SemiBold,
      Foreground = CreateBrush(0x17, 0x17, 0x17),
      VerticalAlignment = VerticalAlignment.Center
    };

    var badgeText = new TextBlock
    {
      FontSize = 11,
      FontWeight = FontWeights.SemiBold,
      Foreground = CreateBrush(0x6B, 0x72, 0x80),
      VerticalAlignment = VerticalAlignment.Center
    };

    var badge = new Border
    {
      Background = CreateAlphaBrush(0xD1, 0xD5, 0xDB, 40),
      CornerRadius = new CornerRadius(999),
      Padding = new Thickness(10, 6, 10, 6),
      Child = badgeText
    };

    Grid.SetColumn(dot, 0);
    Grid.SetColumn(titleBlock, 1);
    Grid.SetColumn(badge, 3);

    row.Children.Add(dot);
    row.Children.Add(titleBlock);
    row.Children.Add(badge);

    parent.Children.Add(row);
    _diagnosticRows[key] = new DiagnosticRowView(dot, badge, badgeText);
  }

  private void UpdateDiagnostic(string key, DiagnosticState state, string text)
  {
    if (!_diagnosticRows.TryGetValue(key, out var row))
    {
      return;
    }

    var tone = GetDiagnosticTone(state);
    row.Dot.Background = tone.Solid;
    row.Badge.Background = tone.Soft;
    row.BadgeText.Foreground = tone.Solid;
    row.BadgeText.Text = text;
  }

  private static (SolidColorBrush Solid, SolidColorBrush Soft) GetDiagnosticTone(DiagnosticState state)
  {
    return state switch
    {
      DiagnosticState.Ok => (CreateBrush(0x16, 0xA3, 0x4A), CreateAlphaBrush(0x16, 0xA3, 0x4A, 24)),
      DiagnosticState.Warning => (CreateBrush(0xD9, 0x77, 0x06), CreateAlphaBrush(0xD9, 0x77, 0x06, 24)),
      _ => (CreateBrush(0xDC, 0x26, 0x26), CreateAlphaBrush(0xDC, 0x26, 0x26, 24))
    };
  }

  private static Forms.FolderBrowserDialog CreateFolderBrowser(string description)
  {
    return new Forms.FolderBrowserDialog
    {
      UseDescriptionForTitle = true,
      Description = description,
      ShowNewFolderButton = true
    };
  }

  private static void SelectComboValue(ComboBox comboBox, string value)
  {
    if (string.IsNullOrWhiteSpace(value))
    {
      comboBox.SelectedIndex = comboBox.Items.Count > 0 ? 0 : -1;
      return;
    }

    var selectedItem = comboBox.Items.Cast<object>()
      .FirstOrDefault(item => string.Equals(Convert.ToString(item), value, StringComparison.OrdinalIgnoreCase));
    comboBox.SelectedItem = selectedItem ?? (comboBox.Items.Count > 0 ? comboBox.Items[0] : null);
  }

  private static Border CreateCard(string title, UIElement content)
  {
    var stack = new StackPanel
    {
      Orientation = Orientation.Vertical
    };
    stack.Children.Add(new TextBlock
    {
      Text = title,
      FontSize = 18,
      FontWeight = FontWeights.SemiBold,
      Foreground = CreateBrush(0x17, 0x17, 0x17),
      Margin = new Thickness(0, 0, 0, 14)
    });
    stack.Children.Add(content);

    return new Border
    {
      Background = System.Windows.Media.Brushes.White,
      BorderBrush = CreateAlphaBrush(0x17, 0x17, 0x17, 15),
      BorderThickness = new Thickness(1),
      CornerRadius = new CornerRadius(20),
      Padding = new Thickness(18),
      Margin = new Thickness(0, 0, 0, 18),
      Child = stack
    };
  }

  private static StackPanel CreateSectionStack()
  {
    return new StackPanel
    {
      Orientation = Orientation.Vertical
    };
  }

  private static UIElement CreateLabeledTextField(string label, TextBox textBox)
  {
    return CreateFieldContainer(label, textBox);
  }

  private static UIElement CreateLabeledPasswordField(string label, PasswordBox passwordBox)
  {
    return CreateFieldContainer(label, passwordBox);
  }

  private static UIElement CreateLabeledComboField(string label, ComboBox comboBox)
  {
    return CreateFieldContainer(label, comboBox);
  }

  private static UIElement CreateLabeledValueField(string label, string value)
  {
    return CreateFieldContainer(label, CreateValueBox(value));
  }

  private static UIElement CreateFolderField(string label, TextBox textBox, RoutedEventHandler onBrowseClick)
  {
    return CreateFieldContainer(label, CreateBrowseRow(textBox, onBrowseClick));
  }

  private static UIElement CreateToggleField(string label, MacToggleSwitch checkBox)
  {
    var row = new Grid
    {
      Margin = new Thickness(0, 0, 0, 12)
    };
    row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
    row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

    var text = new TextBlock
    {
      Text = label,
      FontSize = 12,
      Foreground = CreateBrush(0x6B, 0x72, 0x80),
      VerticalAlignment = VerticalAlignment.Center
    };
    Grid.SetColumn(text, 0);
    Grid.SetColumn(checkBox, 1);
    row.Children.Add(text);
    row.Children.Add(checkBox);
    return row;
  }

  private static FrameworkElement CreateFieldContainer(string label, UIElement control)
  {
    var stack = new StackPanel
    {
      Orientation = Orientation.Vertical,
      Margin = new Thickness(0, 0, 0, 12)
    };
    stack.Children.Add(new TextBlock
    {
      Text = label,
      FontSize = 12,
      Foreground = CreateBrush(0x6B, 0x72, 0x80),
      Margin = new Thickness(0, 0, 0, 4)
    });
    stack.Children.Add(control);
    return stack;
  }

  private static TextBox CreateTextBox(bool readOnly = false)
  {
    return new TextBox
    {
      IsReadOnly = readOnly,
      Height = 34,
      Padding = new Thickness(10, 6, 10, 6),
      BorderThickness = new Thickness(1),
      BorderBrush = CreateBrush(0xD1, 0xD5, 0xDB),
      Background = readOnly ? CreateBrush(0xFA, 0xFA, 0xFA) : System.Windows.Media.Brushes.White
    };
  }

  private static TextBox CreateIdentityTextBox()
  {
    var textBox = CreateTextBox();
    InputMethod.SetPreferredImeState(textBox, InputMethodState.Off);
    InputMethod.SetPreferredImeConversionMode(textBox, ImeConversionModeValues.Alphanumeric);
    return textBox;
  }

  private static PasswordBox CreatePasswordBox()
  {
    return new PasswordBox
    {
      Height = 34,
      Padding = new Thickness(10, 6, 10, 6),
      BorderThickness = new Thickness(1),
      BorderBrush = CreateBrush(0xD1, 0xD5, 0xDB),
      Background = System.Windows.Media.Brushes.White
    };
  }

  private static ComboBox CreateComboBox(IEnumerable<string> values)
  {
    var comboBox = new ComboBox
    {
      Height = 34,
      Padding = new Thickness(8, 4, 8, 4),
      BorderThickness = new Thickness(1),
      BorderBrush = CreateBrush(0xD1, 0xD5, 0xDB),
      Background = System.Windows.Media.Brushes.White
    };
    foreach (var value in values)
    {
      comboBox.Items.Add(value);
    }

    if (comboBox.Items.Count > 0)
    {
      comboBox.SelectedIndex = 0;
    }

    return comboBox;
  }

  private static MacToggleSwitch CreateToggleSwitch()
  {
    return new MacToggleSwitch();
  }

  private static UIElement CreateBrowseRow(TextBox textBox, RoutedEventHandler onBrowseClick)
  {
    var grid = new Grid();
    grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
    grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
    grid.Children.Add(textBox);

    var button = CreateSecondaryButton("폴더 선택");
    button.Margin = new Thickness(10, 0, 0, 0);
    button.Click += onBrowseClick;
    Grid.SetColumn(button, 1);
    grid.Children.Add(button);
    return grid;
  }

  private static Border CreateValueBox(string text)
  {
    return new Border
    {
      Background = CreateBrush(0xFA, 0xFA, 0xFA),
      BorderBrush = CreateBrush(0xE5, 0xE7, 0xEB),
      BorderThickness = new Thickness(1),
      CornerRadius = new CornerRadius(8),
      Padding = new Thickness(12, 10, 12, 10),
      Child = new TextBlock
      {
        Text = text,
        Foreground = CreateBrush(0x17, 0x17, 0x17)
      }
    };
  }

  private static Button CreateSecondaryButton(string text)
  {
    return new Button
    {
      Content = text,
      Height = 34,
      Padding = new Thickness(14, 0, 14, 0),
      Margin = new Thickness(0, 0, 10, 0),
      Background = System.Windows.Media.Brushes.White,
      BorderBrush = CreateBrush(0xD1, 0xD5, 0xDB),
      BorderThickness = new Thickness(1),
      Foreground = CreateBrush(0x17, 0x17, 0x17),
      Cursor = WpfCursors.Hand
    };
  }

  private static Button CreatePrimaryButton(string text)
  {
    return new Button
    {
      Content = text,
      Height = 34,
      Padding = new Thickness(16, 0, 16, 0),
      Background = CreateBrush(0x17, 0x17, 0x17),
      BorderBrush = CreateBrush(0x17, 0x17, 0x17),
      BorderThickness = new Thickness(1),
      Foreground = System.Windows.Media.Brushes.White,
      Cursor = WpfCursors.Hand
    };
  }

  private static System.Windows.Media.Brush CreateWindowBackground()
  {
    return new LinearGradientBrush
    {
      StartPoint = new System.Windows.Point(0, 0),
      EndPoint = new System.Windows.Point(1, 1),
      GradientStops = new GradientStopCollection
      {
        new GradientStop(WpfColor.FromRgb(0xF6, 0xF7, 0xFB), 0),
        new GradientStop(WpfColor.FromRgb(0xEE, 0xF1, 0xF6), 1)
      }
    };
  }

  private static SolidColorBrush CreateBrush(byte red, byte green, byte blue)
  {
    var brush = new SolidColorBrush(WpfColor.FromRgb(red, green, blue));
    brush.Freeze();
    return brush;
  }

  private static SolidColorBrush CreateAlphaBrush(byte red, byte green, byte blue, byte alpha)
  {
    var brush = new SolidColorBrush(WpfColor.FromArgb(alpha, red, green, blue));
    brush.Freeze();
    return brush;
  }

  private enum DiagnosticState
  {
    Ok,
    Warning,
    Missing
  }

  private sealed record DiagnosticRowView(Border Dot, Border Badge, TextBlock BadgeText);
}
