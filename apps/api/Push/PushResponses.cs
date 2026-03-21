namespace OctOP.Gateway;

public sealed class PushConfigResponse
{
  public bool Enabled { get; set; }

  public string Provider { get; set; } = PushProviderKind.WebPush;

  public IReadOnlyList<string> Providers { get; set; } = [];

  public string PublicVapidKey { get; set; } = string.Empty;

  public string AppId { get; set; } = string.Empty;

  public string BridgeId { get; set; } = string.Empty;

  public int SubscriptionCount { get; set; }

  public PushTemplateSnapshot Templates { get; set; } = new();
}

public sealed class PushSubscriptionSummaryResponse
{
  public bool Enabled { get; set; }

  public string Provider { get; set; } = PushProviderKind.WebPush;

  public IReadOnlyList<string> Providers { get; set; } = [];

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

public sealed class PushTemplateSnapshot
{
  public string CompletedTitle { get; set; } = string.Empty;

  public string CompletedBody { get; set; } = string.Empty;

  public string FailedTitle { get; set; } = string.Empty;

  public string FailedBody { get; set; } = string.Empty;

  public string DefaultTitle { get; set; } = string.Empty;

  public string DefaultBody { get; set; } = string.Empty;

  public string CompletedTag { get; set; } = string.Empty;

  public string FailedTag { get; set; } = string.Empty;

  public string DashboardUrl { get; set; } = string.Empty;

  public string MobileUrl { get; set; } = string.Empty;

  public string AndroidWatchUrl { get; set; } = string.Empty;

  public string AppleWatchUrl { get; set; } = string.Empty;
}
