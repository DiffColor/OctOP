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
      var payload = JsonSerializer.Serialize(new
      {
        title = request.Title,
        body = request.Body,
        tag = notificationTag,
        url = string.IsNullOrWhiteSpace(request.Url) ? "/" : request.Url,
        kind = request.Kind,
        bridgeId = request.BridgeId,
        projectId = request.ProjectId,
        threadId = request.ThreadId,
        issueId = request.IssueId,
        issueStatus = request.IssueStatus,
        sourceAppId = request.SourceAppId,
        targetAppId = request.TargetAppId,
        sentAt = sentAt.ToString("O")
      });
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
        var shouldDelete = exception.StatusCode is HttpStatusCode.Gone or HttpStatusCode.NotFound;
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
}
