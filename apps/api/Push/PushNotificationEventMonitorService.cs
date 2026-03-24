using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Newtonsoft.Json.Linq;

namespace OctOP.Gateway;

public sealed class PushNotificationEventMonitorService(
  BridgeNatsClient bridgeNatsClient,
  PushSubscriptionService pushSubscriptionService,
  WebPushNotificationService webPushNotificationService,
  PushNotificationTemplateService pushNotificationTemplateService,
  VapidKeyService vapidKeyService,
  ILogger<PushNotificationEventMonitorService> logger) : BackgroundService
{
  private const string UntitledIssueTitle = "Untitled issue";
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

    var terminalEvent = ResolveTerminalIssueEvent(envelope);

    if (terminalEvent is null)
    {
      return;
    }

    var userId = terminalEvent.UserId;
    var bridgeId = terminalEvent.BridgeId;
    var issueId = terminalEvent.IssueId;
    var threadId = terminalEvent.ThreadId;
    var projectId = terminalEvent.ProjectId;
    var issueStatus = terminalEvent.IssueStatus;
    var eventType = terminalEvent.EventType;

    var receiptId = PushSubscriptionService.CreateReceiptId(userId, bridgeId, issueId, issueStatus);

    if (!_inFlightReceiptIds.TryAdd(receiptId, (byte)0))
    {
      return;
    }

    var createdAt = DateTimeOffset.UtcNow.ToString("O");
    var reservedReceipt = new PushNotificationReceiptEntity
    {
      Id = receiptId,
      LoginId = userId,
      UserId = userId,
      BridgeId = bridgeId,
      IssueId = issueId,
      ThreadId = threadId,
      ProjectId = projectId,
      IssueStatus = issueStatus,
      EventType = eventType,
      SuccessCount = 0,
      FailureCount = 0,
      CreatedAt = createdAt
    };
    var receiptCommitted = false;

    try
    {
      if (!await pushSubscriptionService.TryReserveReceiptAsync(reservedReceipt, cancellationToken))
      {
        return;
      }

      var subscriptions = await pushSubscriptionService.GetActiveSubscriptionsAsync(userId, bridgeId, cancellationToken);

      if (subscriptions.Count == 0)
      {
        await pushSubscriptionService.DeleteReceiptAsync(receiptId, cancellationToken);
        return;
      }

      var issueSnapshot = await pushSubscriptionService.GetIssueSnapshotAsync(userId, bridgeId, issueId, cancellationToken);
      var sourceIssueSnapshot = await pushSubscriptionService.GetSourceIssueSnapshotAsync(userId, bridgeId, issueId, cancellationToken);
      var resolvedProjectId = issueSnapshot?.Value<string>("project_id") ?? projectId;
      var projectSnapshot = !string.IsNullOrWhiteSpace(resolvedProjectId)
        ? await pushSubscriptionService.GetProjectSnapshotAsync(userId, bridgeId, resolvedProjectId, cancellationToken)
        : null;
      var sourceAppId = PushNotificationTemplateService.NormalizeAppId(
        issueSnapshot?.Value<string>("source_app_id") ?? sourceIssueSnapshot?.Value<string>("source_app_id"));
      var targetSubscriptions = subscriptions
        .Where((subscription) => PushNotificationTemplateService.ShouldDeliverToApp(sourceAppId, subscription.AppId))
        .ToList();

      if (targetSubscriptions.Count == 0)
      {
        await pushSubscriptionService.DeleteReceiptAsync(receiptId, cancellationToken);
        return;
      }

      var issueTitle = ResolveIssueTitle(issueSnapshot, sourceIssueSnapshot);
      var projectName = projectSnapshot?.Value<string>("name");
      var response = await webPushNotificationService.SendAsync(
        targetSubscriptions,
        (subscription) => pushNotificationTemplateService.BuildIssueTerminalNotification(
          bridgeId,
          resolvedProjectId,
          threadId,
          issueId,
          issueStatus,
          issueTitle,
          projectName,
          sourceAppId,
          subscription.AppId),
        cancellationToken);

      if (response.SuccessCount <= 0)
      {
        await pushSubscriptionService.DeleteReceiptAsync(receiptId, cancellationToken);
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
          EventType = eventType,
          SuccessCount = response.SuccessCount,
          FailureCount = response.FailureCount,
          CreatedAt = createdAt
        },
        cancellationToken);
      receiptCommitted = true;
    }
    catch (OperationCanceledException)
    {
      if (!receiptCommitted)
      {
        try
        {
          await pushSubscriptionService.DeleteReceiptAsync(receiptId, CancellationToken.None);
        }
        catch
        {
        }
      }
    }
    catch (Exception exception)
    {
      if (!receiptCommitted)
      {
        try
        {
          await pushSubscriptionService.DeleteReceiptAsync(receiptId, cancellationToken);
        }
        catch
        {
        }
      }

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

  private static string ResolveIssueTitle(JObject? issueSnapshot, JObject? sourceIssueSnapshot)
  {
    var title = issueSnapshot?.Value<string>("title");

    if (!string.IsNullOrWhiteSpace(title))
    {
      return title.Trim();
    }

    title = sourceIssueSnapshot?.Value<string>("title");

    if (!string.IsNullOrWhiteSpace(title))
    {
      return title.Trim();
    }

    return UntitledIssueTitle;
  }

  private static ResolvedTerminalIssueEvent? ResolveTerminalIssueEvent(PushEventEnvelope? envelope)
  {
    if (envelope is null)
    {
      return null;
    }

    var eventType = NormalizeLowerInvariantValue(envelope.Type);
    var userId = NormalizeTrimmedValue(envelope.ResolvedLoginId ?? envelope.ResolvedUserId);
    var bridgeId = NormalizeTrimmedValue(envelope.ResolvedBridgeId);
    var issueId = NormalizeTrimmedValue(envelope.Payload?.ResolvedIssueId);

    if (string.IsNullOrWhiteSpace(userId) || string.IsNullOrWhiteSpace(bridgeId) || string.IsNullOrWhiteSpace(issueId))
    {
      return null;
    }

    var issueStatus = ResolveTerminalIssueStatus(eventType, envelope.Payload);

    if (issueStatus is not ("completed" or "failed"))
    {
      return null;
    }

    return new ResolvedTerminalIssueEvent(
      userId,
      bridgeId,
      issueId,
      NormalizeTrimmedValue(envelope.Payload?.ResolvedThreadId),
      NormalizeTrimmedValue(envelope.Payload?.ResolvedProjectId),
      issueStatus,
      eventType);
  }

  private static string ResolveTerminalIssueStatus(string eventType, PushEventPayload? payload)
  {
    return eventType switch
    {
      "turn.completed" => NormalizeTerminalStatus(payload?.Turn?.Status),
      "turn.start.failed" => "failed",
      "thread.status.changed" when string.Equals(
        NormalizeLowerInvariantValue(payload?.Status?.Type),
        "error",
        StringComparison.Ordinal) => "failed",
      _ => string.Empty
    };
  }

  private static string NormalizeTerminalStatus(string? value)
  {
    var normalized = NormalizeLowerInvariantValue(value);
    return normalized is "completed" or "failed" ? normalized : string.Empty;
  }

  private static string NormalizeTrimmedValue(string? value)
  {
    return Convert.ToString(value ?? string.Empty)?.Trim() ?? string.Empty;
  }

  private static string NormalizeLowerInvariantValue(string? value)
  {
    return NormalizeTrimmedValue(value).ToLowerInvariant();
  }

  private sealed record ResolvedTerminalIssueEvent(
    string UserId,
    string BridgeId,
    string IssueId,
    string ThreadId,
    string ProjectId,
    string IssueStatus,
    string EventType);

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

    public PushThreadStatusPayload? Status { get; set; }

    public string? ResolvedThreadId => ThreadId ?? Thread_id;

    public string? ResolvedProjectId => ProjectId ?? Project_id;

    public string? ResolvedIssueId => IssueId ?? Issue_id;
  }

  private sealed class PushTurnPayload
  {
    public string? Status { get; set; }
  }

  private sealed class PushThreadStatusPayload
  {
    public string? Type { get; set; }
  }
}
