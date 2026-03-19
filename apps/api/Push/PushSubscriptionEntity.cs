using Newtonsoft.Json;

namespace OctOP.Gateway;

public sealed class PushSubscriptionEntity
{
  [JsonProperty("id")]
  public string Id { get; set; } = string.Empty;

  [JsonProperty("login_id")]
  public string LoginId { get; set; } = string.Empty;

  [JsonProperty("user_id")]
  public string UserId { get; set; } = string.Empty;

  [JsonProperty("bridge_id")]
  public string BridgeId { get; set; } = string.Empty;

  [JsonProperty("app_id")]
  public string AppId { get; set; } = string.Empty;

  [JsonProperty("endpoint")]
  public string Endpoint { get; set; } = string.Empty;

  [JsonProperty("origin")]
  public string Origin { get; set; } = string.Empty;

  [JsonProperty("user_agent")]
  public string? UserAgent { get; set; }

  [JsonProperty("client_mode")]
  public string? ClientMode { get; set; }

  [JsonProperty("p256dh")]
  public string P256dh { get; set; } = string.Empty;

  [JsonProperty("auth")]
  public string Auth { get; set; } = string.Empty;

  [JsonProperty("is_active")]
  public bool IsActive { get; set; } = true;

  [JsonProperty("created_at")]
  public string CreatedAt { get; set; } = DateTimeOffset.UtcNow.ToString("O");

  [JsonProperty("updated_at")]
  public string UpdatedAt { get; set; } = DateTimeOffset.UtcNow.ToString("O");

  [JsonProperty("last_success_at")]
  public string? LastSuccessAt { get; set; }

  [JsonProperty("last_failure_at")]
  public string? LastFailureAt { get; set; }

  [JsonProperty("last_failure_message")]
  public string? LastFailureMessage { get; set; }
}
