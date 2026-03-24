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
}
