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

export default function useThreadListReorder({
  filteredThreadIds,
  optimisticThreadOrderByProjectId,
  orderedThreadIds,
  onChangeThreadOrder,
  onResetThreadSelection,
  reorderMoveTolerancePx,
  reorderPositionLockFrameCount,
  selectedProjectId,
  setOptimisticThreadOrderByProjectId,
  threadOrderByProjectId,
  utils
}) {
  const {
    applySubsetThreadOrder,
    areStringArraysEqual,
    buildThreadListCollapsedLayouts,
    normalizeThreadOrder,
    reorderThreadIdsByIndex
  } = utils;
  const threadListItemNodesRef = useRef(new Map());
  const threadListDragStateRef = useRef(null);
  const threadListDropIndexRef = useRef(-1);
  const threadListLayoutSnapshotRef = useRef(new Map());
  const [draggingThreadId, setDraggingThreadId] = useState("");
  const [draggingThreadOffsetY, setDraggingThreadOffsetY] = useState(0);
  const [lockThreadListDropLayout, setLockThreadListDropLayout] = useState(false);

  const draggingThreadDropIndex =
    draggingThreadId && threadListDragStateRef.current?.active ? threadListDropIndexRef.current : -1;
  const draggingThreadShiftDistance = useMemo(() => {
    if (!draggingThreadId) {
      return 0;
    }

    const draggingNode = threadListItemNodesRef.current.get(draggingThreadId);

    if (!draggingNode) {
      return 0;
    }

    return draggingNode.offsetHeight;
  }, [draggingThreadId, draggingThreadOffsetY, filteredThreadIds]);
  const draggingThreadProjectedIds = useMemo(() => {
    const activeDragState = threadListDragStateRef.current;

    if (
      !draggingThreadId ||
      !activeDragState?.active ||
      !activeDragState.moved ||
      draggingThreadDropIndex < 0
    ) {
      return filteredThreadIds;
    }

    return reorderThreadIdsByIndex(filteredThreadIds, draggingThreadId, draggingThreadDropIndex);
  }, [draggingThreadDropIndex, draggingThreadId, draggingThreadOffsetY, filteredThreadIds, reorderThreadIdsByIndex]);
  const resolveThreadListItemSlideOffsetY = useCallback(
    (threadId) => {
      const normalizedThreadId = String(threadId ?? "").trim();
      const activeDragState = threadListDragStateRef.current;

      if (
        !normalizedThreadId ||
        !draggingThreadId ||
        normalizedThreadId === draggingThreadId ||
        !activeDragState?.active ||
        !activeDragState.moved ||
        draggingThreadShiftDistance <= 0
      ) {
        return 0;
      }

      const fromIndex = filteredThreadIds.indexOf(draggingThreadId);
      const toIndex = draggingThreadProjectedIds.indexOf(draggingThreadId);
      const currentIndex = filteredThreadIds.indexOf(normalizedThreadId);

      if (fromIndex < 0 || toIndex < 0 || currentIndex < 0 || fromIndex === toIndex) {
        return 0;
      }

      if (toIndex > fromIndex && currentIndex > fromIndex && currentIndex <= toIndex) {
        return -draggingThreadShiftDistance;
      }

      if (toIndex < fromIndex && currentIndex >= toIndex && currentIndex < fromIndex) {
        return draggingThreadShiftDistance;
      }

      return 0;
    },
    [draggingThreadId, draggingThreadProjectedIds, draggingThreadShiftDistance, filteredThreadIds]
  );

  const resetThreadListDragInteraction = useCallback(() => {
    threadListDragStateRef.current = null;
    threadListDropIndexRef.current = -1;
    threadListLayoutSnapshotRef.current = new Map();
    setDraggingThreadId("");
    setDraggingThreadOffsetY(0);
  }, []);

  const registerThreadListItemNode = useCallback((threadId, node) => {
    const normalizedThreadId = String(threadId ?? "").trim();

    if (!normalizedThreadId) {
      return;
    }

    if (node) {
      threadListItemNodesRef.current.set(normalizedThreadId, node);
      return;
    }

    threadListItemNodesRef.current.delete(normalizedThreadId);
  }, []);

  const captureThreadListLayoutSnapshot = useCallback(
    (threadIds) => {
      const snapshot = new Map();

      normalizeThreadOrder(threadIds).forEach((threadId) => {
        const node = threadListItemNodesRef.current.get(threadId);

        if (!node) {
          return;
        }

        const rect = node.getBoundingClientRect();
        snapshot.set(threadId, {
          top: rect.top,
          height: rect.height
        });
      });

      threadListLayoutSnapshotRef.current = snapshot;
      return snapshot;
    },
    [normalizeThreadOrder]
  );

  const resolveThreadDropIndex = useCallback(
    (draggedCenterY, draggedThreadId) => {
      const activeDragState = threadListDragStateRef.current;
      const normalizedDraggedThreadId = String(draggedThreadId ?? "").trim();
      const baseThreadIds = normalizeThreadOrder(activeDragState?.visibleThreadIds ?? filteredThreadIds);
      const layoutSnapshot = threadListLayoutSnapshotRef.current;
      const draggedThreadLayout = layoutSnapshot.get(normalizedDraggedThreadId);
      const draggedNode = threadListItemNodesRef.current.get(normalizedDraggedThreadId);
      const { draggedThreadIndex, draggableLayouts } = buildThreadListCollapsedLayouts(
        baseThreadIds,
        normalizedDraggedThreadId,
        layoutSnapshot,
        draggedThreadLayout?.height ?? draggedNode?.offsetHeight ?? 0
      );

      if (draggedThreadIndex < 0) {
        return -1;
      }

      for (let index = 0; index < draggableLayouts.length; index += 1) {
        const layout = draggableLayouts[index];
        const triggerY = layout.top + layout.height / 2;

        if (draggedCenterY < triggerY) {
          return index;
        }
      }

      return draggableLayouts.length;
    },
    [buildThreadListCollapsedLayouts, filteredThreadIds, normalizeThreadOrder]
  );

  const handleThreadReorderStart = useCallback(
    ({ thread, pointerId, clientY }) => {
      if (!thread?.id || !selectedProjectId) {
        return;
      }

      const visibleThreadIds = [...filteredThreadIds];
      const layoutSnapshot = captureThreadListLayoutSnapshot(visibleThreadIds);
      const draggedLayout = layoutSnapshot.get(thread.id);
      const draggedNode = threadListItemNodesRef.current.get(thread.id);
      const dragOriginCenterY = draggedLayout
        ? draggedLayout.top + draggedLayout.height / 2
        : ((draggedNode?.getBoundingClientRect?.().top ?? clientY) + (draggedNode?.offsetHeight ?? 0) / 2);

      onResetThreadSelection();
      threadListDragStateRef.current = {
        active: true,
        moved: false,
        pointerId,
        thread,
        startY: clientY,
        dragOriginCenterY,
        latestDraggedCenterY: dragOriginCenterY,
        visibleThreadIds
      };
      threadListDropIndexRef.current = resolveThreadDropIndex(dragOriginCenterY, thread.id);
      setDraggingThreadId(thread.id);
      setDraggingThreadOffsetY(0);
    },
    [captureThreadListLayoutSnapshot, filteredThreadIds, onResetThreadSelection, resolveThreadDropIndex, selectedProjectId]
  );

  const handleThreadReorderMove = useCallback(
    ({ threadId, pointerId, clientY }) => {
      const activeDragState = threadListDragStateRef.current;

      if (
        !activeDragState ||
        activeDragState.pointerId !== pointerId ||
        activeDragState.thread?.id !== String(threadId ?? "").trim()
      ) {
        return false;
      }

      const dragOffsetY = clientY - activeDragState.startY;
      const draggedCenterY = activeDragState.dragOriginCenterY + dragOffsetY;
      activeDragState.latestDraggedCenterY = draggedCenterY;

      if (!activeDragState.moved && Math.abs(dragOffsetY) > reorderMoveTolerancePx) {
        activeDragState.moved = true;
      }

      threadListDropIndexRef.current = resolveThreadDropIndex(draggedCenterY, activeDragState.thread.id);
      setDraggingThreadOffsetY(dragOffsetY);
      return true;
    },
    [reorderMoveTolerancePx, resolveThreadDropIndex]
  );

  const handleThreadReorderEnd = useCallback(
    ({ threadId, pointerId }) => {
      const activeDragState = threadListDragStateRef.current;

      if (
        !activeDragState ||
        activeDragState.pointerId !== pointerId ||
        activeDragState.thread?.id !== String(threadId ?? "").trim()
      ) {
        resetThreadListDragInteraction();
        return false;
      }

      const { moved, thread } = activeDragState;
      const dropIndex = threadListDropIndexRef.current;

      if (!moved || !selectedProjectId) {
        resetThreadListDragInteraction();
        return true;
      }

      const reorderedVisibleThreadIds = reorderThreadIdsByIndex(filteredThreadIds, thread.id, dropIndex);
      const nextThreadOrder = applySubsetThreadOrder(orderedThreadIds, filteredThreadIds, reorderedVisibleThreadIds);

      if (!areStringArraysEqual(nextThreadOrder, orderedThreadIds)) {
        holdReorderedLayout(setLockThreadListDropLayout, reorderPositionLockFrameCount);
        setOptimisticThreadOrderByProjectId((current) => ({
          ...current,
          [selectedProjectId]: nextThreadOrder
        }));
        onChangeThreadOrder(selectedProjectId, nextThreadOrder);
      }

      resetThreadListDragInteraction();
      return true;
    },
    [
      applySubsetThreadOrder,
      areStringArraysEqual,
      filteredThreadIds,
      onChangeThreadOrder,
      orderedThreadIds,
      reorderPositionLockFrameCount,
      reorderThreadIdsByIndex,
      resetThreadListDragInteraction,
      selectedProjectId,
      setOptimisticThreadOrderByProjectId
    ]
  );

  const handleThreadReorderCancel = useCallback(
    ({ threadId, pointerId }) => {
      const activeDragState = threadListDragStateRef.current;

      if (
        activeDragState &&
        activeDragState.pointerId === pointerId &&
        activeDragState.thread?.id === String(threadId ?? "").trim()
      ) {
        resetThreadListDragInteraction();
        return true;
      }

      return false;
    },
    [resetThreadListDragInteraction]
  );

  useEffect(() => {
    const optimisticProjectIds = Object.keys(optimisticThreadOrderByProjectId);

    if (optimisticProjectIds.length === 0) {
      return;
    }

    setOptimisticThreadOrderByProjectId((current) => {
      const next = { ...current };
      let changed = false;

      optimisticProjectIds.forEach((projectId) => {
        const normalizedOptimisticOrder = normalizeThreadOrder(current[projectId] ?? []);
        const normalizedCommittedOrder = normalizeThreadOrder(threadOrderByProjectId[projectId] ?? []);

        if (areStringArraysEqual(normalizedOptimisticOrder, normalizedCommittedOrder)) {
          delete next[projectId];
          changed = true;
        }
      });

      return changed ? next : current;
    });
  }, [
    areStringArraysEqual,
    normalizeThreadOrder,
    optimisticThreadOrderByProjectId,
    setOptimisticThreadOrderByProjectId,
    threadOrderByProjectId
  ]);

  useEffect(
    () => () => {
      resetThreadListDragInteraction();
    },
    [resetThreadListDragInteraction]
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const handleTouchMove = (event) => {
      if (threadListDragStateRef.current?.active) {
        event.preventDefault();
      }
    };

    window.addEventListener("touchmove", handleTouchMove, { passive: false });

    return () => {
      window.removeEventListener("touchmove", handleTouchMove);
    };
  }, []);

  return {
    registerThreadListItemNode,
    draggingThreadId,
    draggingThreadOffsetY,
    lockThreadListDropLayout,
    resolveThreadListItemSlideOffsetY,
    handleThreadReorderStart,
    handleThreadReorderMove,
    handleThreadReorderEnd,
    handleThreadReorderCancel
  };
}
