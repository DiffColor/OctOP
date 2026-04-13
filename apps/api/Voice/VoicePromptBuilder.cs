using System.Collections.Generic;
using System.Text.Json.Nodes;

namespace OctOP.Gateway.Voice;

public sealed class VoicePromptBuilder
{
  public string BuildInstructions(VoiceSessionStartRequest request)
  {
    var projectName = Normalize(request.ProjectName, "프로젝트 미지정");
    var threadTitle = Normalize(request.ThreadTitle, "현재 채팅");
    var threadStatus = Normalize(request.ThreadStatusLabel, "상태 미확인");
    var latestUserText = Normalize(request.LatestUserText, "아직 최근 사용자 발화가 없습니다.");
    var latestAssistantText = Normalize(request.LatestAssistantText, "아직 최근 응답이 없습니다.");
    var sections = new List<string>
    {
      "당신은 OctOP의 실시간 음성 비서입니다.",
      "항상 한국어로 간결하고 분명하게 말합니다.",
      "현재 선택된 프로젝트, 워크스페이스 경로, 쓰레드, handoff summary, 최근 대화 문맥을 최우선으로 사용합니다.",
      "프로젝트나 소스 맥락이 불충분하거나 최신 상태가 의심되면 get_project_context tool로 현재 문맥을 다시 조회합니다.",
      "사용자가 작업 실행, 중단, 상태 확인을 요청하면 정의된 function tool을 호출합니다.",
      "tool 없이 추측으로 실행 상태를 말하지 않습니다.",
      "tool 결과를 받으면 핵심만 짧게 요약하고 다음 행동을 제안합니다.",
      $"현재 프로젝트: {projectName}",
      $"현재 쓰레드: {threadTitle}",
      $"현재 쓰레드 상태 라벨: {threadStatus}",
      $"최근 사용자 텍스트: {latestUserText}",
      $"최근 어시스턴트 텍스트: {latestAssistantText}"
    };

    AppendLine(sections, "현재 프로젝트 작업 경로", request.ProjectWorkspacePath);
    AppendLine(sections, "현재 쓰레드 continuity", request.ThreadContinuitySummary);
    AppendSection(sections, "프로젝트 공통 지침", request.ProjectBaseInstructions);
    AppendSection(sections, "프로젝트 개발 지침", request.ProjectDeveloperInstructions);
    AppendSection(sections, "현재 쓰레드 개발 지침", request.ThreadDeveloperInstructions);
    AppendSection(sections, "최신 handoff summary", request.LatestHandoffSummary);
    AppendSection(sections, "최근 대화 요약", request.RecentConversationSummary);

    return string.Join("\n\n", sections.Where(section => !string.IsNullOrWhiteSpace(section)));
  }

  public JsonArray BuildTools()
  {
    return new JsonArray(
      BuildTool(
        "get_project_context",
        "현재 프로젝트, 워크스페이스 경로, 쓰레드 continuity, 최신 handoff summary, 최근 대화 문맥을 다시 조회합니다.",
        new JsonObject()),
      BuildTool(
        "get_thread_status",
        "현재 선택된 쓰레드의 실행 상태와 활성 이슈를 조회합니다.",
        new JsonObject()),
      BuildTool(
        "start_thread_run",
        "현재 선택된 쓰레드에서 대기 중인 이슈를 실행합니다. 특정 이슈만 실행하려면 issue_ids를 전달합니다.",
        new JsonObject
        {
          ["type"] = "object",
          ["properties"] = new JsonObject
          {
            ["issue_ids"] = new JsonObject
            {
              ["type"] = "array",
              ["items"] = new JsonObject
              {
                ["type"] = "string"
              },
              ["description"] = "실행할 이슈 ID 목록입니다. 생략하면 현재 쓰레드의 대기 이슈를 실행합니다."
            }
          }
        }),
      BuildTool(
        "stop_thread_run",
        "현재 선택된 쓰레드의 실행을 안전하게 정지합니다.",
        new JsonObject
        {
          ["type"] = "object",
          ["properties"] = new JsonObject
          {
            ["reason"] = new JsonObject
            {
              ["type"] = "string",
              ["description"] = "정지 사유입니다."
            }
          }
        }),
      BuildTool(
        "interrupt_active_issue",
        "현재 실행 중인 이슈를 중단합니다. issue_id를 주면 해당 이슈를 우선 중단합니다.",
        new JsonObject
        {
          ["type"] = "object",
          ["properties"] = new JsonObject
          {
            ["issue_id"] = new JsonObject
            {
              ["type"] = "string",
              ["description"] = "중단할 이슈 ID입니다."
            },
            ["reason"] = new JsonObject
            {
              ["type"] = "string",
              ["description"] = "중단 사유입니다."
            }
          }
        }));
  }

  private static JsonObject BuildTool(string name, string description, JsonObject? parameters)
  {
    return new JsonObject
    {
      ["type"] = "function",
      ["name"] = name,
      ["description"] = description,
      ["parameters"] = parameters ?? new JsonObject
      {
        ["type"] = "object",
        ["properties"] = new JsonObject()
      }
    };
  }

  private static string Normalize(string? value, string fallback)
  {
    var normalized = value?.Trim();
    return string.IsNullOrWhiteSpace(normalized) ? fallback : normalized;
  }

  private static void AppendLine(List<string> sections, string label, string? value)
  {
    var normalized = value?.Trim();

    if (string.IsNullOrWhiteSpace(normalized))
    {
      return;
    }

    sections.Add($"{label}: {normalized}");
  }

  private static void AppendSection(List<string> sections, string heading, string? value)
  {
    var normalized = value?.Trim();

    if (string.IsNullOrWhiteSpace(normalized))
    {
      return;
    }

    sections.Add($"[{heading}]\n{normalized}");
  }
}
