using System.Collections.Generic;

namespace OctOP.Gateway.Voice;

public sealed class VoicePromptBuilder
{
  public string BuildInstructions(VoiceSessionStartRequest request)
  {
    var hasThreadContext = !string.IsNullOrWhiteSpace(request.ThreadId);
    var projectName = Normalize(request.ProjectName, "프로젝트 미지정");
    var threadTitle = Normalize(request.ThreadTitle, "현재 채팅");
    var threadStatus = Normalize(request.ThreadStatusLabel, "상태 미확인");
    var latestUserText = Normalize(request.LatestUserText, "아직 최근 사용자 발화가 없습니다.");
    var latestAssistantText = Normalize(request.LatestAssistantText, "아직 최근 응답이 없습니다.");
    var priorityInstructionBlock = BuildPriorityInstructionBlock(request);
    var sections = new List<string>
    {
      "당신은 OctOP의 실시간 음성 비서입니다.",
      priorityInstructionBlock,
      "항상 한국어로 짧고 자연스럽고 분명하게 말합니다.",
      "초기 대화의 주도권은 현재 Realtime 세션이 가집니다.",
      "사용자와 대화하며 작업 의도와 필요한 맥락을 짧게 확인하고, app-server에 전달할 때는 대화 내용을 요약한 핵심 작업 프롬프트로 정리합니다.",
      hasThreadContext
        ? "현재 세션은 app-server 작업 이후 이어진 쓰레드 문맥입니다. app-server가 주도적으로 작업하고, 당신은 그 진행 요약과 결과를 받아 짧게 리포트하며 대화를 이어갑니다."
        : "현재 세션은 프로젝트 단위의 시작 대화입니다. 아직 작업 쓰레드가 없으면 먼저 사용자와 짧게 대화한 뒤 delegate_to_app_server 함수로 새 작업 쓰레드와 app-server 실행을 시작합니다.",
      "사용자가 작업을 요청하면 먼저 delegate_to_app_server 함수를 호출합니다.",
      hasThreadContext
        ? "사용자가 현재 진행 상황이나 상태를 물으면 get_thread_status 함수를 호출해 확인한 뒤 짧게 보고합니다."
        : "작업 쓰레드가 생기기 전에는 진행 상황을 추측하지 말고, 먼저 app-server 위임 여부를 결정합니다.",
      hasThreadContext
        ? "사용자가 중단이나 취소를 요청하면 interrupt_active_issue 함수를 호출합니다."
        : "활성 작업 쓰레드가 생긴 뒤에만 중단 함수를 사용합니다.",
      "함수 결과와 app-server가 준 진행 리포트, 확정 응답만 근거로 말하고 추측하지 않습니다.",
      "파일 경로, 코드, 명령어, 장문의 보고를 그대로 읽지 말고 핵심만 자연스럽게 요약합니다.",
      "한 번의 음성 보고는 보통 한두 문장으로 유지합니다.",
      "현재 선택된 프로젝트, 워크스페이스 경로, 프로그램 요약, 파일 정보, 쓰레드, handoff summary, 최근 대화 문맥을 최우선으로 사용합니다.",
      "프로젝트와 쓰레드 맥락은 세션 시작 시 app-server가 다시 조회해 전달합니다.",
      "실행 상태나 결과를 추측으로 만들지 않습니다.",
      $"현재 프로젝트: {projectName}",
      $"현재 쓰레드: {threadTitle}",
      $"현재 쓰레드 상태 라벨: {threadStatus}",
      $"최근 사용자 텍스트: {latestUserText}",
      $"최근 어시스턴트 텍스트: {latestAssistantText}"
    };

    AppendLine(sections, "현재 프로젝트 작업 경로", request.ProjectWorkspacePath);
    AppendSection(sections, "프로그램 요약", request.ProjectProgramSummary);
    AppendSection(sections, "파일 정보 요약", request.ThreadFileContextSummary);
    AppendLine(sections, "현재 쓰레드 continuity", request.ThreadContinuitySummary);
    AppendSection(sections, "프로젝트 공통 지침", request.ProjectBaseInstructions);
    AppendSection(sections, "프로젝트 개발 지침", request.ProjectDeveloperInstructions);
    AppendSection(sections, "현재 쓰레드 개발 지침", request.ThreadDeveloperInstructions);
    AppendSection(sections, "최신 handoff summary", request.LatestHandoffSummary);
    AppendSection(sections, "최근 대화 요약", request.RecentConversationSummary);

    return string.Join("\n\n", sections.Where(section => !string.IsNullOrWhiteSpace(section)));
  }

  public string BuildTranscriptionPrompt(VoiceSessionStartRequest request)
  {
    var developerInstructions = MergeInstructionTexts(
      request.ProjectDeveloperInstructions,
      request.ThreadDeveloperInstructions);
    var fragments = new List<string>
    {
      $"프로젝트: {Normalize(request.ProjectName, "프로젝트 미지정")}",
      $"쓰레드: {Normalize(request.ThreadTitle, "현재 채팅")}",
      $"상태: {Normalize(request.ThreadStatusLabel, "상태 미확인")}",
      "전사 목적: 사용자 발화를 정확히 받아 app-server 작업 위임과 상태 보고에 사용"
    };

    AppendInlineFragment(fragments, "기본지침", request.ProjectBaseInstructions);
    AppendInlineFragment(fragments, "개발지침", developerInstructions);
    AppendInlineFragment(fragments, "작업 경로", request.ProjectWorkspacePath);
    AppendInlineFragment(fragments, "프로그램 요약", request.ProjectProgramSummary);
    AppendInlineFragment(fragments, "파일 정보", request.ThreadFileContextSummary);
    AppendInlineFragment(fragments, "연속성", request.ThreadContinuitySummary);
    AppendInlineFragment(fragments, "핸드오프", request.LatestHandoffSummary);
    AppendInlineFragment(fragments, "최근 대화", request.RecentConversationSummary);

    var prompt = string.Join(" | ", fragments.Where(fragment => !string.IsNullOrWhiteSpace(fragment))).Trim();
    return prompt.Length <= 900 ? prompt : $"{prompt[..900].TrimEnd()}…";
  }

  private static string BuildPriorityInstructionBlock(VoiceSessionStartRequest request)
  {
    var baseInstructions = NormalizeInstructionText(request.ProjectBaseInstructions);
    var developerInstructions = MergeInstructionTexts(
      request.ProjectDeveloperInstructions,
      request.ThreadDeveloperInstructions);

    if (string.IsNullOrWhiteSpace(baseInstructions) && string.IsNullOrWhiteSpace(developerInstructions))
    {
      return string.Empty;
    }

    var sections = new List<string>
    {
      "[세션 최우선 지침]",
      "아래 기본지침과 개발지침은 참고사항이 아니라 현재 음성 세션의 최우선 시스템 규칙입니다.",
      "첫 응답, 첫 함수 호출, 첫 작업 요약부터 이미 적용된 상태로 행동하고 다른 운영 문구와 충돌하면 아래 지침을 우선합니다."
    };

    if (!string.IsNullOrWhiteSpace(baseInstructions))
    {
      sections.Add($"[기본지침]\n{baseInstructions}");
    }

    if (!string.IsNullOrWhiteSpace(developerInstructions))
    {
      sections.Add($"[개발지침]\n{developerInstructions}");
    }

    return string.Join("\n\n", sections);
  }

  private static string MergeInstructionTexts(params string?[] values)
  {
    return string.Join(
      "\n\n",
      values
        .Select(NormalizeInstructionText)
        .Where(value => !string.IsNullOrWhiteSpace(value)));
  }

  private static string NormalizeInstructionText(string? value)
  {
    return value?.Trim() ?? string.Empty;
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

  private static void AppendInlineFragment(List<string> fragments, string label, string? value)
  {
    var normalized = value?.Trim();

    if (string.IsNullOrWhiteSpace(normalized))
    {
      return;
    }

    var compact = string.Join(" ", normalized.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries)).Trim();

    if (compact.Length > 180)
    {
      compact = $"{compact[..180].TrimEnd()}…";
    }

    fragments.Add($"{label}: {compact}");
  }
}
