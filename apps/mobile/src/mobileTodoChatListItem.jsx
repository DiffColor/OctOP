import { useCallback, useRef, useState } from "react";

export default function TodoChatListItem({ chat, active, updatedLabel = "", preview = "", onOpen, onRename, onDelete }) {
  const startPointRef = useRef(null);
  const baseOffsetRef = useRef(0);
  const pointerIdRef = useRef(null);
  const swipeAxisRef = useRef(null);
  const offsetRef = useRef(0);
  const movedRef = useRef(false);
  const ACTION_WIDTH = 92;
  const SNAP_THRESHOLD = 42;
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

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
    baseOffsetRef.current = offsetRef.current;
    pointerIdRef.current = event.pointerId;
    swipeAxisRef.current = null;
    movedRef.current = false;
    setDragging(false);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, []);

  const handlePointerMove = useCallback(
    (event) => {
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

      if (swipeAxisRef.current === null) {
        if (absX < 6 && absY < 6) {
          return;
        }

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
    [setRevealOffset]
  );

  const handlePointerUp = useCallback(
    (event) => {
      if (startPointRef.current === null) {
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
      setDragging(false);
      if (event?.currentTarget && typeof event.currentTarget.releasePointerCapture === "function") {
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          // ignore pointer capture release failures
        }
      }
    },
    [setRevealOffset]
  );

  const showDeleteAction = offset > 0;
  const showRenameAction = offset < 0;

  return (
    <div className="relative overflow-hidden border-b border-white/8">
      <button
        type="button"
        onClick={() => {
          setRevealOffset(0);
          onDelete(chat);
        }}
        className={`absolute inset-y-0 left-0 flex w-[92px] items-center justify-center bg-rose-500 text-[12px] font-semibold text-white transition-opacity duration-150 ${
          showDeleteAction ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        삭제
      </button>

      <button
        type="button"
        onClick={() => {
          setRevealOffset(0);
          onRename(chat);
        }}
        className={`absolute inset-y-0 right-0 flex w-[92px] items-center justify-center bg-slate-800 text-[12px] font-semibold text-white transition-opacity duration-150 ${
          showRenameAction ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        편집
      </button>

      <button
        type="button"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={() => {
          if (movedRef.current) {
            movedRef.current = false;
            return;
          }

          if (offsetRef.current !== 0) {
            setRevealOffset(0);
            return;
          }

          onOpen(chat.id);
        }}
        className={`relative w-full px-3 py-3 text-left ${
          dragging ? "" : "transition-transform duration-180 ease-out"
        } ${active ? "bg-slate-900" : "bg-slate-950 hover:bg-slate-900/90"}`}
        style={{
          transform: `translate3d(${offset}px, 0, 0)`,
          touchAction: "pan-y",
          willChange: "transform"
        }}
      >
        <div
          className={`min-w-0 rounded-2xl border px-3 py-3 ${
            active ? "border-white/12 bg-white/[0.03]" : "border-transparent bg-transparent"
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 flex-1 truncate text-sm font-semibold text-white">{chat.title}</p>
            <span className="shrink-0 text-[11px] text-slate-500">{updatedLabel}</span>
          </div>
          <p className="mt-1 text-[13px] leading-5 text-slate-300">{preview}</p>
          <div className="mt-2 flex items-center gap-2 text-[10px] text-slate-500">
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-slate-300">
              메모 {chat.message_count}
            </span>
          </div>
        </div>
      </button>
    </div>
  );
}
