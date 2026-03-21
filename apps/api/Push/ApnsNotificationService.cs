using System.Text;
using System.Text.Json;

namespace OctOP.Gateway;

public sealed class ApnsNotificationService(
  PushSubscriptionService pushSubscriptionService,
  ApnsJwtTokenService apnsJwtTokenService,
  IHttpClientFactory httpClientFactory,
  ILogger<ApnsNotificationService> logger)
{
  public async Task<PushSendResponse> SendAsync(
    IReadOnlyList<PushSubscriptionEntity> subscriptions,
    Func<PushSubscriptionEntity, PushNotificationRequest?> requestFactory,
    CancellationToken cancellationToken)
  {
    if (!apnsJwtTokenService.IsConfigured)
    {
      return CreateUnavailableResponse("APNs가 설정되지 않았습니다.");
    }

    if (subscriptions.Count == 0)
    {
      return CreateUnavailableResponse("전송할 APNs 구독이 없습니다.");
    }

    var jwt = await apnsJwtTokenService.GetTokenAsync(cancellationToken);
    var host = apnsJwtTokenService.UseSandbox ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
    var results = new List<PushSendResultItem>(subscriptions.Count);

    foreach (var subscription in subscriptions)
    {
      var request = requestFactory(subscription);

      if (request is null)
      {
        continue;
      }

      var topic = string.IsNullOrWhiteSpace(subscription.ApnsTopic)
        ? apnsJwtTokenService.DefaultTopic
        : subscription.ApnsTopic.Trim();

      if (string.IsNullOrWhiteSpace(topic))
      {
        results.Add(new PushSendResultItem
        {
          Endpoint = subscription.Endpoint,
          Ok = false,
          StatusCode = 500,
          Message = "APNs topic 이 비어 있습니다."
        });
        continue;
      }

      try
      {
        using var httpRequest = new HttpRequestMessage(HttpMethod.Post, $"{host}/3/device/{subscription.Endpoint}");
        httpRequest.Headers.Authorization =
          new System.Net.Http.Headers.AuthenticationHeaderValue("bearer", jwt);
        httpRequest.Headers.TryAddWithoutValidation("apns-topic", topic);
        httpRequest.Headers.TryAddWithoutValidation("apns-push-type", "alert");
        httpRequest.Headers.TryAddWithoutValidation("apns-priority", "10");
        httpRequest.Content = new StringContent(JsonSerializer.Serialize(BuildPayload(request)), Encoding.UTF8, "application/json");

        using var response = await httpClientFactory.CreateClient().SendAsync(httpRequest, cancellationToken);
        var content = await response.Content.ReadAsStringAsync(cancellationToken);

        if (response.IsSuccessStatusCode)
        {
          await pushSubscriptionService.MarkSuccessAsync(subscription.Id, cancellationToken);
          results.Add(new PushSendResultItem
          {
            Endpoint = subscription.Endpoint,
            Ok = true
          });
          continue;
        }

        var shouldDeactivate = content.Contains("Unregistered", StringComparison.OrdinalIgnoreCase) ||
          content.Contains("BadDeviceToken", StringComparison.OrdinalIgnoreCase) ||
          content.Contains("DeviceTokenNotForTopic", StringComparison.OrdinalIgnoreCase);
        await pushSubscriptionService.MarkFailureAsync(
          subscription.Id,
          subscription.Endpoint,
          content,
          shouldDeactivate,
          cancellationToken);
        results.Add(new PushSendResultItem
        {
          Endpoint = subscription.Endpoint,
          Ok = false,
          StatusCode = (int)response.StatusCode,
          Message = content
        });
      }
      catch (Exception exception)
      {
        logger.LogWarning(exception, "APNs delivery failed for {SubscriptionId}", subscription.Id);
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

    return BuildResponse(results);
  }

  private static object BuildPayload(PushNotificationRequest request)
  {
    return new Dictionary<string, object?>
    {
      ["aps"] = new Dictionary<string, object?>
      {
        ["alert"] = new Dictionary<string, object?>
        {
          ["title"] = request.Title,
          ["body"] = request.Body
        },
        ["sound"] = "default",
        ["thread-id"] = request.Tag ?? "octop"
      },
      ["launchUrl"] = request.Url ?? "/",
      ["tag"] = request.Tag,
      ["kind"] = request.Kind,
      ["bridgeId"] = request.BridgeId,
      ["projectId"] = request.ProjectId,
      ["threadId"] = request.ThreadId,
      ["issueId"] = request.IssueId,
      ["issueStatus"] = request.IssueStatus,
      ["projectName"] = request.ProjectName,
      ["sourceAppId"] = request.SourceAppId,
      ["targetAppId"] = request.TargetAppId
    };
  }

  private static PushSendResponse CreateUnavailableResponse(string message)
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
          Message = message
        }
      ]
    };
  }

  private static PushSendResponse BuildResponse(IReadOnlyList<PushSendResultItem> results)
  {
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
