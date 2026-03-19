using System.IO;
using System.Linq;
using System.Text.Json.Serialization;

enum CodexAuthMode
{
  ChatGptDeviceAuth
}

sealed class RuntimeConfiguration
{
  public static string GetCurrentUserLogin()
  {
    return string.IsNullOrWhiteSpace(Environment.UserName) ? "local-user" : Environment.UserName;
  }

  public static string GetDefaultWorkspaceRoot()
  {
    var documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
    if (string.IsNullOrWhiteSpace(documents))
    {
      return Environment.CurrentDirectory;
    }

    return Path.Combine(documents, "Workspaces");
  }

  public static string GetCurrentDeviceName()
  {
    return string.IsNullOrWhiteSpace(Environment.MachineName) ? "Windows PC" : Environment.MachineName;
  }

  public string InstallRoot { get; set; } = OctopPaths.GetDefaultInstallRoot();
  public string NatsUrl { get; set; } = "nats://ilysrv.ddns.net:4222";
  public string BridgeHost { get; set; } = "0.0.0.0";
  public string BridgePort { get; set; } = "4100";
  public string BridgeToken { get; set; } = "octop-local-bridge";
  public string DeviceName { get; set; } = GetCurrentDeviceName();
  public string OwnerLoginId { get; set; } = GetCurrentUserLogin();
  public string WorkspaceRootsText { get; set; } = GetDefaultWorkspaceRoot();
  public string AppServerMode { get; set; } = "ws-local";
  public string AppServerWsUrl { get; set; } = "ws://127.0.0.1:4600";
  public string CodexModel { get; set; } = "gpt-5.4";
  public string CodexReasoningEffort { get; set; } = "high";
  public string CodexApprovalPolicy { get; set; } = "never";
  public string CodexSandbox { get; set; } = "workspace-write";
  public string WatchdogIntervalMs { get; set; } = "15000";
  public string StaleMs { get; set; } = "120000";
  public string ExtraEnvironmentText { get; set; } = string.Empty;
  public bool AutoStartAtLogin { get; set; } = true;
  public bool AutoUpdateEnabled { get; set; } = true;
  public CodexAuthMode AuthMode { get; set; } = CodexAuthMode.ChatGptDeviceAuth;
  public IEnumerable<string> GetWorkspaceRoots()
  {
    return WorkspaceRootsText
      .Split(["\r\n", "\n", ";"], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
      .Where(static value => !string.IsNullOrWhiteSpace(value));
  }

  public Dictionary<string, string> GetEnvironmentVariables(OctopPaths paths)
  {
    var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
      ["OCTOP_NATS_URL"] = NatsUrl.Trim(),
      ["OCTOP_BRIDGE_HOST"] = BridgeHost.Trim(),
      ["OCTOP_BRIDGE_PORT"] = BridgePort.Trim(),
      ["OCTOP_BRIDGE_TOKEN"] = BridgeToken.Trim(),
      ["OCTOP_BRIDGE_ID"] = paths.ResolveOrCreateBridgeId(),
      ["OCTOP_BRIDGE_DEVICE_NAME"] = DeviceName.Trim(),
      ["OCTOP_BRIDGE_OWNER_LOGIN_ID"] = OwnerLoginId.Trim(),
      ["OCTOP_BRIDGE_OWNER_USER_ID"] = OwnerLoginId.Trim(),
      ["OCTOP_APP_SERVER_MODE"] = AppServerMode.Trim(),
      ["OCTOP_APP_SERVER_WS_URL"] = AppServerWsUrl.Trim(),
      ["OCTOP_CODEX_MODEL"] = CodexModel.Trim(),
      ["OCTOP_CODEX_REASONING_EFFORT"] = CodexReasoningEffort.Trim(),
      ["OCTOP_CODEX_APPROVAL_POLICY"] = CodexApprovalPolicy.Trim(),
      ["OCTOP_CODEX_SANDBOX"] = CodexSandbox.Trim(),
      ["OCTOP_RUNNING_ISSUE_WATCHDOG_INTERVAL_MS"] = WatchdogIntervalMs.Trim(),
      ["OCTOP_RUNNING_ISSUE_STALE_MS"] = StaleMs.Trim(),
      ["OCTOP_STATE_HOME"] = paths.StateHome,
      ["CODEX_HOME"] = paths.CodexHome
    };

    var workspaceRoots = string.Join(",", GetWorkspaceRoots().Select(Path.GetFullPath));
    if (!string.IsNullOrWhiteSpace(workspaceRoots))
    {
      env["OCTOP_WORKSPACE_ROOTS"] = workspaceRoots;
    }

    foreach (var line in ExtraEnvironmentText.Split(["\r\n", "\n"], StringSplitOptions.RemoveEmptyEntries))
    {
      var trimmed = line.Trim();
      if (trimmed.Length == 0 || trimmed.StartsWith('#'))
      {
        continue;
      }

      var separatorIndex = trimmed.IndexOf('=');
      if (separatorIndex <= 0)
      {
        continue;
      }

      var key = trimmed[..separatorIndex].Trim();
      var value = trimmed[(separatorIndex + 1)..].Trim();
      if (key.Length > 0)
      {
        env[key] = value;
      }
    }

    return env;
  }

  public void Normalize()
  {
    if (string.IsNullOrWhiteSpace(InstallRoot))
    {
      InstallRoot = OctopPaths.GetDefaultInstallRoot();
    }

    if (string.IsNullOrWhiteSpace(DeviceName))
    {
      DeviceName = GetCurrentDeviceName();
    }

    var firstWorkspaceRoot = GetWorkspaceRoots().FirstOrDefault();
    WorkspaceRootsText = string.IsNullOrWhiteSpace(firstWorkspaceRoot) ? GetDefaultWorkspaceRoot() : firstWorkspaceRoot;

    if (string.IsNullOrWhiteSpace(AppServerMode))
    {
      AppServerMode = "ws-local";
    }

    if (string.IsNullOrWhiteSpace(WatchdogIntervalMs))
    {
      WatchdogIntervalMs = "15000";
    }

    if (string.IsNullOrWhiteSpace(StaleMs))
    {
      StaleMs = "120000";
    }

    AuthMode = CodexAuthMode.ChatGptDeviceAuth;
  }
}

sealed class RuntimeStatus
{
  public bool RuntimeBundlePresent { get; init; }
  public bool ConfigurationSaved { get; init; }
  public bool RuntimeVersionMatches { get; init; }
  public string RuntimeVersion { get; init; } = "unknown";
  public bool NodeInstalled { get; init; }
  public string? NodeVersion { get; init; }
  public bool RuntimeDependenciesInstalled { get; init; }
  public bool CodexInstalled { get; init; }
  public bool CodexLoggedIn { get; init; }
  public string CodexLoginStatus { get; init; } = "확인 전";
  public bool AutoStartRequested { get; init; }
  public bool AutoStartConfigured { get; init; }
  public bool ReadyToRun =>
    RuntimeBundlePresent &&
    ConfigurationSaved &&
    RuntimeVersionMatches &&
    NodeInstalled &&
    RuntimeDependenciesInstalled &&
    CodexInstalled &&
    CodexLoggedIn &&
    (!AutoStartRequested || AutoStartConfigured);

  public string GetSummary()
  {
    var parts = new List<string>
    {
      RuntimeBundlePresent ? "런타임 준비됨" : "런타임 없음",
      ConfigurationSaved ? "설정 저장됨" : "설정 없음",
      RuntimeVersionMatches ? $"런타임 버전 {RuntimeVersion}" : "런타임 업데이트 필요",
      NodeInstalled ? $"Node {NodeVersion ?? "설치됨"}" : "Node 없음",
      RuntimeDependenciesInstalled ? "bridge 의존성 설치됨" : "bridge 의존성 없음",
      CodexInstalled ? "Codex 설치됨" : "Codex 없음",
      $"로그인: {CodexLoginStatus}",
      AutoStartRequested
        ? (AutoStartConfigured ? "로그인 시 자동 실행 켜짐" : "로그인 시 자동 실행 설정 필요")
        : "로그인 시 자동 실행 꺼짐"
    };

    return string.Join(" · ", parts);
  }
}
