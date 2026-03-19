using System.Text.Json.Serialization;

namespace OctOP.Gateway;

public sealed class PushSubscriptionDeleteRequest
{
  [JsonPropertyName("endpoint")]
  public string Endpoint { get; set; } = string.Empty;
}
