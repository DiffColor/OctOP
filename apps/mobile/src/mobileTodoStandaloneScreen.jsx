import MobileTodoChatDetail from "./mobileTodoChatDetail.jsx";

export default function MobileTodoStandaloneScreen({
  todoChatDetailProps,
  deferredOverlays
}) {
  return (
    <div className="telegram-shell min-h-screen bg-slate-950 text-slate-100">
      <MobileTodoChatDetail {...todoChatDetailProps} />
      {deferredOverlays}
    </div>
  );
}
