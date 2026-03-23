using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;

sealed class WindowsAutoUpdater
{
  private const int DownloadBufferSize = 1024 * 128;
  private const long DiskSafetyMarginBytes = 64L * 1024 * 1024;
  private static readonly TimeSpan UpdateCheckCacheDuration = TimeSpan.FromHours(6);
  private static readonly TimeSpan NoUpdateCheckCacheDuration = TimeSpan.FromMinutes(5);
  private static readonly TimeSpan DownloadProgressLogInterval = TimeSpan.FromSeconds(2);
  private static readonly TimeSpan DownloadStallTimeout = TimeSpan.FromMinutes(2);

  private readonly GitHubTagUpdateClient _releaseClient = new();
  private string? _cachedVersionTag;
  private DateTimeOffset? _cachedCheckedAt;
  private AppUpdateDescriptor? _cachedUpdate;

  public async Task<AppUpdateDescriptor?> GetAvailableUpdateAsync(
    string currentVersionTag,
    CancellationToken cancellationToken,
    bool force = false)
  {
    var normalizedVersionTag = AppMetadata.NormalizeVersionTag(currentVersionTag);
    var now = DateTimeOffset.UtcNow;
    var cacheDuration = _cachedUpdate is null ? NoUpdateCheckCacheDuration : UpdateCheckCacheDuration;

    if (!force &&
        _cachedCheckedAt is not null &&
        string.Equals(_cachedVersionTag, normalizedVersionTag, StringComparison.OrdinalIgnoreCase) &&
        now - _cachedCheckedAt.Value < cacheDuration)
    {
      return _cachedUpdate;
    }

    try
    {
      var availableUpdate = await _releaseClient.GetLatestWindowsReleaseAsync(normalizedVersionTag, cancellationToken);
      _cachedVersionTag = normalizedVersionTag;
      _cachedCheckedAt = now;
      _cachedUpdate = availableUpdate;
      return availableUpdate;
    }
    catch
    {
      if (_cachedCheckedAt is not null &&
          string.Equals(_cachedVersionTag, normalizedVersionTag, StringComparison.OrdinalIgnoreCase))
      {
        return _cachedUpdate;
      }

      throw;
    }
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
    await DownloadAsync(updateDescriptor.DownloadUrl, downloadPath, currentExecutablePath, log, cancellationToken);
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
      paths.AppUpdateLaunchMarkerPath,
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

  private static async Task DownloadAsync(
    Uri downloadUrl,
    string destinationPath,
    string currentExecutablePath,
    Action<string> log,
    CancellationToken cancellationToken)
  {
    Directory.CreateDirectory(Path.GetDirectoryName(destinationPath) ?? Path.GetTempPath());

    using var client = CreateDownloadHttpClient();
    using var response = await client.GetAsync(downloadUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
    response.EnsureSuccessStatusCode();

    var packageSizeBytes = response.Content.Headers.ContentLength;
    if (packageSizeBytes is not > 0)
    {
      throw new InvalidOperationException("다운로드 크기를 확인하지 못해 디스크 여유 공간을 검사할 수 없습니다.");
    }

    LogDiskSpaceCheck(destinationPath, currentExecutablePath, packageSizeBytes.Value, log);
    EnsureSufficientDiskSpace(destinationPath, currentExecutablePath, packageSizeBytes.Value);
    log($"앱 업데이트 다운로드를 시작합니다. 크기={FormatBytes(packageSizeBytes.Value)}");

    try
    {
      await using var remoteStream = await response.Content.ReadAsStreamAsync(cancellationToken);
      await using var fileStream = new FileStream(
        destinationPath,
        FileMode.Create,
        FileAccess.Write,
        FileShare.None,
        DownloadBufferSize,
        useAsync: true);

      var buffer = new byte[DownloadBufferSize];
      var stopwatch = Stopwatch.StartNew();
      var totalRead = 0L;
      var nextLogAt = DownloadProgressLogInterval;
      var nextLogPercent = 5d;

      using var stalledDownloadCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);

      while (true)
      {
        stalledDownloadCts.CancelAfter(DownloadStallTimeout);

        int bytesRead;
        try
        {
          bytesRead = await remoteStream.ReadAsync(buffer.AsMemory(0, buffer.Length), stalledDownloadCts.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
          throw new TimeoutException($"다운로드가 {DownloadStallTimeout.TotalMinutes:0}분 이상 진행되지 않아 중단했습니다.");
        }
        finally
        {
          stalledDownloadCts.CancelAfter(Timeout.InfiniteTimeSpan);
        }

        if (bytesRead == 0)
        {
          break;
        }

        await fileStream.WriteAsync(buffer.AsMemory(0, bytesRead), cancellationToken);
        totalRead += bytesRead;

        var progressPercent = totalRead * 100d / packageSizeBytes.Value;
        if (stopwatch.Elapsed >= nextLogAt || progressPercent >= nextLogPercent)
        {
          log(BuildDownloadProgressMessage(totalRead, packageSizeBytes.Value, stopwatch.Elapsed));
          while (nextLogAt <= stopwatch.Elapsed)
          {
            nextLogAt += DownloadProgressLogInterval;
          }

          while (nextLogPercent <= progressPercent)
          {
            nextLogPercent += 5d;
          }
        }
      }

      await fileStream.FlushAsync(cancellationToken);
      log(BuildDownloadProgressMessage(totalRead, packageSizeBytes.Value, stopwatch.Elapsed, completed: true));
    }
    catch
    {
      try
      {
        if (File.Exists(destinationPath))
        {
          File.Delete(destinationPath);
        }
      }
      catch
      {
      }

      throw;
    }
  }

  private static HttpClient CreateDownloadHttpClient()
  {
    var client = new HttpClient
    {
      Timeout = Timeout.InfiniteTimeSpan
    };
    client.DefaultRequestHeaders.UserAgent.ParseAdd("OctOPAgentMenu/1.0");
    return client;
  }

  private static void LogDiskSpaceCheck(string downloadPath, string currentExecutablePath, long packageSizeBytes, Action<string> log)
  {
    var downloadDrive = ResolveDriveInfo(downloadPath);
    var targetDrive = ResolveDriveInfo(currentExecutablePath);
    var requiredBytesByDrive = ResolveRequiredBytesByDrive(downloadDrive, targetDrive, packageSizeBytes);

    foreach (var requirement in requiredBytesByDrive.OrderBy(static item => item.Key.Name, StringComparer.OrdinalIgnoreCase))
    {
      log(
        $"디스크 여유 공간 확인: 드라이브={requirement.Key.Name}, 필요={FormatBytes(requirement.Value)}, 사용 가능={FormatBytes(requirement.Key.AvailableFreeSpace)}");
    }
  }

  private static void EnsureSufficientDiskSpace(string downloadPath, string currentExecutablePath, long packageSizeBytes)
  {
    var downloadDrive = ResolveDriveInfo(downloadPath);
    var targetDrive = ResolveDriveInfo(currentExecutablePath);
    var requiredBytesByDrive = ResolveRequiredBytesByDrive(downloadDrive, targetDrive, packageSizeBytes);

    foreach (var requirement in requiredBytesByDrive)
    {
      if (requirement.Key.AvailableFreeSpace < requirement.Value)
      {
        throw new InvalidOperationException(
          $"앱 업데이트를 위한 디스크 여유 공간이 부족합니다. 드라이브={requirement.Key.Name}, 필요={FormatBytes(requirement.Value)}, 사용 가능={FormatBytes(requirement.Key.AvailableFreeSpace)}");
      }
    }
  }

  private static Dictionary<DriveInfo, long> ResolveRequiredBytesByDrive(
    DriveInfo downloadDrive,
    DriveInfo targetDrive,
    long packageSizeBytes)
  {
    var requirements = new Dictionary<DriveInfo, long>(DriveInfoNameComparer.Instance);
    var downloadRequirement = packageSizeBytes + DiskSafetyMarginBytes;
    var targetRequirement = packageSizeBytes + DiskSafetyMarginBytes;

    AddRequiredBytes(requirements, downloadDrive, downloadRequirement);
    AddRequiredBytes(requirements, targetDrive, targetRequirement);

    return requirements;
  }

  private static void AddRequiredBytes(Dictionary<DriveInfo, long> requirements, DriveInfo drive, long bytes)
  {
    if (requirements.TryGetValue(drive, out var existingBytes))
    {
      requirements[drive] = existingBytes + bytes;
      return;
    }

    requirements[drive] = bytes;
  }

  private static DriveInfo ResolveDriveInfo(string path)
  {
    var fullPath = Path.GetFullPath(path);
    var rootPath = Path.GetPathRoot(fullPath);
    if (string.IsNullOrWhiteSpace(rootPath))
    {
      throw new InvalidOperationException($"드라이브 경로를 확인하지 못했습니다: {path}");
    }

    return new DriveInfo(rootPath);
  }

  private static string BuildDownloadProgressMessage(long downloadedBytes, long totalBytes, TimeSpan elapsed, bool completed = false)
  {
    var progressPercent = totalBytes <= 0 ? 0d : downloadedBytes * 100d / totalBytes;
    var bytesPerSecond = elapsed.TotalSeconds > 0
      ? downloadedBytes / elapsed.TotalSeconds
      : 0d;

    if (completed)
    {
      return $"앱 업데이트 다운로드 완료: 100.0% ({FormatBytes(downloadedBytes)} / {FormatBytes(totalBytes)}, 평균 속도 {FormatBytes(bytesPerSecond)}/s)";
    }

    var remainingBytes = Math.Max(0, totalBytes - downloadedBytes);
    var eta = bytesPerSecond > 0
      ? TimeSpan.FromSeconds(remainingBytes / bytesPerSecond)
      : (TimeSpan?)null;

    return eta is TimeSpan remaining
      ? $"앱 업데이트 다운로드 진행률: {progressPercent:0.0}% ({FormatBytes(downloadedBytes)} / {FormatBytes(totalBytes)}, {FormatBytes(bytesPerSecond)}/s, 남은 {FormatDuration(remaining)})"
      : $"앱 업데이트 다운로드 진행률: {progressPercent:0.0}% ({FormatBytes(downloadedBytes)} / {FormatBytes(totalBytes)}, {FormatBytes(bytesPerSecond)}/s)";
  }

  private static string FormatBytes(double bytes)
  {
    string[] units = ["B", "KB", "MB", "GB", "TB"];
    var value = Math.Max(0d, bytes);
    var unitIndex = 0;
    while (value >= 1024d && unitIndex < units.Length - 1)
    {
      value /= 1024d;
      unitIndex += 1;
    }

    return $"{value:0.0} {units[unitIndex]}";
  }

  private static string FormatDuration(TimeSpan duration)
  {
    if (duration.TotalHours >= 1)
    {
      return $"{(int)duration.TotalHours}시간 {duration.Minutes}분";
    }

    if (duration.TotalMinutes >= 1)
    {
      return $"{duration.Minutes}분 {duration.Seconds}초";
    }

    return $"{Math.Max(1, duration.Seconds)}초";
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
    string launchMarkerPath,
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
    $launchMarker = "{{EscapePowerShellSingleQuotedString(launchMarkerPath)}}"
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

sealed class DriveInfoNameComparer : IEqualityComparer<DriveInfo>
{
  public static DriveInfoNameComparer Instance { get; } = new();

  public bool Equals(DriveInfo? x, DriveInfo? y)
  {
    return string.Equals(x?.Name, y?.Name, StringComparison.OrdinalIgnoreCase);
  }

  public int GetHashCode(DriveInfo obj)
  {
    return StringComparer.OrdinalIgnoreCase.GetHashCode(obj.Name);
  }
}
