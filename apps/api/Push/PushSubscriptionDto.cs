using System.Text.Json.Serialization;

namespace OctOP.Gateway;

public sealed class PushSubscriptionDto
{
  [JsonPropertyName("endpoint")]
  public string Endpoint { get; set; } = string.Empty;

  [JsonPropertyName("clientMode")]
  public string? ClientMode { get; set; }

  [JsonPropertyName("expirationTime")]
  public long? ExpirationTime { get; set; }

  [JsonPropertyName("keys")]
  public PushSubscriptionKeysDto Keys { get; set; } = new();
}

public sealed class PushSubscriptionKeysDto
{
  [JsonPropertyName("p256dh")]
  public string P256dh { get; set; } = string.Empty;

  [JsonPropertyName("auth")]
  public string Auth { get; set; } = string.Empty;
}
