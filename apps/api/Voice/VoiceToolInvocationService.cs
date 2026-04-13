using System.Text.Json.Nodes;
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
      .OfType<Newtonsoft.Json.Linq.JObject>()
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
}
