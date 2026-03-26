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
  private static readonly TimeSpan[] IdleSnapshotResolutionRetryDelays =
  [
    TimeSpan.Zero,
    TimeSpan.FromMilliseconds(150),
    TimeSpan.FromMilliseconds(350)
  ];
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
    var eventType = terminalEvent.EventType;
    string? receiptId = null;
    var receiptCommitted = false;

    try
    {
      var subscriptions = await pushSubscriptionService.GetActiveSubscriptionsAsync(userId, bridgeId, cancellationToken);

      if (subscriptions.Count == 0)
      {
        return;
      }

      var issueDelivery = await ResolveIssueDeliveryAsync(
        pushSubscriptionService,
        terminalEvent,
        cancellationToken);

      if (issueDelivery is null)
      {
        return;
      }

      var issueStatus = issueDelivery.IssueStatus;
      var issueSnapshot = issueDelivery.IssueSnapshot;
      var sourceIssueSnapshot = issueDelivery.SourceIssueSnapshot;
      var resolvedProjectId = issueDelivery.ProjectId ?? projectId;
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
        return;
      }

      receiptId = PushSubscriptionService.CreateReceiptId(userId, bridgeId, issueId, issueStatus);

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
        ProjectId = resolvedProjectId,
        IssueStatus = issueStatus,
        EventType = eventType,
        SuccessCount = 0,
        FailureCount = 0,
        CreatedAt = createdAt
      };

      if (!await pushSubscriptionService.TryReserveReceiptAsync(reservedReceipt, cancellationToken))
      {
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
      if (!receiptCommitted && !string.IsNullOrWhiteSpace(receiptId))
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
      if (!receiptCommitted && !string.IsNullOrWhiteSpace(receiptId))
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
      if (!string.IsNullOrWhiteSpace(receiptId))
      {
        _inFlightReceiptIds.TryRemove(receiptId, out _);
      }
    }
  }

  private async Task<ResolvedIssueDelivery?> ResolveIssueDeliveryAsync(
    PushSubscriptionService pushSubscriptionService,
    ResolvedTerminalIssueEvent terminalEvent,
    CancellationToken cancellationToken)
  {
    JObject? issueSnapshot = null;
    JObject? sourceIssueSnapshot = null;

    foreach (var delay in ResolveSnapshotRetryDelays(terminalEvent))
    {
      if (delay > TimeSpan.Zero)
      {
        await Task.Delay(delay, cancellationToken);
      }

      issueSnapshot = await pushSubscriptionService.GetIssueSnapshotAsync(
        terminalEvent.UserId,
        terminalEvent.BridgeId,
        terminalEvent.IssueId,
        cancellationToken);
      sourceIssueSnapshot = await pushSubscriptionService.GetSourceIssueSnapshotAsync(
        terminalEvent.UserId,
        terminalEvent.BridgeId,
        terminalEvent.IssueId,
        cancellationToken);

      var resolvedIssueStatus = ResolveIssueStatusFromEventOrSnapshot(terminalEvent, issueSnapshot, sourceIssueSnapshot);

      if (resolvedIssueStatus is "completed" or "failed")
      {
        return new ResolvedIssueDelivery(
          resolvedIssueStatus,
          issueSnapshot,
          sourceIssueSnapshot,
          NormalizeTrimmedValue(issueSnapshot?.Value<string>("project_id")) is { Length: > 0 } snapshotProjectId
            ? snapshotProjectId
            : terminalEvent.ProjectId);
      }
    }

    return null;
  }

  private static IReadOnlyList<TimeSpan> ResolveSnapshotRetryDelays(ResolvedTerminalIssueEvent terminalEvent)
  {
    return terminalEvent is
    {
      EventType: "thread.status.changed",
      ThreadStatusType: "idle",
      IssueStatusHint: ""
    }
      ? IdleSnapshotResolutionRetryDelays
      : [TimeSpan.Zero];
  }

  private static string ResolveIssueStatusFromEventOrSnapshot(
    ResolvedTerminalIssueEvent terminalEvent,
    JObject? issueSnapshot,
    JObject? sourceIssueSnapshot)
  {
    if (terminalEvent.IssueStatusHint is "completed" or "failed")
    {
      return terminalEvent.IssueStatusHint;
    }

    if (terminalEvent.EventType == "thread.status.changed" && terminalEvent.ThreadStatusType == "idle")
    {
      var snapshotStatus = ResolveTerminalStatusFromSnapshots(issueSnapshot, sourceIssueSnapshot);

      if (snapshotStatus is "completed" or "failed")
      {
        return snapshotStatus;
      }

      return "completed";
    }

    return string.Empty;
  }

  private static string ResolveTerminalStatusFromSnapshots(JObject? issueSnapshot, JObject? sourceIssueSnapshot)
  {
    var logicalStatus = NormalizeTerminalStatus(issueSnapshot?.Value<string>("status"));

    if (logicalStatus is "completed" or "failed")
    {
      return logicalStatus;
    }

    var sourceStatus = NormalizeTerminalStatus(sourceIssueSnapshot?.Value<string>("status"));

    return sourceStatus is "completed" or "failed" ? sourceStatus : string.Empty;
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

    var threadStatusType = NormalizeLowerInvariantValue(envelope.Payload?.Status?.Type);

    if (issueStatus is not ("completed" or "failed"))
    {
      if (!(eventType == "thread.status.changed" && threadStatusType == "idle"))
      {
        return null;
      }
    }

    return new ResolvedTerminalIssueEvent(
      userId,
      bridgeId,
      issueId,
      NormalizeTrimmedValue(envelope.Payload?.ResolvedThreadId),
      NormalizeTrimmedValue(envelope.Payload?.ResolvedProjectId),
      issueStatus,
      eventType,
      threadStatusType);
  }

  private static string ResolveTerminalIssueStatus(string eventType, PushEventPayload? payload)
  {
    var explicitIssueStatus = NormalizeTerminalStatus(payload?.ResolvedIssueStatus);

    if (explicitIssueStatus is "completed" or "failed")
    {
      return explicitIssueStatus;
    }

    return eventType switch
    {
      "turn.completed" => NormalizeTerminalStatus(payload?.Turn?.Status),
      "turn.start.failed" => "failed",
      "thread.status.changed" => ResolveTerminalIssueStatusFromThreadStatus(payload?.Status?.Type),
      _ => string.Empty
    };
  }

  private static string ResolveTerminalIssueStatusFromThreadStatus(string? statusType)
  {
    var normalized = NormalizeLowerInvariantValue(statusType);

    return normalized switch
    {
      "error" => "failed",
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
    string IssueStatusHint,
    string EventType,
    string ThreadStatusType);

  private sealed record ResolvedIssueDelivery(
    string IssueStatus,
    JObject? IssueSnapshot,
    JObject? SourceIssueSnapshot,
    string ProjectId);

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

    public string? IssueStatus { get; set; }

    public string? Issue_status { get; set; }

    public PushTurnPayload? Turn { get; set; }

    public PushThreadStatusPayload? Status { get; set; }

    public string? ResolvedThreadId => ThreadId ?? Thread_id;

    public string? ResolvedProjectId => ProjectId ?? Project_id;

    public string? ResolvedIssueId => IssueId ?? Issue_id;

    public string? ResolvedIssueStatus => IssueStatus ?? Issue_status;
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
