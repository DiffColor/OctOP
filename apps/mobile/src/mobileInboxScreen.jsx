export default function MobileInboxScreen({
  appChrome,
  inboxListContent,
  actionBarContent,
  deferredOverlays
}) {
  return (
    <div className="telegram-shell min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col">
        {appChrome}

        <main className="flex-1 px-4 pb-28 pt-3">
          <section className="mt-1">{inboxListContent}</section>
        </main>

        <div className="telegram-safe-bottom-panel fixed inset-x-0 bottom-0 z-30 mx-auto flex w-full max-w-3xl justify-center border-t border-white/10 bg-slate-950/92 px-4 pt-2 backdrop-blur">
          {actionBarContent}
        </div>
      </div>
      {deferredOverlays}
    </div>
  );
}
