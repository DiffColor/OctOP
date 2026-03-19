using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json.Linq;

namespace OctOP.Gateway;

public sealed class PushSubscriptionService(OctopStore octopStore)
{
  public const string ClientModeBrowser = "browser";
  public const string ClientModeStandalone = "standalone";

  public async Task<int> GetCountAsync(
    string userId,
    string bridgeId,
    string appId,
    CancellationToken cancellationToken)
  {
    var subscriptions = await octopStore.ListPushSubscriptionsAsync(userId, bridgeId, appId, cancellationToken);
    return subscriptions.Count;
  }

  public async Task<IReadOnlyList<string>> GetEndpointsAsync(
    string userId,
    string bridgeId,
    string appId,
    CancellationToken cancellationToken)
  {
    var subscriptions = await octopStore.ListPushSubscriptionsAsync(userId, bridgeId, appId, cancellationToken);
    return subscriptions
      .Select(subscription => subscription.Endpoint)
      .OrderBy(endpoint => endpoint, StringComparer.Ordinal)
      .ToList();
  }

  public Task<IReadOnlyList<PushSubscriptionEntity>> GetActiveSubscriptionsAsync(
    string userId,
    string bridgeId,
    CancellationToken cancellationToken)
  {
    return GetEffectiveSubscriptionsAsync(userId, bridgeId, cancellationToken);
  }

  public async Task<int> UpsertAsync(
    string userId,
    string bridgeId,
    string appId,
    string origin,
    PushSubscriptionDto subscriptionDto,
    string? userAgent,
    CancellationToken cancellationToken)
  {
    Validate(subscriptionDto);
    var now = DateTimeOffset.UtcNow.ToString("O");
    var documentId = CreateSubscriptionDocumentId(userId, bridgeId, appId, subscriptionDto.Endpoint);
    var existing = await octopStore.GetPushSubscriptionAsync(documentId, cancellationToken);

    var entity = new PushSubscriptionEntity
    {
      Id = documentId,
      LoginId = userId,
      UserId = userId,
      BridgeId = bridgeId,
      AppId = appId,
      Endpoint = subscriptionDto.Endpoint,
      Origin = origin,
      UserAgent = userAgent,
      ClientMode = NormalizeClientMode(subscriptionDto.ClientMode),
      P256dh = subscriptionDto.Keys.P256dh,
      Auth = subscriptionDto.Keys.Auth,
      CreatedAt = existing?.CreatedAt ?? now,
      UpdatedAt = now,
      LastSuccessAt = existing?.LastSuccessAt,
      LastFailureAt = existing?.LastFailureAt,
      LastFailureMessage = existing?.LastFailureMessage,
      IsActive = true
    };

    await octopStore.UpsertPushSubscriptionAsync(entity, cancellationToken);
    return await GetCountAsync(userId, bridgeId, appId, cancellationToken);
  }

  public async Task<int> DeleteAsync(
    string userId,
    string bridgeId,
    string appId,
    string endpoint,
    CancellationToken cancellationToken)
  {
    if (string.IsNullOrWhiteSpace(endpoint))
    {
      throw new ArgumentException("삭제할 endpoint가 필요합니다.", nameof(endpoint));
    }

    await octopStore.DeletePushSubscriptionAsync(
      CreateSubscriptionDocumentId(userId, bridgeId, appId, endpoint),
      cancellationToken);

    return await GetCountAsync(userId, bridgeId, appId, cancellationToken);
  }

  public async Task MarkSuccessAsync(string subscriptionId, CancellationToken cancellationToken)
  {
    var existing = await octopStore.GetPushSubscriptionAsync(subscriptionId, cancellationToken);

    if (existing is null)
    {
      return;
    }

    existing.LastSuccessAt = DateTimeOffset.UtcNow.ToString("O");
    existing.LastFailureAt = null;
    existing.LastFailureMessage = null;
    existing.UpdatedAt = DateTimeOffset.UtcNow.ToString("O");
    existing.IsActive = true;
    await octopStore.UpsertPushSubscriptionAsync(existing, cancellationToken);
  }

  public async Task MarkFailureAsync(
    string subscriptionId,
    string endpoint,
    string? message,
    bool deactivate,
    CancellationToken cancellationToken)
  {
    var existing = await octopStore.GetPushSubscriptionAsync(subscriptionId, cancellationToken);

    if (existing is null)
    {
      return;
    }

    existing.LastFailureAt = DateTimeOffset.UtcNow.ToString("O");
    existing.LastFailureMessage = message;
    existing.UpdatedAt = DateTimeOffset.UtcNow.ToString("O");
    existing.IsActive = !deactivate;

    if (deactivate)
    {
      await octopStore.DeletePushSubscriptionsByEndpointAsync(endpoint, cancellationToken);
      return;
    }

    await octopStore.UpsertPushSubscriptionAsync(existing, cancellationToken);
  }

  public Task<PushNotificationReceiptEntity?> GetReceiptAsync(string receiptId, CancellationToken cancellationToken)
  {
    return octopStore.GetPushNotificationReceiptAsync(receiptId, cancellationToken);
  }

  public Task<bool> TryReserveReceiptAsync(PushNotificationReceiptEntity receipt, CancellationToken cancellationToken)
  {
    return octopStore.TryCreatePushNotificationReceiptAsync(receipt, cancellationToken);
  }

  public Task UpsertReceiptAsync(PushNotificationReceiptEntity receipt, CancellationToken cancellationToken)
  {
    return octopStore.UpsertPushNotificationReceiptAsync(receipt, cancellationToken);
  }

  public Task DeleteReceiptAsync(string receiptId, CancellationToken cancellationToken)
  {
    return octopStore.DeletePushNotificationReceiptAsync(receiptId, cancellationToken);
  }

  public Task<JObject?> GetIssueSnapshotAsync(
    string userId,
    string bridgeId,
    string issueId,
    CancellationToken cancellationToken)
  {
    return octopStore.GetLogicalThreadIssueAsync(userId, bridgeId, issueId, cancellationToken);
  }

  public Task<JObject?> GetProjectSnapshotAsync(
    string userId,
    string bridgeId,
    string projectId,
    CancellationToken cancellationToken)
  {
    return octopStore.GetProjectAsync(userId, bridgeId, projectId, cancellationToken);
  }

  public static string CreateSubscriptionDocumentId(string userId, string bridgeId, string appId, string endpoint)
  {
    return CreateHash($"{userId}\n{bridgeId}\n{appId}\n{endpoint}");
  }

  public static string CreateReceiptId(string userId, string bridgeId, string issueId, string issueStatus)
  {
    return CreateHash($"{userId}\n{bridgeId}\n{issueId}\n{issueStatus}");
  }

  private static string CreateHash(string value)
  {
    var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
    return Convert.ToHexString(bytes).ToLowerInvariant();
  }

  private async Task<IReadOnlyList<PushSubscriptionEntity>> GetEffectiveSubscriptionsAsync(
    string userId,
    string bridgeId,
    CancellationToken cancellationToken)
  {
    var subscriptions = await octopStore.ListPushSubscriptionsAsync(userId, bridgeId, appId: null, cancellationToken);
    return SelectDeliveryTargets(subscriptions);
  }

  private static IReadOnlyList<PushSubscriptionEntity> SelectDeliveryTargets(
    IReadOnlyList<PushSubscriptionEntity> subscriptions)
  {
    if (subscriptions.Count <= 1)
    {
      return subscriptions;
    }

    var deliveryTargets = new List<PushSubscriptionEntity>(subscriptions.Count);
    var mobileSubscriptions = subscriptions
      .Where(subscription => string.Equals(subscription.AppId, PushNotificationTemplateService.MobileAppId, StringComparison.Ordinal))
      .ToList();

    if (mobileSubscriptions.Count > 0)
    {
      var preferredMobileSubscriptions = mobileSubscriptions
        .Where(subscription => string.Equals(
          NormalizeClientMode(subscription.ClientMode),
          ClientModeStandalone,
          StringComparison.Ordinal))
        .ToList();

      deliveryTargets.AddRange(preferredMobileSubscriptions.Count > 0 ? preferredMobileSubscriptions : mobileSubscriptions);
    }

    deliveryTargets.AddRange(
      subscriptions.Where(subscription => !string.Equals(subscription.AppId, PushNotificationTemplateService.MobileAppId, StringComparison.Ordinal))
    );

    return deliveryTargets;
  }

  private static string NormalizeClientMode(string? value)
  {
    return string.Equals(value?.Trim(), ClientModeStandalone, StringComparison.OrdinalIgnoreCase)
      ? ClientModeStandalone
      : ClientModeBrowser;
  }

  private static void Validate(PushSubscriptionDto subscriptionDto)
  {
    if (
      string.IsNullOrWhiteSpace(subscriptionDto.Endpoint) ||
      string.IsNullOrWhiteSpace(subscriptionDto.Keys.P256dh) ||
      string.IsNullOrWhiteSpace(subscriptionDto.Keys.Auth))
    {
      throw new ArgumentException("유효한 구독 객체가 필요합니다.");
    }
  }
}
