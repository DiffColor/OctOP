using System.Collections.Generic;

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
      "사용자 음성은 전사 후 app-server의 같은 쓰레드 작업으로 전달됩니다.",
      "판단, 실행, 도구 호출, 최종 응답 생성은 모두 app-server가 주도합니다.",
      "사용자의 발화에 대해 임의로 새 답변을 만들거나 직접 도구를 호출하지 않습니다.",
      "최종 음성 응답은 별도 TTS 경로에서 재생되므로, 이 세션은 임의 응답을 만들거나 읽지 않습니다.",
      "현재 선택된 프로젝트, 워크스페이스 경로, 쓰레드, handoff summary, 최근 대화 문맥을 최우선으로 사용합니다.",
      "프로젝트와 쓰레드 맥락은 세션 시작 시 app-server가 다시 조회해 전달합니다.",
      "실행 상태나 결과를 추측으로 만들지 않습니다.",
      "음성 세션의 역할은 사용자 발화 전사입니다.",
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
