using System.Text.Json.Nodes;

namespace OctOP.Gateway.Voice;

public sealed class VoiceSessionStartRequest
{
  public string? ProjectId { get; init; }
  public string? ThreadId { get; init; }
  public string? ProjectName { get; init; }
  public string? ThreadTitle { get; init; }
  public string? ThreadStatusLabel { get; init; }
  public string? LatestUserText { get; init; }
  public string? LatestAssistantText { get; init; }
}

public sealed class VoiceToolInvocationRequest
{
  public string? ToolName { get; init; }
  public JsonObject? Arguments { get; init; }
  public string? ProjectId { get; init; }
  public string? ThreadId { get; init; }
}
