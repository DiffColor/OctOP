import { normalizeAssistantMessageContent } from "./assistantMessageNormalization.js";
import { mergeAssistantDeltaContent } from "./assistantDelta.js";

const SYSTEM_ACTIVITY_BOUNDARY_KINDS = new Set([
  "tool_call",
  "tool_result",
  "mcp_call",
  "mcp_result",
  "skill_call",
  "skill_result",
  "function_call",
  "function_result"
]);

function normalizeRole(message = {}) {
  if (message?.role === "assistant") {
    return "assistant";
  }

  if (message?.role === "system" || message?.kind === "handoff_summary") {
    return "system";
  }

  return "user";
}

function normalizeKind(message = {}) {
  return typeof message?.kind === "string" ? message.kind : "message";
}

function isSystemActivityBoundaryKind(kind = "") {
  return SYSTEM_ACTIVITY_BOUNDARY_KINDS.has(String(kind ?? "").trim());
}

function resolveLatestTimestamp(currentMessage = {}, nextMessage = {}) {
  const currentTimestamp = Date.parse(currentMessage?.timestamp ?? "");
  const nextTimestamp = Date.parse(nextMessage?.timestamp ?? "");

  if (Number.isFinite(currentTimestamp) && Number.isFinite(nextTimestamp)) {
    return nextTimestamp >= currentTimestamp ? nextMessage.timestamp : currentMessage.timestamp;
  }

  return nextMessage?.timestamp ?? currentMessage?.timestamp ?? new Date().toISOString();
}

function mergeAssistantSnapshotContent(currentContent = "", nextContent = "") {
  const normalizedCurrent = normalizeAssistantMessageContent(String(currentContent ?? ""));
  const normalizedNext = normalizeAssistantMessageContent(String(nextContent ?? ""));

  if (!normalizedCurrent) {
    return normalizedNext;
  }

  if (!normalizedNext) {
    return normalizedCurrent;
  }

  if (normalizedCurrent === normalizedNext) {
    return normalizedCurrent;
  }

  if (normalizedNext.startsWith(normalizedCurrent)) {
    return normalizedNext;
  }

  if (normalizedCurrent.startsWith(normalizedNext) || normalizedCurrent.length > normalizedNext.length) {
    return normalizedCurrent;
  }

  const merged = mergeAssistantDeltaContent(normalizedCurrent, normalizedNext);

  if (merged.startsWith(normalizedCurrent) && merged.length >= normalizedNext.length) {
    return merged;
  }

  return normalizedNext;
}

function selectPreferredPromptMessage(currentMessage, nextMessage) {
  const currentOptimistic = currentMessage?.optimistic === true;
  const nextOptimistic = nextMessage?.optimistic === true;

  if (currentOptimistic !== nextOptimistic) {
    return currentOptimistic ? nextMessage : currentMessage;
  }

  const currentTimestamp = Date.parse(currentMessage?.timestamp ?? "");
  const nextTimestamp = Date.parse(nextMessage?.timestamp ?? "");

  if (Number.isFinite(currentTimestamp) && Number.isFinite(nextTimestamp) && nextTimestamp !== currentTimestamp) {
    return nextTimestamp > currentTimestamp ? nextMessage : currentMessage;
  }

  return nextMessage;
}

function mergeAssistantMessages(currentMessage, nextMessage) {
  return {
    ...currentMessage,
    ...nextMessage,
    id: currentMessage?.id ?? nextMessage?.id,
    role: "assistant",
    kind: normalizeKind(nextMessage),
    content: mergeAssistantSnapshotContent(currentMessage?.content ?? "", nextMessage?.content ?? ""),
    timestamp: resolveLatestTimestamp(currentMessage, nextMessage),
    issue_id: nextMessage?.issue_id ?? currentMessage?.issue_id ?? null,
    issue_title: String(nextMessage?.issue_title ?? currentMessage?.issue_title ?? ""),
    issue_status: String(nextMessage?.issue_status ?? currentMessage?.issue_status ?? ""),
    attachments:
      Array.isArray(nextMessage?.attachments) && nextMessage.attachments.length > 0
        ? nextMessage.attachments
        : currentMessage?.attachments ?? [],
    optimistic: currentMessage?.optimistic === true && nextMessage?.optimistic === true
  };
}

export function consolidateThreadMessages(messages = []) {
  const consolidated = [];
  const promptIndexByIssueId = new Map();
  const assistantIndexBySegmentKey = new Map();
  const assistantSegmentPhaseByIssueId = new Map();
  const lastCategoryByIssueId = new Map();

  (messages ?? []).forEach((message) => {
    if (!message) {
      return;
    }

    const role = normalizeRole(message);
    const kind = normalizeKind(message);
    const issueId = String(message.issue_id ?? "").trim();
    const category =
      role === "assistant" && kind === "message"
        ? "assistant"
        : role === "user" && kind === "prompt"
          ? "prompt"
          : issueId && isSystemActivityBoundaryKind(kind)
            ? "system_activity"
            : "other";

    if (role === "user" && kind === "prompt" && issueId) {
      assistantSegmentPhaseByIssueId.set(issueId, 0);
      lastCategoryByIssueId.set(issueId, "prompt");
      const existingIndex = promptIndexByIssueId.get(issueId);

      if (existingIndex == null) {
        promptIndexByIssueId.set(issueId, consolidated.length);
        consolidated.push(message);
        return;
      }

      consolidated[existingIndex] = selectPreferredPromptMessage(consolidated[existingIndex], message);
      return;
    }

    if (category === "system_activity" && issueId) {
      const previousCategory = lastCategoryByIssueId.get(issueId) ?? "";
      const nextPhase =
        previousCategory === "system_activity"
          ? assistantSegmentPhaseByIssueId.get(issueId) ?? 0
          : (assistantSegmentPhaseByIssueId.get(issueId) ?? 0) + 1;

      assistantSegmentPhaseByIssueId.set(issueId, nextPhase);
      lastCategoryByIssueId.set(issueId, "system_activity");
      consolidated.push(message);
      return;
    }

    if (role === "assistant" && kind === "message") {
      const assistantSegmentKey = issueId
        ? `${issueId}:${assistantSegmentPhaseByIssueId.get(issueId) ?? 0}`
        : `message:${String(message.id ?? "").trim()}`;

      if (!assistantSegmentKey || assistantSegmentKey === "message:") {
        consolidated.push(message);
        return;
      }

      if (issueId) {
        lastCategoryByIssueId.set(issueId, "assistant");
      }

      const existingIndex = assistantIndexBySegmentKey.get(assistantSegmentKey);

      if (existingIndex == null) {
        assistantIndexBySegmentKey.set(assistantSegmentKey, consolidated.length);
        consolidated.push(message);
        return;
      }

      consolidated[existingIndex] = mergeAssistantMessages(consolidated[existingIndex], message);
      return;
    }

    if (issueId) {
      lastCategoryByIssueId.set(issueId, category);
    }

    consolidated.push(message);
  });

  return consolidated;
}
