using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;

sealed class WindowsAutoUpdater
{
  private readonly GitHubTagUpdateClient _releaseClient = new();

  public Task<AppUpdateDescriptor?> GetAvailableUpdateAsync(string currentVersionTag, CancellationToken cancellationToken)
  {
    return _releaseClient.GetLatestWindowsReleaseAsync(currentVersionTag, cancellationToken);
  }

  public async Task<bool> TryApplyUpdateAsync(
    AppUpdateDescriptor updateDescriptor,
    OctopPaths paths,
    RuntimeConfiguration configuration,
    Action<string> log,
    CancellationToken cancellationToken)
  {
    if (!AppMetadata.CanSelfUpdate() || AppMetadata.CurrentExecutablePath is not { } currentExecutablePath)
    {
      log("현재 실행 방식에서는 앱 업데이트를 적용할 수 없습니다.");
      return false;
    }

    var updateRoot = Path.Combine(Path.GetTempPath(), "OctOP.WindowsAgentMenu", "updates", updateDescriptor.Tag);
    Directory.CreateDirectory(updateRoot);

    var downloadPath = Path.Combine(updateRoot, updateDescriptor.AssetName);
    var scriptPath = Path.Combine(updateRoot, "apply-update.ps1");
    var logPath = Path.Combine(updateRoot, "apply-update.log");

    log($"새 앱 번들을 다운로드합니다. tag={updateDescriptor.Tag}");
    await DownloadAsync(updateDescriptor.DownloadUrl, downloadPath, cancellationToken);
    ValidateDownloadedExecutable(downloadPath);

    var pendingState = new PendingAppUpdateState
    {
      TargetTag = updateDescriptor.Tag,
      CurrentExecutablePath = currentExecutablePath,
      PreparedAt = DateTimeOffset.UtcNow
    };

    Directory.CreateDirectory(paths.InstallRoot);
    WritePendingAppUpdateState(paths, pendingState);
    if (File.Exists(paths.AppUpdateLaunchMarkerPath))
    {
      File.Delete(paths.AppUpdateLaunchMarkerPath);
    }

    WriteUpdateScript(
      scriptPath,
      logPath,
      downloadPath,
      currentExecutablePath,
      Environment.ProcessId,
      ResolveServicePorts(configuration));

    Process.Start(new ProcessStartInfo
    {
      FileName = "powershell.exe",
      Arguments = $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{scriptPath}\"",
      UseShellExecute = false,
      CreateNoWindow = true,
      WorkingDirectory = updateRoot
    });

    log($"앱 업데이트 적용을 시작합니다. target={updateDescriptor.Tag}");
    return true;
  }

  public void MarkPendingAppUpdateLaunchSucceededIfNeeded(OctopPaths paths, Action<string> log)
  {
    var pending = LoadPendingAppUpdateState(paths);
    if (pending is null ||
        pending.LaunchConfirmedAt is not null ||
        !string.Equals(
          Path.GetFullPath(pending.CurrentExecutablePath),
          Path.GetFullPath(AppMetadata.CurrentExecutablePath ?? string.Empty),
          StringComparison.OrdinalIgnoreCase))
    {
      return;
    }

    pending.LaunchConfirmedAt = DateTimeOffset.UtcNow;
    WritePendingAppUpdateState(paths, pending);
    File.WriteAllText(paths.AppUpdateLaunchMarkerPath, "ok", new UTF8Encoding(false));
    log("새 앱 기동 확인 마커를 기록했습니다.");
  }

  public void CleanupCompletedUpdateArtifactsIfNeeded(OctopPaths paths, Action<string> log)
  {
    var pending = LoadPendingAppUpdateState(paths);
    if (pending is not null && pending.LaunchConfirmedAt is null)
    {
      return;
    }

    var currentExecutablePath = AppMetadata.CurrentExecutablePath;
    if (!string.IsNullOrWhiteSpace(currentExecutablePath))
    {
      var backupExecutablePath = currentExecutablePath + ".previous-update";
      if (File.Exists(backupExecutablePath))
      {
        try
        {
          File.Delete(backupExecutablePath);
          log("이전 앱 실행 파일 백업을 정리했습니다.");
        }
        catch (Exception error)
        {
          log($"이전 앱 실행 파일 백업 정리 실패: {error.Message}");
        }
      }
    }

    try
    {
      if (File.Exists(paths.PendingAppUpdateStatePath))
      {
        File.Delete(paths.PendingAppUpdateStatePath);
      }

      if (File.Exists(paths.AppUpdateLaunchMarkerPath))
      {
        File.Delete(paths.AppUpdateLaunchMarkerPath);
      }
    }
    catch (Exception error)
    {
      log($"앱 업데이트 상태 정리 실패: {error.Message}");
    }
  }

  private static async Task DownloadAsync(Uri downloadUrl, string destinationPath, CancellationToken cancellationToken)
  {
    using var client = new HttpClient();
    client.DefaultRequestHeaders.UserAgent.ParseAdd("OctOPAgentMenu/1.0");
    await using var remoteStream = await client.GetStreamAsync(downloadUrl, cancellationToken);
    await using var fileStream = File.Create(destinationPath);
    await remoteStream.CopyToAsync(fileStream, cancellationToken);
  }

  private static void WritePendingAppUpdateState(OctopPaths paths, PendingAppUpdateState state)
  {
    var json = JsonSerializer.Serialize(state, new JsonSerializerOptions(JsonSerializerDefaults.Web)
    {
      WriteIndented = true
    });
    File.WriteAllText(paths.PendingAppUpdateStatePath, json, new UTF8Encoding(false));
  }

  private static PendingAppUpdateState? LoadPendingAppUpdateState(OctopPaths paths)
  {
    if (!File.Exists(paths.PendingAppUpdateStatePath))
    {
      return null;
    }

    return JsonSerializer.Deserialize<PendingAppUpdateState>(
      File.ReadAllText(paths.PendingAppUpdateStatePath, Encoding.UTF8),
      new JsonSerializerOptions(JsonSerializerDefaults.Web));
  }

  private static IReadOnlyList<int> ResolveServicePorts(RuntimeConfiguration configuration)
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

  private static void WriteUpdateScript(
    string scriptPath,
    string logPath,
    string downloadedExecutablePath,
    string currentExecutablePath,
    int currentProcessId,
    IReadOnlyList<int> servicePorts)
  {
    var portsLiteral = string.Join(",", servicePorts.OrderBy(static port => port));
    var script = $$"""
    $ErrorActionPreference = "Stop"
    $source = "{{EscapePowerShellSingleQuotedString(downloadedExecutablePath)}}"
    $target = "{{EscapePowerShellSingleQuotedString(currentExecutablePath)}}"
    $currentProcessId = {{currentProcessId}}
    $backup = "$target.previous-update"
    $updateRoot = Split-Path -Parent "{{EscapePowerShellSingleQuotedString(scriptPath)}}"
    $launchMarker = "{{EscapePowerShellSingleQuotedString(Path.Combine(Path.GetDirectoryName(currentExecutablePath) ?? string.Empty, "app-update-launch-confirmed"))}}"
    $ports = @({{portsLiteral}})

    function Write-Log {
      param([string]$Message)
      try {
        Add-Content -Path "{{EscapePowerShellSingleQuotedString(logPath)}}" -Value ("[" + (Get-Date).ToString("s") + "] " + $Message) -Encoding UTF8
      } catch {
      }
    }

    function Wait-ForPortsReleased {
      for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
        $listeners = @()
        if ($ports.Count -gt 0) {
          $listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort }
        }

        if ($listeners.Count -eq 0) {
          return $true
        }

        Start-Sleep -Seconds 1
      }

      return $false
    }

    try {
      while (Get-Process -Id $currentProcessId -ErrorAction SilentlyContinue) {
        Start-Sleep -Milliseconds 500
      }

      if (-not (Wait-ForPortsReleased)) {
        Write-Log("service ports did not close before update")
        exit 1
      }

      if (Test-Path $backup) {
        Remove-Item -Path $backup -Force -ErrorAction SilentlyContinue
      }

      if (Test-Path $target) {
        Move-Item -Path $target -Destination $backup -Force
      }

      Copy-Item -Path $source -Destination $target -Force
      Start-Process -FilePath $target -WindowStyle Hidden | Out-Null

      for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
        if (Test-Path $launchMarker) {
          Remove-Item -Path $backup -Force -ErrorAction SilentlyContinue
          $cleanupCommand = 'ping 127.0.0.1 -n 3 > nul & rmdir /s /q "' + $updateRoot + '"'
          Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", $cleanupCommand) -WindowStyle Hidden | Out-Null
          exit 0
        }

        Start-Sleep -Seconds 1
      }

      throw "new app launch confirmation was not observed"
    } catch {
      Write-Log("update failed: " + $_.Exception.Message)
      try {
        if (Test-Path $target) {
          Remove-Item -Path $target -Force -ErrorAction SilentlyContinue
        }

        if (Test-Path $backup) {
          Move-Item -Path $backup -Destination $target -Force
        }

        if (Test-Path $target) {
          Start-Process -FilePath $target -WindowStyle Hidden | Out-Null
        }
      } catch {
        Write-Log("rollback failed: " + $_.Exception.Message)
      }
    }
    """;

    File.WriteAllText(scriptPath, script.Replace("\n", Environment.NewLine), new UTF8Encoding(false));
  }

  private static string EscapePowerShellSingleQuotedString(string value)
  {
    return value.Replace("'", "''");
  }

  private static void ValidateDownloadedExecutable(string executablePath)
  {
    var fileInfo = new FileInfo(executablePath);
    if (!fileInfo.Exists || fileInfo.Length < 2)
    {
      throw new InvalidOperationException("다운로드한 실행 파일이 비어 있습니다.");
    }

    using var stream = File.OpenRead(executablePath);
    var header = new byte[2];
    if (stream.Read(header, 0, header.Length) != header.Length ||
        header[0] != (byte)'M' ||
        header[1] != (byte)'Z')
    {
      throw new InvalidOperationException("다운로드한 파일이 유효한 Windows 실행 파일이 아닙니다.");
    }
  }
}
