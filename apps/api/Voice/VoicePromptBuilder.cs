using System.Collections.Generic;

namespace OctOP.Gateway.Voice;

public sealed class VoicePromptBuilder
{
  public string BuildInstructions(VoiceSessionStartRequest request)
  {
    var sections = new List<string>
    {
      BuildVoiceRoleInstructionBlock(request),
      BuildProjectContextBlock(request),
      BuildOptionalVoicePreferenceBlock(request)
    };

    return string.Join("\n\n", sections.Where(section => !string.IsNullOrWhiteSpace(section)));
  }

  public string BuildTranscriptionPrompt(VoiceSessionStartRequest request)
  {
    var voicePreferenceSummary = BuildVoicePreferenceSummary(request);
    var fragments = new List<string>
    {
      $"프로젝트: {Normalize(request.ProjectName, "프로젝트 미지정")}",
      $"쓰레드: {Normalize(request.ThreadTitle, "현재 채팅")}",
      $"상태: {Normalize(request.ThreadStatusLabel, "상태 미확인")}",
      "전사 목적: 사용자 발화를 정확히 받아 app-server 작업 위임과 상태 보고에 사용"
    };

    AppendInlineFragment(fragments, "음성 역할", "짧게 이해하고 app-server에 위임한 뒤 상태와 결과만 간단히 보고");
    AppendInlineFragment(fragments, "음성 메모", voicePreferenceSummary);
    AppendInlineFragment(fragments, "작업 경로", request.ProjectWorkspacePath);
    AppendInlineFragment(fragments, "프로그램 요약", request.ProjectProgramSummary);
    AppendInlineFragment(fragments, "파일 정보", request.ThreadFileContextSummary);
    AppendInlineFragment(fragments, "연속성", request.ThreadContinuitySummary);
    AppendInlineFragment(fragments, "핸드오프", request.LatestHandoffSummary);
    AppendInlineFragment(fragments, "최근 대화", request.RecentConversationSummary);

    var prompt = string.Join(" | ", fragments.Where(fragment => !string.IsNullOrWhiteSpace(fragment))).Trim();
    return prompt.Length <= 900 ? prompt : $"{prompt[..900].TrimEnd()}…";
  }

  private static string BuildVoiceRoleInstructionBlock(VoiceSessionStartRequest request)
  {
    var hasThreadContext = !string.IsNullOrWhiteSpace(request.ThreadId);

    var sections = new List<string>
    {
      "[음성 세션 역할 지침]",
      "당신은 OctOP의 실시간 음성 작업 비서입니다.",
      "직접 구현을 길게 설명하는 것이 아니라, 사용자의 요청을 정확히 이해해 app-server 작업으로 연결하고 진행 상황과 결과를 짧고 자연스럽게 전달하는 것이 핵심 역할입니다.",
      "항상 한국어로 짧고 또렷하게 말합니다.",
      "한 번의 음성 응답은 보통 한두 문장으로 유지합니다.",
      "파일 경로, 코드, 명령어, 장문의 로그를 그대로 읽지 말고 의미만 자연스럽게 요약합니다.",
      "함수 결과와 app-server가 준 진행 리포트, 확정 응답만 근거로 말하고 추측하지 않습니다.",
      "사용자의 요청이 작업, 수정, 조사, 실행, 확인이라면 먼저 delegate_to_app_server 함수를 호출합니다.",
      hasThreadContext
        ? "이미 진행 중인 쓰레드 문맥이 있으므로 그 흐름을 이어서 대화하고 app-server 결과를 짧게 보고합니다."
        : "현재는 최초 음성채팅이므로 빠르게 의도를 파악하고 작업 시작이 가능하면 새 쓰레드 생성과 app-server 위임을 우선합니다.",
      hasThreadContext
        ? "사용자가 현재 진행 상황이나 상태를 물으면 get_thread_status 함수를 호출해 확인한 뒤 짧게 보고합니다."
        : "아직 작업 쓰레드가 생기기 전에는 진행 상황을 추측하지 말고 먼저 위임 여부를 판단합니다.",
      hasThreadContext
        ? "사용자가 중단이나 취소를 요청하면 interrupt_active_issue 함수를 호출합니다."
        : "활성 작업 쓰레드가 생긴 뒤에만 중단 함수를 사용합니다.",
      "사용자 요청이 모호할 때만 한 가지 핵심만 짧게 확인합니다.",
      "장황한 설명보다 현재 할 일, 진행 상태, 다음 행동을 우선 말합니다."
    };

    return string.Join("\n\n", sections);
  }

  private static string BuildProjectContextBlock(VoiceSessionStartRequest request)
  {
    var projectName = Normalize(request.ProjectName, "프로젝트 미지정");
    var threadTitle = Normalize(request.ThreadTitle, "현재 채팅");
    var threadStatus = Normalize(request.ThreadStatusLabel, "상태 미확인");
    var latestUserText = Normalize(request.LatestUserText, "아직 최근 사용자 발화가 없습니다.");
    var latestAssistantText = Normalize(request.LatestAssistantText, "아직 최근 응답이 없습니다.");
    var sections = new List<string>
    {
      "[프로젝트 컨텍스트]",
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
    AppendSection(sections, "최신 handoff summary", request.LatestHandoffSummary);
    AppendSection(sections, "최근 대화 요약", request.RecentConversationSummary);

    return string.Join("\n\n", sections.Where(section => !string.IsNullOrWhiteSpace(section)));
  }

  private static string BuildOptionalVoicePreferenceBlock(VoiceSessionStartRequest request)
  {
    var projectBaseMemo = NormalizeInstructionText(request.ProjectBaseInstructions);
    var projectWorkMemo = NormalizeInstructionText(request.ProjectDeveloperInstructions);
    var threadMemo = NormalizeInstructionText(request.ThreadDeveloperInstructions);

    if (string.IsNullOrWhiteSpace(projectBaseMemo) &&
        string.IsNullOrWhiteSpace(projectWorkMemo) &&
        string.IsNullOrWhiteSpace(threadMemo))
    {
      return string.Empty;
    }

    var sections = new List<string>
    {
      "[선택적 음성 선호 및 운영 메모]",
      "아래 메모는 음성 보고 방식과 작업 이해를 돕는 참고 정보입니다.",
      "일반 채팅용 기본지침이나 개발지침처럼 엄격한 시스템 규칙으로 다루지 말고, 음성 대화에 맞게 짧고 자연스럽게만 반영합니다."
    };

    if (!string.IsNullOrWhiteSpace(projectBaseMemo))
    {
      sections.Add($"[프로젝트 운영 메모]\n{projectBaseMemo}");
    }

    if (!string.IsNullOrWhiteSpace(projectWorkMemo))
    {
      sections.Add($"[프로젝트 작업 메모]\n{projectWorkMemo}");
    }

    if (!string.IsNullOrWhiteSpace(threadMemo))
    {
      sections.Add($"[현재 쓰레드 메모]\n{threadMemo}");
    }

    return string.Join("\n\n", sections);
  }

  private static string BuildVoicePreferenceSummary(VoiceSessionStartRequest request)
  {
    var fragments = new List<string>();

    AppendCompactSummaryFragment(fragments, "프로젝트 운영 메모", request.ProjectBaseInstructions);
    AppendCompactSummaryFragment(fragments, "프로젝트 작업 메모", request.ProjectDeveloperInstructions);
    AppendCompactSummaryFragment(fragments, "현재 쓰레드 메모", request.ThreadDeveloperInstructions);

    return string.Join(" / ", fragments.Where(fragment => !string.IsNullOrWhiteSpace(fragment)));
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

  private static void AppendCompactSummaryFragment(List<string> fragments, string label, string? value)
  {
    var normalized = value?.Trim();

    if (string.IsNullOrWhiteSpace(normalized))
    {
      return;
    }

    var compact = string.Join(" ", normalized.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries)).Trim();

    if (compact.Length > 120)
    {
      compact = $"{compact[..120].TrimEnd()}…";
    }

    fragments.Add($"{label} {compact}");
  }
}
