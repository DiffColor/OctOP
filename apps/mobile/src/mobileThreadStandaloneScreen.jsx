import ThreadDetail from "./mobileThreadDetail.jsx";

export default function MobileThreadStandaloneScreen({
  threadDetailKey,
  threadDetailProps
}) {
  return (
    <div className="telegram-shell min-h-screen bg-slate-950 text-slate-100">
      <ThreadDetail key={threadDetailKey} {...threadDetailProps} />
    </div>
  );
}
