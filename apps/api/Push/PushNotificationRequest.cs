using System.Text.Json.Serialization;

namespace OctOP.Gateway;

public sealed class PushNotificationRequest
{
  [JsonPropertyName("title")]
  public string Title { get; set; } = string.Empty;

  [JsonPropertyName("body")]
  public string Body { get; set; } = string.Empty;

  [JsonPropertyName("url")]
  public string Url { get; set; } = "/";

  [JsonPropertyName("tag")]
  public string? Tag { get; set; }

  [JsonPropertyName("kind")]
  public string? Kind { get; set; }

  [JsonPropertyName("bridgeId")]
  public string? BridgeId { get; set; }

  [JsonPropertyName("projectId")]
  public string? ProjectId { get; set; }

  [JsonPropertyName("threadId")]
  public string? ThreadId { get; set; }

  [JsonPropertyName("issueId")]
  public string? IssueId { get; set; }

  [JsonPropertyName("issueStatus")]
  public string? IssueStatus { get; set; }

  [JsonPropertyName("projectName")]
  public string? ProjectName { get; set; }

  [JsonPropertyName("sourceAppId")]
  public string? SourceAppId { get; set; }

  [JsonPropertyName("targetAppId")]
  public string? TargetAppId { get; set; }
}
