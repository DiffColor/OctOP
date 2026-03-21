using System.Text.RegularExpressions;

namespace OctOP.Gateway;

public sealed partial class PushNotificationTemplateService
{
  public const string DashboardAppId = "dashboard-web";
  public const string MobileAppId = "mobile-web";
  public const string AndroidWatchAppId = "android-watch";
  public const string AppleWatchAppId = "apple-watch";
  private const string DefaultTitleTemplate = "OctOP Push";
  private const string DefaultBodyTemplate = "테스트 푸시입니다.";
  private const string DefaultCompletedTitleTemplate = "{projectPrefix}이슈 완료";
  private const string DefaultCompletedBodyTemplate = "{issueTitleOrId} 이(가) 완료 상태가 되었습니다.";
  private const string DefaultFailedTitleTemplate = "{projectPrefix}이슈 실패";
  private const string DefaultFailedBodyTemplate = "{issueTitleOrId} 이(가) 실패 상태가 되었습니다.";
  private const string DefaultCompletedTagTemplate = "issue-{issueId}-completed";
  private const string DefaultFailedTagTemplate = "issue-{issueId}-failed";
  private const string DefaultUrlTemplate = "/?bridge_id={bridgeId}&project_id={projectId}&thread_id={threadId}&issue_id={issueId}";

  public PushNotificationTemplateService()
  {
    DefaultTitle = ReadTemplate("OCTOP_PUSH_TEMPLATE_DEFAULT_TITLE", DefaultTitleTemplate);
    DefaultBody = ReadTemplate("OCTOP_PUSH_TEMPLATE_DEFAULT_BODY", DefaultBodyTemplate);
    CompletedTitleTemplate = ReadTemplate("OCTOP_PUSH_TEMPLATE_COMPLETED_TITLE", DefaultCompletedTitleTemplate);
    CompletedBodyTemplate = ReadTemplate("OCTOP_PUSH_TEMPLATE_COMPLETED_BODY", DefaultCompletedBodyTemplate);
    FailedTitleTemplate = ReadTemplate("OCTOP_PUSH_TEMPLATE_FAILED_TITLE", DefaultFailedTitleTemplate);
    FailedBodyTemplate = ReadTemplate("OCTOP_PUSH_TEMPLATE_FAILED_BODY", DefaultFailedBodyTemplate);
    CompletedTagTemplate = ReadTemplate("OCTOP_PUSH_TEMPLATE_COMPLETED_TAG", DefaultCompletedTagTemplate);
    FailedTagTemplate = ReadTemplate("OCTOP_PUSH_TEMPLATE_FAILED_TAG", DefaultFailedTagTemplate);
    UrlTemplate = ReadTemplate("OCTOP_PUSH_TEMPLATE_URL", DefaultUrlTemplate);
    DashboardUrlTemplate = ReadTemplate("OCTOP_PUSH_TEMPLATE_DASHBOARD_URL", UrlTemplate);
    MobileUrlTemplate = ReadTemplate("OCTOP_PUSH_TEMPLATE_MOBILE_URL", UrlTemplate);
    AndroidWatchUrlTemplate = ReadTemplate("OCTOP_PUSH_TEMPLATE_ANDROID_WATCH_URL", MobileUrlTemplate);
    AppleWatchUrlTemplate = ReadTemplate("OCTOP_PUSH_TEMPLATE_APPLE_WATCH_URL", MobileUrlTemplate);
  }

  public string CompletedTitleTemplate { get; }

  public string CompletedBodyTemplate { get; }

  public string DefaultTitle { get; }

  public string DefaultBody { get; }

  public string FailedTitleTemplate { get; }

  public string FailedBodyTemplate { get; }

  public string CompletedTagTemplate { get; }

  public string FailedTagTemplate { get; }

  public string UrlTemplate { get; }

  public string DashboardUrlTemplate { get; }

  public string MobileUrlTemplate { get; }

  public string AndroidWatchUrlTemplate { get; }

  public string AppleWatchUrlTemplate { get; }

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

  public PushNotificationRequest BuildManualNotification(
    PushNotificationRequest request,
    string bridgeId,
    string? targetAppId)
  {
    var normalizedSourceAppId = NormalizeAppId(request.SourceAppId);
    var normalizedTargetAppId = NormalizeAppId(targetAppId);
    var normalizedIssueStatus = string.IsNullOrWhiteSpace(request.IssueStatus)
      ? string.Empty
      : request.IssueStatus.Trim().ToLowerInvariant();
    var statusLabel = string.Equals(normalizedIssueStatus, "completed", StringComparison.OrdinalIgnoreCase)
      ? "완료"
      : string.Equals(normalizedIssueStatus, "failed", StringComparison.OrdinalIgnoreCase)
        ? "실패"
        : normalizedIssueStatus;
    var issueId = request.IssueId?.Trim() ?? string.Empty;
    var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
      ["bridgeId"] = bridgeId,
      ["projectId"] = request.ProjectId?.Trim() ?? string.Empty,
      ["threadId"] = request.ThreadId?.Trim() ?? string.Empty,
      ["issueId"] = issueId,
      ["issueStatus"] = normalizedIssueStatus,
      ["statusLabel"] = statusLabel,
      ["issueTitle"] = request.Title?.Trim() ?? string.Empty,
      ["issueTitleOrId"] = string.IsNullOrWhiteSpace(request.Title) ? issueId : request.Title.Trim(),
      ["projectName"] = request.ProjectName?.Trim() ?? string.Empty,
      ["projectPrefix"] = string.IsNullOrWhiteSpace(request.ProjectName) ? string.Empty : $"{request.ProjectName.Trim()} · ",
      ["sourceAppId"] = normalizedSourceAppId,
      ["targetAppId"] = normalizedTargetAppId
    };

    var renderedUrl = string.IsNullOrWhiteSpace(request.Url)
      ? RenderTemplate(GetUrlTemplateForTargetApp(normalizedTargetAppId), values)
      : request.Url.Trim();

    return new PushNotificationRequest
    {
      Title = string.IsNullOrWhiteSpace(request.Title)
        ? RenderTemplate(DefaultTitle, values)
        : request.Title.Trim(),
      Body = string.IsNullOrWhiteSpace(request.Body)
        ? RenderTemplate(DefaultBody, values)
        : request.Body.Trim(),
      Url = string.IsNullOrWhiteSpace(renderedUrl) ? DefaultUrlTemplate : renderedUrl,
      Tag = string.IsNullOrWhiteSpace(request.Tag) ? null : request.Tag.Trim(),
      Kind = request.Kind,
      BridgeId = bridgeId,
      ProjectId = request.ProjectId,
      ThreadId = request.ThreadId,
      IssueId = request.IssueId,
      IssueStatus = request.IssueStatus,
      ProjectName = request.ProjectName,
      SourceAppId = normalizedSourceAppId,
      TargetAppId = normalizedTargetAppId
    };
  }

  public PushTemplateSnapshot CreateSnapshot()
  {
    return new PushTemplateSnapshot
    {
      CompletedTitle = CompletedTitleTemplate,
      CompletedBody = CompletedBodyTemplate,
      FailedTitle = FailedTitleTemplate,
      FailedBody = FailedBodyTemplate,
      DefaultTitle = DefaultTitle,
      DefaultBody = DefaultBody,
      CompletedTag = CompletedTagTemplate,
      FailedTag = FailedTagTemplate,
      DashboardUrl = DashboardUrlTemplate,
      MobileUrl = MobileUrlTemplate,
      AndroidWatchUrl = AndroidWatchUrlTemplate,
      AppleWatchUrl = AppleWatchUrlTemplate
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

    if (
      string.Equals(normalizedSourceAppId, MobileAppId, StringComparison.Ordinal) ||
      IsWatchAppId(normalizedSourceAppId))
    {
      return string.Equals(normalizedTargetAppId, MobileAppId, StringComparison.Ordinal) ||
        IsWatchAppId(normalizedTargetAppId);
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
      AndroidWatchAppId => AndroidWatchAppId,
      AppleWatchAppId => AppleWatchAppId,
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
      AndroidWatchAppId => AndroidWatchUrlTemplate,
      AppleWatchAppId => AppleWatchUrlTemplate,
      _ => UrlTemplate
    };
  }

  private static bool IsWatchAppId(string? appId)
  {
    return string.Equals(appId, AndroidWatchAppId, StringComparison.Ordinal) ||
      string.Equals(appId, AppleWatchAppId, StringComparison.Ordinal);
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
