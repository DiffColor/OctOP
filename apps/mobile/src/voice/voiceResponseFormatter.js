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
