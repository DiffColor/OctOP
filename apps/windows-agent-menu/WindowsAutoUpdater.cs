using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;

sealed class WindowsAutoUpdater
{
  private readonly GitHubTagUpdateClient _releaseClient = new();

  public async Task<bool> TryApplyUpdateAsync(Action<string> log, CancellationToken cancellationToken, Func<bool>? beforeReplacement = null)
  {
    var currentTag = AppMetadata.CurrentVersionTag;
    if (!SemVersion.TryParse(currentTag, out var currentVersion))
    {
      log($"현재 앱 버전을 해석하지 못했습니다: {currentTag}");
      return false;
    }

    ReleaseDescriptor? latestRelease;
    try
    {
      latestRelease = await _releaseClient.GetLatestWindowsReleaseAsync(cancellationToken);
    }
    catch (Exception error)
    {
      log($"업데이트 확인 실패: {error.Message}");
      return false;
    }

    if (latestRelease is null || !SemVersion.TryParse(latestRelease.Tag, out var latestVersion))
    {
      return false;
    }

    if (latestVersion.CompareTo(currentVersion) <= 0)
    {
      log($"최신 앱 버전 사용 중: {AppMetadata.CurrentVersionDisplay}");
      return false;
    }

    if (!AppMetadata.CanSelfUpdate() || AppMetadata.CurrentExecutablePath is not { } currentExecutablePath)
    {
      log($"새 버전 {latestRelease.Tag}를 확인했지만 현재 실행 방식에서는 앱 본체 자동 업데이트를 적용할 수 없습니다.");
      return false;
    }

    var updateRoot = Path.Combine(Path.GetTempPath(), "OctOPAgentMenu", "updates", latestRelease.Tag);
    Directory.CreateDirectory(updateRoot);
    var downloadPath = Path.Combine(updateRoot, latestRelease.AssetName);
    var scriptPath = Path.Combine(updateRoot, "apply-update.ps1");

    log($"새 버전 {latestRelease.Tag}를 다운로드합니다.");
    await DownloadAsync(latestRelease.DownloadUrl, downloadPath, cancellationToken);
    WriteUpdateScript(scriptPath, downloadPath, currentExecutablePath, Environment.ProcessId);
    if (beforeReplacement is not null && !beforeReplacement())
    {
      log("로그인 정보와 상태 데이터 백업에 실패해 앱 업데이트를 중단합니다.");
      return false;
    }

    Process.Start(new ProcessStartInfo
    {
      FileName = "powershell.exe",
      Arguments =
        $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{scriptPath}\"",
      UseShellExecute = false,
      CreateNoWindow = true,
      WorkingDirectory = updateRoot
    });

    log($"새 버전 {latestRelease.Tag} 적용을 시작합니다.");
    return true;
  }

  private static async Task DownloadAsync(Uri downloadUrl, string destinationPath, CancellationToken cancellationToken)
  {
    using var client = new HttpClient();
    client.DefaultRequestHeaders.UserAgent.ParseAdd("OctOPAgentMenu/1.0");
    await using var remoteStream = await client.GetStreamAsync(downloadUrl, cancellationToken);
    await using var fileStream = File.Create(destinationPath);
    await remoteStream.CopyToAsync(fileStream, cancellationToken);
  }

  private static void WriteUpdateScript(
    string scriptPath,
    string downloadedExecutablePath,
    string currentExecutablePath,
    int currentProcessId)
  {
    var script = $$"""
    $ErrorActionPreference = "Stop"
    $source = "{{EscapePowerShellSingleQuotedString(downloadedExecutablePath)}}"
    $target = "{{EscapePowerShellSingleQuotedString(currentExecutablePath)}}"
    $currentProcessId = {{currentProcessId}}
    $scriptPath = $MyInvocation.MyCommand.Path
    $updateRoot = Split-Path -Parent $scriptPath
    $backup = "$target.previous-update"
    $logPath = Join-Path $updateRoot "apply-update.log"
    $replaced = $false

    function Write-Log {
      param([string]$Message)
      try {
        Add-Content -Path $logPath -Value ("[" + (Get-Date).ToString("s") + "] " + $Message) -Encoding UTF8
      } catch {
      }
    }

    try {
      while (Get-Process -Id $currentProcessId -ErrorAction SilentlyContinue) {
        Start-Sleep -Milliseconds 500
      }

      Start-Sleep -Seconds 1

      for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
        try {
          if (Test-Path $backup) {
            Remove-Item -Path $backup -Recurse -Force -ErrorAction SilentlyContinue
          }

          if (Test-Path $target) {
            Move-Item -Path $target -Destination $backup -Force
          }

          Copy-Item -Path $source -Destination $target -Force
          $replaced = $true
          break
        } catch {
          Write-Log("replace attempt failed: " + $_.Exception.Message)
          try {
            if (Test-Path $target) {
              Remove-Item -Path $target -Force -ErrorAction SilentlyContinue
            }

            if (Test-Path $backup) {
              Move-Item -Path $backup -Destination $target -Force
            }
          } catch {
            Write-Log("rollback failed: " + $_.Exception.Message)
          }

          if ($attempt -ge 59) {
            break
          }

          Start-Sleep -Seconds 1
        }
      }

      if (-not $replaced) {
        Write-Log("app replacement failed; restored existing executable if possible")
        if (Test-Path $target) {
          Start-Process -FilePath $target -WindowStyle Hidden | Out-Null
        }
        exit 0
      }

      Start-Process -FilePath $target -WindowStyle Hidden | Out-Null

      try {
        if (Test-Path $backup) {
          Remove-Item -Path $backup -Force -ErrorAction SilentlyContinue
        }
      } catch {
      }

      try {
        $cleanupCommand = 'ping 127.0.0.1 -n 3 > nul & rmdir /s /q "' + $updateRoot + '"'
        Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", $cleanupCommand) -WindowStyle Hidden | Out-Null
      } catch {
      }
    } catch {
      Write-Log("update script failed unexpectedly: " + $_.Exception.Message)
      try {
        if (Test-Path $backup) {
          if (Test-Path $target) {
            Remove-Item -Path $target -Force -ErrorAction SilentlyContinue
          }
          Move-Item -Path $backup -Destination $target -Force
        }
        if (Test-Path $target) {
          Start-Process -FilePath $target -WindowStyle Hidden | Out-Null
        }
      } catch {
        Write-Log("final recovery failed: " + $_.Exception.Message)
      }
    }
    """;

    File.WriteAllText(scriptPath, script.Replace("\n", Environment.NewLine), new UTF8Encoding(false));
  }

  private static string EscapePowerShellSingleQuotedString(string value)
  {
    return value.Replace("'", "''");
  }
}
