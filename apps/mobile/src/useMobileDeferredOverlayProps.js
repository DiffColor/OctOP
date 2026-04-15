import { useCallback, useMemo } from "react";

export default function useMobileDeferredOverlayProps({
  threadDeleteDialog,
  threadBusy,
  onCloseThreadDeleteDialog,
  onConfirmThreadDeleteDialog,
  todoChatBeingEdited,
  setTodoChatBeingEdited,
  todoRenameBusy,
  onRenameTodoChat,
  activeTodoMessage,
  setActiveTodoMessage,
  todoMessageEditorOpen,
  setTodoMessageEditorOpen,
  todoTransferOpen,
  setTodoTransferOpen,
  onDeleteTodoMessage,
  todoBusy,
  onEditTodoMessage,
  todoTransferBusy,
  projects,
  threadOptionsByProjectId,
  selectedProjectId,
  onEnsureProjectThreads,
  onTransferTodoMessage,
  projectActionTarget,
  projectEditBusy,
  projectBusy,
  setProjectActionProjectId,
  onOpenProjectEditDialog,
  requestProjectDeletion,
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
  projectEditTarget,
  projectEditError,
  onCloseProjectEditDialog,
  onSubmitProjectEdit,
  threadInstructionDialogOpen,
  threadInstructionBusy,
  threadInstructionTarget,
  threadInstructionProject,
  threadInstructionSupported,
  threadInstructionError,
  onCloseThreadInstructionDialog,
  onSubmitThreadInstruction
}) {
  const shouldRenderDeferredOverlays =
    threadDeleteDialog.open ||
    Boolean(todoChatBeingEdited) ||
    Boolean(activeTodoMessage) ||
    todoMessageEditorOpen ||
    todoTransferOpen ||
    Boolean(projectActionTarget) ||
    utilityOpen ||
    projectComposerOpen ||
    threadCreateDialogOpen ||
    projectInstructionDialogOpen ||
    projectEditDialogOpen ||
    threadInstructionDialogOpen;

  const handleCloseTodoChatRename = useCallback(() => {
    setTodoChatBeingEdited(null);
  }, [setTodoChatBeingEdited]);

  const handleSubmitTodoChatRename = useCallback(
    (title) => onRenameTodoChat(todoChatBeingEdited?.id, title),
    [onRenameTodoChat, todoChatBeingEdited?.id]
  );

  const handleCloseTodoMessageAction = useCallback(() => {
    setActiveTodoMessage(null);
  }, [setActiveTodoMessage]);

  const handleOpenTodoMessageEditor = useCallback(() => {
    setTodoMessageEditorOpen(true);
  }, [setTodoMessageEditorOpen]);

  const handleDeleteActiveTodoMessage = useCallback(async () => {
    const accepted = await onDeleteTodoMessage(activeTodoMessage?.id);

    if (accepted !== false) {
      setActiveTodoMessage(null);
    }
  }, [activeTodoMessage?.id, onDeleteTodoMessage, setActiveTodoMessage]);

  const handleOpenTodoTransfer = useCallback(() => {
    setTodoTransferOpen(true);
  }, [setTodoTransferOpen]);

  const handleCloseTodoMessageEditor = useCallback(() => {
    setTodoMessageEditorOpen(false);
  }, [setTodoMessageEditorOpen]);

  const handleSubmitTodoMessageEditor = useCallback(
    async (content) => {
      const accepted = await onEditTodoMessage(activeTodoMessage?.id, content);

      if (accepted !== false) {
        setTodoMessageEditorOpen(false);
        setActiveTodoMessage(null);
      }

      return accepted;
    },
    [activeTodoMessage?.id, onEditTodoMessage, setActiveTodoMessage, setTodoMessageEditorOpen]
  );

  const handleCloseTodoTransfer = useCallback(() => {
    setTodoTransferOpen(false);
  }, [setTodoTransferOpen]);

  const handleSubmitTodoTransfer = useCallback(
    async (payload) => {
      const accepted = await onTransferTodoMessage(activeTodoMessage?.id, payload);

      if (accepted !== false) {
        setTodoTransferOpen(false);
        setActiveTodoMessage(null);
      }

      return accepted;
    },
    [activeTodoMessage?.id, onTransferTodoMessage, setActiveTodoMessage, setTodoTransferOpen]
  );

  const handleCloseProjectAction = useCallback(() => {
    setProjectActionProjectId("");
  }, [setProjectActionProjectId]);

  const handleEditProjectAction = useCallback(() => {
    if (!projectActionTarget) {
      return;
    }

    setProjectActionProjectId("");
    onOpenProjectEditDialog(projectActionTarget);
  }, [onOpenProjectEditDialog, projectActionTarget, setProjectActionProjectId]);

  const handleDeleteProjectAction = useCallback(() => {
    requestProjectDeletion(projectActionTarget);
  }, [projectActionTarget, requestProjectDeletion]);

  const deferredOverlayProps = useMemo(
    () => ({
      threadDeleteDialog,
      threadBusy,
      onCloseThreadDeleteDialog,
      onConfirmThreadDeleteDialog,
      todoChatBeingEdited,
      todoRenameBusy,
      onCloseTodoChatRename: handleCloseTodoChatRename,
      onSubmitTodoChatRename: handleSubmitTodoChatRename,
      activeTodoMessage,
      todoMessageEditorOpen,
      todoTransferOpen,
      onCloseTodoMessageAction: handleCloseTodoMessageAction,
      onOpenTodoMessageEditor: handleOpenTodoMessageEditor,
      onDeleteActiveTodoMessage: handleDeleteActiveTodoMessage,
      onOpenTodoTransfer: handleOpenTodoTransfer,
      todoBusy,
      onCloseTodoMessageEditor: handleCloseTodoMessageEditor,
      onSubmitTodoMessageEditor: handleSubmitTodoMessageEditor,
      todoTransferBusy,
      projects,
      threadOptionsByProjectId,
      selectedProjectId,
      onEnsureProjectThreads,
      onCloseTodoTransfer: handleCloseTodoTransfer,
      onSubmitTodoTransfer: handleSubmitTodoTransfer,
      projectActionTarget,
      projectActionBusy: projectEditBusy || projectBusy,
      onCloseProjectAction: handleCloseProjectAction,
      onEditProjectAction: handleEditProjectAction,
      onDeleteProjectAction: handleDeleteProjectAction,
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
      onRequestProjectDeletion: requestProjectDeletion,
      threadInstructionDialogOpen,
      threadInstructionBusy,
      threadInstructionTarget,
      threadInstructionProject,
      threadInstructionSupported,
      threadInstructionError,
      onCloseThreadInstructionDialog,
      onSubmitThreadInstruction
    }),
    [
      activeTodoMessage,
      bridgeSignal,
      folderLoading,
      folderState,
      handleCloseProjectAction,
      handleCloseTodoChatRename,
      handleCloseTodoMessageAction,
      handleCloseTodoMessageEditor,
      handleCloseTodoTransfer,
      handleDeleteActiveTodoMessage,
      handleDeleteProjectAction,
      handleEditProjectAction,
      handleOpenTodoMessageEditor,
      handleOpenTodoTransfer,
      handleSubmitTodoChatRename,
      handleSubmitTodoMessageEditor,
      handleSubmitTodoTransfer,
      onBrowseFolder,
      onCloseProjectComposer,
      onCloseProjectEditDialog,
      onCloseProjectInstructionDialog,
      onCloseThreadCreateDialog,
      onCloseThreadDeleteDialog,
      onCloseThreadInstructionDialog,
      onConfirmThreadDeleteDialog,
      onEnsureProjectThreads,
      onLogout,
      onOpenProjectComposer,
      onOpenProjectInstructionDialog,
      onCloseUtility,
      onRefresh,
      onSelectWorkspace,
      onSubmitProject,
      onSubmitProjectEdit,
      onSubmitProjectInstruction,
      onSubmitThreadCreateDialog,
      onSubmitThreadInstruction,
      projectActionTarget,
      projectBusy,
      projectComposerOpen,
      projectEditBusy,
      projectEditDialogOpen,
      projectEditError,
      projectEditTarget,
      projectInstructionBusy,
      projectInstructionDialogOpen,
      projectInstructionType,
      projects,
      pushNotificationCard,
      requestProjectDeletion,
      selectedProject,
      selectedProjectId,
      selectedWorkspacePath,
      session,
      threadBusy,
      threadCreateDialogOpen,
      threadDeleteDialog,
      threadInstructionBusy,
      threadInstructionDialogOpen,
      threadInstructionError,
      threadInstructionProject,
      threadInstructionSupported,
      threadInstructionTarget,
      threadOptionsByProjectId,
      todoBusy,
      todoChatBeingEdited,
      todoMessageEditorOpen,
      todoRenameBusy,
      todoTransferBusy,
      todoTransferOpen,
      utilityOpen,
      workspaceRoots
    ]
  );

  return {
    shouldRenderDeferredOverlays,
    deferredOverlayProps
  };
}
