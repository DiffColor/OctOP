import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createThreadTitleFromPrompt, getPathLabel, getRelativeWorkspacePath } from "./mobileOverlayUtils.js";
import { AutoSizingReadOnlyTextarea, BottomSheet } from "./mobileSharedUi.jsx";

export default function MobileDeferredOverlays(props) {
  const {
    threadDeleteDialog,
    threadBusy,
    onCloseThreadDeleteDialog,
    onConfirmThreadDeleteDialog,
    todoChatBeingEdited,
    todoRenameBusy,
    onCloseTodoChatRename,
    onSubmitTodoChatRename,
    activeTodoMessage,
    todoMessageEditorOpen,
    todoTransferOpen,
    onCloseTodoMessageAction,
    onOpenTodoMessageEditor,
    onDeleteActiveTodoMessage,
    onOpenTodoTransfer,
    todoBusy,
    onCloseTodoMessageEditor,
    onSubmitTodoMessageEditor,
    todoTransferBusy,
    projects,
    threadOptionsByProjectId,
    selectedProjectId,
    onEnsureProjectThreads,
    onCloseTodoTransfer,
    onSubmitTodoTransfer,
    projectActionTarget,
    projectActionBusy,
    onCloseProjectAction,
    onEditProjectAction,
    onDeleteProjectAction,
    utilityOpen,
    session,
    bridgeSignal,
    selectedProject,
    pushNotificationCard,
    onOpenProjectInstructionDialog,
    onCloseUtility,
    onOpenProjectComposer,
    onRefresh,
    onLogout,
    projectComposerOpen,
    projectBusy,
    workspaceRoots,
    folderState,
    folderLoading,
    selectedWorkspacePath,
    onBrowseFolder,
    onSelectWorkspace,
    onCloseProjectComposer,
    onSubmitProject,
    threadCreateDialogOpen,
    onCloseThreadCreateDialog,
    onSubmitThreadCreateDialog,
    projectInstructionDialogOpen,
    projectInstructionBusy,
    projectInstructionType,
    onCloseProjectInstructionDialog,
    onSubmitProjectInstruction,
    projectEditDialogOpen,
    projectEditBusy,
    projectEditTarget,
    projectEditError,
    onCloseProjectEditDialog,
    onSubmitProjectEdit,
    onRequestProjectDeletion,
    threadInstructionDialogOpen,
    threadInstructionBusy,
    threadInstructionTarget,
    threadInstructionProject,
    threadInstructionSupported,
    threadInstructionError,
    onCloseThreadInstructionDialog,
    onSubmitThreadInstruction
  } = props;

  return (
    <>
      <DeleteConfirmDialog
        open={threadDeleteDialog.open}
        busy={threadBusy}
        title={threadDeleteDialog.title}
        description={threadDeleteDialog.description}
        confirmLabel={threadDeleteDialog.confirmLabel}
        onClose={onCloseThreadDeleteDialog}
        onConfirm={onConfirmThreadDeleteDialog}
      />
      <TodoChatRenameDialog
        open={Boolean(todoChatBeingEdited)}
        busy={todoRenameBusy}
        chat={todoChatBeingEdited}
        onClose={onCloseTodoChatRename}
        onSubmit={onSubmitTodoChatRename}
      />
      <TodoMessageActionSheet
        open={Boolean(activeTodoMessage) && !todoMessageEditorOpen && !todoTransferOpen}
        message={activeTodoMessage}
        onClose={onCloseTodoMessageAction}
        onEdit={onOpenTodoMessageEditor}
        onDelete={onDeleteActiveTodoMessage}
        onTransfer={onOpenTodoTransfer}
      />
      <TodoMessageEditorDialog
        open={todoMessageEditorOpen}
        busy={todoBusy}
        message={activeTodoMessage}
        onClose={onCloseTodoMessageEditor}
        onSubmit={onSubmitTodoMessageEditor}
      />
      <TodoTransferSheet
        open={todoTransferOpen}
        busy={todoTransferBusy}
        message={activeTodoMessage}
        projects={projects}
        threadOptionsByProjectId={threadOptionsByProjectId}
        selectedProjectId={selectedProjectId}
        onEnsureProjectThreads={onEnsureProjectThreads}
        onClose={onCloseTodoTransfer}
        onSubmit={onSubmitTodoTransfer}
      />
      <ProjectActionSheet
        open={Boolean(projectActionTarget)}
        project={projectActionTarget}
        busy={projectActionBusy}
        onClose={onCloseProjectAction}
        onEdit={onEditProjectAction}
        onDelete={onDeleteProjectAction}
      />
      <UtilitySheet
        open={utilityOpen}
        session={session}
        bridgeSignal={bridgeSignal}
        selectedProject={selectedProject}
        pushNotificationCard={pushNotificationCard}
        onOpenProjectInstructionDialog={onOpenProjectInstructionDialog}
        onClose={onCloseUtility}
        onOpenProjectComposer={onOpenProjectComposer}
        onRefresh={onRefresh}
        onLogout={onLogout}
      />
      <ProjectComposerSheet
        open={projectComposerOpen}
        busy={projectBusy}
        roots={workspaceRoots}
        folderState={folderState}
        folderLoading={folderLoading}
        selectedWorkspacePath={selectedWorkspacePath}
        onBrowseFolder={onBrowseFolder}
        onSelectWorkspace={onSelectWorkspace}
        onClose={onCloseProjectComposer}
        onSubmit={onSubmitProject}
      />
      <ThreadCreateDialog
        open={threadCreateDialogOpen}
        busy={threadBusy}
        project={selectedProject}
        onClose={onCloseThreadCreateDialog}
        onSubmit={onSubmitThreadCreateDialog}
      />
      <ProjectInstructionDialog
        open={projectInstructionDialogOpen}
        busy={projectInstructionBusy}
        project={selectedProject}
        instructionType={projectInstructionType}
        onClose={onCloseProjectInstructionDialog}
        onSubmit={onSubmitProjectInstruction}
      />
      <ProjectEditDialog
        open={projectEditDialogOpen}
        busy={projectEditBusy}
        deleteBusy={projectBusy}
        project={projectEditTarget}
        errorMessage={projectEditError}
        onClose={onCloseProjectEditDialog}
        onSubmit={onSubmitProjectEdit}
        onDelete={onRequestProjectDeletion}
      />
      <ThreadEditDialog
        open={threadInstructionDialogOpen}
        busy={threadInstructionBusy}
        thread={threadInstructionTarget}
        project={threadInstructionProject}
        threadInstructionSupported={threadInstructionSupported}
        errorMessage={threadInstructionError}
        onClose={onCloseThreadInstructionDialog}
        onSubmit={onSubmitThreadInstruction}
      />
    </>
  );
}

function UtilitySheet({
  open,
  session,
  bridgeSignal,
  selectedProject,
  pushNotificationCard,
  onOpenProjectInstructionDialog,
  onClose,
  onOpenProjectComposer,
  onRefresh,
  onLogout
}) {
  return (
    <BottomSheet
      open={open}
      title="워크스페이스 설정"
      onClose={onClose}
      variant="center"
    >
      <div className="px-5 py-5">
        <section className="flex items-start gap-3 border-b border-white/10 pb-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-telegram-500/15 text-sm font-semibold text-white">
            {(session.displayName || session.loginId || "O").slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-semibold text-white">{session.displayName || session.loginId}</p>
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: bridgeSignal.dotColor }}
                title={bridgeSignal.title}
              />
            </div>
            <p className="mt-1 text-[11px]" style={{ color: bridgeSignal.chipStyle.color }}>
              {bridgeSignal.label}
            </p>
            <p className="truncate text-xs text-slate-400">{session.loginId}</p>
          </div>
        </section>

        <section className="grid grid-cols-2 gap-2 border-t border-white/10 py-4">
          <button
            type="button"
            disabled={!selectedProject}
            onClick={() => onOpenProjectInstructionDialog("base")}
            className="rounded-full bg-sky-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-300 disabled:opacity-60"
          >
            일반지침 설정
          </button>
          <button
            type="button"
            disabled={!selectedProject}
            onClick={() => onOpenProjectInstructionDialog("developer")}
            className="rounded-full bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-300 disabled:opacity-60"
          >
            개발지침 설정
          </button>
        </section>

        {pushNotificationCard ? <section className="border-t border-white/10 pt-4">{pushNotificationCard}</section> : null}

        <section className="grid grid-cols-2 gap-2 border-t border-white/10 pt-4">
          <button
            type="button"
            onClick={() => {
              onClose();
              onRefresh();
            }}
            className="flex-1 rounded-full border border-white/10 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-white/5"
          >
            새로고침
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenProjectComposer();
            }}
            className="flex-1 rounded-full bg-telegram-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-telegram-400"
          >
            프로젝트 등록
          </button>
        </section>

        <button
          type="button"
          onClick={onLogout}
          className="mt-4 w-full rounded-full border border-rose-400/20 px-4 py-2.5 text-sm font-semibold text-rose-100 transition hover:bg-rose-500/10"
        >
          로그아웃
        </button>
      </div>
    </BottomSheet>
  );
}

function ProjectComposerSheet({
  open,
  busy,
  roots,
  folderState,
  folderLoading,
  selectedWorkspacePath,
  onBrowseFolder,
  onSelectWorkspace,
  onClose,
  onSubmit
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [developerInstructions, setDeveloperInstructions] = useState("");
  const tapStateRef = useRef({ path: "", timestamp: 0 });

  useEffect(() => {
    if (!open) {
      setName("");
      setDescription("");
      setDeveloperInstructions("");
      tapStateRef.current = { path: "", timestamp: 0 };
      return;
    }
  }, [open]);

  const selectedWorkspaceLabel = useMemo(
    () => getRelativeWorkspacePath(selectedWorkspacePath, roots),
    [roots, selectedWorkspacePath]
  );

  const handleFolderTap = useCallback(
    (path) => {
      const now = Date.now();
      const lastTap = tapStateRef.current;
      const isSecondTap = lastTap.path === path && now - lastTap.timestamp < 320;

      tapStateRef.current = {
        path,
        timestamp: now
      };

      onSelectWorkspace(path);
      setName(getPathLabel(path));

      if (isSecondTap) {
        tapStateRef.current = { path: "", timestamp: 0 };
        void onBrowseFolder(path);
      }
    },
    [onBrowseFolder, onSelectWorkspace]
  );

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!name.trim() || !selectedWorkspacePath) {
      return;
    }

    await onSubmit({
      name: name.trim(),
      description: description.trim(),
      developerInstructions,
      workspace_path: selectedWorkspacePath
    });
  };

  return (
    <BottomSheet
      open={open}
      title="새 프로젝트 등록"
      onClose={onClose}
      variant="center"
    >
      <form className="space-y-5 px-5 py-5" onSubmit={handleSubmit}>
        <section className="border border-white/10 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-white">워크스페이스 선택</p>
            {folderLoading ? <span className="text-xs text-slate-400">불러오는 중...</span> : null}
          </div>

          <div className="mt-4 rounded-[1rem] border border-white/10 bg-black/10 px-3 py-2 text-[11px] text-slate-400">
            한 번 클릭하면 선택되고, 더블 클릭하면 폴더 내부로 들어갑니다.
          </div>

          <div className="telegram-scroll mt-3 max-h-72 overflow-y-auto rounded-[1rem] border border-white/10">
            {folderState.parent_path ? (
              <button
                type="button"
                onClick={() => handleFolderTap(folderState.parent_path)}
                className={`flex w-full items-center gap-3 border-b border-white/10 px-4 py-3 text-left transition ${
                  selectedWorkspacePath === folderState.parent_path
                    ? "bg-telegram-500/10"
                    : "bg-transparent hover:bg-white/[0.03]"
                }`}
              >
                <span className="text-sm font-medium text-white">..</span>
              </button>
            ) : null}

            {folderState.entries?.length ? (
              folderState.entries.map((entry) => {
                const active = selectedWorkspacePath === entry.path;

                return (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => handleFolderTap(entry.path)}
                    className={`flex w-full items-center gap-3 border-b border-white/10 px-4 py-3 text-left last:border-b-0 transition ${
                      active ? "bg-telegram-500/10" : "bg-transparent hover:bg-white/[0.03]"
                    }`}
                  >
                    <span className="text-sm font-medium text-white">{entry.name}</span>
                  </button>
                );
              })
            ) : (
              <div className="px-4 py-4 text-sm text-slate-400">
                하위 폴더가 없습니다.
              </div>
            )}
          </div>
        </section>

        <div className="border border-white/10 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Selected Workspace</p>
          <p className="mt-2 break-all text-sm text-white">
            {selectedWorkspaceLabel || "아직 선택된 경로가 없습니다."}
          </p>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="project-name">
            프로젝트 이름
          </label>
          <input
            id="project-name"
            type="text"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="예: OctOP 모바일 운영"
            className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="project-description">
            프로젝트 설명
          </label>
          <textarea
            id="project-description"
            rows="4"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="프로젝트 목적과 작업 범위를 적어 주세요."
            className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="project-developer-instructions">
            공통 개발지침
          </label>
          <textarea
            id="project-developer-instructions"
            rows="8"
            value={developerInstructions}
            onChange={(event) => setDeveloperInstructions(event.target.value)}
            placeholder="예: 답변 언어, 금지사항, 출력 형식, 코드 수정 원칙 등 이 프로젝트 전체에 공통으로 적용할 개발지침을 입력해 주세요."
            className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-400/30"
          />
          <div className="mt-3 rounded-[1rem] border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-[12px] leading-6 text-emerald-50">
            여기 저장한 공통 개발지침은 이 프로젝트의 새 채팅창이 실행될 때 기본 developerInstructions로 자동 적용됩니다.
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/10 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-white/5"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={busy || !selectedWorkspacePath}
            className="rounded-full bg-telegram-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "등록 중..." : "프로젝트 등록"}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}

function ThreadCreateDialog({ open, busy, project, onClose, onSubmit }) {
  const [title, setTitle] = useState("");
  const [developerInstructions, setDeveloperInstructions] = useState("");
  const projectDeveloperInstructions = String(project?.developer_instructions ?? "");
  const hasProjectDeveloperInstructions = projectDeveloperInstructions.trim().length > 0;

  useEffect(() => {
    if (!open) {
      setTitle("");
      setDeveloperInstructions("");
    }
  }, [open]);

  if (!open || !project) {
    return null;
  }

  return (
    <BottomSheet
      open={open}
      title="새 채팅창 시작"
      onClose={onClose}
      variant="center"
    >
      <form
        className="space-y-5 px-5 py-5"
        onSubmit={async (event) => {
          event.preventDefault();
          const accepted = await onSubmit({
            title,
            developerInstructions
          });

          if (accepted !== false) {
            onClose();
          }
        }}
      >
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="thread-create-title">
            제목
          </label>
          <input
            id="thread-create-title"
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="비워두면 제목없음으로 생성됩니다."
            className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          />
        </div>

        {hasProjectDeveloperInstructions ? (
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="thread-create-project-developer-instructions">
              프로젝트 공통 개발지침
            </label>
            <AutoSizingReadOnlyTextarea
              id="thread-create-project-developer-instructions"
              value={projectDeveloperInstructions}
              placeholder="저장된 프로젝트 공통 개발지침이 없습니다."
              className="w-full resize-none rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white/90 outline-none"
            />
            <p className="mt-2 text-[11px] leading-5 text-slate-400">
              프로젝트에 저장된 공통 개발지침이며 여기서는 읽기 전용으로만 표시됩니다.
            </p>
          </div>
        ) : null}

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="thread-create-developer-instructions">
            개발지침
          </label>
          <textarea
            id="thread-create-developer-instructions"
            rows="8"
            value={developerInstructions}
            onChange={(event) => setDeveloperInstructions(event.target.value)}
            placeholder="이 채팅창에서만 추가로 적용할 개발지침이 있으면 입력해 주세요."
            className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-400/30"
          />
          {hasProjectDeveloperInstructions ? (
            <div className="mt-3 rounded-[1rem] border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-[12px] leading-6 text-emerald-50">
              이 프로젝트의 공통 개발지침이 새 채팅창 기본 지침으로 자동 적용됩니다. 여기 입력한 채팅창 개발지침은 그 뒤에 이어 붙습니다.
            </div>
          ) : (
            <p className="mt-2 text-[11px] leading-5 text-slate-400">
              프로젝트 공통 개발지침이 없으면 이 값만 이 채팅창의 다음 실행부터 적용됩니다.
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/10 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-white/5"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-full bg-telegram-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "생성 중..." : "채팅 시작"}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}

function DeleteConfirmDialog({
  open,
  busy,
  title,
  description,
  confirmLabel = "삭제",
  cancelLabel = "취소",
  onClose,
  onConfirm
}) {
  return (
    <BottomSheet
      open={open}
      title={title}
      description={description}
      onClose={busy ? () => {} : onClose}
      variant="center"
    >
      <div className="space-y-5 px-5 py-5">
        <div className="rounded-3xl border border-rose-400/15 bg-rose-500/10 px-4 py-4 text-sm leading-7 text-slate-200">
          삭제한 항목은 목록에서 즉시 사라집니다.
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex-1 rounded-full border border-white/10 px-4 py-3 text-sm font-medium text-slate-200 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="flex-1 rounded-full bg-rose-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {busy ? "삭제 중..." : confirmLabel}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}

function TodoChatRenameDialog({ open, busy, chat, onClose, onSubmit }) {
  const [title, setTitle] = useState("");

  useEffect(() => {
    if (!open) {
      setTitle("");
      return;
    }

    setTitle(chat?.title ?? "");
  }, [chat, open]);

  if (!open || !chat) {
    return null;
  }

  return (
    <BottomSheet open={open} title="ToDo 채팅 이름 변경" onClose={onClose} variant="center">
      <form
        className="space-y-5 px-5 py-5"
        onSubmit={async (event) => {
          event.preventDefault();

          if (!title.trim()) {
            return;
          }

          const accepted = await onSubmit(title.trim());

          if (accepted !== false) {
            onClose();
          }
        }}
      >
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="todo-chat-title">
            제목
          </label>
          <input
            id="todo-chat-title"
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/10 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-white/5"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={busy || !title.trim()}
            className="rounded-full bg-telegram-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "저장 중..." : "저장"}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}

function TodoMessageEditorDialog({ open, busy, message, onClose, onSubmit }) {
  const [content, setContent] = useState("");

  useEffect(() => {
    if (!open) {
      setContent("");
      return;
    }

    setContent(message?.content ?? "");
  }, [message, open]);

  if (!open || !message) {
    return null;
  }

  return (
    <BottomSheet open={open} title="메모 수정" onClose={onClose} variant="center">
      <form
        className="space-y-5 px-5 py-5"
        onSubmit={async (event) => {
          event.preventDefault();

          if (!content.trim()) {
            return;
          }

          const accepted = await onSubmit(content.trim());

          if (accepted !== false) {
            onClose();
          }
        }}
      >
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="todo-message-content">
            내용
          </label>
          <textarea
            id="todo-message-content"
            rows="6"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/10 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-white/5"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={busy || !content.trim()}
            className="rounded-full bg-telegram-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "저장 중..." : "저장"}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}

function TodoMessageActionSheet({ open, message, onClose, onEdit, onDelete, onTransfer }) {
  if (!open || !message) {
    return null;
  }

  return (
    <BottomSheet open={open} title="메모 작업" onClose={onClose} variant="center">
      <div className="space-y-3 px-5 py-5">
        <div className="rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm leading-6 text-slate-200">
          {message.content}
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="w-full rounded-full border border-white/10 px-4 py-3 text-sm font-medium text-white transition hover:bg-white/5"
        >
          편집
        </button>
        <button
          type="button"
          onClick={onTransfer}
          className="w-full rounded-full bg-telegram-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-telegram-400"
        >
          프로젝트-쓰레드로 이동
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="w-full rounded-full bg-rose-500/90 px-4 py-3 text-sm font-semibold text-white transition hover:bg-rose-400"
        >
          삭제
        </button>
      </div>
    </BottomSheet>
  );
}

function TodoTransferSheet({
  open,
  busy,
  message,
  projects,
  threadOptionsByProjectId,
  selectedProjectId,
  onEnsureProjectThreads,
  onClose,
  onSubmit
}) {
  const [projectId, setProjectId] = useState("");
  const [threadMode, setThreadMode] = useState("existing");
  const [threadId, setThreadId] = useState("");
  const [threadName, setThreadName] = useState("");

  useEffect(() => {
    if (!open) {
      setProjectId("");
      setThreadMode("existing");
      setThreadId("");
      setThreadName("");
      return;
    }

    const nextProjectId = selectedProjectId || projects[0]?.id || "";
    setProjectId(nextProjectId);
    setThreadMode("existing");
    setThreadId("");
    setThreadName(createThreadTitleFromPrompt(message?.content ?? "") || "새 채팅창");
  }, [message, open, projects, selectedProjectId]);

  useEffect(() => {
    if (!open || !projectId || !onEnsureProjectThreads) {
      return;
    }

    void onEnsureProjectThreads(projectId);
  }, [onEnsureProjectThreads, open, projectId]);

  const availableThreads = useMemo(
    () => threadOptionsByProjectId[projectId] ?? [],
    [projectId, threadOptionsByProjectId]
  );

  if (!open || !message) {
    return null;
  }

  return (
    <BottomSheet
      open={open}
      title="프로젝트-쓰레드로 이동"
      description="이 메모를 staged issue로 넘깁니다. 실행은 자동으로 시작되지 않습니다."
      onClose={onClose}
      variant="center"
    >
      <form
        className="space-y-5 px-5 py-5"
        onSubmit={async (event) => {
          event.preventDefault();

          if (!projectId) {
            return;
          }

          if (threadMode === "existing" && !threadId) {
            return;
          }

          if (threadMode === "new" && !threadName.trim()) {
            return;
          }

          const accepted = await onSubmit({
            project_id: projectId,
            thread_mode: threadMode,
            thread_id: threadMode === "existing" ? threadId : null,
            thread_name: threadMode === "new" ? threadName.trim() : null
          });

          if (accepted !== false) {
            onClose();
          }
        }}
      >
        <div className="rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm leading-6 text-slate-200">
          {message.content}
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="todo-transfer-project">
            프로젝트
          </label>
          <select
            id="todo-transfer-project"
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              setThreadId("");
            }}
            className="w-full rounded-[1rem] border border-white/10 bg-[#0b1622] px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          >
            <option value="">프로젝트 선택</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setThreadMode("existing")}
            className={`rounded-full px-4 py-2.5 text-sm font-semibold transition ${
              threadMode === "existing"
                ? "bg-white text-slate-900"
                : "border border-white/10 text-slate-200 hover:bg-white/5"
            }`}
          >
            기존 쓰레드
          </button>
          <button
            type="button"
            onClick={() => setThreadMode("new")}
            className={`rounded-full px-4 py-2.5 text-sm font-semibold transition ${
              threadMode === "new"
                ? "bg-white text-slate-900"
                : "border border-white/10 text-slate-200 hover:bg-white/5"
            }`}
          >
            신규 쓰레드
          </button>
        </div>

        {threadMode === "existing" ? (
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="todo-transfer-thread">
              대상 쓰레드
            </label>
            <select
              id="todo-transfer-thread"
              value={threadId}
              onChange={(event) => setThreadId(event.target.value)}
              className="w-full rounded-[1rem] border border-white/10 bg-[#0b1622] px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
            >
              <option value="">쓰레드 선택</option>
              {availableThreads.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="todo-transfer-thread-name">
              새 쓰레드 이름
            </label>
            <input
              id="todo-transfer-thread-name"
              type="text"
              value={threadName}
              onChange={(event) => setThreadName(event.target.value)}
              className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
            />
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/10 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-white/5"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={busy || !projectId || (threadMode === "existing" ? !threadId : !threadName.trim())}
            className="rounded-full bg-telegram-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "이동 중..." : "이동"}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}

function ProjectActionSheet({ open, project, busy = false, onClose, onEdit, onDelete }) {
  if (!open || !project) {
    return null;
  }

  return (
    <BottomSheet
      open={open}
      title="프로젝트 작업"
      description={`${project.name} 프로젝트를 편집하거나 삭제할 수 있습니다.`}
      onClose={busy ? () => {} : onClose}
      variant="center"
    >
      <div className="space-y-3 px-5 py-5">
        <div className="rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm leading-6 text-slate-200">
          공통 개발지침은 새 채팅창이 실행될 때 기본 지침으로 자동 주입됩니다.
        </div>
        <button
          type="button"
          onClick={onEdit}
          disabled={busy}
          className="w-full rounded-full bg-telegram-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          편집
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="w-full rounded-full bg-rose-500/90 px-4 py-3 text-sm font-semibold text-white transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          삭제
        </button>
      </div>
    </BottomSheet>
  );
}

function ProjectEditDialog({ open, busy, deleteBusy = false, project, errorMessage, onClose, onSubmit, onDelete }) {
  const [name, setName] = useState("");
  const [developerInstructions, setDeveloperInstructions] = useState("");
  const [dirty, setDirty] = useState(false);
  const draftProjectIdRef = useRef("");
  const draftProjectId = open && project ? project.id : "";

  useEffect(() => {
    if (!open) {
      setName("");
      setDeveloperInstructions("");
      setDirty(false);
      draftProjectIdRef.current = "";
      return;
    }

    if (!project) {
      return;
    }

    if (draftProjectIdRef.current !== draftProjectId) {
      draftProjectIdRef.current = draftProjectId;
      setName(project?.name ?? "");
      setDeveloperInstructions(project?.developer_instructions ?? "");
      setDirty(false);
      return;
    }

    if (!dirty) {
      setName(project?.name ?? "");
      setDeveloperInstructions(project?.developer_instructions ?? "");
    }
  }, [dirty, draftProjectId, open, project]);

  if (!open || !project) {
    return null;
  }

  const actionBusy = busy || deleteBusy;

  return (
    <BottomSheet
      open={open}
      title="프로젝트 편집"
      description="프로젝트 이름과 공통 개발지침을 수정합니다. 공통 개발지침은 새 채팅창 실행 시 기본 developerInstructions로 들어갑니다."
      onClose={onClose}
      variant="center"
    >
      <form
        className="space-y-5 px-5 py-5"
        onSubmit={async (event) => {
          event.preventDefault();
          await onSubmit({
            name: name.trim(),
            developerInstructions
          });
        }}
      >
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="project-edit-name">
            프로젝트 이름
          </label>
          <input
            id="project-edit-name"
            type="text"
            value={name}
            disabled={actionBusy}
            onChange={(event) => {
              setName(event.target.value);
              setDirty(true);
            }}
            className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="project-edit-developer-instructions">
            공통 개발지침
          </label>
          <textarea
            id="project-edit-developer-instructions"
            rows="10"
            value={developerInstructions}
            disabled={actionBusy}
            onChange={(event) => {
              setDeveloperInstructions(event.target.value);
              setDirty(true);
            }}
            placeholder="예: 코드 스타일, 테스트 기준, 금지사항, 응답 형식 같은 프로젝트 공통 규칙을 입력해 주세요."
            className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-emerald-300 focus:ring-2 focus:ring-emerald-400/30"
          />
          <p className="mt-2 text-[11px] leading-5 text-slate-400">
            비워 두고 저장하면 공통 개발지침이 제거됩니다.
          </p>
        </div>

        {errorMessage ? (
          <div className="rounded-[1rem] border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-[12px] leading-6 text-rose-100">
            {errorMessage}
          </div>
        ) : null}

        {typeof onDelete === "function" ? (
          <button
            type="button"
            onClick={() => void onDelete(project)}
            disabled={actionBusy}
            className="w-full rounded-full border border-rose-400/40 bg-rose-500/10 px-4 py-2.5 text-sm font-semibold text-rose-100 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {deleteBusy ? "삭제 중..." : "프로젝트 삭제"}
          </button>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={actionBusy}
            className="rounded-full border border-white/10 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-60"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={actionBusy || !name.trim()}
            className="rounded-full bg-telegram-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "저장 중..." : "저장"}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}

function ProjectInstructionDialog({ open, busy, project, instructionType, onClose, onSubmit }) {
  const [value, setValue] = useState("");
  const [dirty, setDirty] = useState(false);
  const draftScopeRef = useRef("");
  const instructionValue = instructionType === "developer" ? (project?.developer_instructions ?? "") : (project?.base_instructions ?? "");
  const draftScope = open && project ? `${project.id}:${instructionType}` : "";

  useEffect(() => {
    if (!open) {
      setValue("");
      setDirty(false);
      draftScopeRef.current = "";
      return;
    }

    if (!project) {
      return;
    }

    if (draftScopeRef.current !== draftScope) {
      draftScopeRef.current = draftScope;
      setValue(instructionValue);
      setDirty(false);
      return;
    }

    if (!dirty) {
      setValue(instructionValue);
    }
  }, [dirty, draftScope, instructionValue, open, project]);

  if (!open || !project) {
    return null;
  }

  const isDeveloperInstruction = instructionType === "developer";

  return (
    <BottomSheet
      open={open}
      title={isDeveloperInstruction ? "개발지침" : "일반지침"}
      description={
        isDeveloperInstruction
          ? `${project.name} 프로젝트에 저장하고 새 thread 시작 시 app-server에 주입합니다.`
          : "공통 일반지침으로 저장하고 모든 프로젝트의 새 thread 시작 시 app-server에 동일하게 주입합니다."
      }
      onClose={onClose}
      variant="center"
    >
      <form
        className="space-y-5 px-5 py-5"
        onSubmit={async (event) => {
          event.preventDefault();
          await onSubmit({
            instructionType,
            value
          });
        }}
      >
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="project-instruction-input">
            {isDeveloperInstruction ? "개발지침 본문" : "일반지침 본문"}
          </label>
          <textarea
            id="project-instruction-input"
            rows="10"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setDirty(true);
            }}
            placeholder={
              isDeveloperInstruction
                ? "예: 코드 스타일, 테스트 기준, 금지사항 같은 개발 규칙을 입력해 주세요."
                : "예: 작업 방식, 응답 톤, 우선순위 같은 공통 기본 지침을 입력해 주세요."
            }
            className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          />
          <p className="mt-2 text-[11px] leading-5 text-slate-400">
            비워 두고 저장하면 해당 지침은 제거됩니다.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/10 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-white/5"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-full bg-telegram-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "저장 중..." : "저장"}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}

function ThreadEditDialog({
  open,
  busy,
  thread,
  project,
  threadInstructionSupported = false,
  errorMessage,
  onClose,
  onSubmit
}) {
  const [title, setTitle] = useState("");
  const [developerInstructions, setDeveloperInstructions] = useState("");
  const [dirty, setDirty] = useState(false);
  const draftThreadIdRef = useRef("");
  const instructionValue = thread?.developer_instructions ?? "";
  const projectDeveloperInstructions = String(project?.developer_instructions ?? "");
  const hasProjectDeveloperInstructions = projectDeveloperInstructions.trim().length > 0;
  const draftThreadId = open && thread ? thread.id : "";

  useEffect(() => {
    if (!open) {
      setTitle("");
      setDeveloperInstructions("");
      setDirty(false);
      draftThreadIdRef.current = "";
      return;
    }

    if (!thread) {
      return;
    }

    if (draftThreadIdRef.current !== draftThreadId) {
      draftThreadIdRef.current = draftThreadId;
      setTitle(thread?.title ?? "");
      setDeveloperInstructions(instructionValue);
      setDirty(false);
      return;
    }

    if (!dirty) {
      setTitle(thread?.title ?? "");
      setDeveloperInstructions(instructionValue);
    }
  }, [dirty, draftThreadId, instructionValue, open, thread]);

  if (!open || !thread) {
    return null;
  }

  return (
    <BottomSheet
      open={open}
      title="채팅창 편집"
      description={`${thread.title ?? "채팅창"}의 제목을 수정하고, 필요하면 이 채팅창 전용 개발지침도 함께 저장합니다.`}
      onClose={onClose}
      variant="center"
      >
        <form
        className="space-y-5 px-5 py-5"
        onSubmit={async (event) => {
          event.preventDefault();
          await onSubmit({
            title: title.trim(),
            developerInstructions
          });
        }}
      >
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="thread-edit-title">
            제목
          </label>
          <input
            id="thread-edit-title"
            type="text"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setDirty(true);
            }}
            className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          />
        </div>

        {hasProjectDeveloperInstructions ? (
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="thread-edit-project-developer-instructions">
              프로젝트 공통 개발지침
            </label>
            <AutoSizingReadOnlyTextarea
              id="thread-edit-project-developer-instructions"
              value={projectDeveloperInstructions}
              placeholder="저장된 프로젝트 공통 개발지침이 없습니다."
              className="w-full resize-none rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white/90 outline-none"
            />
            <p className="mt-2 text-[11px] leading-5 text-slate-400">
              프로젝트에 저장된 공통 개발지침이며 여기서는 읽기 전용으로만 표시됩니다.
            </p>
          </div>
        ) : null}

        {threadInstructionSupported ? (
          <>
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="thread-instruction-input">
                개발지침 본문
              </label>
              <textarea
                id="thread-instruction-input"
                rows="10"
                value={developerInstructions}
                onChange={(event) => {
                  setDeveloperInstructions(event.target.value);
                  setDirty(true);
                }}
                placeholder="예: 이 채팅창에서만 지켜야 할 출력 형식, 금지사항, 역할 제약을 입력해 주세요."
                className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-400/30"
              />
              <p className="mt-2 text-[11px] leading-5 text-slate-400">
                비워 두고 저장하면 이 채팅창 전용 개발지침이 제거됩니다.
              </p>
            </div>
          </>
        ) : (
          <div className="rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-[12px] leading-6 text-slate-300">
            현재 연결된 브리지는 채팅창 전용 개발지침 저장을 지원하지 않아 제목만 수정할 수 있습니다.
          </div>
        )}

        {errorMessage ? (
          <div className="rounded-[1rem] border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-[12px] leading-6 text-rose-100">
            {errorMessage}
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/10 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-white/5"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={busy || !title.trim()}
            className="rounded-full bg-telegram-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "저장 중..." : "저장"}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}
