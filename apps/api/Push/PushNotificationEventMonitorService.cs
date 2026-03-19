using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Newtonsoft.Json.Linq;

namespace OctOP.Gateway;

public sealed class PushNotificationEventMonitorService(
  BridgeNatsClient bridgeNatsClient,
  PushSubscriptionService pushSubscriptionService,
  WebPushNotificationService webPushNotificationService,
  VapidKeyService vapidKeyService,
  ILogger<PushNotificationEventMonitorService> logger) : BackgroundService
{
  private readonly ConcurrentDictionary<string, byte> _inFlightReceiptIds = new(StringComparer.Ordinal);

  protected override async Task ExecuteAsync(CancellationToken stoppingToken)
  {
    if (!vapidKeyService.IsConfigured)
    {
      logger.LogInformation("Push notification worker is disabled because VAPID keys are not configured.");

      try
      {
        await Task.Delay(Timeout.InfiniteTimeSpan, stoppingToken);
      }
      catch (OperationCanceledException)
      {
      }

      return;
    }

    using var subscription = bridgeNatsClient.Subscribe("octop.user.*.bridge.*.events", (_, args) =>
    {
      var raw = BridgeNatsClient.Decode(args.Message);
      _ = Task.Run(() => ProcessEventAsync(raw, stoppingToken), CancellationToken.None);
    });

    logger.LogInformation("Push notification worker subscribed to OctOP bridge events.");

    try
    {
      await Task.Delay(Timeout.InfiniteTimeSpan, stoppingToken);
    }
    catch (OperationCanceledException)
    {
    }
  }

  private async Task ProcessEventAsync(string raw, CancellationToken cancellationToken)
  {
    PushEventEnvelope? envelope;

    try
    {
      envelope = JsonSerializer.Deserialize<PushEventEnvelope>(raw, new JsonSerializerOptions
      {
        PropertyNameCaseInsensitive = true
      });
    }
    catch (Exception exception)
    {
      logger.LogDebug(exception, "Push event parse skipped.");
      return;
    }

    if (!string.Equals(envelope?.Type, "turn.completed", StringComparison.Ordinal))
    {
      return;
    }

    var userId = Convert.ToString(envelope.ResolvedLoginId ?? envelope.ResolvedUserId ?? string.Empty)?.Trim() ?? string.Empty;
    var bridgeId = Convert.ToString(envelope.ResolvedBridgeId ?? string.Empty)?.Trim() ?? string.Empty;
    var issueId = Convert.ToString(envelope.Payload?.ResolvedIssueId ?? string.Empty)?.Trim() ?? string.Empty;
    var threadId = Convert.ToString(envelope.Payload?.ResolvedThreadId ?? string.Empty)?.Trim() ?? string.Empty;
    var projectId = Convert.ToString(envelope.Payload?.ResolvedProjectId ?? string.Empty)?.Trim() ?? string.Empty;
    var issueStatus = Convert.ToString(envelope.Payload?.Turn?.Status ?? string.Empty)?.Trim().ToLowerInvariant() ?? string.Empty;

    if (
      string.IsNullOrWhiteSpace(userId) ||
      string.IsNullOrWhiteSpace(bridgeId) ||
      string.IsNullOrWhiteSpace(issueId) ||
      (issueStatus != "completed" && issueStatus != "failed"))
    {
      return;
    }

    var receiptId = PushSubscriptionService.CreateReceiptId(userId, bridgeId, issueId, issueStatus);

    if (!_inFlightReceiptIds.TryAdd(receiptId, (byte)0))
    {
      return;
    }

    try
    {
      if (await pushSubscriptionService.GetReceiptAsync(receiptId, cancellationToken) is not null)
      {
        return;
      }

      var subscriptions = await pushSubscriptionService.GetActiveSubscriptionsAsync(userId, bridgeId, cancellationToken);

      if (subscriptions.Count == 0)
      {
        return;
      }

      var issueSnapshot = await pushSubscriptionService.GetIssueSnapshotAsync(userId, bridgeId, issueId, cancellationToken);
      var resolvedProjectId = issueSnapshot?.Value<string>("project_id") ?? projectId;
      var projectSnapshot = !string.IsNullOrWhiteSpace(resolvedProjectId)
        ? await pushSubscriptionService.GetProjectSnapshotAsync(userId, bridgeId, resolvedProjectId, cancellationToken)
        : null;
      var issueTitle = issueSnapshot?.Value<string>("title") ?? issueId;
      var projectName = projectSnapshot?.Value<string>("name");
      var notification = BuildNotificationRequest(
        bridgeId,
        resolvedProjectId,
        threadId,
        issueId,
        issueStatus,
        issueTitle,
        projectName);
      var response = await webPushNotificationService.SendAsync(subscriptions, notification, cancellationToken);

      if (response.SuccessCount <= 0)
      {
        logger.LogInformation(
          "Push notification skipped receipt commit because no delivery succeeded. user={UserId}, bridge={BridgeId}, issue={IssueId}, status={IssueStatus}",
          userId,
          bridgeId,
          issueId,
          issueStatus);
        return;
      }

      await pushSubscriptionService.UpsertReceiptAsync(
        new PushNotificationReceiptEntity
        {
          Id = receiptId,
          LoginId = userId,
          UserId = userId,
          BridgeId = bridgeId,
          IssueId = issueId,
          ThreadId = threadId,
          ProjectId = resolvedProjectId,
          IssueStatus = issueStatus,
          EventType = envelope.Type ?? "turn.completed",
          SuccessCount = response.SuccessCount,
          FailureCount = response.FailureCount,
          CreatedAt = DateTimeOffset.UtcNow.ToString("O")
        },
        cancellationToken);
    }
    catch (OperationCanceledException)
    {
    }
    catch (Exception exception)
    {
      logger.LogError(
        exception,
        "Push notification worker failed. type={Type}",
        envelope?.Type ?? "unknown");
    }
    finally
    {
      _inFlightReceiptIds.TryRemove(receiptId, out _);
    }
  }

  private static PushNotificationRequest BuildNotificationRequest(
    string bridgeId,
    string? projectId,
    string? threadId,
    string issueId,
    string issueStatus,
    string issueTitle,
    string? projectName)
  {
    var statusLabel = issueStatus == "completed" ? "완료" : "실패";
    var title = string.IsNullOrWhiteSpace(projectName)
      ? $"OctOP 이슈 {statusLabel}"
      : $"{projectName} · 이슈 {statusLabel}";
    var body = string.IsNullOrWhiteSpace(issueTitle)
      ? $"이슈 {issueId} 가 {statusLabel} 상태가 되었습니다."
      : $"{issueTitle} 이(가) {statusLabel} 상태가 되었습니다.";

    return new PushNotificationRequest
    {
      Title = title,
      Body = body,
      Url = "/",
      Tag = $"issue-{issueId}-{issueStatus}",
      Kind = "issue-terminal",
      BridgeId = bridgeId,
      ProjectId = projectId,
      ThreadId = threadId,
      IssueId = issueId,
      IssueStatus = issueStatus
    };
  }

  private sealed class PushEventEnvelope
  {
    public string? UserId { get; set; }

    public string? User_id { get; set; }

    public string? LoginId { get; set; }

    public string? Login_id { get; set; }

    public string? BridgeId { get; set; }

    public string? Bridge_id { get; set; }

    public string? Type { get; set; }

    public PushEventPayload? Payload { get; set; }

    public string? ResolvedUserId => UserId ?? User_id;

    public string? ResolvedLoginId => LoginId ?? Login_id;

    public string? ResolvedBridgeId => BridgeId ?? Bridge_id;
  }

  private sealed class PushEventPayload
  {
    public string? ThreadId { get; set; }

    public string? Thread_id { get; set; }

    public string? ProjectId { get; set; }

    public string? Project_id { get; set; }

    public string? IssueId { get; set; }

    public string? Issue_id { get; set; }

    public PushTurnPayload? Turn { get; set; }

    public string? ResolvedThreadId => ThreadId ?? Thread_id;

    public string? ResolvedProjectId => ProjectId ?? Project_id;

    public string? ResolvedIssueId => IssueId ?? Issue_id;
  }

  private sealed class PushTurnPayload
  {
    public string? Status { get; set; }
  }
}
