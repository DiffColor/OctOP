namespace OctOP.Gateway;

public sealed class PushConfigResponse
{
  public bool Enabled { get; set; }

  public string PublicVapidKey { get; set; } = string.Empty;

  public string AppId { get; set; } = string.Empty;

  public string BridgeId { get; set; } = string.Empty;

  public int SubscriptionCount { get; set; }
}

public sealed class PushSubscriptionSummaryResponse
{
  public bool Enabled { get; set; }

  public int Count { get; set; }

  public IReadOnlyList<string> Endpoints { get; set; } = [];
}

public sealed class PushSendResultItem
{
  public string Endpoint { get; set; } = string.Empty;

  public bool Ok { get; set; }

  public int? StatusCode { get; set; }

  public string? Message { get; set; }
}

public sealed class PushSendResponse
{
  public bool Ok { get; set; }

  public int SuccessCount { get; set; }

  public int FailureCount { get; set; }

  public IReadOnlyList<PushSendResultItem> Results { get; set; } = [];
}
