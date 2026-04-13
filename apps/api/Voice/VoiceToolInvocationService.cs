using System.Text.Json.Nodes;
using Newtonsoft.Json.Linq;
using OctOP.ServerShared;

namespace OctOP.Gateway.Voice;

public sealed class VoiceToolInvocationService(BridgeNatsClient bridgeNatsClient, OctopStore octopStore)
{
  private readonly BridgeNatsClient _bridgeNatsClient = bridgeNatsClient;
  private readonly OctopStore _octopStore = octopStore;

  public async Task<JsonObject> InvokeAsync(
    string userId,
    string bridgeId,
    VoiceToolInvocationRequest request,
    CancellationToken cancellationToken)
  {
    var toolName = request.ToolName?.Trim();

    if (string.IsNullOrWhiteSpace(toolName))
    {
      throw new InvalidOperationException("voice_tool_name_required");
    }

    return toolName switch
    {
      "get_project_context" => await GetProjectContextAsync(userId, bridgeId, request.ProjectId, request.ThreadId, cancellationToken),
      "get_thread_status" => await GetThreadStatusAsync(userId, bridgeId, request.ThreadId, cancellationToken),
      "start_thread_run" => await StartThreadRunAsync(userId, bridgeId, request.ThreadId, request.Arguments, cancellationToken),
      "stop_thread_run" => await StopThreadRunAsync(userId, bridgeId, request.ThreadId, request.Arguments, cancellationToken),
      "interrupt_active_issue" => await InterruptActiveIssueAsync(userId, bridgeId, request.ThreadId, request.Arguments, cancellationToken),
      _ => new JsonObject
      {
        ["ok"] = false,
        ["error"] = $"지원하지 않는 voice tool입니다: {toolName}"
      }
    };
  }

  private async Task<JsonObject> GetProjectContextAsync(
    string userId,
    string bridgeId,
    string? projectId,
    string? threadId,
    CancellationToken cancellationToken)
  {
    var normalizedProjectId = projectId?.Trim();
    var normalizedThreadId = threadId?.Trim();

    if (string.IsNullOrWhiteSpace(normalizedProjectId) && string.IsNullOrWhiteSpace(normalizedThreadId))
    {
      return new JsonObject
      {
        ["ok"] = false,
        ["error"] = "project_id 또는 thread_id가 필요합니다."
      };
    }

    var projectionThreads = await _octopStore.ListThreadsAsync(userId, bridgeId, null);
    var thread = !string.IsNullOrWhiteSpace(normalizedThreadId)
      ? projectionThreads
        .OfType<JObject>()
        .FirstOrDefault(item => string.Equals(item.Value<string>("id"), normalizedThreadId, StringComparison.Ordinal))
      : null;

    if (string.IsNullOrWhiteSpace(normalizedProjectId))
    {
      normalizedProjectId = thread?.Value<string>("project_id")?.Trim();
    }

    var project = !string.IsNullOrWhiteSpace(normalizedProjectId)
      ? await _octopStore.GetProjectAsync(userId, bridgeId, normalizedProjectId, cancellationToken)
      : null;

    JsonObject? continuityPayload = null;
    string continuityError = string.Empty;
    var rootThreadId = normalizedThreadId ?? string.Empty;

    if (!string.IsNullOrWhiteSpace(normalizedThreadId))
    {
      try
      {
        var subjects = BridgeSubjects.ForUser(userId, bridgeId);
        continuityPayload = await _bridgeNatsClient.RequestAsync(
          subjects.ThreadContinuityGet,
          new
          {
            login_id = userId,
            user_id = userId,
            bridge_id = bridgeId,
            thread_id = normalizedThreadId
          },
          cancellationToken) as JsonObject;
        rootThreadId = continuityPayload?["root_thread"]?["id"]?.ToString()?.Trim() ?? rootThreadId;
      }
      catch (OperationCanceledException)
      {
        throw;
      }
      catch (Exception error)
      {
        continuityError = error.Message ?? "continuity 조회 실패";
      }
    }

    var recentMessages = new JsonArray();
    string latestHandoffSummary = string.Empty;
    var issueBoard = new JArray();

    if (!string.IsNullOrWhiteSpace(rootThreadId))
    {
      var timelineEntries = await _octopStore.ListLogicalThreadTimelineAsync(userId, bridgeId, rootThreadId);
      issueBoard = await _octopStore.ListLogicalThreadIssueBoardAsync(userId, bridgeId, rootThreadId);
      var orderedEntries = timelineEntries
        .OfType<JObject>()
        .OrderBy(entry => ParseTimestamp(entry.Value<string>("timestamp") ?? entry.Value<string>("created_at")))
        .ToList();

      latestHandoffSummary = orderedEntries
        .Where(entry => string.Equals(entry.Value<string>("kind"), "handoff_summary", StringComparison.Ordinal))
        .Select(entry => entry.Value<string>("content")?.Trim())
        .Where(value => !string.IsNullOrWhiteSpace(value))
        .LastOrDefault() ?? string.Empty;

      foreach (var entry in orderedEntries
        .Where(entry => !string.Equals(entry.Value<string>("kind"), "handoff_summary", StringComparison.Ordinal))
        .Where(entry => !string.IsNullOrWhiteSpace(entry.Value<string>("content")))
        .TakeLast(8))
      {
        var attachmentsJson = entry["attachments"] is JArray attachments
          ? JsonNode.Parse(attachments.ToString()) as JsonArray
          : null;

        recentMessages.Add(new JsonObject
        {
          ["role"] = entry.Value<string>("role") ?? "system",
          ["content"] = entry.Value<string>("content")?.Trim() ?? string.Empty,
          ["timestamp"] = entry.Value<string>("timestamp") ?? entry.Value<string>("created_at") ?? string.Empty,
          ["attachments"] = attachmentsJson
        });
      }
    }

    return new JsonObject
    {
      ["ok"] = true,
      ["project"] = project is null
        ? null
        : new JsonObject
        {
          ["id"] = project.Value<string>("id") ?? normalizedProjectId ?? string.Empty,
          ["name"] = project.Value<string>("name") ?? "프로젝트 미지정",
          ["workspace_path"] = project.Value<string>("workspace_path") ?? string.Empty,
          ["base_instructions"] = project.Value<string>("base_instructions") ?? string.Empty,
          ["developer_instructions"] = project.Value<string>("developer_instructions") ?? string.Empty
        },
      ["thread"] = new JsonObject
      {
        ["id"] = normalizedThreadId ?? string.Empty,
        ["title"] = thread?.Value<string>("title") ?? "현재 쓰레드",
        ["status"] = thread?.Value<string>("status") ?? "unknown",
        ["developer_instructions"] = thread?.Value<string>("developer_instructions") ?? string.Empty,
        ["root_thread_id"] = rootThreadId,
        ["continuity_status"] = continuityPayload?["root_thread"]?["continuity_status"]?.ToString()
          ?? thread?.Value<string>("continuity_status")
          ?? string.Empty,
        ["active_physical_thread_id"] = continuityPayload?["active_physical_thread"]?["id"]?.ToString() ?? string.Empty,
        ["active_codex_thread_id"] = continuityPayload?["active_physical_thread"]?["codex_thread_id"]?.ToString() ?? string.Empty,
        ["context_usage_percent"] = continuityPayload?["active_physical_thread"]?["context_usage_percent"]?.GetValue<int?>()
          ?? thread?.Value<int?>("context_usage_percent")
      },
      ["program_summary"] = BuildProgramSummary(project, thread, continuityPayload, latestHandoffSummary, recentMessages),
      ["file_context_summary"] = BuildFileContextSummary(issueBoard, recentMessages),
      ["latest_handoff_summary"] = latestHandoffSummary,
      ["recent_messages"] = recentMessages,
      ["continuity_error"] = continuityError
    };
  }

  private async Task<JsonObject> GetThreadStatusAsync(
    string userId,
    string bridgeId,
    string? threadId,
    CancellationToken cancellationToken)
  {
    var normalizedThreadId = threadId?.Trim();

    if (string.IsNullOrWhiteSpace(normalizedThreadId))
    {
      return new JsonObject
      {
        ["ok"] = false,
        ["error"] = "thread_id가 필요합니다."
      };
    }

    var subjects = BridgeSubjects.ForUser(userId, bridgeId);
    var threadPayload = await _bridgeNatsClient.RequestAsync(
      subjects.ThreadIssuesGet,
      new
      {
        login_id = userId,
        user_id = userId,
        bridge_id = bridgeId,
        thread_id = normalizedThreadId
      },
      cancellationToken);
    var projectionThreads = await _octopStore.ListThreadsAsync(userId, bridgeId, null);
    var thread = projectionThreads
      .OfType<JObject>()
      .FirstOrDefault(item => string.Equals(item.Value<string>("id"), normalizedThreadId, StringComparison.Ordinal));
    var issues = threadPayload?["issues"]?.AsArray() ?? [];
    var activeIssue = issues
      .Select(node => node as JsonObject)
      .FirstOrDefault(issue =>
        string.Equals(issue?["status"]?.ToString(), "running", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(issue?["status"]?.ToString(), "awaiting_input", StringComparison.OrdinalIgnoreCase));

    return new JsonObject
    {
      ["ok"] = true,
      ["thread"] = new JsonObject
      {
        ["id"] = normalizedThreadId,
        ["title"] = thread?.Value<string>("title") ?? threadPayload?["thread"]?["title"]?.ToString() ?? "현재 쓰레드",
        ["status"] = thread?.Value<string>("status") ?? threadPayload?["thread"]?["status"]?.ToString() ?? "unknown"
      },
      ["active_issue"] = activeIssue?.DeepClone(),
      ["issues"] = new JsonArray(issues.Take(6).Select(node => node?.DeepClone()).ToArray())
    };
  }

  private async Task<JsonObject> StartThreadRunAsync(
    string userId,
    string bridgeId,
    string? threadId,
    JsonObject? arguments,
    CancellationToken cancellationToken)
  {
    var normalizedThreadId = threadId?.Trim();

    if (string.IsNullOrWhiteSpace(normalizedThreadId))
    {
      return new JsonObject
      {
        ["ok"] = false,
        ["error"] = "thread_id가 필요합니다."
      };
    }

    var issueIds = arguments?["issue_ids"]?.AsArray()
      .Select(node => node?.ToString()?.Trim())
      .Where(value => !string.IsNullOrWhiteSpace(value))
      .Cast<string>()
      .ToArray() ?? [];
    var subjects = BridgeSubjects.ForUser(userId, bridgeId);
    var payload = await _bridgeNatsClient.RequestAsync(
      subjects.ThreadIssuesStart,
      new
      {
        user_id = userId,
        login_id = userId,
        bridge_id = bridgeId,
        thread_id = normalizedThreadId,
        issue_ids = issueIds
      },
      cancellationToken);
    var requestedIssueIds = new JsonArray();

    foreach (var issueId in issueIds)
    {
      requestedIssueIds.Add(issueId);
    }

    return new JsonObject
    {
      ["ok"] = payload?["accepted"]?.GetValue<bool?>() ?? true,
      ["thread_id"] = normalizedThreadId,
      ["requested_issue_ids"] = requestedIssueIds,
      ["bridge"] = payload?.DeepClone()
    };
  }

  private async Task<JsonObject> StopThreadRunAsync(
    string userId,
    string bridgeId,
    string? threadId,
    JsonObject? arguments,
    CancellationToken cancellationToken)
  {
    var normalizedThreadId = threadId?.Trim();

    if (string.IsNullOrWhiteSpace(normalizedThreadId))
    {
      return new JsonObject
      {
        ["ok"] = false,
        ["error"] = "thread_id가 필요합니다."
      };
    }

    var subjects = BridgeSubjects.ForUser(userId, bridgeId);
    var payload = await _bridgeNatsClient.RequestAsync(
      subjects.ProjectThreadStop,
      new
      {
        user_id = userId,
        login_id = userId,
        bridge_id = bridgeId,
        thread_id = normalizedThreadId,
        reason = arguments?["reason"]?.ToString() ?? "voice_stop_request"
      },
      cancellationToken);

    return new JsonObject
    {
      ["ok"] = payload?["accepted"]?.GetValue<bool?>() ?? false,
      ["thread_id"] = normalizedThreadId,
      ["bridge"] = payload?.DeepClone()
    };
  }

  private async Task<JsonObject> InterruptActiveIssueAsync(
    string userId,
    string bridgeId,
    string? threadId,
    JsonObject? arguments,
    CancellationToken cancellationToken)
  {
    var issueId = arguments?["issue_id"]?.ToString()?.Trim();

    if (string.IsNullOrWhiteSpace(issueId))
    {
      var status = await GetThreadStatusAsync(userId, bridgeId, threadId, cancellationToken);
      issueId = status["active_issue"]?["id"]?.ToString()?.Trim();
    }

    if (string.IsNullOrWhiteSpace(issueId))
    {
      return new JsonObject
      {
        ["ok"] = false,
        ["error"] = "중단할 활성 이슈를 찾지 못했습니다."
      };
    }

    var subjects = BridgeSubjects.ForUser(userId, bridgeId);
    var payload = await _bridgeNatsClient.RequestAsync(
      subjects.ThreadIssueInterrupt,
      new
      {
        user_id = userId,
        login_id = userId,
        bridge_id = bridgeId,
        issue_id = issueId,
        reason = arguments?["reason"]?.ToString() ?? "voice_interrupt_request"
      },
      cancellationToken);

    return new JsonObject
    {
      ["ok"] = payload?["accepted"]?.GetValue<bool?>() ?? false,
      ["issue_id"] = issueId,
      ["bridge"] = payload?.DeepClone()
    };
  }

  private static DateTimeOffset ParseTimestamp(string? value)
  {
    return DateTimeOffset.TryParse(value, out var parsed)
      ? parsed
      : DateTimeOffset.MinValue;
  }

  private static string BuildProgramSummary(
    JObject? project,
    JObject? thread,
    JsonObject? continuityPayload,
    string latestHandoffSummary,
    JsonArray recentMessages)
  {
    var segments = new List<string>();
    var projectName = project?.Value<string>("name")?.Trim();
    var workspacePath = project?.Value<string>("workspace_path")?.Trim();
    var projectInstructions = project?.Value<string>("developer_instructions")?.Trim();
    var projectBaseInstructions = project?.Value<string>("base_instructions")?.Trim();
    var threadTitle = thread?.Value<string>("title")?.Trim();
    var threadStatus = thread?.Value<string>("status")?.Trim();
    var continuityStatus = continuityPayload?["root_thread"]?["continuity_status"]?.ToString()?.Trim()
      ?? thread?.Value<string>("continuity_status")?.Trim();
    var activePhysicalThreadId = continuityPayload?["active_physical_thread"]?["id"]?.ToString()?.Trim();

    if (!string.IsNullOrWhiteSpace(projectName))
    {
      segments.Add($"프로젝트 {projectName}");
    }

    if (!string.IsNullOrWhiteSpace(threadTitle))
    {
      segments.Add($"현재 쓰레드 {threadTitle}");
    }

    if (!string.IsNullOrWhiteSpace(threadStatus))
    {
      segments.Add($"쓰레드 상태 {threadStatus}");
    }

    if (!string.IsNullOrWhiteSpace(continuityStatus))
    {
      segments.Add($"연속성 상태 {continuityStatus}");
    }

    if (!string.IsNullOrWhiteSpace(activePhysicalThreadId))
    {
      segments.Add($"활성 physical thread {activePhysicalThreadId}");
    }

    if (!string.IsNullOrWhiteSpace(workspacePath))
    {
      segments.Add($"작업 경로 {workspacePath}");
    }

    if (!string.IsNullOrWhiteSpace(projectBaseInstructions))
    {
      segments.Add($"공통 지침 {CompactInline(projectBaseInstructions, 180)}");
    }

    if (!string.IsNullOrWhiteSpace(projectInstructions))
    {
      segments.Add($"개발 지침 {CompactInline(projectInstructions, 180)}");
    }

    if (!string.IsNullOrWhiteSpace(latestHandoffSummary))
    {
      segments.Add($"최신 handoff {CompactInline(latestHandoffSummary, 180)}");
    }

    var recentConversation = recentMessages
      .OfType<JsonObject>()
      .Select(message =>
      {
        var role = message["role"]?.ToString()?.Trim();
        var content = CompactInline(message["content"]?.ToString(), 90);

        if (string.IsNullOrWhiteSpace(role) || string.IsNullOrWhiteSpace(content))
        {
          return null;
        }

        return $"{role}: {content}";
      })
      .Where(value => !string.IsNullOrWhiteSpace(value))
      .TakeLast(4)
      .ToArray();

    if (recentConversation.Length > 0)
    {
      segments.Add($"최근 대화 {string.Join(" / ", recentConversation)}");
    }

    return string.Join(". ", segments.Where(value => !string.IsNullOrWhiteSpace(value)));
  }

  private static string BuildFileContextSummary(JArray issueBoard, JsonArray recentMessages)
  {
    var items = new List<string>();
    var seen = new HashSet<string>(StringComparer.Ordinal);

    foreach (var issue in issueBoard.OfType<JObject>())
    {
      AppendNewtonsoftAttachmentSummaries(items, seen, issue["attachments"] as JArray);
    }

    foreach (var message in recentMessages.OfType<JsonObject>())
    {
      AppendJsonAttachmentSummaries(items, seen, message["attachments"] as JsonArray);
    }

    return items.Count == 0 ? string.Empty : string.Join(" | ", items.Take(8));
  }

  private static void AppendNewtonsoftAttachmentSummaries(List<string> items, HashSet<string> seen, JArray? attachments)
  {
    if (attachments is null)
    {
      return;
    }

    foreach (var attachment in attachments.OfType<JObject>())
    {
      AppendAttachmentSummary(
        items,
        seen,
        attachment.Value<string>("name")?.Trim(),
        attachment.Value<string>("mime_type")?.Trim(),
        CompactInline(attachment.Value<string>("text_content"), 80));
    }
  }

  private static void AppendJsonAttachmentSummaries(List<string> items, HashSet<string> seen, JsonArray? attachments)
  {
    if (attachments is null)
    {
      return;
    }

    foreach (var attachment in attachments.OfType<JsonObject>())
    {
      AppendAttachmentSummary(
        items,
        seen,
        attachment["name"]?.ToString()?.Trim(),
        attachment["mime_type"]?.ToString()?.Trim(),
        CompactInline(attachment["text_content"]?.ToString(), 80));
    }
  }

  private static void AppendAttachmentSummary(List<string> items, HashSet<string> seen, string? name, string? mimeType, string? textContent)
  {
    if (string.IsNullOrWhiteSpace(name) && string.IsNullOrWhiteSpace(textContent))
    {
      return;
    }

    var summary = !string.IsNullOrWhiteSpace(name)
      ? !string.IsNullOrWhiteSpace(textContent)
        ? $"{name}{(!string.IsNullOrWhiteSpace(mimeType) ? $" ({mimeType})" : string.Empty)}: {textContent}"
        : $"{name}{(!string.IsNullOrWhiteSpace(mimeType) ? $" ({mimeType})" : string.Empty)}"
      : textContent;

    if (string.IsNullOrWhiteSpace(summary) || !seen.Add(summary))
    {
      return;
    }

    items.Add(summary);
  }

  private static string CompactInline(string? value, int maxLength)
  {
    var normalized = string.Join(
      " ",
      (value ?? string.Empty)
        .Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
      .Trim();

    if (normalized.Length <= maxLength)
    {
      return normalized;
    }

    return $"{normalized[..maxLength].TrimEnd()}…";
  }
}
