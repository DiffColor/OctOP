import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";

const LOCAL_STORAGE_KEY = "octop.mobile.session";
const SESSION_STORAGE_KEY = "octop.mobile.session.ephemeral";
const LEGACY_LOCAL_STORAGE_KEY = "octop.dashboard.session";
const LEGACY_SESSION_STORAGE_KEY = "octop.dashboard.session.ephemeral";
const PWA_PROMPT_DISMISSED_KEY = "octop.mobile.pwa.install.dismissed";
const PWA_PROMPT_DISMISSED_VALUE = "manual";
const DEFAULT_API_BASE_URL =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
    ? "http://127.0.0.1:4000"
    : "https://octop.ilycode.app";
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");

const STATUS_META = {
  queued: {
    label: "Queued",
    chipClassName: "bg-slate-500/15 text-slate-200",
    dotClassName: "bg-slate-300",
    bubbleClassName: "bg-white text-slate-900"
  },
  idle: {
    label: "Idle",
    chipClassName: "bg-slate-500/15 text-slate-200",
    dotClassName: "bg-slate-300",
    bubbleClassName: "bg-white text-slate-900"
  },
  awaiting_input: {
    label: "Need Input",
    chipClassName: "bg-amber-400/20 text-amber-100",
    dotClassName: "bg-amber-300",
    bubbleClassName: "bg-amber-100 text-slate-900"
  },
  running: {
    label: "Running",
    chipClassName: "bg-telegram-400/20 text-telegram-50",
    dotClassName: "bg-telegram-300",
    bubbleClassName: "bg-telegram-500 text-white"
  },
  failed: {
    label: "Failed",
    chipClassName: "bg-rose-400/20 text-rose-100",
    dotClassName: "bg-rose-300",
    bubbleClassName: "bg-rose-100 text-slate-900"
  },
  completed: {
    label: "Done",
    chipClassName: "bg-emerald-400/20 text-emerald-100",
    dotClassName: "bg-emerald-300",
    bubbleClassName: "bg-emerald-100 text-slate-900"
  }
};

const KANBAN_FILTERS = [
  { id: "todo", label: "todo" },
  { id: "in_progress", label: "in progress" },
  { id: "review", label: "review" },
  { id: "done", label: "done" }
];

function readStoredSession() {
  for (const key of [
    LOCAL_STORAGE_KEY,
    SESSION_STORAGE_KEY,
    LEGACY_LOCAL_STORAGE_KEY,
    LEGACY_SESSION_STORAGE_KEY
  ]) {
    try {
      const raw = window.localStorage.getItem(key) ?? window.sessionStorage.getItem(key);

      if (!raw) {
        continue;
      }

      const parsed = JSON.parse(raw);

      if (parsed?.accessToken && parsed?.userId) {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function storeSession(session, rememberDevice) {
  const serialized = JSON.stringify(session);

  window.localStorage.removeItem(LOCAL_STORAGE_KEY);
  window.sessionStorage.removeItem(SESSION_STORAGE_KEY);

  if (rememberDevice) {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, serialized);
    return;
  }

  window.sessionStorage.setItem(SESSION_STORAGE_KEY, serialized);
}

function clearSessionStorage() {
  window.localStorage.removeItem(LOCAL_STORAGE_KEY);
  window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

function isPwaPromptDismissed() {
  if (typeof window === "undefined") {
    return false;
  }

  return window.localStorage.getItem(PWA_PROMPT_DISMISSED_KEY) === PWA_PROMPT_DISMISSED_VALUE;
}

function dismissPwaPrompt() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(PWA_PROMPT_DISMISSED_KEY, PWA_PROMPT_DISMISSED_VALUE);
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function formatRelativeTime(value) {
  if (!value) {
    return "방금 전";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "방금 전";
  }

  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("ko-KR", { numeric: "auto" });
  const ranges = [
    { limit: 60, unit: "second" },
    { limit: 3600, unit: "minute" },
    { limit: 86400, unit: "hour" },
    { limit: 604800, unit: "day" }
  ];

  for (const range of ranges) {
    if (Math.abs(diffSeconds) < range.limit) {
      const divisor =
        range.unit === "second" ? 1 : range.unit === "minute" ? 60 : range.unit === "hour" ? 3600 : 86400;
      return formatter.format(Math.round(diffSeconds / divisor), range.unit);
    }
  }

  return formatter.format(Math.round(diffSeconds / 604800), "week");
}

function getPathLabel(value) {
  if (!value) {
    return "";
  }

  const normalized = String(value).replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments.at(-1) ?? normalized;
}

function normalizePath(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function getDisplayPathFromStartFolder(value, depth = 2) {
  const normalized = normalizePath(value);

  if (!normalized) {
    return "";
  }

  const segments = normalized.split("/").filter(Boolean);
  return segments.slice(-depth).join("/");
}

function getRelativeWorkspacePath(value, roots = []) {
  const normalizedValue = normalizePath(value);

  if (!normalizedValue) {
    return "";
  }

  const matchingRoot = [...roots]
    .map((root) => normalizePath(root?.path))
    .filter(Boolean)
    .filter((rootPath) => normalizedValue === rootPath || normalizedValue.startsWith(`${rootPath}/`))
    .sort((left, right) => right.length - left.length)[0];

  if (!matchingRoot) {
    return getDisplayPathFromStartFolder(normalizedValue);
  }

  const relativePath = normalizedValue.slice(matchingRoot.length).replace(/^\/+/, "");
  const rootLabel = getDisplayPathFromStartFolder(matchingRoot);

  return relativePath ? `${rootLabel}/${relativePath}` : rootLabel;
}

function shortenPath(value) {
  if (!value) {
    return "-";
  }

  const normalized = String(value);

  if (normalized.length <= 46) {
    return normalized;
  }

  return `...${normalized.slice(-43)}`;
}

function clampProgress(value) {
  const numeric = Number(value);

  if (Number.isNaN(numeric)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function getStatusMeta(status) {
  return STATUS_META[status] ?? STATUS_META.queued;
}

function getLaneByStatus(status) {
  if (status === "running") {
    return "in_progress";
  }

  if (status === "awaiting_input" || status === "failed") {
    return "review";
  }

  if (status === "completed") {
    return "done";
  }

  return "todo";
}

function parseResponseBody(response, text) {
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    if (!response.ok) {
      throw new Error(text);
    }

    return { message: text };
  }
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {})
    }
  });
  const text = await response.text();
  const payload = parseResponseBody(response, text);

  if (!response.ok) {
    const message =
      payload?.error ??
      payload?.message ??
      payload?.title ??
      `요청에 실패했습니다. (${response.status})`;
    throw new Error(message);
  }

  return payload;
}

function normalizeThread(thread, fallbackProjectId = null) {
  if (!thread?.id) {
    return null;
  }

  return {
    id: thread.id,
    title: thread.title ?? thread.name ?? "제목 없는 이슈",
    project_id: thread.project_id ?? fallbackProjectId,
    status: thread.status ?? "queued",
    progress: clampProgress(thread.progress),
    last_event: thread.last_event ?? "thread.started",
    last_message: thread.last_message ?? "",
    created_at: thread.created_at ?? new Date().toISOString(),
    updated_at: thread.updated_at ?? thread.created_at ?? new Date().toISOString(),
    source: thread.source ?? "appServer",
    turn_id: thread.turn_id ?? null
  };
}

function mergeThreads(currentThreads, nextThreads) {
  const nextById = new Map();

  for (const thread of currentThreads) {
    const normalized = normalizeThread(thread);

    if (normalized) {
      nextById.set(normalized.id, normalized);
    }
  }

  for (const thread of nextThreads) {
    const normalized = normalizeThread(thread);

    if (normalized) {
      nextById.set(normalized.id, normalized);
    }
  }

  return [...nextById.values()].sort(
    (left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at)
  );
}

function upsertThread(currentThreads, thread) {
  const normalized = normalizeThread(thread);

  if (!normalized) {
    return currentThreads;
  }

  const next = [...currentThreads];
  const index = next.findIndex((item) => item.id === normalized.id);

  if (index === -1) {
    next.unshift(normalized);
  } else {
    next[index] = {
      ...next[index],
      ...normalized
    };
  }

  return next.sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
}

function getThreadPreview(thread) {
  if (thread.last_message) {
    return thread.last_message;
  }

  return `${getStatusMeta(thread.status).label} · 진행률 ${thread.progress}%`;
}

function createThreadTitleFromPrompt(prompt) {
  const normalized = String(prompt ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "";
  }

  return normalized.length <= 34 ? normalized : `${normalized.slice(0, 34)}...`;
}

function summarizeMessageContent(content, limit = 160) {
  const normalized = String(content ?? "").trim();

  if (!normalized) {
    return "내용 없음";
  }

  if (normalized.length <= limit) {
    return normalized;
  }

  const safeLimit = Math.max(0, limit - 3);
  return `${normalized.slice(0, safeLimit)}...`;
}

function BottomSheet({ open, title, description, onClose, children, variant = "bottom" }) {
  if (!open) {
    return null;
  }

  const isCenterDialog = variant === "center";
  const containerClassName = isCenterDialog
    ? "fixed inset-0 z-50 flex items-center justify-center bg-slate-950/86 px-4 py-6 backdrop-blur-sm"
    : "fixed inset-0 z-50 flex items-end justify-center bg-slate-950/75 px-4 pb-4 pt-10 backdrop-blur-sm";
  const panelClassName = isCenterDialog
    ? "modal-enter relative z-10 flex w-full max-w-xl max-h-[min(720px,88dvh)] flex-col overflow-hidden rounded-[1.75rem] border border-white/15 bg-[#0b1622] shadow-[0_30px_90px_rgba(0,0,0,0.65)] ring-1 ring-white/8"
    : "sheet-enter relative z-10 w-full max-w-xl overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950 shadow-telegram-soft";

  return (
    <div className={containerClassName}>
      <button type="button" aria-label="닫기" className="absolute inset-0" onClick={onClose} />
      <section className={panelClassName}>
        <div className="border-b border-white/10 bg-white/5 px-5 py-4">
          {isCenterDialog ? null : <div className="mx-auto mb-4 h-1.5 w-14 rounded-full bg-white/15" />}
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-white">{title}</h2>
              {description ? <p className="mt-1 text-sm leading-6 text-slate-400">{description}</p> : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-black/20 text-slate-300 transition hover:bg-white/10 hover:text-white"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
            </button>
          </div>
        </div>
        <div className="telegram-scroll max-h-[80dvh] overflow-y-auto">{children}</div>
      </section>
    </div>
  );
}

function InstallPromptBanner({ visible, installing, onInstall, onDismiss }) {
  if (!visible) {
    return null;
  }

  return (
    <div className="border-b border-telegram-400/20 bg-telegram-500/10 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-telegram-500/20 text-telegram-100">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M12 3v12m0 0l4-4m-4 4l-4-4M5 19h14" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
            </svg>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">앱으로 설치해서 바로 여시겠습니까?</p>
            <p className="truncate text-xs text-telegram-100/70">홈 화면에 추가하면 더 빠르게 접근하실 수 있습니다.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onInstall}
          disabled={installing}
          className="shrink-0 rounded-full bg-telegram-500 px-3 py-2 text-[11px] font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {installing ? "설치 중" : "설치"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 text-[11px] text-slate-300 transition hover:text-white"
        >
          다시 보지 않음
        </button>
      </div>
    </div>
  );
}

function LoginPage({ initialLoginId, loading, error, onSubmit }) {
  const [loginId, setLoginId] = useState(initialLoginId ?? "");
  const [password, setPassword] = useState("");
  const [rememberDevice, setRememberDevice] = useState(Boolean(initialLoginId));

  useEffect(() => {
    setLoginId(initialLoginId ?? "");
  }, [initialLoginId]);

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!loginId.trim() || !password.trim()) {
      return;
    }

    await onSubmit({
      loginId: loginId.trim(),
      password,
      rememberDevice
    });
  };

  return (
    <div className="telegram-shell flex min-h-screen items-center justify-center px-5 py-8">
      <div className="absolute inset-0 overflow-hidden">
        <div className="telegram-grid absolute inset-0 opacity-20" />
        <div className="absolute left-[-15%] top-[-8%] h-72 w-72 rounded-full bg-telegram-400/30 blur-[100px]" />
        <div className="absolute bottom-[-8%] right-[-12%] h-72 w-72 rounded-full bg-orange-300/20 blur-[120px]" />
      </div>

      <main className="relative z-10 w-full max-w-sm overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/85 shadow-telegram-soft backdrop-blur">
        <div className="bg-gradient-to-br from-telegram-500 via-telegram-600 to-telegram-800 px-6 pb-10 pt-8">
          <div className="flex h-14 w-14 items-center justify-center rounded-[1.25rem] bg-white/15 text-white">
            <svg className="h-7 w-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M20 4L4 10.5l6 2.2L12.5 19 20 4z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
            </svg>
          </div>
          <p className="mt-6 text-[11px] uppercase tracking-[0.32em] text-telegram-100/70">OctOP Pocket</p>
          <h1 className="mt-3 font-display text-3xl font-bold tracking-tight text-white">모바일 워크스페이스</h1>
          <p className="mt-3 text-sm leading-6 text-telegram-50/80">
            대시보드의 프로젝트, thread, bridge 상태를 텔레그램 형식으로 바로 확인하실 수 있습니다.
          </p>
        </div>

        <form className="space-y-5 px-6 py-6" onSubmit={handleSubmit}>
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="loginId">
              Login ID
            </label>
            <input
              id="loginId"
              name="loginId"
              type="text"
              autoComplete="username"
              required
              value={loginId}
              onChange={(event) => setLoginId(event.target.value)}
              placeholder="LicenseHub 로그인 ID"
              className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="비밀번호를 입력해 주세요"
              className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
            />
          </div>

          <label className="flex items-center gap-3 text-sm text-slate-400">
            <input
              type="checkbox"
              checked={rememberDevice}
              onChange={(event) => setRememberDevice(event.target.checked)}
              className="h-4 w-4 rounded border-white/10 bg-white/5 text-telegram-400 focus:ring-telegram-300"
            />
            이 기기에서 로그인 유지
          </label>

          {error ? (
            <div className="rounded-2xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-telegram-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <>
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                로그인 중...
              </>
            ) : (
              "접속하기"
            )}
          </button>
        </form>
      </main>
    </div>
  );
}

function UtilitySheet({
  open,
  session,
  status,
  bridges,
  selectedBridgeId,
  projects,
  threads,
  onClose,
  onSelectBridge,
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
        <section className="flex items-center gap-3 border-b border-white/10 pb-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-telegram-500/15 text-sm font-semibold text-white">
            {(session.displayName || session.loginId || "O").slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-semibold text-white">{session.displayName || session.loginId}</p>
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  status.app_server?.connected ? "bg-emerald-300" : "bg-rose-300"
                }`}
              />
            </div>
            <p className="truncate text-xs text-slate-400">{session.loginId}</p>
          </div>
        </section>

        <section className="grid grid-cols-3 gap-2 border-b border-white/10 py-4 text-center">
          <div className="rounded-[1rem] border border-white/10 bg-black/15 px-3 py-3">
            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Bridge</p>
            <p className="mt-1 text-base font-semibold text-white">{bridges.length}</p>
          </div>
          <div className="rounded-[1rem] border border-white/10 bg-black/15 px-3 py-3">
            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Project</p>
            <p className="mt-1 text-base font-semibold text-white">{projects.length}</p>
          </div>
          <div className="rounded-[1rem] border border-white/10 bg-black/15 px-3 py-3">
            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Thread</p>
            <p className="mt-1 text-base font-semibold text-white">{threads.length}</p>
          </div>
        </section>

        <section className="py-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold text-white">Bridge 선택</p>
            <span
              className={`text-[11px] ${
                status.app_server?.connected ? "text-emerald-200" : "text-rose-200"
              }`}
            >
              {status.app_server?.connected ? "온라인" : "오프라인"}
            </span>
          </div>

          <div className="divide-y divide-white/10 overflow-hidden rounded-[1.1rem] border border-white/10 bg-black/10">
            {bridges.length === 0 ? (
              <div className="px-4 py-4 text-sm text-slate-400">연결된 bridge가 없습니다.</div>
            ) : (
              bridges.map((bridge) => {
                const active = bridge.bridge_id === selectedBridgeId;

                return (
                  <button
                    key={bridge.bridge_id}
                    type="button"
                    onClick={() => {
                      onSelectBridge(bridge.bridge_id);
                      onClose();
                    }}
                    className={`w-full px-4 py-3 text-left transition ${
                      active ? "bg-telegram-500/10" : "bg-transparent hover:bg-white/[0.03]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-white">{bridge.device_name ?? bridge.bridge_id}</p>
                        <p className="truncate text-[11px] text-slate-500">{bridge.bridge_id}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-[11px] text-slate-400">{formatRelativeTime(bridge.last_seen_at)}</p>
                        {active ? <p className="mt-0.5 text-[10px] text-telegram-200">현재 선택</p> : null}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>

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

function InlineIssueComposer({ busy, selectedProject, onSubmit }) {
  const [prompt, setPrompt] = useState("");
  const textareaRef = useRef(null);

  const syncPromptHeight = useCallback((element) => {
    const textarea = element ?? textareaRef.current;

    if (!textarea) {
      return;
    }

    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, []);

  useLayoutEffect(() => {
    syncPromptHeight();
  }, [prompt, selectedProject, syncPromptHeight]);

  const handlePromptChange = useCallback(
    (event) => {
      setPrompt(event.target.value);
      syncPromptHeight(event.target);
    },
    [syncPromptHeight]
  );

  const handleSubmit = async (event) => {
    event.preventDefault();

    const normalizedPrompt = prompt.trim();
    const normalizedTitle = createThreadTitleFromPrompt(normalizedPrompt);

    if (!normalizedPrompt || !normalizedTitle || !selectedProject?.id) {
      return;
    }

    const accepted = await onSubmit({
      title: normalizedTitle,
      prompt: normalizedPrompt,
      project_id: selectedProject.id
    });

    if (accepted !== false) {
      setPrompt("");
    }
  };

  return (
    <form className="pointer-events-auto w-full" onSubmit={handleSubmit}>
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1 rounded-[1.35rem] border border-white/10 bg-white/[0.03] px-4 py-3">
          <div className="mb-1 text-[11px] text-slate-500">
            {selectedProject ? `${selectedProject.name} · 프롬프트` : "프로젝트를 선택해 주세요"}
          </div>
          <textarea
            rows="1"
            ref={textareaRef}
            value={prompt}
            onChange={handlePromptChange}
            placeholder={
              selectedProject
                ? "채팅처럼 작업 지시를 입력하세요"
                : "먼저 프로젝트를 선택해 주세요"
            }
            disabled={!selectedProject || busy}
            className="min-h-[24px] w-full resize-none overflow-hidden border-none bg-transparent p-0 text-sm leading-6 text-white outline-none ring-0 placeholder:text-slate-500 focus:ring-0"
          />
        </div>
        <button
          type="submit"
          disabled={busy || !selectedProject || !prompt.trim()}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-telegram-500 text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {busy ? (
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          ) : (
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M20 4L4 12l6 2 2 6 8-16z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
            </svg>
          )}
        </button>
      </div>
    </form>
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
  const tapStateRef = useRef({ path: "", timestamp: 0 });

  useEffect(() => {
    if (!open) {
      setName("");
      tapStateRef.current = { path: "", timestamp: 0 };
      return;
    }

    if (!name.trim() && selectedWorkspacePath) {
      setName(getPathLabel(selectedWorkspacePath));
    }
  }, [name, open, selectedWorkspacePath]);

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

function ThreadListItem({ thread, projectName, active, onOpen }) {
  const status = getStatusMeta(thread.status);

  return (
    <button
      type="button"
      onClick={() => onOpen(thread.id)}
      className={`w-full border-b border-white/8 px-1 py-3 text-left transition ${
        active
          ? "bg-white/[0.04]"
          : "bg-transparent hover:bg-white/[0.03]"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-telegram-500/12 text-sm font-semibold text-white">
          {thread.title.slice(0, 1).toUpperCase()}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="thread-title text-sm font-semibold text-white">{thread.title}</p>
              <p className="mt-0.5 text-xs text-slate-400">{projectName || "프로젝트 미지정"}</p>
            </div>
            <span className="shrink-0 text-[11px] text-slate-500">{formatRelativeTime(thread.updated_at)}</span>
          </div>

          <p className="thread-preview mt-1.5 text-[13px] leading-5 text-slate-300">{getThreadPreview(thread)}</p>

          <div className="mt-2 flex items-center gap-2">
            <span className={`inline-flex items-center gap-2 rounded-full px-2 py-0.5 text-[10px] ${status.chipClassName}`}>
              <span className={`h-2 w-2 rounded-full ${status.dotClassName}`} />
              {status.label}
            </span>
            <span className="text-[11px] text-slate-500">{thread.progress}%</span>
          </div>
        </div>
      </div>
    </button>
  );
}

function MessageBubble({ align = "left", tone = "light", title, meta, children }) {
  const bubbleClassName =
    tone === "brand"
      ? "bg-telegram-500 text-white"
      : tone === "success"
        ? "bg-emerald-100 text-slate-900"
        : tone === "warn"
          ? "bg-amber-100 text-slate-900"
          : tone === "danger"
            ? "bg-rose-100 text-slate-900"
            : "bg-white text-slate-900";
  const wrapperClassName = align === "right" ? "justify-end" : "justify-start";

  return (
    <div className={`message-enter flex ${wrapperClassName}`}>
      <article className={`max-w-[86%] rounded-[1.35rem] px-4 py-3 ${bubbleClassName}`}>
        {title ? <p className="text-xs font-semibold uppercase tracking-[0.16em] opacity-70">{title}</p> : null}
        <div className={title ? "mt-2" : ""}>{children}</div>
        {meta ? <p className="mt-3 text-right text-[11px] opacity-60">{meta}</p> : null}
      </article>
    </div>
  );
}

function ThreadDetail({
  thread,
  project,
  messages,
  messagesLoading,
  messagesError,
  onRefreshMessages,
  onSubmitPrompt,
  submitBusy,
  onBack
}) {
  const status = getStatusMeta(thread.status);
  const scrollRef = useRef(null);
  const timeline = useMemo(() => {
    const normalized = [];
    let lastPrompt = null;

    const safeMessages = Array.isArray(messages) ? messages : [];

    safeMessages.forEach((message, index) => {
      if (!message) {
        return;
      }

      const role = message.role === "assistant" ? "assistant" : "user";
      const content = String(message.content ?? "").trim();
      const timestamp = message.timestamp ?? thread.updated_at ?? thread.created_at ?? new Date().toISOString();
      const base = {
        id: message.id ?? `${role}-${index}`,
        role,
        content,
        timestamp
      };

      if (role === "user") {
        lastPrompt = base;
        normalized.push({
          ...base,
          align: "right",
          tone: "brand",
          title: "프롬프트"
        });
        return;
      }

      normalized.push({
        ...base,
        align: "left",
        tone: "light",
        title: "응답",
        replyTo: lastPrompt
      });
    });

    return normalized;
  }, [messages, thread.created_at, thread.updated_at]);

  useEffect(() => {
    if (!scrollRef.current) {
      return;
    }

    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, messagesLoading]);

  const handleRefreshMessages = () => {
    if (onRefreshMessages) {
      onRefreshMessages();
    }
  };

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-slate-950/85 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-white/5 text-white transition hover:bg-white/10"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
            </svg>
          </button>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-white">{thread.title}</p>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-400">
              <span className="truncate">{project?.name ?? "프로젝트 미지정"}</span>
              <span className={`h-1.5 w-1.5 rounded-full ${status.dotClassName}`} />
              <span>{status.label}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={handleRefreshMessages}
            disabled={messagesLoading}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {messagesLoading ? (
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            ) : (
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  d="M4 4v5h.582m15.418 11v-5h-.581M5.007 9a7 7 0 0111.995-3m2.998 9a7 7 0 01-11.995 3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                />
              </svg>
            )}
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="telegram-grid flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pb-10">
          <div className="flex justify-center">
            <span className="rounded-full bg-slate-950/70 px-3 py-1.5 text-[11px] text-slate-300">
              {formatDateTime(thread.created_at)}
            </span>
          </div>

          {messagesError ? (
            <div className="rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
              <p>메시지를 불러오는 중 문제가 발생했습니다.</p>
              <button
                type="button"
                onClick={handleRefreshMessages}
                className="mt-2 rounded-full border border-white/20 px-3 py-1.5 text-xs text-white/80 transition hover:bg-white/10"
              >
                다시 시도
              </button>
            </div>
          ) : null}

          {timeline.map((message) => (
            <MessageBubble
              key={message.id}
              align={message.align}
              tone={message.tone}
              title={message.title}
              meta={formatRelativeTime(message.timestamp)}
            >
              {message.replyTo ? (
                <div className="mb-2 border-l-2 border-slate-300/45 pl-3 text-xs text-slate-700/80">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-600/70">프롬프트</p>
                  <p className="mt-1 text-sm leading-5">{summarizeMessageContent(message.replyTo.content)}</p>
                </div>
              ) : null}
              <p className="whitespace-pre-wrap text-sm leading-6">
                {message.content || (message.role === "assistant" ? "응답을 기다리고 있습니다..." : "프롬프트가 비어 있습니다.")}
              </p>
            </MessageBubble>
          ))}

          {messagesLoading ? (
            <div className="flex justify-center py-4">
              <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white" />
            </div>
          ) : null}

          {!messagesLoading && !messagesError && timeline.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/15 px-4 py-4 text-center text-sm text-slate-300">
              아직 대화가 없습니다. 첫 프롬프트를 입력해 작업을 시작해 보세요.
            </div>
          ) : null}

          <div className="flex justify-center">
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-slate-950/70 px-3 py-1.5 text-[11px] text-slate-300">
              <span className={`h-2 w-2 rounded-full ${status.dotClassName}`} />
              <span>{status.label}</span>
              <span className="text-slate-500">{thread.progress}%</span>
              <span className="text-slate-500">{formatRelativeTime(thread.updated_at)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-white/10 bg-slate-950/92 px-4 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] pt-2 backdrop-blur">
        <div className="mx-auto w-full max-w-3xl">
          <InlineIssueComposer
            busy={submitBusy}
            selectedProject={project}
            onSubmit={onSubmitPrompt}
          />
        </div>
      </div>
    </div>
  );
}

function MainPage({
  session,
  bridges,
  status,
  projects,
  threads,
  threadDetail,
  workspaceRoots,
  folderState,
  folderLoading,
  selectedWorkspacePath,
  selectedBridgeId,
  selectedProjectId,
  selectedThreadId,
  search,
  loadingState,
  projectBusy,
  issueBusy,
  utilityOpen,
  projectComposerOpen,
  installPromptVisible,
  installBusy,
  laneFilter,
  activeView,
  onSearchChange,
  onChangeLaneFilter,
  onSelectBridge,
  onSelectProject,
  onSelectThread,
  onOpenUtility,
  onOpenProjectComposer,
  onInstallPwa,
  onDismissInstallPrompt,
  onCloseUtility,
  onCloseProjectComposer,
  onBrowseWorkspaceRoot,
  onBrowseFolder,
  onSelectWorkspace,
  onSubmitProject,
  onSubmitIssue,
  onRefreshThreadDetail,
  onRefresh,
  onLogout,
  onBackToInbox
}) {
  const deferredSearch = useDeferredValue(search);
  const searchKeyword = deferredSearch.trim().toLowerCase();
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const filteredThreads = useMemo(() => {
    return threads.filter((thread) => {
      const matchesProject = !selectedProjectId || thread.project_id === selectedProjectId;
      const matchesLane = getLaneByStatus(thread.status) === laneFilter;
      const matchesSearch =
        !searchKeyword ||
        thread.title.toLowerCase().includes(searchKeyword) ||
        thread.last_message.toLowerCase().includes(searchKeyword);

      return matchesProject && matchesLane && matchesSearch;
    });
  }, [laneFilter, searchKeyword, selectedProjectId, threads]);
  const bridgeLabel =
    bridges.find((bridge) => bridge.bridge_id === selectedBridgeId)?.device_name ??
    bridges.find((bridge) => bridge.bridge_id === selectedBridgeId)?.bridge_id ??
    "No Bridge";
  const threadDetailMessages = threadDetail?.messages ?? [];
  const threadDetailLoading = threadDetail?.loading ?? false;
  const threadDetailError = threadDetail?.error ?? "";

  if (activeView === "thread" && selectedThread) {
    const threadProject = projects.find((project) => project.id === selectedThread.project_id) ?? selectedProject;

    return (
      <div className="telegram-shell min-h-screen bg-slate-950 text-slate-100">
        <ThreadDetail
          thread={selectedThread}
          project={threadProject}
          messages={threadDetailMessages}
          messagesLoading={threadDetailLoading}
          messagesError={threadDetailError}
          onRefreshMessages={onRefreshThreadDetail}
          onSubmitPrompt={(payload) => onSubmitIssue(payload, { stayOnThread: true })}
          submitBusy={issueBusy}
          onBack={onBackToInbox}
        />
      </div>
    );
  }

  return (
    <div className="telegram-shell min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col">
        <header className="sticky top-0 z-20 border-b border-white/10 bg-slate-950/88 px-4 py-3 backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={onOpenUtility}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-white/5 text-white transition hover:bg-white/10"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M4 7h16M4 12h16M4 17h10" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
            </button>

            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold text-white">OctOP Pocket</h1>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-400">
                <span className="truncate">{bridgeLabel}</span>
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    status.app_server?.connected ? "bg-emerald-300" : "bg-rose-300"
                  }`}
                />
                <span>{status.app_server?.connected ? "연결됨" : "미연결"}</span>
              </div>
            </div>

            <div className="text-right text-[11px] text-slate-500">
              {selectedProject ? selectedProject.name : "프로젝트 선택"}
            </div>
          </div>
        </header>

        <InstallPromptBanner
          visible={installPromptVisible}
          installing={installBusy}
          onInstall={onInstallPwa}
          onDismiss={onDismissInstallPrompt}
        />

        <main className="flex-1 px-4 pb-24 pt-2">
          <div className="border-b border-white/10 pb-3">
            <div className="flex gap-2 overflow-x-auto pb-2">
              {KANBAN_FILTERS.map((filter) => {
                const count = threads.filter((thread) => {
                  const matchesProject = !selectedProjectId || thread.project_id === selectedProjectId;
                  return matchesProject && getLaneByStatus(thread.status) === filter.id;
                }).length;

                return (
                  <button
                    key={filter.id}
                    type="button"
                    onClick={() => onChangeLaneFilter(filter.id)}
                    className={`shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium transition ${
                      laneFilter === filter.id
                        ? "bg-white text-slate-900"
                        : "bg-transparent text-slate-400 hover:text-white"
                    }`}
                  >
                    {filter.label}
                    <span className={`ml-1.5 text-[11px] ${laneFilter === filter.id ? "text-slate-500" : "text-slate-500"}`}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-3 px-1 py-2">
              <svg className="h-4 w-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="검색"
                className="w-full border-none bg-transparent p-0 text-sm text-white outline-none ring-0 placeholder:text-slate-500 focus:ring-0"
              />
            </div>

            <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
              <button
                type="button"
                onClick={() => onSelectProject("")}
                className={`shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium transition ${
                  !selectedProjectId
                    ? "bg-white text-slate-900"
                    : "bg-transparent text-slate-400 hover:text-white"
                }`}
              >
                전체
              </button>
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => onSelectProject(project.id)}
                  className={`shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium transition ${
                    project.id === selectedProjectId
                      ? "bg-white text-slate-900"
                      : "bg-transparent text-slate-400 hover:text-white"
                  }`}
                >
                  {project.name}
                </button>
              ))}
            </div>
          </div>

          <section className="mt-1">
            {filteredThreads.length === 0 ? (
              <div className="px-2 py-10 text-center text-sm leading-7 text-slate-400">
                {loadingState === "loading"
                  ? "데이터를 동기화하고 있습니다."
                  : "조건에 맞는 thread가 없습니다. 새 이슈를 보내서 작업을 시작해 주세요."}
              </div>
            ) : (
              filteredThreads.map((thread) => (
                <ThreadListItem
                  key={thread.id}
                  thread={thread}
                  active={thread.id === selectedThreadId}
                  projectName={projects.find((project) => project.id === thread.project_id)?.name}
                  onOpen={onSelectThread}
                />
              ))
            )}
          </section>
        </main>

        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 mx-auto flex w-full max-w-3xl justify-center border-t border-white/10 bg-slate-950/92 px-4 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] pt-2 backdrop-blur">
          <div className="pointer-events-auto flex w-full items-center gap-3 px-1 py-1">
            <InlineIssueComposer
              busy={issueBusy}
              selectedProject={selectedProject}
              onSubmit={onSubmitIssue}
            />
          </div>
        </div>
      </div>

      <UtilitySheet
        open={utilityOpen}
        session={session}
        status={status}
        bridges={bridges}
        selectedBridgeId={selectedBridgeId}
        projects={projects}
        threads={threads}
        onClose={onCloseUtility}
        onSelectBridge={onSelectBridge}
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
        onBrowseRoot={onBrowseWorkspaceRoot}
        onBrowseFolder={onBrowseFolder}
        onSelectWorkspace={onSelectWorkspace}
        onClose={onCloseProjectComposer}
        onSubmit={onSubmitProject}
      />
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(() => (typeof window === "undefined" ? null : readStoredSession()));
  const [loginState, setLoginState] = useState({ loading: false, error: "" });
  const [bridges, setBridges] = useState([]);
  const [status, setStatus] = useState({
    app_server: {
      connected: false,
      initialized: false,
      account: null,
      last_error: null
    },
    updated_at: null
  });
  const [projects, setProjects] = useState([]);
  const [threads, setThreads] = useState([]);
  const [threadDetails, setThreadDetails] = useState({});
  const [workspaceRoots, setWorkspaceRoots] = useState([]);
  const [folderState, setFolderState] = useState({ path: "", parent_path: null, entries: [] });
  const [folderLoading, setFolderLoading] = useState(false);
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState("");
  const [selectedBridgeId, setSelectedBridgeId] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [search, setSearch] = useState("");
  const [loadingState, setLoadingState] = useState("idle");
  const [laneFilter, setLaneFilter] = useState("todo");
  const [utilityOpen, setUtilityOpen] = useState(false);
  const [projectComposerOpen, setProjectComposerOpen] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [issueBusy, setIssueBusy] = useState(false);
  const [activeView, setActiveView] = useState("inbox");
  const [deferredInstallPrompt, setDeferredInstallPrompt] = useState(null);
  const [installPromptVisible, setInstallPromptVisible] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [threads, selectedThreadId]
  );
  const currentThreadDetail = threadDetails[selectedThreadId] ?? null;
  const currentThreadDetailVersion = currentThreadDetail?.version ?? null;
  const currentThreadDetailLoading = currentThreadDetail?.loading ?? false;
  const currentThreadDetailHasMessages = (currentThreadDetail?.messages?.length ?? 0) > 0;
  const hasCurrentThreadDetail = Boolean(currentThreadDetail);
  const selectedThreadUpdatedAt = selectedThread?.updated_at ?? null;
  const loadThreadMessages = useCallback(
    async (threadId, { force = false, version = null } = {}) => {
      if (!session?.loginId || !selectedBridgeId || !threadId) {
        return;
      }

      setThreadDetails((current) => {
        const currentEntry = current[threadId];

        if (!force && currentEntry?.loading) {
          return current;
        }

        return {
          ...current,
          [threadId]: {
            ...currentEntry,
            loading: true,
            error: "",
            messages: currentEntry?.messages ?? [],
            version: currentEntry?.version ?? null
          }
        };
      });

      try {
        const detail = await apiRequest(
          `/api/threads/${threadId}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`
        );

        setThreadDetails((current) => ({
          ...current,
          [threadId]: {
            loading: false,
            error: "",
            messages: detail?.messages ?? [],
            thread: detail?.thread ?? current[threadId]?.thread ?? null,
            fetchedAt: Date.now(),
            version:
              version ??
              detail?.thread?.updated_at ??
              detail?.thread?.created_at ??
              current[threadId]?.version ??
              null
          }
        }));
      } catch (error) {
        setThreadDetails((current) => ({
          ...current,
          [threadId]: {
            ...current[threadId],
            loading: false,
            error: error.message ?? "메시지를 불러오지 못했습니다."
          }
        }));
      }
    },
    [selectedBridgeId, session?.loginId]
  );

  async function loadBridges(sessionArg) {
    if (!sessionArg?.loginId) {
      return [];
    }

    const nextBridges = (await apiRequest(
      `/api/bridges?login_id=${encodeURIComponent(sessionArg.loginId)}`
    )).bridges ?? [];

    setBridges(nextBridges);
    setSelectedBridgeId((current) => {
      if (current && nextBridges.some((bridge) => bridge.bridge_id === current)) {
        return current;
      }

      return nextBridges[0]?.bridge_id ?? "";
    });

    return nextBridges;
  }

  async function loadBridgeWorkspace(sessionArg, bridgeId) {
    if (!sessionArg?.loginId || !bridgeId) {
      setProjects([]);
      setThreads([]);
      setStatus({
        app_server: {
          connected: false,
          initialized: false,
          account: null,
          last_error: null
        },
        updated_at: null
      });
      return;
    }

    setLoadingState("loading");

    try {
      const [nextStatus, nextProjects, nextThreads] = await Promise.all([
        apiRequest(
          `/api/bridge/status?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
        ),
        apiRequest(
          `/api/projects?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
        ),
        apiRequest(
          `/api/threads?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
        )
      ]);

      setStatus(nextStatus);
      setProjects(nextProjects.projects ?? []);
      setThreads(mergeThreads([], nextThreads.threads ?? []));
      setSelectedProjectId((current) => {
        if (current && nextProjects.projects?.some((project) => project.id === current)) {
          return current;
        }

        return nextProjects.projects?.[0]?.id || "";
      });
      setSelectedThreadId((current) => current || nextThreads.threads?.[0]?.id || "");
      setLoadingState("ready");
    } catch (error) {
      setLoadingState("error");
    }
  }

  async function loadWorkspaceRoots(sessionArg, bridgeId) {
    if (!sessionArg?.loginId || !bridgeId) {
      setWorkspaceRoots([]);
      return [];
    }

    const payload = await apiRequest(
      `/api/workspace-roots?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
    );
    const roots = payload?.roots ?? [];
    setWorkspaceRoots(roots);
    return roots;
  }

  async function browseWorkspacePath(path, bridgeIdArg = selectedBridgeId) {
    if (!session?.loginId || !bridgeIdArg) {
      return null;
    }

    setFolderLoading(true);

    try {
      const query = new URLSearchParams({
        login_id: session.loginId,
        bridge_id: bridgeIdArg
      });

      if (path) {
        query.set("path", path);
      }

      const payload = await apiRequest(`/api/folders?${query.toString()}`);
      setFolderState({
        path: payload?.path ?? "",
        parent_path: payload?.parent_path ?? null,
        entries: payload?.entries ?? []
      });
      return payload;
    } finally {
      setFolderLoading(false);
    }
  }

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const isStandalone =
      window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;

    if (isStandalone || isPwaPromptDismissed()) {
      return undefined;
    }

    const handleBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setDeferredInstallPrompt(event);
      setInstallPromptVisible(true);
    };

    const handleAppInstalled = () => {
      setDeferredInstallPrompt(null);
      setInstallPromptVisible(false);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.history?.pushState) {
      return undefined;
    }

    const handlePopState = (event) => {
      event?.preventDefault?.();
      window.history.pushState(null, "", window.location.href);
      setActiveView((current) => (current === "thread" ? "inbox" : current));
    };

    window.history.pushState(null, "", window.location.href);
    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  useEffect(() => {
    if (!session?.loginId) {
      return;
    }

    void loadBridges(session);
  }, [session]);

  useEffect(() => {
    if (!session?.loginId || !selectedBridgeId) {
      return undefined;
    }

    const eventSource = new EventSource(
      `${API_BASE_URL}/api/events?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`
    );

    eventSource.addEventListener("snapshot", (event) => {
      try {
        const payload = JSON.parse(event.data);
        setStatus(payload);
      } catch {
        // ignore malformed snapshot
      }
    });

    eventSource.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(event.data);

        if (payload.type === "bridge.status.updated") {
          setStatus(payload.payload);
          return;
        }

        if (payload.type === "bridge.projects.updated") {
          const nextProjects = payload.payload?.projects ?? [];
          setProjects(nextProjects);
          setSelectedProjectId((current) => {
            if (current && nextProjects.some((project) => project.id === current)) {
              return current;
            }

            return nextProjects[0]?.id || "";
          });
          return;
        }

        if (payload.type === "bridge.threads.updated") {
          const nextThreads = mergeThreads([], payload.payload?.threads ?? []);
          setThreads(nextThreads);
          setSelectedThreadId((current) => current || nextThreads[0]?.id || "");
          return;
        }

        if (payload.payload?.thread) {
          setThreads((current) => upsertThread(current, payload.payload.thread));
          setSelectedThreadId((current) => current || payload.payload.thread.id);
        }
      } catch {
        // ignore malformed event payload
      }
    });

    return () => {
      eventSource.close();
    };
  }, [session, selectedBridgeId]);

  useEffect(() => {
    if (!session?.loginId) {
      return;
    }

    void loadBridgeWorkspace(session, selectedBridgeId);
  }, [session, selectedBridgeId]);

  useEffect(() => {
    if (!session?.loginId || !selectedBridgeId || !projectComposerOpen) {
      return;
    }

    void (async () => {
      const roots = await loadWorkspaceRoots(session, selectedBridgeId);
      const currentProjectWorkspace =
        projects.find((project) => project.id === selectedProjectId)?.workspace_path ?? "";
      const preferredPath =
        selectedWorkspacePath ||
        currentProjectWorkspace ||
        roots[0]?.path ||
        "";

      setSelectedWorkspacePath((current) => current || preferredPath);
      await browseWorkspacePath(preferredPath, selectedBridgeId);
    })();
  }, [projectComposerOpen, projects, selectedBridgeId, selectedProjectId, selectedWorkspacePath, session]);

  useEffect(() => {
    if (
      !session?.loginId ||
      !selectedBridgeId ||
      !selectedThreadId ||
      activeView !== "thread"
    ) {
      return;
    }

    if (currentThreadDetailLoading) {
      return;
    }

    if (!hasCurrentThreadDetail || currentThreadDetailVersion !== selectedThreadUpdatedAt || !currentThreadDetailHasMessages) {
      void loadThreadMessages(selectedThreadId, { version: selectedThreadUpdatedAt });
    }
  }, [
    activeView,
    currentThreadDetailHasMessages,
    currentThreadDetailLoading,
    currentThreadDetailVersion,
    hasCurrentThreadDetail,
    loadThreadMessages,
    selectedBridgeId,
    selectedThreadId,
    selectedThreadUpdatedAt,
    session?.loginId
  ]);

  useEffect(() => {
    setSelectedProjectId("");
    setSelectedThreadId("");
    setWorkspaceRoots([]);
    setFolderState({ path: "", parent_path: null, entries: [] });
    setSelectedWorkspacePath("");
    setActiveView("inbox");
  }, [selectedBridgeId]);

  useEffect(() => {
    if (!selectedProjectId && projects.length > 0) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  useEffect(() => {
    if (!selectedThreadId && threads.length > 0) {
      setSelectedThreadId(threads[0].id);
      return;
    }

    if (selectedThreadId && !threads.some((thread) => thread.id === selectedThreadId)) {
      setSelectedThreadId(threads[0]?.id ?? "");
    }
  }, [selectedThreadId, threads]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }

    const projectThreads = threads.filter((thread) => thread.project_id === selectedProjectId);

    if (projectThreads.length === 0) {
      setSelectedThreadId("");
      return;
    }

    if (!projectThreads.some((thread) => thread.id === selectedThreadId)) {
      setSelectedThreadId(projectThreads[0].id);
    }
  }, [selectedProjectId, selectedThreadId, threads]);

  const handleLogin = async ({ loginId, password, rememberDevice }) => {
    setLoginState({ loading: true, error: "" });

    try {
      const auth = await apiRequest("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          loginId,
          password
        })
      });

      const nextSession = {
        accessToken: auth.accessToken,
        expiresAt: auth.expiresAt,
        role: auth.role,
        userId: auth.userId,
        displayName: auth.displayName,
        permissions: auth.permissions ?? [],
        loginId
      };

      storeSession(nextSession, rememberDevice);
      setSession(nextSession);
      setLoginState({ loading: false, error: "" });
    } catch (error) {
      setLoginState({ loading: false, error: error.message });
    }
  };

  const handleLogout = () => {
    clearSessionStorage();
    setSession(null);
    setBridges([]);
    setProjects([]);
    setThreads([]);
    setThreadDetails({});
    setWorkspaceRoots([]);
    setFolderState({ path: "", parent_path: null, entries: [] });
    setSelectedWorkspacePath("");
    setSelectedProjectId("");
    setSelectedThreadId("");
    setSearch("");
    setUtilityOpen(false);
    setProjectComposerOpen(false);
    setActiveView("inbox");
  };

  const handleCreateIssue = async (payload, options = {}) => {
    if (!session?.loginId) {
      return;
    }

    setIssueBusy(true);

    try {
      const created = await apiRequest(
        `/api/issues?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify(payload)
        }
      );

      const stayOnThread = Boolean(options?.stayOnThread);

      if (created?.thread?.id) {
        setThreads((current) => upsertThread(current, created.thread));
        setSelectedThreadId(created.thread.id);

        const started = await apiRequest(
          `/api/threads/start?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
          {
            method: "POST",
            body: JSON.stringify({
              thread_ids: [created.thread.id]
            })
          }
        );

        if (Array.isArray(started?.threads)) {
          setThreads((current) => mergeThreads(current, started.threads));
        }

        setLaneFilter("todo");
      }

      if (stayOnThread && created?.thread?.id) {
        setActiveView("thread");
      } else {
        setActiveView("inbox");
      }
      return true;
    } catch (error) {
      if (typeof window !== "undefined") {
        window.alert(error.message);
      }
      return false;
    } finally {
      setIssueBusy(false);
    }
  };

  const handleCreateProject = async (payload) => {
    if (!session?.loginId || !selectedBridgeId) {
      return;
    }

    setProjectBusy(true);

    try {
      const response = await apiRequest(
        `/api/projects?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify(payload)
        }
      );

      const nextProjects = response?.projects ?? null;
      const createdProject = response?.project ?? null;

      if (Array.isArray(nextProjects)) {
        setProjects(nextProjects);
      } else if (createdProject?.id) {
        setProjects((current) => {
          const exists = current.some((project) => project.id === createdProject.id);
          return exists ? current : [createdProject, ...current];
        });
      }

      if (createdProject?.id) {
        setSelectedProjectId(createdProject.id);
      }

      setSelectedWorkspacePath("");
      setProjectComposerOpen(false);
    } catch (error) {
      if (typeof window !== "undefined") {
        window.alert(error.message);
      }
    } finally {
      setProjectBusy(false);
    }
  };

  const handleRefresh = async () => {
    if (!session?.loginId) {
      return;
    }

    const nextBridges = await loadBridges(session);
    const targetBridgeId = selectedBridgeId || nextBridges[0]?.bridge_id;

    if (targetBridgeId) {
      await loadBridgeWorkspace(session, targetBridgeId);
    }
  };

  const handleOpenProjectComposer = async () => {
    setProjectComposerOpen(true);
    setSelectedWorkspacePath("");
    setFolderState({ path: "", parent_path: null, entries: [] });

    if (!session?.loginId || !selectedBridgeId) {
      return;
    }

    const roots = await loadWorkspaceRoots(session, selectedBridgeId);
    const preferredPath =
      projects.find((project) => project.id === selectedProjectId)?.workspace_path ??
      roots[0]?.path ??
      "";

    if (preferredPath) {
      setSelectedWorkspacePath(preferredPath);
      await browseWorkspacePath(preferredPath, selectedBridgeId);
    }
  };

  const handleCloseProjectComposer = () => {
    setProjectComposerOpen(false);
    setSelectedWorkspacePath("");
    setFolderState({ path: "", parent_path: null, entries: [] });
  };

  const handleSelectProject = (projectId) => {
    setSelectedProjectId(projectId);
    setActiveView("inbox");
  };

  const handleSelectThread = (threadId) => {
    startTransition(() => {
      setSelectedThreadId(threadId);
      setActiveView("thread");
    });
  };

  const handleDismissInstallPrompt = () => {
    dismissPwaPrompt();
    setInstallPromptVisible(false);
    setDeferredInstallPrompt(null);
  };

  const handleInstallPwa = async () => {
    if (!deferredInstallPrompt) {
      return;
    }

    setInstallBusy(true);

    try {
      await deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice.catch(() => null);
      setDeferredInstallPrompt(null);
      setInstallPromptVisible(false);
    } finally {
      setInstallBusy(false);
    }
  };

  if (!session) {
    return (
      <LoginPage
        initialLoginId=""
        loading={loginState.loading}
        error={loginState.error}
        onSubmit={handleLogin}
      />
    );
  }

  const currentThreadDetailState = threadDetails[selectedThreadId] ?? { messages: [], loading: false, error: "" };

  return (
    <MainPage
      session={session}
      bridges={bridges}
      status={status}
      projects={projects}
      threads={threads}
      workspaceRoots={workspaceRoots}
      folderState={folderState}
      folderLoading={folderLoading}
      selectedWorkspacePath={selectedWorkspacePath}
      selectedBridgeId={selectedBridgeId}
      selectedProjectId={selectedProjectId}
      selectedThreadId={selectedThreadId}
      search={search}
      loadingState={loadingState}
      utilityOpen={utilityOpen}
      projectBusy={projectBusy}
      issueBusy={issueBusy}
      projectComposerOpen={projectComposerOpen}
      installPromptVisible={installPromptVisible}
      installBusy={installBusy}
      laneFilter={laneFilter}
      activeView={activeView}
      threadDetail={currentThreadDetailState}
      onSearchChange={setSearch}
      onChangeLaneFilter={setLaneFilter}
      onSelectBridge={setSelectedBridgeId}
      onSelectProject={handleSelectProject}
      onSelectThread={handleSelectThread}
      onOpenUtility={() => setUtilityOpen(true)}
      onOpenProjectComposer={() => void handleOpenProjectComposer()}
      onInstallPwa={() => void handleInstallPwa()}
      onDismissInstallPrompt={handleDismissInstallPrompt}
      onCloseUtility={() => setUtilityOpen(false)}
      onCloseProjectComposer={handleCloseProjectComposer}
      onBrowseWorkspaceRoot={(path) => browseWorkspacePath(path)}
      onBrowseFolder={(path) => browseWorkspacePath(path)}
      onSelectWorkspace={setSelectedWorkspacePath}
      onSubmitProject={handleCreateProject}
      onSubmitIssue={handleCreateIssue}
      onRefreshThreadDetail={() => {
        if (selectedThreadId) {
          void loadThreadMessages(selectedThreadId, { force: true, version: selectedThreadUpdatedAt });
        }
      }}
      onRefresh={() => void handleRefresh()}
      onLogout={handleLogout}
      onBackToInbox={() => setActiveView("inbox")}
    />
  );
}
