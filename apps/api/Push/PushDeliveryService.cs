namespace OctOP.Gateway;

public sealed class PushDeliveryService(
  PushProviderConfigurationService pushProviderConfigurationService,
  WebPushNotificationService webPushNotificationService,
  FcmNotificationService fcmNotificationService,
  ApnsNotificationService apnsNotificationService)
{
  public bool IsAnyProviderConfigured => pushProviderConfigurationService.IsAnyConfigured;

  public bool IsProviderConfigured(string provider) => pushProviderConfigurationService.IsConfigured(provider);

  public IReadOnlyList<string> GetConfiguredProviders() => pushProviderConfigurationService.GetConfiguredProviders();

  public async Task<PushSendResponse> SendAsync(
    IReadOnlyList<PushSubscriptionEntity> subscriptions,
    Func<PushSubscriptionEntity, PushNotificationRequest?> requestFactory,
    CancellationToken cancellationToken)
  {
    if (subscriptions.Count == 0)
    {
      return new PushSendResponse
      {
        Ok = false,
        FailureCount = 1,
        Results =
        [
          new PushSendResultItem
          {
            Endpoint = string.Empty,
            Ok = false,
            Message = "전송할 푸시 구독이 없습니다."
          }
        ]
      };
    }

    var results = new List<PushSendResultItem>();

    foreach (var group in subscriptions.GroupBy(subscription => PushProviderKind.Normalize(subscription.Provider)))
    {
      PushSendResponse response = group.Key switch
      {
        PushProviderKind.Fcm => await fcmNotificationService.SendAsync(group.ToList(), requestFactory, cancellationToken),
        PushProviderKind.Apns => await apnsNotificationService.SendAsync(group.ToList(), requestFactory, cancellationToken),
        _ => await webPushNotificationService.SendAsync(group.ToList(), requestFactory, cancellationToken)
      };

      results.AddRange(response.Results);
    }

    var successCount = results.Count(result => result.Ok);
    return new PushSendResponse
    {
      Ok = successCount > 0,
      SuccessCount = successCount,
      FailureCount = results.Count - successCount,
      Results = results
    };
  }
}
