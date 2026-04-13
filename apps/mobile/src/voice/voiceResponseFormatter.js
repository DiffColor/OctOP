const SKIPPED_SECTION_TITLES = new Set(["수정 파일", "수정 경로", "경로", "코드", "명령어"]);
const COMMAND_PREFIXES = [
  "npm ",
  "npx ",
  "pnpm ",
  "yarn ",
  "bun ",
  "git ",
  "dotnet ",
  "node ",
  "python ",
  "pytest ",
  "cargo ",
  "go ",
  "uv "
];

function normalizeInlineText(value) {
  return String(value ?? "")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSectionTitle(value) {
  const normalized = normalizeInlineText(value)
    .replace(/^[\[\(【]\s*/, "")
    .replace(/\s*[\]\)】]$/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "";
  }

  if (normalized.startsWith("변경 사항")) {
    return "변경 사항";
  }

  if (normalized.startsWith("검증 결과")) {
    return "검증 결과";
  }

  if (normalized.startsWith("남은 이슈")) {
    return "남은 이슈";
  }

  if (normalized.startsWith("요약")) {
    return "요약";
  }

  if (normalized.startsWith("핵심")) {
    return "핵심 내용";
  }

  if (normalized.startsWith("다음 단계")) {
    return "다음 단계";
  }

  if (normalized.startsWith("수정 파일")) {
    return "수정 파일";
  }

  if (normalized.startsWith("경로")) {
    return "경로";
  }

  return normalized;
}

function isHeadingLine(line) {
  return /^\[[^\]]+\]$/.test(line) || /^[^:：]{1,30}\s*[:：]$/.test(line);
}

function stripListPrefix(line) {
  return line.replace(/^\s*(?:[-*•]|(?:\d+)[.)])\s*/, "").trim();
}

function isPathLikeLine(line) {
  return /(?:^|[\s(])(?:~\/|\/(?:Users|home|var|tmp|opt|etc|usr)\/|[A-Za-z]:\\|(?:apps|services|packages|playwright|tests|scripts)\/[^\s]+|[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+)(?:$|[\s)])/.test(
    line
  );
}

function isCodeLikeLine(line) {
  if (/^(?:diff --git|index |@@|--- |\+\+\+ )/.test(line)) {
    return true;
  }

  if (COMMAND_PREFIXES.some((prefix) => line.toLowerCase().startsWith(prefix))) {
    return true;
  }

  const symbolCount = (line.match(/[{}[\];\\]|=>|<\/?|^\+|-{2,}/g) ?? []).length;
  return symbolCount >= 3 && /[A-Za-z]/.test(line);
}

function truncateVoiceText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }

  const truncated = text.slice(0, maxLength).replace(/\s+\S*$/, "").trim();
  return truncated ? `${truncated}…` : text.slice(0, maxLength).trim();
}

export function formatAssistantResponseForVoice(content, { maxLength = 420 } = {}) {
  const rawText = String(content ?? "")
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/\r/g, "");

  if (!rawText.trim()) {
    return "";
  }

  const sectionEntries = [];
  const pushSection = (title) => {
    const normalizedTitle = normalizeSectionTitle(title) || "핵심 내용";
    let section = sectionEntries.find((entry) => entry.title === normalizedTitle);

    if (!section) {
      section = { title: normalizedTitle, lines: [] };
      sectionEntries.push(section);
    }

    return section;
  };

  let currentSection = pushSection("핵심 내용");

  for (const rawLine of rawText.split("\n")) {
    const trimmedLine = String(rawLine ?? "").trim();

    if (!trimmedLine) {
      continue;
    }

    if (isHeadingLine(trimmedLine)) {
      const headingText = trimmedLine.replace(/\s*[:：]$/, "");
      currentSection = pushSection(headingText);
      continue;
    }

    const line = normalizeInlineText(stripListPrefix(trimmedLine));

    if (!line || /^[`]+$/.test(line)) {
      continue;
    }

    if (SKIPPED_SECTION_TITLES.has(currentSection.title)) {
      continue;
    }

    if (isPathLikeLine(line) || isCodeLikeLine(line) || /^[a-f0-9]{7,40}$/i.test(line)) {
      continue;
    }

    const previousLine = currentSection.lines.at(-1);

    if (previousLine === line) {
      continue;
    }

    currentSection.lines.push(line);
  }

  const segments = sectionEntries
    .filter((section) => section.lines.length > 0 && !SKIPPED_SECTION_TITLES.has(section.title))
    .map((section) => {
      if (section.title === "핵심 내용") {
        return section.lines.join(" ");
      }

      return `${section.title}. ${section.lines.join(" ")}`;
    })
    .filter(Boolean);

  const joined = segments.join(" ").replace(/\s+/g, " ").trim();
  return truncateVoiceText(joined, maxLength);
}

export function formatProjectProgramSummaryForVoice(
  {
    projectName = "",
    workspacePath = "",
    projectBaseInstructions = "",
    projectDeveloperInstructions = "",
    threadTitle = "",
    threadStatusLabel = "",
    threadContinuitySummary = "",
    latestHandoffSummary = "",
    recentConversationSummary = ""
  },
  { maxLength = 720 } = {}
) {
  const segments = [];
  const normalizedProjectName = normalizeInlineText(projectName);
  const normalizedThreadTitle = normalizeInlineText(threadTitle);
  const normalizedThreadStatus = normalizeInlineText(threadStatusLabel);
  const normalizedWorkspacePath = normalizeInlineText(workspacePath);
  const normalizedBaseInstructions = normalizeInlineText(projectBaseInstructions);
  const normalizedDeveloperInstructions = normalizeInlineText(projectDeveloperInstructions);
  const normalizedContinuity = normalizeInlineText(threadContinuitySummary);
  const normalizedHandoff = normalizeInlineText(latestHandoffSummary);
  const normalizedConversation = normalizeInlineText(recentConversationSummary);

  if (normalizedProjectName) {
    segments.push(`프로젝트는 ${normalizedProjectName}입니다.`);
  }

  if (normalizedThreadTitle) {
    segments.push(`현재 작업 쓰레드는 ${normalizedThreadTitle}입니다.`);
  }

  if (normalizedThreadStatus) {
    segments.push(`현재 쓰레드 상태는 ${normalizedThreadStatus}입니다.`);
  }

  if (normalizedWorkspacePath) {
    segments.push(`작업 경로는 ${normalizedWorkspacePath}입니다.`);
  }

  if (normalizedBaseInstructions) {
    segments.push(`프로젝트 공통 지침은 ${truncateVoiceText(normalizedBaseInstructions, 180)}입니다.`);
  }

  if (normalizedDeveloperInstructions) {
    segments.push(`프로젝트 개발 지침은 ${truncateVoiceText(normalizedDeveloperInstructions, 180)}입니다.`);
  }

  if (normalizedContinuity) {
    segments.push(`쓰레드 연속성 정보는 ${truncateVoiceText(normalizedContinuity, 180)}입니다.`);
  }

  if (normalizedHandoff) {
    segments.push(`최신 handoff 요약은 ${truncateVoiceText(normalizedHandoff, 180)}입니다.`);
  }

  if (normalizedConversation) {
    segments.push(`최근 대화 핵심은 ${truncateVoiceText(normalizedConversation, 220)}입니다.`);
  }

  return truncateVoiceText(segments.join(" ").replace(/\s+/g, " ").trim(), maxLength);
}

export function formatFileContextSummaryForVoice(attachments = [], { maxLength = 420, maxItems = 6 } = {}) {
  const normalizedAttachments = Array.isArray(attachments) ? attachments : [];
  const seen = new Set();
  const parts = [];

  for (const attachment of normalizedAttachments) {
    const name = normalizeInlineText(attachment?.name);
    const mimeType = normalizeInlineText(attachment?.mime_type);
    const textContent = normalizeInlineText(attachment?.text_content);

    if (!name && !textContent) {
      continue;
    }

    const summary = name
      ? `${name}${mimeType ? ` (${mimeType})` : ""}${textContent ? `: ${truncateVoiceText(textContent, 90)}` : ""}`
      : truncateVoiceText(textContent, 90);

    if (!summary || seen.has(summary)) {
      continue;
    }

    seen.add(summary);
    parts.push(summary);

    if (parts.length >= maxItems) {
      break;
    }
  }

  if (parts.length === 0) {
    return "";
  }

  return truncateVoiceText(`최근 파일 정보는 ${parts.join(" | ")}입니다.`, maxLength);
}

export function formatVoiceExecutionReportForVoice(
  {
    prompt = "",
    issueTitle = "",
    progressText = "",
    lastMessage = ""
  },
  { maxLength = 320 } = {}
) {
  const normalizedPrompt = normalizeInlineText(prompt);
  const normalizedIssueTitle = normalizeInlineText(issueTitle);
  const normalizedProgressText = normalizeInlineText(progressText);
  const normalizedLastMessage = normalizeInlineText(lastMessage);
  const segments = ["요청을 app-server에 전달했습니다."];

  if (normalizedPrompt) {
    segments.push(`요청 내용은 ${truncateVoiceText(normalizedPrompt, 120)}입니다.`);
  }

  if (normalizedIssueTitle && normalizedIssueTitle !== normalizedPrompt) {
    segments.push(`현재 이슈는 ${truncateVoiceText(normalizedIssueTitle, 100)}입니다.`);
  }

  if (normalizedProgressText) {
    segments.push(`진행 상태는 ${truncateVoiceText(normalizedProgressText, 72)}입니다.`);
  }

  if (normalizedLastMessage) {
    segments.push(`최근 상태 메시지는 ${truncateVoiceText(normalizedLastMessage, 120)}입니다.`);
  }

  return truncateVoiceText(segments.join(" ").replace(/\s+/g, " ").trim(), maxLength);
}
