export const PROGRESS_HISTORY_HEADING = "[진행 내역]";
const SECTION_HEADING_PATTERN = /^\[[^\]]+\]$/;
const REPEATED_PROGRESS_PREFIX_PATTERN = /^(\s*[-*]\s*)?\[진행 내역\](?:\s*[:：-]\s*)?(.*)$/;

function normalizeProgressHistoryLine(line = "", insideProgressHistorySection = false) {
  if (!insideProgressHistorySection) {
    return String(line ?? "");
  }

  const normalizedLine = String(line ?? "");
  const match = normalizedLine.match(REPEATED_PROGRESS_PREFIX_PATTERN);

  if (!match) {
    return normalizedLine;
  }

  const [, bullet = "", rest = ""] = match;
  const normalizedRest = String(rest ?? "").replace(/^\s+/, "");

  if (!normalizedRest.trim()) {
    return "";
  }

  return `${bullet}${normalizedRest}`;
}

export function normalizeAssistantMessageContent(content = "") {
  const normalized = String(content ?? "");

  if (!normalized) {
    return "";
  }

  const lines = normalized.split("\n");
  const result = [];
  let seenProgressHistoryHeading = false;
  let skippedDuplicateHeading = false;
  let insideProgressHistorySection = false;

  for (const line of lines) {
    const trimmed = String(line ?? "").trim();
    const isSectionHeading = SECTION_HEADING_PATTERN.test(trimmed);

    if (trimmed === PROGRESS_HISTORY_HEADING) {
      if (seenProgressHistoryHeading) {
        skippedDuplicateHeading = true;
        continue;
      }

      seenProgressHistoryHeading = true;
      skippedDuplicateHeading = false;
      insideProgressHistorySection = true;
      result.push(PROGRESS_HISTORY_HEADING);
      continue;
    }

    if (isSectionHeading) {
      insideProgressHistorySection = false;
    }

    const normalizedLine = normalizeProgressHistoryLine(line, insideProgressHistorySection);
    const normalizedTrimmed = normalizedLine.trim();

    if (skippedDuplicateHeading && normalizedTrimmed === "" && String(result.at(-1) ?? "").trim() === "") {
      continue;
    }

    skippedDuplicateHeading = false;
    result.push(normalizedLine);
  }

  return result.join("\n");
}
