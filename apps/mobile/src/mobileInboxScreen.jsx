import MobileThreadListItem from "./mobileThreadListItem.jsx";
import TodoChatListItem from "./mobileTodoChatListItem.jsx";
import { BridgeDropdown, InstallPromptBanner } from "./mobileSharedUi.jsx";

function ProjectChipRow({
  isTodoScope,
  orderedProjects,
  selectedProjectId,
  draggingProjectChipId,
  draggingProjectChipOffsetX,
  lockProjectChipDropLayout,
  optimisticProjectChipOrder,
  projectChipRowRef,
  projectChipNodesRef,
  projectChipLayoutSnapshotRef,
  registerProjectChipNode,
  resolveProjectChipSlideOffsetX,
  onSelectTodoScope,
  onProjectChipClick,
  onProjectChipPointerDown,
  onProjectChipContextMenu
}) {
  return (
    <div className="border-b border-white/10 px-4 py-1.5">
      <div
        ref={projectChipRowRef}
        className={`project-chip-row -mx-1 flex gap-1.5 overflow-x-auto px-1 ${draggingProjectChipId ? "cursor-grabbing" : ""}`}
      >
        <button
          type="button"
          onClick={() => onSelectTodoScope()}
          className={`project-chip-button shrink-0 rounded-full px-3.5 text-[12px] font-medium transition select-none touch-manipulation ${
            isTodoScope ? "bg-white text-slate-900" : "bg-transparent text-slate-400 hover:text-white"
          }`}
        >
          ToDo
        </button>
        {orderedProjects.map((project) => {
          const isDraggingProjectChip = draggingProjectChipId === project.id;
          const projectChipSlideOffsetX = resolveProjectChipSlideOffsetX(project.id);
          const disableProjectChipTransition = lockProjectChipDropLayout || Boolean(optimisticProjectChipOrder);
          const projectChipLayout = projectChipLayoutSnapshotRef.current.get(project.id);
          const projectChipNode = projectChipNodesRef.current.get(project.id);
          const projectChipPlaceholderWidth = projectChipLayout?.width ?? projectChipNode?.offsetWidth ?? undefined;
          const projectChipPlaceholderHeight = projectChipLayout?.height ?? projectChipNode?.offsetHeight ?? undefined;

          return (
            <div
              key={project.id}
              ref={(node) => registerProjectChipNode(project.id, node)}
              data-testid={`project-chip-item-${project.id}`}
              className="relative shrink-0"
              style={
                isDraggingProjectChip
                  ? {
                      width: projectChipPlaceholderWidth ? `${projectChipPlaceholderWidth}px` : undefined,
                      height: projectChipPlaceholderHeight ? `${projectChipPlaceholderHeight}px` : undefined
                    }
                  : projectChipSlideOffsetX !== 0
                    ? {
                        transform: `translateX(${projectChipSlideOffsetX}px)`,
                        transition: disableProjectChipTransition ? "none" : "transform 180ms ease-out"
                      }
                    : disableProjectChipTransition
                      ? { transition: "none" }
                      : undefined
              }
            >
              <button
                type="button"
                onClick={() => onProjectChipClick(project.id)}
                onPointerDown={(event) => onProjectChipPointerDown(event, project)}
                onContextMenu={(event) => onProjectChipContextMenu(event, project)}
                title={project.name}
                className={`project-chip-button max-w-[68vw] overflow-hidden text-ellipsis whitespace-nowrap rounded-full px-3.5 text-[12px] font-medium select-none touch-manipulation ${
                  isDraggingProjectChip ? "w-full" : "shrink-0"
                } ${
                  isDraggingProjectChip
                    ? "bg-white text-slate-900 shadow-[0_12px_24px_rgba(15,23,42,0.35)]"
                    : !isTodoScope && project.id === selectedProjectId
                      ? "bg-white text-slate-900"
                      : "bg-transparent text-slate-400 hover:text-white"
                }`}
                style={
                  isDraggingProjectChip
                    ? {
                        position: "absolute",
                        inset: 0,
                        zIndex: 20,
                        transform: `translateX(${draggingProjectChipOffsetX}px) scale(1.02)`,
                        transition: "none",
                        touchAction: "none",
                        pointerEvents: "none"
                      }
                    : undefined
                }
              >
                {project.name}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function MobileInboxListContent({
  isTodoScope,
  bridgeAvailable,
  loadingState,
  todoListProps,
  threadListProps
}) {
  if (isTodoScope) {
    const {
      chats,
      selectedTodoChatId,
      formatRelativeTime,
      getTodoChatPreview,
      onOpenTodoChat,
      onRenameTodoChat,
      onDeleteTodoChat
    } = todoListProps;

    if (chats.length === 0) {
      return (
        <div className="px-2 py-10 text-center text-sm leading-7 text-slate-400">
          {loadingState === "loading"
            ? "데이터를 불러오고 있습니다."
            : "조건에 맞는 ToDo 채팅이 없습니다. 새 ToDo 채팅을 만들어 아이디어를 모아 주세요."}
        </div>
      );
    }

    return chats.map((chat) => (
      <TodoChatListItem
        key={chat.id}
        chat={chat}
        active={chat.id === selectedTodoChatId}
        updatedLabel={formatRelativeTime(chat.updated_at)}
        preview={getTodoChatPreview(chat)}
        onOpen={onOpenTodoChat}
        onRename={onRenameTodoChat}
        onDelete={onDeleteTodoChat}
      />
    ));
  }

  if (!bridgeAvailable) {
    return (
      <div className="px-2 py-10 text-center text-sm leading-7 text-slate-400">
        브리지가 연결되지 않아 채팅창 목록을 표시할 수 없습니다.
      </div>
    );
  }

  const {
    threads,
    selectedThreadId,
    selectedThreadIds,
    threadSelectionMode,
    signalNow,
    registerThreadListItemNode,
    draggingThreadId,
    draggingThreadOffsetY,
    transitionLocked,
    resolveThreadListItemSlideOffsetY,
    onStartThreadReorder,
    onMoveThreadReorder,
    onEndThreadReorder,
    onCancelThreadReorder,
    onOpenThread,
    onRenameThread,
    onDeleteThread,
    onToggleThreadSelection,
    onEnterThreadSelectionMode,
    threadListItemHelpers
  } = threadListProps;

  if (threads.length === 0) {
    return (
      <div className="px-2 py-10 text-center text-sm leading-7 text-slate-400">
        {loadingState === "loading"
          ? "데이터를 불러오고 있습니다."
          : "조건에 맞는 채팅창이 없습니다. 새 채팅창을 열어 작업을 시작해 주세요."}
      </div>
    );
  }

  return threads.map((thread) => (
    <MobileThreadListItem
      key={thread.id}
      thread={thread}
      active={thread.id === selectedThreadId}
      selected={selectedThreadIds.includes(thread.id)}
      selectionMode={threadSelectionMode}
      signalNow={signalNow}
      registerNode={registerThreadListItemNode}
      reorderActive={draggingThreadId === thread.id}
      transitionLocked={transitionLocked}
      reorderOffsetY={
        draggingThreadId === thread.id ? draggingThreadOffsetY : resolveThreadListItemSlideOffsetY(thread.id)
      }
      onStartReorder={onStartThreadReorder}
      onMoveReorder={onMoveThreadReorder}
      onEndReorder={onEndThreadReorder}
      onCancelReorder={onCancelThreadReorder}
      onOpen={onOpenThread}
      onRename={onRenameThread}
      onDelete={onDeleteThread}
      onToggleSelect={onToggleThreadSelection}
      onEnterSelectionMode={onEnterThreadSelectionMode}
      helpers={threadListItemHelpers}
    />
  ));
}

export function MobileInboxActionBar({
  threadSelectionMode,
  isTodoScope,
  threadBusy,
  selectedThreadCount,
  selectedProjectReady,
  bridgeAvailable,
  selectedProjectId,
  onCancelThreadSelection,
  onDeleteSelectedThreads,
  onCreateInstantThread,
  onOpenNewThread,
  onOpenNewTodoChat
}) {
  if (threadSelectionMode && !isTodoScope) {
    return (
      <div className="flex w-full items-center gap-3">
        <button
          type="button"
          onClick={onCancelThreadSelection}
          disabled={threadBusy}
          className="rounded-full border border-white/10 px-4 py-3 text-sm font-medium text-slate-200 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-45"
        >
          취소
        </button>
        <button
          type="button"
          onClick={() => void onDeleteSelectedThreads()}
          disabled={threadBusy || selectedThreadCount === 0}
          aria-label="선택한 채팅창 삭제"
          className="flex-1 rounded-full bg-rose-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {threadBusy ? "삭제 중..." : `선택 ${selectedThreadCount}개 삭제`}
        </button>
      </div>
    );
  }

  if (!isTodoScope) {
    return (
      <div className="flex w-full items-center gap-3">
        <button
          type="button"
          data-testid="thread-create-instant-button"
          onClick={() => void onCreateInstantThread()}
          disabled={!selectedProjectReady || !bridgeAvailable || threadBusy}
          className="flex-[2_1_0%] rounded-full bg-rose-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-45"
        >
          +인스턴트
        </button>
        <button
          type="button"
          data-testid="thread-create-button"
          onClick={() => onOpenNewThread(selectedProjectId)}
          disabled={!selectedProjectReady || !bridgeAvailable || threadBusy}
          className="flex-[3_1_0%] rounded-full bg-telegram-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-45"
        >
          +채팅
        </button>
      </div>
    );
  }

  return (
    <div className="flex w-full items-center gap-3">
      <button
        type="button"
        onClick={() => onOpenNewTodoChat()}
        disabled={threadBusy}
        className="w-full rounded-full bg-telegram-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-45"
      >
        + ToDo 채팅
      </button>
    </div>
  );
}

export function MobileInboxChrome({
  appHeaderTitle,
  bridges,
  selectedBridgeId,
  bridgeSignal,
  formatRelativeTime,
  bridgeListSyncing,
  searchOpen,
  search,
  installPromptVisible,
  installBusy,
  projectChipRowProps,
  onOpenUtility,
  onSelectBridge,
  onOpenBridgeDropdown,
  onToggleSearch,
  onSearchChange,
  onInstallPwa,
  onDismissInstallPrompt
}) {
  return (
    <div className="sticky top-0 z-20 bg-slate-950/95 backdrop-blur-xl">
      <header className="border-b border-white/10 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onOpenUtility}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-white/5 text-white transition hover:bg-white/10"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M4 7h16M4 12h16M4 17h10" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
            </svg>
          </button>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold text-white">{appHeaderTitle}</h1>
            <div className="mt-0.5">
              <BridgeDropdown
                bridges={bridges}
                selectedBridgeId={selectedBridgeId}
                bridgeSignal={bridgeSignal}
                formatRelativeTime={formatRelativeTime}
                onSelectBridge={onSelectBridge}
                onOpen={onOpenBridgeDropdown}
                syncing={bridgeListSyncing}
              />
            </div>
          </div>

          <button
            type="button"
            onClick={onToggleSearch}
            className={`flex h-10 w-10 items-center justify-center rounded-full transition ${
              searchOpen ? "bg-white text-slate-900" : "bg-white/5 text-white hover:bg-white/10"
            }`}
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
            </svg>
          </button>
        </div>

        {searchOpen ? (
          <div className="mt-3 flex items-center gap-3 border-t border-white/10 pt-3">
            <svg className="h-4 w-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="채팅창 검색"
              className="w-full border-none bg-transparent p-0 text-sm text-white outline-none ring-0 placeholder:text-slate-500 focus:ring-0"
            />
          </div>
        ) : null}
      </header>

      <InstallPromptBanner
        visible={installPromptVisible}
        installing={installBusy}
        onInstall={onInstallPwa}
        onDismiss={onDismissInstallPrompt}
      />

      <ProjectChipRow {...projectChipRowProps} />
    </div>
  );
}

export default function MobileInboxScreen({
  chromeProps,
  listProps,
  actionBarProps,
  deferredOverlays
}) {
  return (
    <div className="telegram-shell min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col">
        <MobileInboxChrome {...chromeProps} />

        <main className="flex-1 px-4 pb-28 pt-3">
          <section className="mt-1">
            <MobileInboxListContent {...listProps} />
          </section>
        </main>

        <div className="telegram-safe-bottom-panel fixed inset-x-0 bottom-0 z-30 mx-auto flex w-full max-w-3xl justify-center border-t border-white/10 bg-slate-950/92 px-4 pt-2 backdrop-blur">
          <MobileInboxActionBar {...actionBarProps} />
        </div>
      </div>
      {deferredOverlays}
    </div>
  );
}
