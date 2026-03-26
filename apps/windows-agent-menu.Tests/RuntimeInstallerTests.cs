using System.Diagnostics;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace OctOP.WindowsAgentMenu.Tests;

public sealed class RuntimeInstallerTests
{
  private static void CleanupRuntimePath(string path)
  {
    try
    {
      if (Directory.Exists(path))
      {
        Directory.Delete(path, recursive: true);
      }
    }
    catch
    {
    }
  }

  private static void RestoreEnvironmentVariable(string name, string? originalValue)
  {
    Environment.SetEnvironmentVariable(name, originalValue);
  }

  private static void CreateFakeRuntimeRepository(string repositoryRoot)
  {
    Directory.CreateDirectory(Path.Combine(repositoryRoot, "services", "codex-adapter", "src"));
    File.WriteAllText(
      Path.Combine(repositoryRoot, "services", "codex-adapter", "package.json"),
      """
      {
        "name": "codex-adapter",
        "private": true,
        "type": "module",
        "version": "1.0.0"
      }
      """);
    File.WriteAllText(
      Path.Combine(repositoryRoot, "services", "codex-adapter", "package-lock.json"),
      """
      {
        "name": "codex-adapter",
        "lockfileVersion": 3,
        "requires": true,
        "packages": {
          "": {
            "name": "codex-adapter",
            "version": "1.0.0"
          }
        }
      }
      """);
    File.WriteAllText(
      Path.Combine(repositoryRoot, "services", "codex-adapter", "src", "index.js"),
      "export const runtime = 'test';\n");
    File.WriteAllText(
      Path.Combine(repositoryRoot, "services", "codex-adapter", "src", "domain.js"),
      "export const domain = 'seed';\n");
    File.WriteAllText(Path.Combine(repositoryRoot, "README.md"), "seed\n");
  }

  private static string RunGit(string repositoryRoot, params string[] arguments)
  {
    var startInfo = new ProcessStartInfo
    {
      FileName = "git",
      WorkingDirectory = repositoryRoot,
      UseShellExecute = false,
      RedirectStandardOutput = true,
      RedirectStandardError = true,
      CreateNoWindow = true
    };

    foreach (var argument in arguments)
    {
      startInfo.ArgumentList.Add(argument);
    }

    using var process = Process.Start(startInfo);
    Assert.NotNull(process);
    var standardOutput = process!.StandardOutput.ReadToEnd();
    var standardError = process.StandardError.ReadToEnd();
    process.WaitForExit();
    Assert.True(
      process.ExitCode == 0,
      $"git command failed: {string.Join(" ", arguments)}\nstdout:\n{standardOutput}\nstderr:\n{standardError}");
    return standardOutput.Trim();
  }

  private static string InitializeGitRepository(string repositoryRoot, string message = "seed codex adapter")
  {
    RunGit(repositoryRoot, "init");
    RunGit(repositoryRoot, "config", "user.name", "OctOP Tests");
    RunGit(repositoryRoot, "config", "user.email", "octop-tests@example.com");
    RunGit(repositoryRoot, "add", ".");
    RunGit(repositoryRoot, "commit", "-m", message);
    return RunGit(repositoryRoot, "rev-parse", "HEAD");
  }

  private static void RenameGitBranch(string repositoryRoot, string branchName)
  {
    RunGit(repositoryRoot, "branch", "-M", branchName);
  }

  private static string RecreateGitRepository(string repositoryRoot, string message = "rewrite codex adapter history")
  {
    var gitDirectory = Path.Combine(repositoryRoot, ".git");
    if (Directory.Exists(gitDirectory))
    {
      Directory.Delete(gitDirectory, recursive: true);
    }

    return InitializeGitRepository(repositoryRoot, message);
  }

  [Fact]
  public void ActivateRuntimeRelease_UpdatesCurrentAndPreviousPointers()
  {
    var root = Path.Combine(Path.GetTempPath(), $"octop-win-agent-runtime-installer-{Guid.NewGuid():N}");
    try
    {
      var paths = new OctopPaths(root);
      Directory.CreateDirectory(paths.RuntimeReleasesRoot);

      var firstReleaseRoot = paths.GetRuntimeReleaseRoot("runtime-a");
      var secondReleaseRoot = paths.GetRuntimeReleaseRoot("runtime-b");
      Directory.CreateDirectory(firstReleaseRoot);
      Directory.CreateDirectory(secondReleaseRoot);

      var installer = new RuntimeInstaller();
      var buildInfo = new RuntimeReleaseBuildInfo
      {
        RuntimeId = "runtime-a",
        SourceHash = "source-a",
        ConfigurationHash = "config-a",
        SourceRevision = "source-rev-a",
        SourceContentRevision = "source-content-a",
        AppVersion = "test-version",
        CreatedAt = DateTimeOffset.UtcNow
      };
      installer.ActivateRuntimeRelease(paths, new PreparedRuntimeRelease
      {
        RuntimeId = "runtime-a",
        ReleaseRoot = firstReleaseRoot,
        BuildInfo = buildInfo
      });

      Assert.Equal("runtime-a", paths.ReadCurrentRuntimeReleaseId());
      Assert.Null(paths.ReadPreviousRuntimeReleaseId());

      installer.ActivateRuntimeRelease(paths, new PreparedRuntimeRelease
      {
        RuntimeId = "runtime-b",
        ReleaseRoot = secondReleaseRoot,
        BuildInfo = buildInfo
      });

      Assert.Equal("runtime-b", paths.ReadCurrentRuntimeReleaseId());
      Assert.Equal("runtime-a", paths.ReadPreviousRuntimeReleaseId());

      installer.ActivateRuntimeRelease(paths, new PreparedRuntimeRelease
      {
        RuntimeId = "runtime-b",
        ReleaseRoot = secondReleaseRoot,
        BuildInfo = buildInfo
      });

      Assert.Equal("runtime-b", paths.ReadCurrentRuntimeReleaseId());
      Assert.Equal("runtime-a", paths.ReadPreviousRuntimeReleaseId());
    }
    finally
    {
      CleanupRuntimePath(root);
    }
  }

  [Fact]
  public void CleanupStaleRuntimeReleases_PreservesCurrentPreviousAndRecentReleases()
  {
    var root = Path.Combine(Path.GetTempPath(), $"octop-win-agent-cleanup-{Guid.NewGuid():N}");
    try
    {
      var paths = new OctopPaths(root);
      Directory.CreateDirectory(paths.RuntimeReleasesRoot);

      var created = DateTime.UtcNow.AddHours(-10);
      for (var i = 0; i < 6; i++)
      {
        var releaseRoot = paths.GetRuntimeReleaseRoot($"runtime-{i}");
        Directory.CreateDirectory(releaseRoot);
        Directory.SetLastWriteTimeUtc(releaseRoot, created.AddHours(i));
        File.WriteAllText(Path.Combine(releaseRoot, "build-info.json"), JsonSerializer.Serialize(new RuntimeReleaseBuildInfo
        {
          RuntimeId = $"runtime-{i}",
          SourceHash = $"source-{i}",
          ConfigurationHash = $"config-{i}",
          SourceRevision = $"rev-{i}",
          SourceContentRevision = $"content-{i}",
          AppVersion = "test",
          CreatedAt = DateTimeOffset.UtcNow
        }));
      }

      File.WriteAllText(paths.RuntimeCurrentPointerPath, "runtime-5");
      File.WriteAllText(paths.RuntimePreviousPointerPath, "runtime-1");

      var installer = new RuntimeInstaller();
      installer.CleanupStaleRuntimeReleases(paths, retentionLimit: 3);

      var remaining = Directory.GetDirectories(paths.RuntimeReleasesRoot)
        .Select(Path.GetFileName)
        .ToList();

      Assert.Contains("runtime-5", remaining);
      Assert.Contains("runtime-1", remaining);
      Assert.Contains("runtime-4", remaining);
      Assert.Contains("runtime-3", remaining);
      Assert.DoesNotContain("runtime-0", remaining);
      Assert.DoesNotContain("runtime-2", remaining);
    }
    finally
    {
      CleanupRuntimePath(root);
    }
  }

  [Fact]
  public void LoadRuntimeBuildInfo_ReturnsNullIfMissingAndParsesValid()
  {
    var root = Path.Combine(Path.GetTempPath(), $"octop-win-agent-build-info-{Guid.NewGuid():N}");
    try
    {
      var paths = new OctopPaths(root);
      Directory.CreateDirectory(paths.RuntimeReleasesRoot);
      var releaseRoot = paths.GetRuntimeReleaseRoot("runtime-a");
      Directory.CreateDirectory(releaseRoot);

      var installer = new RuntimeInstaller();
      Assert.Null(installer.LoadRuntimeBuildInfo(releaseRoot));

      var expectedBuildInfo = new RuntimeReleaseBuildInfo
      {
        RuntimeId = "runtime-a",
        SourceHash = "source-a",
        ConfigurationHash = "config-a",
        SourceRevision = "source-rev-a",
        SourceContentRevision = "source-content-a",
        AppVersion = "test-version",
        CreatedAt = DateTimeOffset.UtcNow
      };
      File.WriteAllText(Path.Combine(releaseRoot, "build-info.json"), JsonSerializer.Serialize(expectedBuildInfo));

      var loaded = installer.LoadRuntimeBuildInfo(releaseRoot);
      Assert.NotNull(loaded);
      Assert.Equal(expectedBuildInfo.RuntimeId, loaded?.RuntimeId);
      Assert.Equal(expectedBuildInfo.SourceRevision, loaded?.SourceRevision);
    }
    finally
    {
      CleanupRuntimePath(root);
    }
  }

  [Fact]
  public void GetEnvironmentVariables_AddsDangerousBypassFlagToAppServerCommandWhenConfigured()
  {
    var root = Path.Combine(Path.GetTempPath(), $"octop-win-agent-env-{Guid.NewGuid():N}");
    try
    {
      var paths = new OctopPaths(root);
      var configuration = new RuntimeConfiguration
      {
        InstallRoot = root,
        CodexSandbox = RuntimeConfiguration.DangerouslyBypassApprovalsAndSandbox,
        AppServerWsUrl = "ws://127.0.0.1:4610"
      };

      var env = configuration.GetEnvironmentVariables(paths);

      Assert.Equal(RuntimeConfiguration.DangerouslyBypassApprovalsAndSandbox, env["OCTOP_CODEX_SANDBOX"]);
      Assert.Contains("--dangerously-bypass-approvals-and-sandbox app-server --listen", env["OCTOP_APP_SERVER_COMMAND"]);
      Assert.Contains("\"ws://127.0.0.1:4610\"", env["OCTOP_APP_SERVER_COMMAND"]);
    }
    finally
    {
      CleanupRuntimePath(root);
    }
  }

  [Fact]
  public async Task ResolveAvailableRuntimeUpdateAsync_FollowsRewrittenRemoteBranchAfterNonFastForwardRewrite()
  {
    var root = Path.Combine(Path.GetTempPath(), $"octop-win-agent-runtime-update-{Guid.NewGuid():N}");
    var remoteRepositoryRoot = Path.Combine(root, "remote-repo");
    var installRoot = Path.Combine(root, "install");
    var originalRepoUrl = Environment.GetEnvironmentVariable("OCTOP_WINDOWS_RUNTIME_REPO_URL");
    var originalRepoBranch = Environment.GetEnvironmentVariable("OCTOP_WINDOWS_RUNTIME_REPO_BRANCH");

    try
    {
      Directory.CreateDirectory(remoteRepositoryRoot);
      CreateFakeRuntimeRepository(remoteRepositoryRoot);
      var initialRevision = InitializeGitRepository(remoteRepositoryRoot);
      RenameGitBranch(remoteRepositoryRoot, "main");

      Environment.SetEnvironmentVariable("OCTOP_WINDOWS_RUNTIME_REPO_URL", remoteRepositoryRoot);
      Environment.SetEnvironmentVariable("OCTOP_WINDOWS_RUNTIME_REPO_BRANCH", "main");

      var installer = new RuntimeInstaller();
      var paths = new OctopPaths(installRoot);

      var initialUpdate = await installer.ResolveAvailableRuntimeUpdateAsync(paths, CancellationToken.None);
      Assert.Equal(initialRevision, initialUpdate?.SourceRevision);

      File.WriteAllText(
        Path.Combine(remoteRepositoryRoot, "services", "codex-adapter", "src", "domain.js"),
        "export const domain = 'rewritten-history';\n");
      var rewrittenRevision = RecreateGitRepository(remoteRepositoryRoot);
      RenameGitBranch(remoteRepositoryRoot, "main");

      var rewrittenUpdate = await installer.ResolveAvailableRuntimeUpdateAsync(paths, CancellationToken.None);

      Assert.NotEqual(initialRevision, rewrittenRevision);
      Assert.Equal(rewrittenRevision, rewrittenUpdate?.SourceRevision);
    }
    finally
    {
      RestoreEnvironmentVariable("OCTOP_WINDOWS_RUNTIME_REPO_URL", originalRepoUrl);
      RestoreEnvironmentVariable("OCTOP_WINDOWS_RUNTIME_REPO_BRANCH", originalRepoBranch);
      CleanupRuntimePath(root);
    }
  }
}
