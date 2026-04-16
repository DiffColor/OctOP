export default function buildMobileUiHelperBundles({
  MessageBubble,
  RichMessageContent,
  CHAT_COMPOSER_MAX_HEIGHT_PX,
  MAX_MESSAGE_ATTACHMENTS,
  MESSAGE_ATTACHMENT_ACCEPT,
  THREAD_LIST_ITEM_LONG_PRESS_MS,
  THREAD_LIST_ITEM_REORDER_MOVE_TOLERANCE_PX,
  THREAD_LIST_ITEM_LONG_PRESS_CANCEL_TOLERANCE_PX,
  appendMessageAttachments,
  buildRunTimeline,
  buildSpeechFriendlyMessageText,
  buildThreadResponseSignal,
  captureScrollAnchorSnapshot,
  cleanupMessageAttachmentUpload,
  cleanupMessageAttachmentUploads,
  copyTextToClipboard,
  createInitialThreadVoiceState,
  findActiveIssueForThread,
  formatDateTime,
  formatMessageAttachmentSize,
  formatRelativeTime,
  formatThreadContextUsage,
  getDistanceFromBottom,
  getRealtimeProgressText,
  getStatusMeta,
  getThreadContextUsage,
  getThreadPreview,
  getViewportOrientation,
  hasCoarsePointerDevice,
  isBottomBoundaryMomentumLocked,
  isTextInputElement,
  normalizeComposerDraftValue,
  normalizeIssue,
  normalizeMessageAttachment,
  normalizeMessageAttachments,
  resolveMessageAttachmentBadge,
  restoreScrollAnchorSnapshot,
  useTouchScrollBoundaryLock
}) {
  const inlineIssueComposerHelpers = {
    CHAT_COMPOSER_MAX_HEIGHT_PX,
    MAX_MESSAGE_ATTACHMENTS,
    MESSAGE_ATTACHMENT_ACCEPT,
    appendMessageAttachments,
    cleanupMessageAttachmentUpload,
    cleanupMessageAttachmentUploads,
    formatMessageAttachmentSize,
    getViewportOrientation,
    hasCoarsePointerDevice,
    normalizeComposerDraftValue,
    normalizeMessageAttachments,
    resolveMessageAttachmentBadge
  };

  const todoChatDetailUiComponents = {
    MessageBubbleComponent: MessageBubble,
    RichMessageContentComponent: RichMessageContent
  };

  const todoChatDetailUtils = {
    formatMessageAttachmentSize,
    formatRelativeTime,
    normalizeMessageAttachment,
    normalizeMessageAttachments,
    resolveMessageAttachmentBadge,
    useTouchScrollBoundaryLock
  };

  const threadDetailHelpers = {
    buildSpeechFriendlyMessageText,
    buildRunTimeline,
    buildThreadResponseSignal,
    captureScrollAnchorSnapshot,
    copyTextToClipboard,
    createInitialThreadVoiceState,
    findActiveIssueForThread,
    formatDateTime,
    formatMessageAttachmentSize,
    formatRelativeTime,
    formatThreadContextUsage,
    getDistanceFromBottom,
    getRealtimeProgressText,
    getStatusMeta,
    getThreadContextUsage,
    isBottomBoundaryMomentumLocked,
    isTextInputElement,
    normalizeIssue,
    normalizeMessageAttachment,
    normalizeMessageAttachments,
    resolveMessageAttachmentBadge,
    restoreScrollAnchorSnapshot,
    useTouchScrollBoundaryLock
  };

  const threadListItemHelpers = {
    buildThreadResponseSignal,
    formatRelativeTime,
    formatThreadContextUsage,
    getStatusMeta,
    getThreadPreview,
    longPressMs: THREAD_LIST_ITEM_LONG_PRESS_MS,
    reorderMoveTolerancePx: THREAD_LIST_ITEM_REORDER_MOVE_TOLERANCE_PX,
    longPressCancelTolerancePx: THREAD_LIST_ITEM_LONG_PRESS_CANCEL_TOLERANCE_PX
  };

  return {
    inlineIssueComposerHelpers,
    todoChatDetailUiComponents,
    todoChatDetailUtils,
    threadDetailHelpers,
    threadListItemHelpers
  };
}
