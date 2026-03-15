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
  if (!selectedThreadId) {
    return false;
  }

  if (!targetThreadId) {
    return true;
  }

  return selectedThreadId === targetThreadId;
}
