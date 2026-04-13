using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace OctOP.Gateway.Voice;

public sealed class VoiceSessionStartRequest
{
  [JsonPropertyName("project_id")]
  public string? ProjectId { get; init; }

  [JsonPropertyName("thread_id")]
  public string? ThreadId { get; init; }

  [JsonPropertyName("project_name")]
  public string? ProjectName { get; init; }

  [JsonPropertyName("thread_title")]
  public string? ThreadTitle { get; init; }

  [JsonPropertyName("thread_status_label")]
  public string? ThreadStatusLabel { get; init; }

  [JsonPropertyName("latest_user_text")]
  public string? LatestUserText { get; init; }

  [JsonPropertyName("latest_assistant_text")]
  public string? LatestAssistantText { get; init; }

  [JsonPropertyName("project_workspace_path")]
  public string? ProjectWorkspacePath { get; init; }

  [JsonPropertyName("project_base_instructions")]
  public string? ProjectBaseInstructions { get; init; }

  [JsonPropertyName("project_developer_instructions")]
  public string? ProjectDeveloperInstructions { get; init; }

  [JsonPropertyName("thread_developer_instructions")]
  public string? ThreadDeveloperInstructions { get; init; }

  [JsonPropertyName("thread_continuity_summary")]
  public string? ThreadContinuitySummary { get; init; }

  [JsonPropertyName("latest_handoff_summary")]
  public string? LatestHandoffSummary { get; init; }

  [JsonPropertyName("recent_conversation_summary")]
  public string? RecentConversationSummary { get; init; }

  [JsonPropertyName("project_program_summary")]
  public string? ProjectProgramSummary { get; init; }

  [JsonPropertyName("thread_file_context_summary")]
  public string? ThreadFileContextSummary { get; init; }
}

public sealed class VoiceToolInvocationRequest
{
  public string? ToolName { get; init; }
  public JsonObject? Arguments { get; init; }
  public string? ProjectId { get; init; }
  public string? ThreadId { get; init; }
}

public sealed class VoiceNarrationRequest
{
  public string? Text { get; init; }
}
