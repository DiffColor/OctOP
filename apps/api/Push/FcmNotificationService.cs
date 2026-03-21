using System.Text;
using System.Text.Json;

namespace OctOP.Gateway;

public sealed class FcmNotificationService(
  PushSubscriptionService pushSubscriptionService,
  FcmAccessTokenService fcmAccessTokenService,
  IHttpClientFactory httpClientFactory,
  ILogger<FcmNotificationService> logger)
{
  public async Task<PushSendResponse> SendAsync(
    IReadOnlyList<PushSubscriptionEntity> subscriptions,
    Func<PushSubscriptionEntity, PushNotificationRequest?> requestFactory,
    CancellationToken cancellationToken)
  {
    if (!fcmAccessTokenService.IsConfigured)
    {
      return CreateUnavailableResponse("FCM이 설정되지 않았습니다.");
    }

    if (subscriptions.Count == 0)
    {
      return CreateUnavailableResponse("전송할 FCM 구독이 없습니다.");
    }

    var accessToken = await fcmAccessTokenService.GetAccessTokenAsync(cancellationToken);
    var projectId = fcmAccessTokenService.ProjectId;
    var results = new List<PushSendResultItem>(subscriptions.Count);

    foreach (var subscription in subscriptions)
    {
      var request = requestFactory(subscription);

      if (request is null)
      {
        continue;
      }

      var token = string.IsNullOrWhiteSpace(subscription.DeviceToken) ? subscription.Endpoint : subscription.DeviceToken;

      try
      {
        using var httpRequest = new HttpRequestMessage(
          HttpMethod.Post,
          $"https://fcm.googleapis.com/v1/projects/{projectId}/messages:send");
        httpRequest.Headers.Authorization =
          new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", accessToken);
        httpRequest.Content = new StringContent(
          JsonSerializer.Serialize(BuildRequest(token ?? string.Empty, request)),
          Encoding.UTF8,
          "application/json");

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

        var shouldDeactivate = content.Contains("UNREGISTERED", StringComparison.OrdinalIgnoreCase) ||
          content.Contains("registration-token-not-registered", StringComparison.OrdinalIgnoreCase);
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
        logger.LogWarning(exception, "FCM delivery failed for {SubscriptionId}", subscription.Id);
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

  private static object BuildRequest(string token, PushNotificationRequest request)
  {
    return new
    {
      message = new
      {
        token,
        notification = new
        {
          title = request.Title,
          body = request.Body
        },
        data = BuildData(request),
        android = new
        {
          priority = "HIGH"
        }
      }
    };
  }

  private static Dictionary<string, string> BuildData(PushNotificationRequest request)
  {
    var values = new Dictionary<string, string>(StringComparer.Ordinal)
    {
      ["title"] = request.Title,
      ["body"] = request.Body,
      ["launchUrl"] = request.Url ?? "/"
    };

    Append(values, "tag", request.Tag);
    Append(values, "kind", request.Kind);
    Append(values, "bridgeId", request.BridgeId);
    Append(values, "projectId", request.ProjectId);
    Append(values, "threadId", request.ThreadId);
    Append(values, "issueId", request.IssueId);
    Append(values, "issueStatus", request.IssueStatus);
    Append(values, "projectName", request.ProjectName);
    Append(values, "sourceAppId", request.SourceAppId);
    Append(values, "targetAppId", request.TargetAppId);
    return values;
  }

  private static void Append(IDictionary<string, string> values, string key, string? value)
  {
    if (!string.IsNullOrWhiteSpace(value))
    {
      values[key] = value.Trim();
    }
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
