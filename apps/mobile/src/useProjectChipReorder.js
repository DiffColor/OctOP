import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function holdReorderedLayout(setter, frameCount) {
  setter(true);

  if (typeof window === "undefined") {
    setter(false);
    return;
  }

  let remainingFrames = Math.max(1, Number(frameCount) || 1);

  const release = () => {
    remainingFrames -= 1;

    if (remainingFrames <= 0) {
      setter(false);
      return;
    }

    window.requestAnimationFrame(release);
  };

  window.requestAnimationFrame(release);
}

export default function useProjectChipReorder({
  orderedProjectIds,
  projects,
  projectChipOrder,
  optimisticProjectChipOrder,
  setOptimisticProjectChipOrder,
  onChangeProjectChipOrder,
  onOpenProjectEditDialog,
  setProjectActionProjectId,
  onResetThreadSelection,
  onSelectProject,
  longPressMs,
  reorderMoveTolerancePx,
  longPressCancelTolerancePx,
  reorderPositionLockFrameCount,
  utils
}) {
  const {
    areStringArraysEqual,
    buildProjectChipCollapsedLayouts,
    getFlexRowGapPx,
    normalizeProjectChipOrder,
    reorderProjectChipIdsByIndex
  } = utils;
  const projectLongPressTimerRef = useRef(null);
  const projectLongPressTriggeredRef = useRef(false);
  const projectChipRowRef = useRef(null);
  const projectChipNodesRef = useRef(new Map());
  const projectChipDragStateRef = useRef(null);
  const projectChipDropIndexRef = useRef(-1);
  const projectChipLayoutSnapshotRef = useRef(new Map());
  const [draggingProjectChipId, setDraggingProjectChipId] = useState("");
  const [draggingProjectChipOffsetX, setDraggingProjectChipOffsetX] = useState(0);
  const [lockProjectChipDropLayout, setLockProjectChipDropLayout] = useState(false);

  const draggingProjectChipDropIndex =
    draggingProjectChipId && projectChipDragStateRef.current?.active ? projectChipDropIndexRef.current : -1;
  const draggingProjectChipShiftDistance = useMemo(() => {
    if (!draggingProjectChipId) {
      return 0;
    }

    const draggingLayout = projectChipLayoutSnapshotRef.current.get(draggingProjectChipId);
    const draggingNode = projectChipNodesRef.current.get(draggingProjectChipId);
    const draggingWidth = draggingLayout?.width ?? draggingNode?.offsetWidth ?? 0;

    if (draggingWidth <= 0) {
      return 0;
    }

    return draggingWidth + getFlexRowGapPx(projectChipRowRef.current);
  }, [draggingProjectChipId, draggingProjectChipOffsetX, getFlexRowGapPx, orderedProjectIds]);
  const draggingProjectChipProjectedIds = useMemo(() => {
    const activeDragState = projectChipDragStateRef.current;

    if (
      !draggingProjectChipId ||
      !activeDragState?.active ||
      !activeDragState.moved ||
      draggingProjectChipDropIndex < 0
    ) {
      return orderedProjectIds;
    }

    return reorderProjectChipIdsByIndex(orderedProjectIds, draggingProjectChipId, draggingProjectChipDropIndex);
  }, [draggingProjectChipDropIndex, draggingProjectChipId, draggingProjectChipOffsetX, orderedProjectIds, reorderProjectChipIdsByIndex]);
  const resolveProjectChipSlideOffsetX = useCallback(
    (projectId) => {
      const normalizedProjectId = String(projectId ?? "").trim();
      const activeDragState = projectChipDragStateRef.current;

      if (
        !normalizedProjectId ||
        !draggingProjectChipId ||
        normalizedProjectId === draggingProjectChipId ||
        !activeDragState?.active ||
        !activeDragState.moved ||
        draggingProjectChipShiftDistance <= 0
      ) {
        return 0;
      }

      const fromIndex = orderedProjectIds.indexOf(draggingProjectChipId);
      const toIndex = draggingProjectChipProjectedIds.indexOf(draggingProjectChipId);
      const currentIndex = orderedProjectIds.indexOf(normalizedProjectId);

      if (fromIndex < 0 || toIndex < 0 || currentIndex < 0 || fromIndex === toIndex) {
        return 0;
      }

      if (toIndex > fromIndex && currentIndex > fromIndex && currentIndex <= toIndex) {
        return -draggingProjectChipShiftDistance;
      }

      if (toIndex < fromIndex && currentIndex >= toIndex && currentIndex < fromIndex) {
        return draggingProjectChipShiftDistance;
      }

      return 0;
    },
    [draggingProjectChipId, draggingProjectChipProjectedIds, draggingProjectChipShiftDistance, orderedProjectIds]
  );

  const clearPendingProjectLongPress = useCallback(() => {
    if (projectLongPressTimerRef.current) {
      clearTimeout(projectLongPressTimerRef.current);
      projectLongPressTimerRef.current = null;
    }
  }, []);

  const resetProjectChipDragInteraction = useCallback(() => {
    projectChipDragStateRef.current = null;
    projectChipDropIndexRef.current = -1;
    projectChipLayoutSnapshotRef.current = new Map();
    setDraggingProjectChipId("");
    setDraggingProjectChipOffsetX(0);
  }, []);

  const registerProjectChipNode = useCallback((projectId, node) => {
    const normalizedProjectId = String(projectId ?? "").trim();

    if (!normalizedProjectId) {
      return;
    }

    if (node) {
      projectChipNodesRef.current.set(normalizedProjectId, node);
      return;
    }

    projectChipNodesRef.current.delete(normalizedProjectId);
  }, []);

  const captureProjectChipLayoutSnapshot = useCallback((projectIds) => {
    const snapshot = new Map();
    const scrollLeft = projectChipRowRef.current?.scrollLeft ?? 0;

    normalizeProjectChipOrder(projectIds).forEach((projectId) => {
      const node = projectChipNodesRef.current.get(projectId);

      if (!node) {
        return;
      }

      const rect = node.getBoundingClientRect();
      snapshot.set(projectId, {
        left: rect.left + scrollLeft,
        width: rect.width,
        height: rect.height
      });
    });

    projectChipLayoutSnapshotRef.current = snapshot;
    return snapshot;
  }, [normalizeProjectChipOrder]);

  const resolveProjectChipDropIndex = useCallback(
    (draggedCenterX, draggedProjectId) => {
      const normalizedDraggedProjectId = String(draggedProjectId ?? "").trim();
      const layoutSnapshot = projectChipLayoutSnapshotRef.current;
      const draggedLayout = layoutSnapshot.get(normalizedDraggedProjectId);
      const draggedNode = projectChipNodesRef.current.get(normalizedDraggedProjectId);
      const gapPx = getFlexRowGapPx(projectChipRowRef.current);
      const { draggedProjectIndex, draggableLayouts } = buildProjectChipCollapsedLayouts(
        orderedProjectIds,
        normalizedDraggedProjectId,
        layoutSnapshot,
        draggedLayout?.width ?? draggedNode?.offsetWidth ?? 0,
        gapPx
      );

      if (draggedProjectIndex < 0) {
        return -1;
      }

      for (let index = 0; index < draggableLayouts.length; index += 1) {
        const layout = draggableLayouts[index];
        const triggerX = layout.left + layout.width / 2;

        if (draggedCenterX < triggerX) {
          return index;
        }
      }

      return draggableLayouts.length;
    },
    [buildProjectChipCollapsedLayouts, getFlexRowGapPx, orderedProjectIds]
  );

  const maybeAutoScrollProjectChipRow = useCallback((clientX) => {
    const rowNode = projectChipRowRef.current;

    if (!rowNode) {
      return;
    }

    const rect = rowNode.getBoundingClientRect();
    const edgeThreshold = 36;

    if (clientX <= rect.left + edgeThreshold) {
      rowNode.scrollLeft = Math.max(0, rowNode.scrollLeft - 18);
      return;
    }

    if (clientX >= rect.right - edgeThreshold) {
      rowNode.scrollLeft = Math.min(rowNode.scrollWidth - rowNode.clientWidth, rowNode.scrollLeft + 18);
    }
  }, []);

  const handleProjectChipPointerDown = useCallback(
    (event, project) => {
      if (typeof window === "undefined" || !project) {
        return;
      }

      const isMousePointer = event?.pointerType === "mouse";
      const isTouchPointer = event?.pointerType === "touch" || event?.pointerType === "pen";

      if (!isTouchPointer && !(isMousePointer && event?.button === 0)) {
        return;
      }

      if (!isMousePointer) {
        event.preventDefault();
      }

      projectLongPressTriggeredRef.current = false;
      clearPendingProjectLongPress();
      resetProjectChipDragInteraction();
      projectChipDragStateRef.current = {
        active: false,
        moved: false,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        project,
        startX: event.clientX,
        startY: event.clientY,
        latestClientX: event.clientX,
        latestClientY: event.clientY,
        dragOriginCenterX: event.clientX,
        startScrollLeft: projectChipRowRef.current?.scrollLeft ?? 0
      };
      if (event?.currentTarget && typeof event.currentTarget.setPointerCapture === "function") {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // ignore pointer capture failures and fall back to window-level listeners
        }
      }

      projectLongPressTimerRef.current = window.setTimeout(() => {
        const activeDragState = projectChipDragStateRef.current;

        if (!activeDragState || activeDragState.pointerId !== event.pointerId) {
          projectLongPressTimerRef.current = null;
          return;
        }

        projectLongPressTimerRef.current = null;
        projectLongPressTriggeredRef.current = true;
        activeDragState.active = true;
        activeDragState.startX = activeDragState.latestClientX ?? event.clientX;
        activeDragState.startY = activeDragState.latestClientY ?? event.clientY;
        activeDragState.startScrollLeft = projectChipRowRef.current?.scrollLeft ?? activeDragState.startScrollLeft;
        const layoutSnapshot = captureProjectChipLayoutSnapshot(orderedProjectIds);
        const draggedLayout = layoutSnapshot.get(project.id);
        const draggedNode = projectChipNodesRef.current.get(project.id);
        const draggedRect = draggedNode?.getBoundingClientRect?.();
        activeDragState.dragOriginCenterX = draggedLayout
          ? draggedLayout.left + draggedLayout.width / 2
          : draggedRect
            ? draggedRect.left + (projectChipRowRef.current?.scrollLeft ?? activeDragState.startScrollLeft) + draggedRect.width / 2
            : activeDragState.startX + (projectChipRowRef.current?.scrollLeft ?? activeDragState.startScrollLeft);
        activeDragState.latestDraggedCenterX = activeDragState.dragOriginCenterX;
        projectChipDropIndexRef.current = resolveProjectChipDropIndex(activeDragState.dragOriginCenterX, project.id);
        setDraggingProjectChipId(project.id);
        setDraggingProjectChipOffsetX(0);
      }, longPressMs);
    },
    [
      captureProjectChipLayoutSnapshot,
      clearPendingProjectLongPress,
      longPressMs,
      orderedProjectIds,
      resetProjectChipDragInteraction,
      resolveProjectChipDropIndex
    ]
  );

  const handleProjectChipContextMenu = useCallback(
    (event, project) => {
      event.preventDefault();

      const activeDragState = projectChipDragStateRef.current;
      const activePointerType = activeDragState?.pointerType ?? "";
      const suppressActionSheet =
        Boolean(projectLongPressTimerRef.current) ||
        Boolean(activeDragState) ||
        projectLongPressTriggeredRef.current ||
        activePointerType === "touch" ||
        activePointerType === "pen";

      if (suppressActionSheet) {
        return;
      }

      clearPendingProjectLongPress();
      projectLongPressTriggeredRef.current = false;
      resetProjectChipDragInteraction();
      setProjectActionProjectId(project?.id ?? "");
    },
    [clearPendingProjectLongPress, resetProjectChipDragInteraction, setProjectActionProjectId]
  );

  const handleProjectChipPointerMove = useCallback(
    (event) => {
      const activeDragState = projectChipDragStateRef.current;

      if (!activeDragState || activeDragState.pointerId !== event.pointerId) {
        return;
      }

      const deltaX = event.clientX - activeDragState.startX;
      const deltaY = event.clientY - activeDragState.startY;
      activeDragState.latestClientX = event.clientX;
      activeDragState.latestClientY = event.clientY;

      if (!activeDragState.active) {
        if (Math.hypot(deltaX, deltaY) > longPressCancelTolerancePx) {
          clearPendingProjectLongPress();
          projectChipDragStateRef.current = null;
        }

        return;
      }

      const currentScrollLeft = projectChipRowRef.current?.scrollLeft ?? activeDragState.startScrollLeft;
      const dragOffsetX = event.clientX - activeDragState.startX + (currentScrollLeft - activeDragState.startScrollLeft);
      const draggedCenterX = activeDragState.dragOriginCenterX + dragOffsetX;
      activeDragState.latestDraggedCenterX = draggedCenterX;

      if (!activeDragState.moved && Math.hypot(dragOffsetX, deltaY) > reorderMoveTolerancePx) {
        activeDragState.moved = true;
      }

      projectChipDropIndexRef.current = resolveProjectChipDropIndex(draggedCenterX, activeDragState.project.id);
      setDraggingProjectChipOffsetX(dragOffsetX);
      maybeAutoScrollProjectChipRow(event.clientX);
      event.preventDefault();
    },
    [
      clearPendingProjectLongPress,
      longPressCancelTolerancePx,
      maybeAutoScrollProjectChipRow,
      reorderMoveTolerancePx,
      resolveProjectChipDropIndex
    ]
  );

  const handleProjectChipPointerEnd = useCallback(
    (event) => {
      const activeDragState = projectChipDragStateRef.current;

      clearPendingProjectLongPress();

      if (!activeDragState || activeDragState.pointerId !== event.pointerId) {
        projectLongPressTriggeredRef.current = false;
        resetProjectChipDragInteraction();
        return;
      }

      event.currentTarget.releasePointerCapture?.(event.pointerId);

      const { active, moved, project } = activeDragState;
      const dropIndex = projectChipDropIndexRef.current;

      if (!active) {
        projectLongPressTriggeredRef.current = false;
        resetProjectChipDragInteraction();
        return;
      }

      event.preventDefault();

      if (moved) {
        const nextProjectOrder = reorderProjectChipIdsByIndex(orderedProjectIds, project.id, dropIndex);

        if (!areStringArraysEqual(nextProjectOrder, orderedProjectIds)) {
          holdReorderedLayout(setLockProjectChipDropLayout, reorderPositionLockFrameCount);
          setOptimisticProjectChipOrder(nextProjectOrder);
          onChangeProjectChipOrder(nextProjectOrder);
        }

        resetProjectChipDragInteraction();
        window.setTimeout(() => {
          projectLongPressTriggeredRef.current = false;
        }, 0);
        return;
      }

      resetProjectChipDragInteraction();
      onOpenProjectEditDialog(project);

      window.setTimeout(() => {
        projectLongPressTriggeredRef.current = false;
      }, 0);
    },
    [
      areStringArraysEqual,
      clearPendingProjectLongPress,
      onChangeProjectChipOrder,
      onOpenProjectEditDialog,
      orderedProjectIds,
      reorderPositionLockFrameCount,
      reorderProjectChipIdsByIndex,
      resetProjectChipDragInteraction,
      setOptimisticProjectChipOrder
    ]
  );

  const handleProjectChipPointerCancel = useCallback(
    (event) => {
      clearPendingProjectLongPress();

      if (event?.currentTarget && typeof event.currentTarget.releasePointerCapture === "function" && event.pointerId != null) {
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          // ignore pointer capture release failures
        }
      }

      projectLongPressTriggeredRef.current = false;
      resetProjectChipDragInteraction();
    },
    [clearPendingProjectLongPress, resetProjectChipDragInteraction]
  );

  const handleProjectChipClick = useCallback(
    (projectId) => {
      if (projectLongPressTriggeredRef.current) {
        projectLongPressTriggeredRef.current = false;
        return;
      }

      const normalizedProjectId = String(projectId ?? "").trim();

      onResetThreadSelection();
      onSelectProject(normalizedProjectId);
    },
    [onResetThreadSelection, onSelectProject]
  );

  useEffect(() => {
    if (!optimisticProjectChipOrder) {
      return;
    }

    const normalizedAvailableProjectIds = projects.map((project) => project.id);
    const normalizedOptimisticOrder = normalizeProjectChipOrder(optimisticProjectChipOrder, normalizedAvailableProjectIds);
    const normalizedCommittedOrder = normalizeProjectChipOrder(projectChipOrder, normalizedAvailableProjectIds);

    if (areStringArraysEqual(normalizedOptimisticOrder, normalizedCommittedOrder)) {
      setOptimisticProjectChipOrder(null);
    }
  }, [
    areStringArraysEqual,
    normalizeProjectChipOrder,
    optimisticProjectChipOrder,
    projectChipOrder,
    projects,
    setOptimisticProjectChipOrder
  ]);

  useEffect(
    () => () => {
      clearPendingProjectLongPress();
      resetProjectChipDragInteraction();
    },
    [clearPendingProjectLongPress, resetProjectChipDragInteraction]
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const handleTouchMove = (event) => {
      if (projectChipDragStateRef.current?.active) {
        event.preventDefault();
      }
    };

    window.addEventListener("touchmove", handleTouchMove, { passive: false });

    return () => {
      window.removeEventListener("touchmove", handleTouchMove);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const handleWindowPointerMove = (event) => {
      if (projectChipDragStateRef.current?.pointerId !== event.pointerId) {
        return;
      }

      handleProjectChipPointerMove(event);
    };
    const handleWindowPointerEnd = (event) => {
      if (projectChipDragStateRef.current?.pointerId !== event.pointerId) {
        return;
      }

      handleProjectChipPointerEnd(event);
    };
    const handleWindowPointerCancel = (event) => {
      if (projectChipDragStateRef.current?.pointerId !== event.pointerId) {
        return;
      }

      handleProjectChipPointerCancel(event);
    };

    window.addEventListener("pointermove", handleWindowPointerMove, { passive: false });
    window.addEventListener("pointerup", handleWindowPointerEnd);
    window.addEventListener("pointercancel", handleWindowPointerCancel);

    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", handleWindowPointerEnd);
      window.removeEventListener("pointercancel", handleWindowPointerCancel);
    };
  }, [handleProjectChipPointerCancel, handleProjectChipPointerEnd, handleProjectChipPointerMove]);

  return {
    projectChipRowRef,
    projectChipNodesRef,
    projectChipLayoutSnapshotRef,
    draggingProjectChipId,
    draggingProjectChipOffsetX,
    lockProjectChipDropLayout,
    registerProjectChipNode,
    resolveProjectChipSlideOffsetX,
    handleProjectChipPointerDown,
    handleProjectChipContextMenu,
    handleProjectChipClick,
    resetProjectChipDragInteraction
  };
}
