import ThreadDetail from "./mobileThreadDetail.jsx";
import MobileTodoChatDetail from "./mobileTodoChatDetail.jsx";

export default function MobileWideSplitWorkspace({
  minPaneWidthPx,
  appChrome,
  inboxListContent,
  actionBarContent,
  deferredOverlays,
  wideThreadSplitLayoutRef,
  wideThreadSplitResizeEnabled,
  wideThreadSplitLeftWeight,
  wideThreadSplitRightWeight,
  onResizePointerDown,
  onResizePointerMove,
  onResizePointerUp,
  isTodoScope,
  selectedTodoChatId,
  todoChatDetailProps,
  threadDetailKey,
  threadDetailProps
}) {
  return (
    <div
      className="telegram-shell overflow-hidden bg-slate-950 text-slate-100"
      style={{ height: "var(--app-stable-viewport-height)" }}
      data-testid="thread-split-layout"
    >
      <div className="mx-auto flex h-full min-h-0 w-full flex-col">
        {appChrome}
        <main
          ref={wideThreadSplitLayoutRef}
          className="grid min-h-0 flex-1 overflow-hidden px-4 pb-4 pt-3"
          style={{
            gridTemplateColumns: wideThreadSplitResizeEnabled
              ? `minmax(${minPaneWidthPx}px, ${wideThreadSplitLeftWeight}fr) 22px minmax(${minPaneWidthPx}px, ${wideThreadSplitRightWeight}fr)`
              : "minmax(0, 1fr) minmax(0, 1fr)",
            columnGap: wideThreadSplitResizeEnabled ? "0px" : "1rem"
          }}
        >
          <section
            data-testid="thread-list-pane"
            className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/72 shadow-2xl shadow-black/20"
          >
            <div data-testid="thread-list-scroll" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3">
              <section className="mt-1">{inboxListContent}</section>
            </div>
            <div
              data-testid="thread-list-footer"
              className="shrink-0 border-t border-white/10 bg-slate-950/92 px-4 py-3 backdrop-blur"
            >
              {actionBarContent}
            </div>
          </section>

          {wideThreadSplitResizeEnabled ? (
            <div className="flex min-h-0 items-center justify-center">
              <button
                type="button"
                data-testid="thread-split-resizer"
                aria-label="좌우 패널 크기 조절"
                onPointerDown={onResizePointerDown}
                onPointerMove={onResizePointerMove}
                onPointerUp={onResizePointerUp}
                onPointerCancel={onResizePointerUp}
                className="group flex h-full min-h-0 w-full touch-none items-center justify-center bg-transparent"
                style={{ cursor: "col-resize" }}
              >
                <span className="relative flex h-full w-full items-center justify-center">
                  <span className="h-full w-px bg-white/8 transition group-hover:bg-white/18" />
                  <span className="absolute flex h-12 w-4 items-center justify-center rounded-full border border-white/10 bg-slate-900/92 shadow-lg shadow-black/30 backdrop-blur">
                    <span className="h-5 w-px bg-white/20" />
                    <span className="ml-1 h-5 w-px bg-white/20" />
                  </span>
                </span>
              </button>
            </div>
          ) : null}

          <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/80 shadow-2xl shadow-black/20">
            {isTodoScope ? (
              selectedTodoChatId ? (
                <MobileTodoChatDetail {...todoChatDetailProps} />
              ) : (
                <div className="flex h-full min-h-0 flex-col items-center justify-center px-8 text-center">
                  <div className="max-w-md rounded-[2rem] border border-dashed border-white/15 bg-white/[0.03] px-6 py-8">
                    <p className="text-base font-semibold text-white">ToDo 채팅을 선택해 주세요.</p>
                    <p className="mt-3 text-sm leading-6 text-slate-300">
                      좌측 목록에서 기존 ToDo를 열거나 새 ToDo 채팅을 만들어 분할 화면에서 바로 이어서 작업할 수 있습니다.
                    </p>
                  </div>
                </div>
              )
            ) : (
              <ThreadDetail key={threadDetailKey} {...threadDetailProps} />
            )}
          </section>
        </main>
      </div>
      {deferredOverlays}
    </div>
  );
}
