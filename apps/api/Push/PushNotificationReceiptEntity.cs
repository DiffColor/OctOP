using Newtonsoft.Json;

namespace OctOP.Gateway;

public sealed class PushNotificationReceiptEntity
{
  [JsonProperty("id")]
  public string Id { get; set; } = string.Empty;

  [JsonProperty("login_id")]
  public string LoginId { get; set; } = string.Empty;

  [JsonProperty("user_id")]
  public string UserId { get; set; } = string.Empty;

  [JsonProperty("bridge_id")]
  public string BridgeId { get; set; } = string.Empty;

  [JsonProperty("issue_id")]
  public string IssueId { get; set; } = string.Empty;

  [JsonProperty("thread_id")]
  public string ThreadId { get; set; } = string.Empty;

  [JsonProperty("project_id")]
  public string ProjectId { get; set; } = string.Empty;

  [JsonProperty("issue_status")]
  public string IssueStatus { get; set; } = string.Empty;

  [JsonProperty("event_type")]
  public string EventType { get; set; } = string.Empty;

  [JsonProperty("success_count")]
  public int SuccessCount { get; set; }

  [JsonProperty("failure_count")]
  public int FailureCount { get; set; }

  [JsonProperty("created_at")]
  public string CreatedAt { get; set; } = DateTimeOffset.UtcNow.ToString("O");
}
