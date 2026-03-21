namespace OctOP.Gateway;

public static class PushProviderKind
{
  public const string WebPush = "webpush";
  public const string Fcm = "fcm";
  public const string Apns = "apns";

  public static string ResolveForApp(string? appId, string? requestedProvider = null)
  {
    return PushNotificationTemplateService.NormalizeAppId(appId) switch
    {
      PushNotificationTemplateService.DashboardAppId => WebPush,
      PushNotificationTemplateService.MobileAppId => WebPush,
      PushNotificationTemplateService.AndroidWatchAppId => Fcm,
      PushNotificationTemplateService.AppleWatchAppId => Apns,
      _ => Normalize(requestedProvider)
    };
  }

  public static string Normalize(string? value)
  {
    var normalized = value?.Trim().ToLowerInvariant();

    return normalized switch
    {
      Fcm => Fcm,
      Apns => Apns,
      _ => WebPush
    };
  }
}
