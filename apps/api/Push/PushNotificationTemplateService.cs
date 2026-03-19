using System.Text.RegularExpressions;

namespace OctOP.Gateway;

public sealed partial class PushNotificationTemplateService
{
  public const string DashboardAppId = "dashboard-web";
  public const string MobileAppId = "mobile-web";
  private const string DefaultCompletedTitleTemplate = "{projectPrefix}이슈 완료";
  private const string DefaultCompletedBodyTemplate = "{issueTitleOrId} 이(가) 완료 상태가 되었습니다.";
  private const string DefaultFailedTitleTemplate = "{projectPrefix}이슈 실패";
  private const string DefaultFailedBodyTemplate = "{issueTitleOrId} 이(가) 실패 상태가 되었습니다.";
  private const string DefaultCompletedTagTemplate = "issue-{issueId}-completed";
  private const string DefaultFailedTagTemplate = "issue-{issueId}-failed";
  private const string DefaultUrlTemplate = "/?bridge_id={bridgeId}&project_id={projectId}&thread_id={threadId}&issue_id={issueId}";

  public PushNotificationTemplateService()
  {
    CompletedTitleTemplate = ReadTemplate("OCTOP_PUSH_TEMPLATE_COMPLETED_TITLE", DefaultCompletedTitleTemplate);
    CompletedBodyTemplate = ReadTemplate("OCTOP_PUSH_TEMPLATE_COMPLETED_BODY", DefaultCompletedBodyTemplate);
    FailedTitleTemplate = ReadTemplate("OCTOP_PUSH_TEMPLATE_FAILED_TITLE", DefaultFailedTitleTemplate);
    FailedBodyTemplate = ReadTemplate("OCTOP_PUSH_TEMPLATE_FAILED_BODY", DefaultFailedBodyTemplate);
    CompletedTagTemplate = ReadTemplate("OCTOP_PUSH_TEMPLATE_COMPLETED_TAG", DefaultCompletedTagTemplate);
    FailedTagTemplate = ReadTemplate("OCTOP_PUSH_TEMPLATE_FAILED_TAG", DefaultFailedTagTemplate);
    UrlTemplate = ReadTemplate("OCTOP_PUSH_TEMPLATE_URL", DefaultUrlTemplate);
    DashboardUrlTemplate = ReadTemplate("OCTOP_PUSH_TEMPLATE_DASHBOARD_URL", UrlTemplate);
    MobileUrlTemplate = ReadTemplate("OCTOP_PUSH_TEMPLATE_MOBILE_URL", UrlTemplate);
  }

  public string CompletedTitleTemplate { get; }

  public string CompletedBodyTemplate { get; }

  public string FailedTitleTemplate { get; }

  public string FailedBodyTemplate { get; }

  public string CompletedTagTemplate { get; }

  public string FailedTagTemplate { get; }

  public string UrlTemplate { get; }

  public string DashboardUrlTemplate { get; }

  public string MobileUrlTemplate { get; }

  public PushNotificationRequest BuildIssueTerminalNotification(
    string bridgeId,
    string? projectId,
    string? threadId,
    string issueId,
    string issueStatus,
    string issueTitle,
    string? projectName,
    string? sourceAppId,
    string? targetAppId)
  {
    var statusLabel = string.Equals(issueStatus, "completed", StringComparison.OrdinalIgnoreCase) ? "완료" : "실패";
    var normalizedSourceAppId = NormalizeAppId(sourceAppId);
    var normalizedTargetAppId = NormalizeAppId(targetAppId);
    var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
      ["bridgeId"] = bridgeId,
      ["projectId"] = projectId ?? string.Empty,
      ["threadId"] = threadId ?? string.Empty,
      ["issueId"] = issueId,
      ["issueStatus"] = issueStatus,
      ["statusLabel"] = statusLabel,
      ["issueTitle"] = issueTitle,
      ["issueTitleOrId"] = string.IsNullOrWhiteSpace(issueTitle) ? issueId : issueTitle,
      ["projectName"] = projectName ?? string.Empty,
      ["projectPrefix"] = string.IsNullOrWhiteSpace(projectName) ? string.Empty : $"{projectName} · ",
      ["sourceAppId"] = normalizedSourceAppId,
      ["targetAppId"] = normalizedTargetAppId
    };

    var isCompleted = string.Equals(issueStatus, "completed", StringComparison.OrdinalIgnoreCase);
    var title = RenderTemplate(isCompleted ? CompletedTitleTemplate : FailedTitleTemplate, values);
    var body = RenderTemplate(isCompleted ? CompletedBodyTemplate : FailedBodyTemplate, values);
    var tag = RenderTemplate(isCompleted ? CompletedTagTemplate : FailedTagTemplate, values);
    var url = RenderTemplate(GetUrlTemplateForTargetApp(normalizedTargetAppId), values);

    return new PushNotificationRequest
    {
      Title = string.IsNullOrWhiteSpace(title)
        ? RenderTemplate(isCompleted ? DefaultCompletedTitleTemplate : DefaultFailedTitleTemplate, values)
        : title,
      Body = string.IsNullOrWhiteSpace(body)
        ? RenderTemplate(isCompleted ? DefaultCompletedBodyTemplate : DefaultFailedBodyTemplate, values)
        : body,
      Url = string.IsNullOrWhiteSpace(url) ? DefaultUrlTemplate : url,
      Tag = string.IsNullOrWhiteSpace(tag)
        ? RenderTemplate(isCompleted ? DefaultCompletedTagTemplate : DefaultFailedTagTemplate, values)
        : tag,
      Kind = "issue-terminal",
      BridgeId = bridgeId,
      ProjectId = projectId,
      ThreadId = threadId,
      IssueId = issueId,
      IssueStatus = issueStatus,
      SourceAppId = normalizedSourceAppId,
      TargetAppId = normalizedTargetAppId
    };
  }

  public static bool ShouldDeliverToApp(string? sourceAppId, string? targetAppId)
  {
    var normalizedSourceAppId = NormalizeAppId(sourceAppId);
    var normalizedTargetAppId = NormalizeAppId(targetAppId);

    if (string.IsNullOrWhiteSpace(normalizedTargetAppId))
    {
      return false;
    }

    if (string.Equals(normalizedSourceAppId, MobileAppId, StringComparison.Ordinal))
    {
      return string.Equals(normalizedTargetAppId, MobileAppId, StringComparison.Ordinal);
    }

    return true;
  }

  public static string NormalizeAppId(string? appId)
  {
    var normalized = string.IsNullOrWhiteSpace(appId) ? string.Empty : appId.Trim().ToLowerInvariant();

    return normalized switch
    {
      DashboardAppId => DashboardAppId,
      MobileAppId => MobileAppId,
      _ => normalized
    };
  }

  private static string ReadTemplate(string environmentVariableName, string fallback)
  {
    var configured = Environment.GetEnvironmentVariable(environmentVariableName)?.Trim();
    return string.IsNullOrWhiteSpace(configured) ? fallback : configured;
  }

  private string GetUrlTemplateForTargetApp(string? targetAppId)
  {
    return targetAppId switch
    {
      DashboardAppId => DashboardUrlTemplate,
      MobileAppId => MobileUrlTemplate,
      _ => UrlTemplate
    };
  }

  private static string RenderTemplate(string template, IReadOnlyDictionary<string, string> values)
  {
    return TemplateTokenRegex().Replace(template, (match) =>
    {
      var key = match.Groups[1].Value;
      return values.TryGetValue(key, out var value) ? value : match.Value;
    });
  }

  [GeneratedRegex(@"\{([a-zA-Z0-9_]+)\}")]
  private static partial Regex TemplateTokenRegex();
}
