export default function buildMobileDetailProps({
  selectedTodoChat,
  todoChatDetail,
  selectedBridgeId,
  todoChatMessages,
  todoChatLoading,
  todoChatError,
  todoBusy,
  todoComposerDraftKey,
  todoComposerDraft,
  onChangeThreadComposerDraft,
  onBackToInbox,
  onRefreshTodoChat,
  setTodoChatBeingEdited,
  setActiveTodoMessage,
  onSubmitTodoMessage,
  inlineIssueComposerHelpers,
  todoChatDetailUiComponents,
  todoChatDetailUtils,
  onDeleteTodoChat,
  resolvedThread,
  threadProject,
  session,
  apiRequest,
  threadDetailMessages,
  threadDetail,
  hasOlderMessages,
  remainingHistoryCount,
  onLoadOlderMessages,
  signalNow,
  threadDetailLoading,
  threadDetailError,
  onRefreshThreadDetail,
  onStopThreadExecution,
  onInterruptThreadIssue,
  onRetryThreadIssue,
  onDeleteThreadIssue,
  threadInstructionSupported,
  onAppendThreadMessage,
  onCreateThread,
  threadBusy,
  threadMessageFilter,
  onChangeThreadMessageFilter,
  threadComposerDraftKey,
  threadComposerDraft,
  selectedThread,
  VOICE_SESSION_ENABLED,
  threadVoiceState,
  voiceFollowupThreadDetail,
  onChangeThreadVoiceState,
  threadDetailHelpers,
  selectedThreadId,
  draftThreadProjectId,
  splitThreadEmptyStateMessage,
  onRegisterDetailBackHandler
}) {
  const resolvedTodoChatForDetail = selectedTodoChat ?? todoChatDetail?.chat ?? null;
  const handleDeleteResolvedTodoChat = () => {
    const targetChat = resolvedTodoChatForDetail;

    if (!targetChat) {
      return;
    }

    void onDeleteTodoChat(targetChat.id);
  };

  const todoStandaloneDetailProps = {
    chat: resolvedTodoChatForDetail,
    bridgeId: selectedBridgeId,
    messages: todoChatMessages,
    loading: todoChatLoading,
    error: todoChatError,
    submitBusy: todoBusy,
    composerDraftKey: todoComposerDraftKey,
    composerDraft: todoComposerDraft,
    onPersistComposerDraft: onChangeThreadComposerDraft,
    onBack: onBackToInbox,
    onRefresh: onRefreshTodoChat,
    onRename: () => setTodoChatBeingEdited(resolvedTodoChatForDetail),
    onDelete: handleDeleteResolvedTodoChat,
    onSelectMessage: (message) => setActiveTodoMessage(message),
    onSubmitMessage: onSubmitTodoMessage,
    inlineIssueComposerHelpers,
    uiComponents: todoChatDetailUiComponents,
    utils: todoChatDetailUtils,
    onRegisterBackHandler: onRegisterDetailBackHandler
  };

  const todoSplitDetailProps = {
    ...todoStandaloneDetailProps,
    showBackButton: false,
    standalone: false
  };

  const baseThreadDetailProps = {
    thread: resolvedThread,
    project: threadProject,
    bridgeId: selectedBridgeId,
    sessionLoginId: session?.loginId ?? "",
    apiRequest,
    messages: resolvedThread ? threadDetailMessages : [],
    issues: resolvedThread ? threadDetail?.issues ?? [] : [],
    historyLoading: threadDetail?.history_loading ?? false,
    historyError: threadDetail?.history_error ?? "",
    hasOlderMessages: Boolean(resolvedThread?.id) && hasOlderMessages,
    remainingHistoryCount,
    onLoadOlderMessages: resolvedThread?.id ? () => onLoadOlderMessages?.(resolvedThread.id) : null,
    signalNow,
    messagesLoading: threadDetailLoading,
    messagesError: threadDetailError,
    onRefreshMessages: resolvedThread?.id ? onRefreshThreadDetail : null,
    onStopThreadExecution: resolvedThread?.id ? onStopThreadExecution : null,
    onInterruptIssue: resolvedThread?.id ? onInterruptThreadIssue : null,
    onRetryIssue: resolvedThread?.id ? onRetryThreadIssue : null,
    onDeleteIssue: resolvedThread?.id ? onDeleteThreadIssue : null,
    threadInstructionSupported,
    onSubmitPrompt: (payload) => {
      if (resolvedThread?.id) {
        return onAppendThreadMessage(resolvedThread.id, payload);
      }

      return onCreateThread(payload, { stayOnThread: true });
    },
    onVoiceDelegatePrompt: (payload) =>
      onCreateThread(
        {
          ...payload,
          project_id: resolvedThread?.project_id ?? threadProject?.id ?? payload?.project_id
        },
        { stayOnThread: true, preserveCurrentThreadSelection: true }
      ),
    submitBusy: threadBusy,
    onBack: onBackToInbox,
    messageFilter: threadMessageFilter,
    onChangeMessageFilter: onChangeThreadMessageFilter,
    composerDraftKey: threadComposerDraftKey,
    composerDraft: threadComposerDraft,
    onPersistComposerDraft: onChangeThreadComposerDraft,
    isDraft: !selectedThread && !threadDetail?.thread,
    voiceSessionEnabled: VOICE_SESSION_ENABLED,
    voiceState: threadVoiceState,
    voiceFollowupThreadDetail,
    onVoiceStateChange: onChangeThreadVoiceState,
    inlineIssueComposerHelpers,
    helpers: threadDetailHelpers,
    onRegisterBackHandler: onRegisterDetailBackHandler
  };

  const threadStandaloneDetailKey = `thread-detail:${resolvedThread?.id ?? selectedThreadId ?? draftThreadProjectId ?? "empty"}`;
  const threadSplitDetailKey = `split-thread-detail:${resolvedThread?.id ?? selectedThreadId ?? draftThreadProjectId ?? "empty"}`;
  const threadSplitDetailProps = {
    ...baseThreadDetailProps,
    showBackButton: false,
    standalone: false,
    emptyStateMessage: splitThreadEmptyStateMessage
  };

  return {
    todoStandaloneDetailProps,
    todoSplitDetailProps,
    baseThreadDetailProps,
    threadStandaloneDetailKey,
    threadSplitDetailKey,
    threadSplitDetailProps
  };
}
