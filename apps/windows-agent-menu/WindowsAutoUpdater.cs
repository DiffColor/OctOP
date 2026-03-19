using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;

sealed class WindowsAutoUpdater
{
  private readonly GitHubTagUpdateClient _releaseClient = new();

  public async Task<bool> TryApplyUpdateAsync(Action<string> log, CancellationToken cancellationToken)
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
    var scriptPath = Path.Combine(updateRoot, "apply-update.cmd");

    log($"새 버전 {latestRelease.Tag}를 다운로드합니다.");
    await DownloadAsync(latestRelease.DownloadUrl, downloadPath, cancellationToken);
    WriteUpdateScript(scriptPath, downloadPath, currentExecutablePath);

    Process.Start(new ProcessStartInfo
    {
      FileName = "cmd.exe",
      Arguments = $"/c start \"\" \"{scriptPath}\"",
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

  private static void WriteUpdateScript(string scriptPath, string downloadedExecutablePath, string currentExecutablePath)
  {
    var script = $$"""
    @echo off
    setlocal
    set "SOURCE={{downloadedExecutablePath}}"
    set "TARGET={{currentExecutablePath}}"
    :retry
    copy /Y "%SOURCE%" "%TARGET%" >nul
    if errorlevel 1 (
      timeout /t 1 /nobreak >nul
      goto retry
    )
    start "" "%TARGET%"
    del /Q "%SOURCE%" >nul 2>nul
    del /Q "%~f0" >nul 2>nul
    """;

    File.WriteAllText(scriptPath, script.Replace("\n", Environment.NewLine), new UTF8Encoding(false));
  }
}
