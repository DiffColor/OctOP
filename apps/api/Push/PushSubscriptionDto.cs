using System.Text.Json.Serialization;

namespace OctOP.Gateway;

public sealed class PushSubscriptionDto
{
  [JsonPropertyName("provider")]
  public string? Provider { get; set; }

  [JsonPropertyName("endpoint")]
  public string Endpoint { get; set; } = string.Empty;

  [JsonPropertyName("deviceToken")]
  public string? DeviceToken { get; set; }

  [JsonPropertyName("deviceName")]
  public string? DeviceName { get; set; }

  [JsonPropertyName("installationId")]
  public string? InstallationId { get; set; }

  [JsonPropertyName("nativePlatform")]
  public string? NativePlatform { get; set; }

  [JsonPropertyName("packageName")]
  public string? PackageName { get; set; }

  [JsonPropertyName("apnsTopic")]
  public string? ApnsTopic { get; set; }

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
