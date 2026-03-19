using System.Net;
using System.Text.Json;
using Lib.Net.Http.WebPush;

namespace OctOP.Gateway;

public sealed class WebPushNotificationService(
  PushSubscriptionService pushSubscriptionService,
  PushServiceClient pushServiceClient,
  VapidKeyService vapidKeyService,
  ILogger<WebPushNotificationService> logger)
{
  public async Task<PushSendResponse> SendAsync(
    IReadOnlyList<PushSubscriptionEntity> subscriptions,
    PushNotificationRequest request,
    CancellationToken cancellationToken)
  {
    return await SendAsync(subscriptions, (_) => request, cancellationToken);
  }

  public async Task<PushSendResponse> SendAsync(
    IReadOnlyList<PushSubscriptionEntity> subscriptions,
    Func<PushSubscriptionEntity, PushNotificationRequest?> requestFactory,
    CancellationToken cancellationToken)
  {
    if (!vapidKeyService.IsConfigured)
    {
      return new PushSendResponse
      {
        Ok = false,
        Results =
        [
          new PushSendResultItem
          {
            Endpoint = string.Empty,
            Ok = false,
            Message = "push vapid keys are not configured"
          }
        ]
      };
    }

    if (subscriptions.Count == 0)
    {
      return new PushSendResponse
      {
        Ok = false,
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

    var authentication = vapidKeyService.CreateAuthentication();
    var results = new List<PushSendResultItem>(subscriptions.Count);

    foreach (var subscription in subscriptions)
    {
      var request = requestFactory(subscription);

      if (request is null)
      {
        continue;
      }

      var sentAt = DateTimeOffset.UtcNow;
      var notificationTag = string.IsNullOrWhiteSpace(request.Tag)
        ? $"octop-push-{sentAt.ToUnixTimeMilliseconds()}"
        : request.Tag.Trim();
      var payload = JsonSerializer.Serialize(BuildPayload(subscription, request, notificationTag, sentAt));
      var target = new PushSubscription
      {
        Endpoint = subscription.Endpoint
      };
      target.SetKey(PushEncryptionKeyName.P256DH, subscription.P256dh);
      target.SetKey(PushEncryptionKeyName.Auth, subscription.Auth);

      try
      {
        var message = new PushMessage(payload)
        {
          Topic = notificationTag,
          TimeToLive = 60,
          Urgency = PushMessageUrgency.High
        };

        await pushServiceClient.RequestPushMessageDeliveryAsync(
          target,
          message,
          authentication,
          cancellationToken);

        await pushSubscriptionService.MarkSuccessAsync(subscription.Id, cancellationToken);
        results.Add(new PushSendResultItem
        {
          Endpoint = subscription.Endpoint,
          Ok = true
        });
      }
      catch (PushServiceClientException exception)
      {
        var shouldDelete = ShouldDeactivateSubscription(exception);

        if (shouldDelete)
        {
          logger.LogInformation(
            "Push subscription will be deleted after provider rejection. subscription={SubscriptionId}, status={StatusCode}",
            subscription.Id,
            (int)exception.StatusCode);
        }

        await pushSubscriptionService.MarkFailureAsync(
          subscription.Id,
          subscription.Endpoint,
          exception.Body ?? exception.Message,
          shouldDelete,
          cancellationToken);
        results.Add(new PushSendResultItem
        {
          Endpoint = subscription.Endpoint,
          Ok = false,
          StatusCode = (int)exception.StatusCode,
          Message = exception.Body ?? exception.Message
        });
      }
      catch (Exception exception)
      {
        logger.LogWarning(exception, "Push delivery failed for {SubscriptionId}", subscription.Id);
        await pushSubscriptionService.MarkFailureAsync(
          subscription.Id,
          subscription.Endpoint,
          exception.Message,
          deactivate: false,
          cancellationToken);
        results.Add(new PushSendResultItem
        {
          Endpoint = subscription.Endpoint,
          Ok = false,
          StatusCode = 500,
          Message = exception.Message
        });
      }
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

  private static bool ShouldDeactivateSubscription(PushServiceClientException exception)
  {
    if (exception.StatusCode is HttpStatusCode.Gone or HttpStatusCode.NotFound)
    {
      return true;
    }

    if (exception.StatusCode is not HttpStatusCode.Forbidden)
    {
      return false;
    }

    var message = $"{exception.Body}\n{exception.Message}".ToLowerInvariant();
    return message.Contains("vapid") && (
      message.Contains("do not correspond") ||
      message.Contains("used to create the subscriptions") ||
      message.Contains("authorization header")
    );
  }

  private static Dictionary<string, object?> BuildPayload(
    PushSubscriptionEntity subscription,
    PushNotificationRequest request,
    string notificationTag,
    DateTimeOffset sentAt)
  {
    var payload = new Dictionary<string, object?>(StringComparer.Ordinal)
    {
      ["title"] = request.Title,
      ["body"] = request.Body,
      ["tag"] = notificationTag,
      ["kind"] = request.Kind,
      ["bridgeId"] = request.BridgeId,
      ["projectId"] = request.ProjectId,
      ["threadId"] = request.ThreadId,
      ["issueId"] = request.IssueId,
      ["issueStatus"] = request.IssueStatus,
      ["sourceAppId"] = request.SourceAppId,
      ["targetAppId"] = request.TargetAppId,
      ["sentAt"] = sentAt.ToString("O")
    };

    // iOS/standalone PWA notifications may surface URL-like payload fields as noisy system text.
    // Mobile web can reconstruct its deep link from the issue metadata, so omit the raw URL there.
    if (!string.Equals(subscription.AppId, PushNotificationTemplateService.MobileAppId, StringComparison.Ordinal))
    {
      payload["launchUrl"] = string.IsNullOrWhiteSpace(request.Url) ? "/" : request.Url;
    }

    return payload;
  }
}
