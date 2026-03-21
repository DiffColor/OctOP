namespace OctOP.Gateway;

public sealed class PushProviderConfigurationService(VapidKeyService vapidKeyService)
{
  public IReadOnlyList<string> GetConfiguredProviders()
  {
    var providers = new List<string>(3);

    if (vapidKeyService.IsConfigured)
    {
      providers.Add(PushProviderKind.WebPush);
    }

    if (IsFcmConfigured)
    {
      providers.Add(PushProviderKind.Fcm);
    }

    if (IsApnsConfigured)
    {
      providers.Add(PushProviderKind.Apns);
    }

    return providers;
  }

  public bool IsAnyConfigured => vapidKeyService.IsConfigured || IsFcmConfigured || IsApnsConfigured;

  public bool IsConfigured(string provider)
  {
    return PushProviderKind.Normalize(provider) switch
    {
      PushProviderKind.Fcm => IsFcmConfigured,
      PushProviderKind.Apns => IsApnsConfigured,
      _ => vapidKeyService.IsConfigured
    };
  }

  public bool IsFcmConfigured =>
    !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("OCTOP_PUSH_FCM_PROJECT_ID")) &&
    (
      !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("OCTOP_PUSH_FCM_SERVICE_ACCOUNT_JSON")) ||
      !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("OCTOP_PUSH_FCM_SERVICE_ACCOUNT_FILE"))
    );

  public bool IsApnsConfigured =>
    !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("OCTOP_PUSH_APNS_KEY_ID")) &&
    !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("OCTOP_PUSH_APNS_TEAM_ID")) &&
    (
      !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("OCTOP_PUSH_APNS_PRIVATE_KEY")) ||
      !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("OCTOP_PUSH_APNS_PRIVATE_KEY_FILE"))
    );
}
