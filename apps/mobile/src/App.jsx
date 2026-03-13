import { startTransition, useDeferredValue, useEffect, useMemo, useState } from "react";

const LOCAL_STORAGE_KEY = "octop.mobile.session";
const SESSION_STORAGE_KEY = "octop.mobile.session.ephemeral";
const LEGACY_LOCAL_STORAGE_KEY = "octop.dashboard.session";
const LEGACY_SESSION_STORAGE_KEY = "octop.dashboard.session.ephemeral";
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

function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `octop-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

function summarizeEvent(event) {
  return (
    event?.summary ??
    event?.payload?.thread?.title ??
    event?.payload?.error ??
    event?.payload?.projects?.[0]?.name ??
    event?.payload?.threads?.[0]?.title ??
    event?.type ??
    "브릿지 상태가 갱신되었습니다."
  );
}

function getThreadPreview(thread) {
  if (thread.last_message) {
    return thread.last_message;
  }

  return `${getStatusMeta(thread.status).label} · ${thread.last_event}`;
}

function BottomSheet({ open, title, description, onClose, children }) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/75 px-4 pb-4 pt-10 backdrop-blur-sm">
      <button type="button" aria-label="닫기" className="absolute inset-0" onClick={onClose} />
      <section className="sheet-enter relative z-10 w-full max-w-xl overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950 shadow-telegram-soft">
        <div className="border-b border-white/10 bg-white/5 px-5 py-4">
          <div className="mx-auto mb-4 h-1.5 w-14 rounded-full bg-white/15" />
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-white">{title}</h2>
              {description ? <p className="mt-1 text-sm leading-6 text-slate-400">{description}</p> : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/10 hover:text-white"
            >
              닫기
            </button>
          </div>
        </div>
        <div className="telegram-scroll max-h-[80dvh] overflow-y-auto">{children}</div>
      </section>
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
      description="bridge 연결과 프로젝트 관리 동작을 여기서 처리합니다."
      onClose={onClose}
    >
      <div className="space-y-5 px-5 py-5">
        <section className="rounded-[1.5rem] border border-white/10 bg-white/5 p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-telegram-500/20 text-base font-semibold text-white">
              {(session.displayName || session.loginId || "O").slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="truncate font-semibold text-white">{session.displayName || session.loginId}</p>
              <p className="truncate text-sm text-slate-400">{session.loginId}</p>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded-2xl bg-slate-900/80 px-3 py-3 text-slate-300">
              <div className="text-lg font-semibold text-white">{bridges.length}</div>
              Bridge
            </div>
            <div className="rounded-2xl bg-slate-900/80 px-3 py-3 text-slate-300">
              <div className="text-lg font-semibold text-white">{projects.length}</div>
              Project
            </div>
            <div className="rounded-2xl bg-slate-900/80 px-3 py-3 text-slate-300">
              <div className="text-lg font-semibold text-white">{threads.length}</div>
              Thread
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-white">연결 bridge</p>
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] ${
                status.app_server?.connected
                  ? "bg-emerald-400/20 text-emerald-100"
                  : "bg-rose-400/20 text-rose-100"
              }`}
            >
              {status.app_server?.connected ? "연결됨" : "미연결"}
            </span>
          </div>

          <div className="space-y-2">
            {bridges.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 px-4 py-4 text-sm text-slate-400">
                연결된 bridge가 없습니다.
              </div>
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
                    className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                      active
                        ? "border-telegram-300/50 bg-telegram-500/15"
                        : "border-white/10 bg-white/5 hover:bg-white/10"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-white">{bridge.device_name ?? bridge.bridge_id}</p>
                        <p className="truncate text-xs text-slate-400">{bridge.bridge_id}</p>
                      </div>
                      <span className="rounded-full bg-slate-900/70 px-2 py-1 text-[10px] text-slate-300">
                        {formatRelativeTime(bridge.last_seen_at)}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>

        <section className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => {
              onClose();
              onRefresh();
            }}
            className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-white transition hover:bg-white/10"
          >
            새로고침
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenProjectComposer();
            }}
            className="rounded-2xl bg-telegram-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-telegram-400"
          >
            프로젝트 등록
          </button>
        </section>

        <button
          type="button"
          onClick={onLogout}
          className="w-full rounded-2xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm font-semibold text-rose-100 transition hover:bg-rose-500/20"
        >
          로그아웃
        </button>
      </div>
    </BottomSheet>
  );
}

function IssueComposerSheet({ open, busy, projects, selectedProjectId, onClose, onSubmit }) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [projectId, setProjectId] = useState(selectedProjectId ?? projects[0]?.id ?? "");

  useEffect(() => {
    if (!open) {
      setTitle("");
      setPrompt("");
      return;
    }

    setProjectId(selectedProjectId ?? projects[0]?.id ?? "");
  }, [open, projects, selectedProjectId]);

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!title.trim() || !projectId) {
      return;
    }

    await onSubmit({
      title: title.trim(),
      prompt: prompt.trim(),
      project_id: projectId
    });
  };

  return (
    <BottomSheet
      open={open}
      title="새 thread 보내기"
      description="메시지를 보내듯 이슈를 등록하면 Codex turn이 생성됩니다."
      onClose={onClose}
    >
      <form className="space-y-4 px-5 py-5" onSubmit={handleSubmit}>
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="issue-title">
            제목
          </label>
          <input
            id="issue-title"
            type="text"
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="예: 모바일 앱 실시간 상태 점검"
            className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="issue-project">
            프로젝트
          </label>
          <select
            id="issue-project"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="issue-prompt">
            작업 설명
          </label>
          <textarea
            id="issue-prompt"
            rows="5"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="필요한 작업 내용이나 확인 포인트를 입력해 주세요."
            className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-slate-200 transition hover:bg-white/10"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-2xl bg-telegram-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "전송 중..." : "전송"}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}

function ProjectComposerSheet({
  open,
  busy,
  roots,
  folderState,
  folderLoading,
  selectedWorkspacePath,
  onBrowseRoot,
  onBrowseFolder,
  onSelectWorkspace,
  onClose,
  onSubmit
}) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!open) {
      setName("");
      setKey("");
      setDescription("");
      return;
    }

    if (!name.trim() && selectedWorkspacePath) {
      setName(getPathLabel(selectedWorkspacePath));
    }
  }, [name, open, selectedWorkspacePath]);

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!name.trim() || !selectedWorkspacePath) {
      return;
    }

    await onSubmit({
      name: name.trim(),
      key: key.trim(),
      description: description.trim(),
      workspace_path: selectedWorkspacePath
    });
  };

  return (
    <BottomSheet
      open={open}
      title="새 프로젝트 등록"
      description="bridge가 노출한 폴더를 선택해 모바일에서도 바로 관리할 수 있게 만듭니다."
      onClose={onClose}
    >
      <form className="space-y-5 px-5 py-5" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-white">Workspace Root</p>
            {folderLoading ? <span className="text-xs text-slate-400">불러오는 중...</span> : null}
          </div>

          <div className="flex gap-2 overflow-x-auto pb-1">
            {roots.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 px-4 py-3 text-sm text-slate-400">
                탐색 가능한 root가 없습니다.
              </div>
            ) : (
              roots.map((root) => (
                <button
                  key={root.path}
                  type="button"
                  onClick={() => void onBrowseRoot(root.path)}
                  className={`shrink-0 rounded-2xl border px-4 py-3 text-left transition ${
                    folderState.path === root.path || selectedWorkspacePath === root.path
                      ? "border-telegram-300/50 bg-telegram-500/15"
                      : "border-white/10 bg-white/5 hover:bg-white/10"
                  }`}
                >
                  <p className="text-sm font-medium text-white">{root.name}</p>
                  <p className="mt-1 text-[11px] text-slate-400">{shortenPath(root.path)}</p>
                </button>
              ))
            )}
          </div>
        </div>

        <section className="rounded-[1.5rem] border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Current Path</p>
              <p className="mt-2 break-all text-sm text-white">{folderState.path || "경로를 선택해 주세요."}</p>
            </div>
            <button
              type="button"
              disabled={!folderState.parent_path}
              onClick={() => void onBrowseFolder(folderState.parent_path)}
              className="rounded-full border border-white/10 bg-slate-950/60 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              상위
            </button>
          </div>

          <button
            type="button"
            disabled={!folderState.path}
            onClick={() => onSelectWorkspace(folderState.path)}
            className="mt-4 w-full rounded-2xl border border-telegram-300/30 bg-telegram-500/10 px-4 py-3 text-sm font-medium text-telegram-50 transition hover:bg-telegram-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            현재 경로를 workspace로 선택
          </button>

          <div className="telegram-scroll mt-4 max-h-64 space-y-2 overflow-y-auto">
            {folderState.entries?.length ? (
              folderState.entries.map((entry) => {
                const active = selectedWorkspacePath === entry.path;

                return (
                  <div
                    key={entry.path}
                    className={`rounded-2xl border px-4 py-3 ${
                      active ? "border-telegram-300/50 bg-telegram-500/15" : "border-white/10 bg-slate-950/45"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => void onBrowseFolder(entry.path)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <p className="truncate text-sm font-medium text-white">{entry.name}</p>
                        <p className="mt-1 truncate text-[11px] text-slate-400">{entry.path}</p>
                      </button>
                      <button
                        type="button"
                        onClick={() => onSelectWorkspace(entry.path)}
                        className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] font-medium text-slate-200 transition hover:bg-white/10"
                      >
                        선택
                      </button>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="rounded-2xl border border-dashed border-white/10 px-4 py-4 text-sm text-slate-400">
                하위 폴더가 없습니다.
              </div>
            )}
          </div>
        </section>

        <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Selected Workspace</p>
          <p className="mt-2 break-all text-sm text-white">
            {selectedWorkspacePath || "아직 선택된 경로가 없습니다."}
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
            className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="project-key">
            프로젝트 Key
          </label>
          <input
            id="project-key"
            type="text"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="비워두면 서버에서 자동 생성됩니다."
            className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="project-description">
            설명
          </label>
          <textarea
            id="project-description"
            rows="4"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="프로젝트 목적과 작업 범위를 적어 주세요."
            className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-slate-200 transition hover:bg-white/10"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={busy || !selectedWorkspacePath}
            className="rounded-2xl bg-telegram-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
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
      className={`w-full rounded-[1.6rem] border p-4 text-left transition ${
        active
          ? "border-telegram-300/50 bg-telegram-500/15 shadow-telegram-card"
          : "border-white/8 bg-white/5 hover:bg-white/10"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-telegram-500/15 text-sm font-semibold text-white">
          {thread.title.slice(0, 1).toUpperCase()}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="thread-title text-sm font-semibold text-white">{thread.title}</p>
              <p className="mt-1 text-xs text-slate-400">{projectName || "프로젝트 미지정"}</p>
            </div>
            <span className="shrink-0 text-[11px] text-slate-500">{formatRelativeTime(thread.updated_at)}</span>
          </div>

          <p className="thread-preview mt-3 text-sm leading-6 text-slate-300">{getThreadPreview(thread)}</p>

          <div className="mt-4 flex items-center justify-between gap-3">
            <span className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] ${status.chipClassName}`}>
              <span className={`h-2 w-2 rounded-full ${status.dotClassName}`} />
              {status.label}
            </span>
            <span className="rounded-full bg-slate-950/60 px-2.5 py-1 text-[11px] text-slate-300">
              {thread.progress}%
            </span>
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
      <article className={`max-w-[86%] rounded-[1.6rem] px-4 py-3 shadow-telegram-card ${bubbleClassName}`}>
        {title ? <p className="text-xs font-semibold uppercase tracking-[0.16em] opacity-70">{title}</p> : null}
        <div className={title ? "mt-2" : ""}>{children}</div>
        {meta ? <p className="mt-3 text-right text-[11px] opacity-60">{meta}</p> : null}
      </article>
    </div>
  );
}

function ThreadDetail({ thread, project, recentEvents, onBack, onOpenComposer }) {
  const status = getStatusMeta(thread.status);
  const activity = recentEvents.slice(0, 4);

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
            <p className="truncate text-xs text-slate-400">{project?.name ?? "프로젝트 미지정"}</p>
          </div>

          <button
            type="button"
            onClick={onOpenComposer}
            className="rounded-full bg-telegram-500 px-3 py-2 text-xs font-semibold text-white transition hover:bg-telegram-400"
          >
            새 이슈
          </button>
        </div>
      </header>

      <div className="telegram-grid flex-1 px-4 py-5">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          <div className="flex justify-center">
            <span className="rounded-full bg-slate-950/70 px-3 py-1.5 text-[11px] text-slate-300">
              {formatDateTime(thread.created_at)}
            </span>
          </div>

          <MessageBubble title="Thread" meta={formatRelativeTime(thread.updated_at)} tone="light">
            <p className="text-sm font-semibold">{thread.title}</p>
            <p className="mt-2 text-sm leading-6 opacity-80">
              {thread.last_message || "아직 작업 메시지가 기록되지 않았습니다. 실시간 이벤트가 도착하면 여기에 이어집니다."}
            </p>
          </MessageBubble>

          <MessageBubble align="right" tone={thread.status === "failed" ? "danger" : thread.status === "completed" ? "success" : thread.status === "awaiting_input" ? "warn" : "brand"} title={status.label} meta={`이벤트 ${thread.last_event}`}>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span>진행률</span>
                <span className="font-semibold">{thread.progress}%</span>
              </div>
              <div className="h-2 rounded-full bg-slate-900/15">
                <div className="h-2 rounded-full bg-current" style={{ width: `${thread.progress}%` }} />
              </div>
            </div>
          </MessageBubble>

          <MessageBubble title="Workspace" meta={project?.workspace_path ? shortenPath(project.workspace_path) : "경로 없음"}>
            <div className="space-y-2 text-sm leading-6">
              <p>프로젝트: {project?.name ?? "미지정"}</p>
              <p>Thread ID: {thread.id}</p>
              {thread.turn_id ? <p>Turn ID: {thread.turn_id}</p> : null}
            </div>
          </MessageBubble>

          {activity.map((event) => (
            <MessageBubble
              key={event.id}
              title={event.type}
              meta={formatRelativeTime(event.timestamp)}
              tone="light"
            >
              <p className="text-sm leading-6">{event.summary}</p>
            </MessageBubble>
          ))}
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
  workspaceRoots,
  folderState,
  folderLoading,
  selectedWorkspacePath,
  selectedBridgeId,
  selectedProjectId,
  selectedThreadId,
  search,
  recentEvents,
  loadingState,
  projectBusy,
  issueBusy,
  utilityOpen,
  projectComposerOpen,
  composerOpen,
  activeView,
  onSearchChange,
  onSelectBridge,
  onSelectProject,
  onSelectThread,
  onOpenUtility,
  onOpenProjectComposer,
  onOpenComposer,
  onCloseUtility,
  onCloseProjectComposer,
  onCloseComposer,
  onBrowseWorkspaceRoot,
  onBrowseFolder,
  onSelectWorkspace,
  onSubmitProject,
  onSubmitIssue,
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
      const matchesSearch =
        !searchKeyword ||
        thread.title.toLowerCase().includes(searchKeyword) ||
        thread.last_event.toLowerCase().includes(searchKeyword) ||
        thread.last_message.toLowerCase().includes(searchKeyword);

      return matchesProject && matchesSearch;
    });
  }, [searchKeyword, selectedProjectId, threads]);
  const bridgeLabel =
    bridges.find((bridge) => bridge.bridge_id === selectedBridgeId)?.device_name ??
    bridges.find((bridge) => bridge.bridge_id === selectedBridgeId)?.bridge_id ??
    "No Bridge";

  if (activeView === "thread" && selectedThread) {
    const threadProject = projects.find((project) => project.id === selectedThread.project_id) ?? selectedProject;

    return (
      <div className="telegram-shell min-h-screen bg-slate-950 text-slate-100">
        <ThreadDetail
          thread={selectedThread}
          project={threadProject}
          recentEvents={recentEvents}
          onBack={onBackToInbox}
          onOpenComposer={onOpenComposer}
        />
        <IssueComposerSheet
          open={composerOpen}
          busy={issueBusy}
          projects={projects}
          selectedProjectId={selectedThread.project_id ?? selectedProjectId}
          onClose={onCloseComposer}
          onSubmit={onSubmitIssue}
        />
      </div>
    );
  }

  return (
    <div className="telegram-shell min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col">
        <header className="relative overflow-hidden px-4 pb-5 pt-4">
          <div className="absolute inset-x-4 top-0 -z-10 h-56 rounded-[2rem] bg-gradient-to-br from-telegram-500 via-telegram-600 to-telegram-800 shadow-telegram-soft" />
          <div className="absolute right-6 top-6 -z-10 h-24 w-24 rounded-full bg-white/10 blur-2xl" />

          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={onOpenUtility}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/20"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M4 7h16M4 12h16M4 17h10" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
            </button>

            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-telegram-50/75">{session.displayName || session.loginId}</p>
              <h1 className="truncate font-display text-2xl font-bold text-white">OctOP Pocket</h1>
            </div>

            <span
              className={`rounded-full px-3 py-1.5 text-[11px] font-semibold ${
                status.app_server?.connected
                  ? "bg-emerald-400/20 text-emerald-50"
                  : "bg-rose-400/20 text-rose-50"
              }`}
            >
              {status.app_server?.connected ? "Bridge OK" : "Bridge Down"}
            </span>
          </div>

          <div className="mt-5 rounded-[1.6rem] bg-slate-950/20 p-4 backdrop-blur">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.28em] text-telegram-50/55">Connected Bridge</p>
                <p className="mt-2 text-lg font-semibold text-white">{bridgeLabel}</p>
                <p className="mt-1 text-sm text-telegram-50/70">
                  {status.app_server?.account?.plan_type ?? "Unknown Plan"} · {formatRelativeTime(status.updated_at)}
                </p>
              </div>

              <button
                type="button"
                onClick={onRefresh}
                className="rounded-full border border-white/15 bg-white/10 px-3 py-2 text-xs font-semibold text-white transition hover:bg-white/20"
              >
                새로고침
              </button>
            </div>
          </div>
        </header>

        <main className="flex-1 px-4 pb-28">
          <div className="rounded-[1.6rem] border border-white/8 bg-white/5 p-3 shadow-telegram-card">
            <div className="flex items-center gap-3 rounded-[1.2rem] bg-slate-950/50 px-3 py-3">
              <svg className="h-4 w-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="thread, event, 메시지 검색"
                className="w-full border-none bg-transparent p-0 text-sm text-white outline-none ring-0 placeholder:text-slate-500 focus:ring-0"
              />
            </div>

            <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
              <button
                type="button"
                onClick={() => onSelectProject("")}
                className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition ${
                  !selectedProjectId
                    ? "bg-white text-slate-900"
                    : "bg-slate-950/60 text-slate-300 hover:bg-slate-900"
                }`}
              >
                전체
              </button>
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => onSelectProject(project.id)}
                  className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition ${
                    project.id === selectedProjectId
                      ? "bg-white text-slate-900"
                      : "bg-slate-950/60 text-slate-300 hover:bg-slate-900"
                  }`}
                >
                  {project.name}
                </button>
              ))}
            </div>
          </div>

          <section className="mt-5 space-y-3">
            {filteredThreads.length === 0 ? (
              <div className="rounded-[1.8rem] border border-dashed border-white/10 bg-white/5 px-5 py-8 text-center text-sm leading-7 text-slate-400">
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

          <section className="mt-6 rounded-[1.8rem] border border-white/8 bg-white/5 p-4 shadow-telegram-card">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-white">실시간 Activity</p>
                <p className="mt-1 text-xs text-slate-400">SSE 이벤트와 bridge 상태가 여기에 쌓입니다.</p>
              </div>
              <span className="rounded-full bg-slate-950/60 px-3 py-1 text-[11px] text-slate-300">
                {recentEvents.length} items
              </span>
            </div>

            <div className="mt-4 space-y-2">
              {recentEvents.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 px-4 py-4 text-sm text-slate-400">
                  아직 받은 이벤트가 없습니다.
                </div>
              ) : (
                recentEvents.slice(0, 5).map((event) => (
                  <div key={event.id} className="rounded-2xl bg-slate-950/55 px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-xs uppercase tracking-[0.14em] text-slate-500">{event.type}</p>
                        <p className="mt-1 text-sm leading-6 text-slate-200">{event.summary}</p>
                      </div>
                      <span className="shrink-0 text-[11px] text-slate-500">{formatRelativeTime(event.timestamp)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </main>

        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 mx-auto flex w-full max-w-3xl justify-center px-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]">
          <div className="pointer-events-auto flex w-full items-center gap-3 rounded-[1.8rem] border border-white/10 bg-slate-950/90 p-3 shadow-telegram-soft backdrop-blur">
            <button
              type="button"
              onClick={onOpenComposer}
              disabled={projects.length === 0}
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-telegram-500 text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M12 5v14m7-7H5" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
            </button>

            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">
                {selectedProject?.name ?? "프로젝트를 선택하거나 새로 등록해 주세요"}
              </p>
              <p className="truncate text-xs text-slate-400">
                새 issue를 보내면 해당 프로젝트의 thread가 실시간으로 추가됩니다.
              </p>
            </div>
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
      <IssueComposerSheet
        open={composerOpen}
        busy={issueBusy}
        projects={projects}
        selectedProjectId={selectedProjectId}
        onClose={onCloseComposer}
        onSubmit={onSubmitIssue}
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
  const [workspaceRoots, setWorkspaceRoots] = useState([]);
  const [folderState, setFolderState] = useState({ path: "", parent_path: null, entries: [] });
  const [folderLoading, setFolderLoading] = useState(false);
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState("");
  const [selectedBridgeId, setSelectedBridgeId] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [search, setSearch] = useState("");
  const [recentEvents, setRecentEvents] = useState([]);
  const [loadingState, setLoadingState] = useState("idle");
  const [utilityOpen, setUtilityOpen] = useState(false);
  const [projectComposerOpen, setProjectComposerOpen] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [issueBusy, setIssueBusy] = useState(false);
  const [activeView, setActiveView] = useState("inbox");

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
      setRecentEvents((current) => [
        {
          id: createId(),
          type: "mobile.load.failed",
          timestamp: new Date().toISOString(),
          summary: error.message
        },
        ...current
      ].slice(0, 20));
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

    const appendEvent = (type, summary) => {
      setRecentEvents((current) => [
        {
          id: createId(),
          type,
          timestamp: new Date().toISOString(),
          summary
        },
        ...current
      ].slice(0, 20));
    };

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
        appendEvent(payload.type, summarizeEvent(payload));

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

    eventSource.addEventListener("error", () => {
      appendEvent("sse.error", "실시간 이벤트 스트림이 재연결을 시도하고 있습니다.");
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
    setSelectedProjectId("");
    setSelectedThreadId("");
    setWorkspaceRoots([]);
    setFolderState({ path: "", parent_path: null, entries: [] });
    setSelectedWorkspacePath("");
    setRecentEvents([]);
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
    setWorkspaceRoots([]);
    setFolderState({ path: "", parent_path: null, entries: [] });
    setSelectedWorkspacePath("");
    setRecentEvents([]);
    setSelectedProjectId("");
    setSelectedThreadId("");
    setSearch("");
    setUtilityOpen(false);
    setProjectComposerOpen(false);
    setComposerOpen(false);
    setActiveView("inbox");
  };

  const handleCreateIssue = async (payload) => {
    if (!session?.loginId) {
      return;
    }

    setIssueBusy(true);

    try {
      const response = await apiRequest(
        `/api/commands/ping?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify(payload)
        }
      );

      if (response?.thread) {
        setThreads((current) => upsertThread(current, response.thread));
        setSelectedThreadId(response.thread.id);
      }

      setComposerOpen(false);
      setActiveView("inbox");
    } catch (error) {
      setRecentEvents((current) => [
        {
          id: createId(),
          type: "issue.create.failed",
          timestamp: new Date().toISOString(),
          summary: error.message
        },
        ...current
      ].slice(0, 20));
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
      setRecentEvents((current) => [
        {
          id: createId(),
          type: "project.create.failed",
          timestamp: new Date().toISOString(),
          summary: error.message
        },
        ...current
      ].slice(0, 20));
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
      recentEvents={recentEvents}
      loadingState={loadingState}
      utilityOpen={utilityOpen}
      projectBusy={projectBusy}
      issueBusy={issueBusy}
      projectComposerOpen={projectComposerOpen}
      composerOpen={composerOpen}
      activeView={activeView}
      onSearchChange={setSearch}
      onSelectBridge={setSelectedBridgeId}
      onSelectProject={handleSelectProject}
      onSelectThread={handleSelectThread}
      onOpenUtility={() => setUtilityOpen(true)}
      onOpenProjectComposer={() => void handleOpenProjectComposer()}
      onOpenComposer={() => setComposerOpen(true)}
      onCloseUtility={() => setUtilityOpen(false)}
      onCloseProjectComposer={handleCloseProjectComposer}
      onCloseComposer={() => setComposerOpen(false)}
      onBrowseWorkspaceRoot={(path) => browseWorkspacePath(path)}
      onBrowseFolder={(path) => browseWorkspacePath(path)}
      onSelectWorkspace={setSelectedWorkspacePath}
      onSubmitProject={handleCreateProject}
      onSubmitIssue={handleCreateIssue}
      onRefresh={() => void handleRefresh()}
      onLogout={handleLogout}
      onBackToInbox={() => setActiveView("inbox")}
    />
  );
}
