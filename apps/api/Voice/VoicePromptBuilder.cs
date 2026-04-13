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

    return string.Join(
      "\n",
      [
        "당신은 OctOP의 실시간 음성 비서입니다.",
        "항상 한국어로 간결하고 분명하게 말합니다.",
        "현재 선택된 프로젝트와 쓰레드의 문맥만 사용합니다.",
        "사용자가 작업 실행, 중단, 상태 확인을 요청하면 정의된 function tool을 호출합니다.",
        "tool 없이 추측으로 실행 상태를 말하지 않습니다.",
        "tool 결과를 받으면 핵심만 짧게 요약하고 다음 행동을 제안합니다.",
        $"현재 프로젝트: {projectName}",
        $"현재 쓰레드: {threadTitle}",
        $"현재 쓰레드 상태 라벨: {threadStatus}",
        $"최근 사용자 텍스트: {latestUserText}",
        $"최근 어시스턴트 텍스트: {latestAssistantText}"
      ]);
  }

  public JsonArray BuildTools()
  {
    return new JsonArray(
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
}
