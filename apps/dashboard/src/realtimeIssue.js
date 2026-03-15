export function resolveRealtimeIssuePayloadScope(payload = {}) {
  return {
    issueId: String(payload.issue_id ?? payload.issueId ?? payload.issue?.id ?? "").trim(),
    threadId: String(
      payload.thread_id ??
      payload.threadId ??
      payload.issue?.thread_id ??
      payload.issue?.threadId ??
      payload.issue?.root_thread_id ??
      payload.issue?.rootThreadId ??
      ""
    ).trim(),
    projectId: String(
      payload.project_id ??
      payload.projectId ??
      payload.issue?.project_id ??
      payload.issue?.projectId ??
      ""
    ).trim()
  };
}

export function mergeIncomingIssueSnapshot(incomingIssue, { currentIssue = null, fallbackThreadId = null } = {}) {
  if (!incomingIssue?.id) {
    return null;
  }

  const threadId = incomingIssue.thread_id ?? currentIssue?.thread_id ?? fallbackThreadId ?? null;

  return {
    ...(currentIssue ?? {}),
    ...incomingIssue,
    thread_id: threadId,
    root_thread_id: incomingIssue.root_thread_id ?? currentIssue?.root_thread_id ?? threadId
  };
}

export function shouldApplyRealtimeIssueToSelectedThread(selectedThreadId, targetThreadId) {
  if (!selectedThreadId || !targetThreadId) {
    return false;
  }

  return selectedThreadId === targetThreadId;
}
