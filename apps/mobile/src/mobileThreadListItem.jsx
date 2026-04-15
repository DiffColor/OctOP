import { useCallback, useRef, useState } from "react";

export default function MobileThreadListItem({
  thread,
  active,
  selected = false,
  selectionMode = false,
  signalNow,
  registerNode,
  reorderActive = false,
  reorderOffsetY = 0,
  transitionLocked = false,
  onStartReorder,
  onMoveReorder,
  onEndReorder,
  onCancelReorder,
  onOpen,
  onRename,
  onDelete,
  onToggleSelect,
  onEnterSelectionMode,
  helpers = {}
}) {
  const {
    buildThreadResponseSignal,
    formatRelativeTime,
    formatThreadContextUsage,
    getStatusMeta,
    getThreadPreview,
    longPressCancelTolerancePx,
    longPressMs,
    reorderMoveTolerancePx
  } = helpers;
  const status = getStatusMeta(thread.status);
  const responseSignal = buildThreadResponseSignal(thread, signalNow);
  const contextUsageLabel = formatThreadContextUsage(thread);
  const startPointRef = useRef(null);
  const baseOffsetRef = useRef(0);
  const pointerIdRef = useRef(null);
  const swipeAxisRef = useRef(null);
  const offsetRef = useRef(0);
  const movedRef = useRef(false);
  const latestPointerPointRef = useRef(null);
  const longPressTimerRef = useRef(null);
  const longPressTriggeredRef = useRef(false);
  const longPressReadyRef = useRef(false);
  const reorderRequestedRef = useRef(false);
  const ACTION_WIDTH = 92;
  const SNAP_THRESHOLD = 42;
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const highlighted = selectionMode ? selected : active;

  const clearPendingLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const setRevealOffset = useCallback((nextOffset) => {
    const clamped = Math.max(-ACTION_WIDTH, Math.min(ACTION_WIDTH, nextOffset));
    offsetRef.current = clamped;
    setOffset(clamped);
  }, []);

  const handlePointerDown = useCallback((event) => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    startPointRef.current = { x: event.clientX, y: event.clientY };
    latestPointerPointRef.current = { x: event.clientX, y: event.clientY };
    baseOffsetRef.current = offsetRef.current;
    pointerIdRef.current = event.pointerId;
    swipeAxisRef.current = null;
    movedRef.current = false;
    longPressTriggeredRef.current = false;
    longPressReadyRef.current = false;
    reorderRequestedRef.current = false;
    setDragging(false);
    event.currentTarget.setPointerCapture?.(event.pointerId);

    clearPendingLongPress();

    if (
      event.pointerType === "touch" ||
      event.pointerType === "pen" ||
      (event.pointerType === "mouse" && event.button === 0)
    ) {
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null;
        longPressTriggeredRef.current = true;
        longPressReadyRef.current = true;
        reorderRequestedRef.current = false;
        setRevealOffset(0);
      }, longPressMs);
    }
  }, [clearPendingLongPress, longPressMs, setRevealOffset]);

  const handlePointerMove = useCallback(
    (event) => {
      if (reorderActive) {
        if (event.cancelable) {
          event.preventDefault();
        }

        onMoveReorder?.({
          threadId: thread.id,
          pointerId: event.pointerId,
          clientY: event.clientY
        });
        return;
      }

      if (
        startPointRef.current === null ||
        (pointerIdRef.current !== null && event.pointerId !== pointerIdRef.current)
      ) {
        return;
      }

      const deltaX = event.clientX - startPointRef.current.x;
      const deltaY = event.clientY - startPointRef.current.y;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      latestPointerPointRef.current = { x: event.clientX, y: event.clientY };

      if (longPressReadyRef.current) {
        if (!reorderRequestedRef.current && absY > reorderMoveTolerancePx) {
          reorderRequestedRef.current = true;
          onStartReorder?.({
            thread,
            pointerId: event.pointerId,
            clientY: startPointRef.current?.y ?? event.clientY
          });
          onMoveReorder?.({
            threadId: thread.id,
            pointerId: event.pointerId,
            clientY: event.clientY
          });
        }

        if (event.cancelable) {
          event.preventDefault();
        }

        return;
      }

      if (Math.hypot(deltaX, deltaY) > longPressCancelTolerancePx) {
        clearPendingLongPress();
      }

      if (swipeAxisRef.current === null) {
        if (absX < 6 && absY < 6) {
          return;
        }

        clearPendingLongPress();
        swipeAxisRef.current = absX > absY ? "x" : "y";
      }

      if (swipeAxisRef.current !== "x") {
        return;
      }

      if (event.cancelable) {
        event.preventDefault();
      }

      if (absX > 6) {
        movedRef.current = true;
      }

      setDragging(true);
      setRevealOffset(baseOffsetRef.current + deltaX);
    },
    [clearPendingLongPress, longPressCancelTolerancePx, onMoveReorder, onStartReorder, reorderActive, reorderMoveTolerancePx, setRevealOffset, thread]
  );

  const handlePointerUp = useCallback((event) => {
    if (reorderActive) {
      clearPendingLongPress();
      startPointRef.current = null;
      baseOffsetRef.current = 0;
      pointerIdRef.current = null;
      swipeAxisRef.current = null;
      latestPointerPointRef.current = null;
      setDragging(false);
      onEndReorder?.({
        threadId: thread.id,
        pointerId: event.pointerId
      });
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      return;
    }

    if (startPointRef.current === null) {
      return;
    }

    const longPressReady = longPressReadyRef.current;
    const reorderRequested = reorderRequestedRef.current;

    clearPendingLongPress();

    if (longPressReady) {
      startPointRef.current = null;
      baseOffsetRef.current = 0;
      pointerIdRef.current = null;
      swipeAxisRef.current = null;
      latestPointerPointRef.current = null;
      longPressReadyRef.current = false;
      reorderRequestedRef.current = false;
      movedRef.current = false;
      setDragging(false);
      setRevealOffset(0);
      event.currentTarget.releasePointerCapture?.(event.pointerId);

      if (!reorderRequested) {
        if (event.cancelable) {
          event.preventDefault();
        }

        onEnterSelectionMode?.(thread.id);
      }

      return;
    }

    if (swipeAxisRef.current === "x" && offsetRef.current <= -SNAP_THRESHOLD) {
      setRevealOffset(-ACTION_WIDTH);
    } else if (swipeAxisRef.current === "x" && offsetRef.current >= SNAP_THRESHOLD) {
      setRevealOffset(ACTION_WIDTH);
    } else if (swipeAxisRef.current === "x") {
      setRevealOffset(0);
    }

    startPointRef.current = null;
    baseOffsetRef.current = 0;
    pointerIdRef.current = null;
    swipeAxisRef.current = null;
    latestPointerPointRef.current = null;
    longPressReadyRef.current = false;
    reorderRequestedRef.current = false;
    setDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, [clearPendingLongPress, onEndReorder, onEnterSelectionMode, reorderActive, setRevealOffset, thread.id]);

  const handlePointerCancel = useCallback(
    (event) => {
      clearPendingLongPress();

      if (reorderActive) {
        onCancelReorder?.({
          threadId: thread.id,
          pointerId: event.pointerId
        });
      }

      startPointRef.current = null;
      baseOffsetRef.current = 0;
      pointerIdRef.current = null;
      swipeAxisRef.current = null;
      latestPointerPointRef.current = null;
      longPressReadyRef.current = false;
      reorderRequestedRef.current = false;
      setDragging(false);

      if (event?.currentTarget && typeof event.currentTarget.releasePointerCapture === "function") {
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          // ignore pointer capture release failures
        }
      }
    },
    [clearPendingLongPress, onCancelReorder, reorderActive, thread.id]
  );

  const showDeleteAction = offset > 0;
  const showRenameAction = offset < 0;

  return (
    <div
      className={`relative border-b border-white/8 ${
        reorderActive || reorderOffsetY !== 0 ? "overflow-visible" : "overflow-hidden"
      }`}
      style={{ zIndex: reorderActive ? 20 : reorderOffsetY !== 0 ? 10 : 0 }}
    >
      <button
        type="button"
        onClick={() => {
          setRevealOffset(0);
          onDelete(thread);
        }}
        className={`absolute inset-y-0 left-0 flex w-[92px] items-center justify-center bg-rose-500 text-[12px] font-semibold text-white transition-opacity duration-150 ${
          !selectionMode && showDeleteAction ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        삭제
      </button>

      <button
        type="button"
        onClick={() => {
          setRevealOffset(0);
          onRename(thread);
        }}
        className={`absolute inset-y-0 right-0 flex w-[92px] items-center justify-center bg-slate-800 text-[12px] font-semibold text-white transition-opacity duration-150 ${
          !selectionMode && showRenameAction ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        편집
      </button>

      <button
        type="button"
        ref={(node) => registerNode?.(thread.id, node)}
        data-testid={`thread-list-item-${thread.id}`}
        onPointerDown={selectionMode ? undefined : handlePointerDown}
        onPointerMove={selectionMode ? undefined : handlePointerMove}
        onPointerUp={selectionMode ? undefined : handlePointerUp}
        onPointerCancel={selectionMode ? undefined : handlePointerCancel}
        onClick={() => {
          if (longPressTriggeredRef.current) {
            longPressTriggeredRef.current = false;
            return;
          }

          if (movedRef.current) {
            movedRef.current = false;
            return;
          }

          if (offsetRef.current !== 0) {
            setRevealOffset(0);
            return;
          }

          if (selectionMode) {
            onToggleSelect?.(thread.id);
            return;
          }

          onOpen(thread.id);
        }}
        onContextMenu={(event) => {
          if (!selectionMode) {
            event.preventDefault();
          }
        }}
        className={`thread-list-item-touch-target relative w-full px-3 py-3 text-left ${
          dragging || reorderActive || transitionLocked ? "" : "transition-transform duration-180 ease-out"
        } ${highlighted ? "bg-slate-900" : "bg-slate-950 hover:bg-slate-900/90"} `}
        aria-pressed={selectionMode ? selected : undefined}
        aria-label={selectionMode ? `${thread.title} 선택` : undefined}
        style={{
          transform: `translate3d(${offset}px, ${reorderOffsetY}px, 0) scale(${reorderActive ? 1.01 : 1})`,
          transition: transitionLocked ? "none" : undefined,
          touchAction: selectionMode ? "auto" : reorderActive ? "none" : "pan-y",
          zIndex: reorderActive ? 20 : 0,
          willChange: "transform"
        }}
      >
        <div
          className={`min-w-0 rounded-2xl border px-3 py-3 ${
            highlighted
              ? "border-white/12 bg-white/[0.03]"
              : "border-transparent bg-transparent"
          } ${reorderActive ? "shadow-[0_18px_42px_rgba(15,23,42,0.38)]" : ""}`}
        >
          <div className="flex items-start gap-3">
            {selectionMode ? (
              <span
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                  selected
                    ? "border-telegram-400 bg-telegram-500 text-white"
                    : "border-white/20 bg-white/[0.03] text-transparent"
                }`}
                aria-hidden="true"
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" />
                </svg>
              </span>
            ) : null}

            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <p className="thread-title min-w-0 flex-1 truncate text-sm font-semibold text-white">{thread.title}</p>
                <span className="shrink-0 text-[11px] text-slate-500">{formatRelativeTime(thread.updated_at)}</span>
              </div>

              <p className="thread-preview mt-1 text-[13px] leading-5 text-slate-300">{getThreadPreview(thread)}</p>

              <div className="mt-2 flex items-center gap-2">
                <span
                  className={`inline-flex items-center gap-2 rounded-full border px-2 py-0.5 text-[10px] ${
                    responseSignal ? "" : `${status.chipClassName} border-transparent`
                  }`}
                  style={responseSignal?.chipStyle}
                  title={responseSignal?.title}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${responseSignal ? "" : status.dotClassName}`}
                    style={responseSignal ? { backgroundColor: responseSignal.dotColor } : undefined}
                  />
                  {status.label}
                </span>
                {contextUsageLabel ? (
                  <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] text-slate-300">
                    {contextUsageLabel}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </button>
    </div>
  );
}
