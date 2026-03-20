using System.Text.Json.Serialization;

sealed class RuntimeReleaseBuildInfo
{
  [JsonPropertyName("runtimeID")]
  public string RuntimeId { get; init; } = string.Empty;

  [JsonPropertyName("sourceHash")]
  public string SourceHash { get; init; } = string.Empty;

  [JsonPropertyName("configurationHash")]
  public string ConfigurationHash { get; init; } = string.Empty;

  [JsonPropertyName("sourceRevision")]
  public string? SourceRevision { get; init; }

  [JsonPropertyName("sourceContentRevision")]
  public string SourceContentRevision { get; init; } = string.Empty;

  [JsonPropertyName("appVersion")]
  public string AppVersion { get; init; } = string.Empty;

  [JsonPropertyName("createdAt")]
  public DateTimeOffset CreatedAt { get; init; } = DateTimeOffset.UtcNow;
}

sealed class RuntimeUpdateDescriptor
{
  public string SourceRevision { get; init; } = string.Empty;
  public string SourceContentRevision { get; init; } = string.Empty;
  public string? CurrentSourceRevision { get; init; }
  public string? CurrentSourceContentRevision { get; init; }

  public string DisplayRevision => (string.IsNullOrWhiteSpace(SourceRevision) ? SourceContentRevision : SourceRevision)[..Math.Min(12, string.IsNullOrWhiteSpace(SourceRevision) ? SourceContentRevision.Length : SourceRevision.Length)];
}

sealed class PreparedRuntimeRelease
{
  public string RuntimeId { get; init; } = string.Empty;
  public string ReleaseRoot { get; init; } = string.Empty;
  public RuntimeReleaseBuildInfo BuildInfo { get; init; } = new();
  public bool ReusedExistingRelease { get; init; }
}

sealed class AppUpdateDescriptor
{
  public string Tag { get; init; } = string.Empty;
  public string AssetName { get; init; } = string.Empty;
  public Uri DownloadUrl { get; init; } = new("https://example.com");
}

sealed class PendingAppUpdateState
{
  public string TargetTag { get; init; } = string.Empty;
  public string CurrentExecutablePath { get; init; } = string.Empty;
  public DateTimeOffset PreparedAt { get; init; } = DateTimeOffset.UtcNow;
  public DateTimeOffset? LaunchConfirmedAt { get; set; }
}
