export const PROGRESS_HISTORY_HEADING = "[진행 내역]";
const SECTION_HEADING_PATTERN = /^\[[^\]]+\]$/;
const REPEATED_PROGRESS_PREFIX_PATTERN = /^(\s*[-*]\s*)?\[진행 내역\](?:\s*[:：-]\s*)?(.*)$/;
const SINGLE_INSTANCE_SECTION_HEADINGS = new Set([
  "[목표]",
  "[계획]",
  "[작업 계획]"
]);
const MERGEABLE_SECTION_HEADINGS = new Set(["[최종 보고]", "[최종 정리]"]);

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
  const seenSingleInstanceSectionHeadings = new Set();
  const seenMergeableSectionHeadings = new Set();
  let seenProgressHistoryHeading = false;
  let skippedDuplicateHeading = false;
  let skippedMergeableHeading = false;
  let insideProgressHistorySection = false;
  let insideSkippedSingleInstanceSection = false;

  for (const line of lines) {
    const trimmed = String(line ?? "").trim();
    const isSectionHeading = SECTION_HEADING_PATTERN.test(trimmed);

    if (isSectionHeading && SINGLE_INSTANCE_SECTION_HEADINGS.has(trimmed)) {
      insideProgressHistorySection = false;
      skippedDuplicateHeading = false;

      if (seenSingleInstanceSectionHeadings.has(trimmed)) {
        insideSkippedSingleInstanceSection = true;
        continue;
      }

      seenSingleInstanceSectionHeadings.add(trimmed);
      insideSkippedSingleInstanceSection = false;
      result.push(trimmed);
      continue;
    }

    if (isSectionHeading && MERGEABLE_SECTION_HEADINGS.has(trimmed)) {
      insideProgressHistorySection = false;
      skippedDuplicateHeading = false;
      insideSkippedSingleInstanceSection = false;

      if (seenMergeableSectionHeadings.has(trimmed)) {
        skippedMergeableHeading = true;
        continue;
      }

      seenMergeableSectionHeadings.add(trimmed);
      skippedMergeableHeading = false;
      result.push(trimmed);
      continue;
    }

    if (trimmed === PROGRESS_HISTORY_HEADING) {
      if (seenProgressHistoryHeading) {
        skippedDuplicateHeading = true;
        skippedMergeableHeading = false;
        insideSkippedSingleInstanceSection = false;
        continue;
      }

      seenProgressHistoryHeading = true;
      skippedDuplicateHeading = false;
      skippedMergeableHeading = false;
      insideProgressHistorySection = true;
      insideSkippedSingleInstanceSection = false;
      result.push(PROGRESS_HISTORY_HEADING);
      continue;
    }

    if (isSectionHeading) {
      insideProgressHistorySection = false;
      skippedMergeableHeading = false;
      insideSkippedSingleInstanceSection = false;
    }

    if (insideSkippedSingleInstanceSection) {
      continue;
    }

    const normalizedLine = normalizeProgressHistoryLine(line, insideProgressHistorySection);
    const normalizedTrimmed = normalizedLine.trim();

    if (skippedDuplicateHeading && normalizedTrimmed === "" && String(result.at(-1) ?? "").trim() === "") {
      continue;
    }

    skippedDuplicateHeading = false;

    if (skippedMergeableHeading && normalizedTrimmed === "" && String(result.at(-1) ?? "").trim() === "") {
      continue;
    }

    skippedMergeableHeading = false;
    result.push(normalizedLine);
  }

  return result.join("\n");
}
