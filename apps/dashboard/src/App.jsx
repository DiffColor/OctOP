import { useEffect, useState } from "react";

const LOCAL_STORAGE_KEY = "octop.dashboard.session";
const SESSION_STORAGE_KEY = "octop.dashboard.session.ephemeral";
const DEFAULT_API_BASE_URL =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
    ? "http://127.0.0.1:4000"
    : "https://octop.ilycode.app";
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");

const COLUMN_ORDER = [
  { id: "todo", label: "To Do", accent: "slate", countClassName: "bg-slate-800 text-slate-300" },
  { id: "running", label: "In Progress", accent: "blue", countClassName: "bg-sky-500/10 text-sky-300" },
  { id: "review", label: "Review", accent: "violet", countClassName: "bg-violet-500/10 text-violet-300" },
  { id: "done", label: "Done", accent: "green", countClassName: "bg-emerald-500/10 text-emerald-300" }
];

const STATUS_META = {
  queued: {
    column: "todo",
    label: "Queued",
    chipClassName: "bg-slate-800 text-slate-300",
    dotClassName: "bg-slate-400"
  },
  idle: {
    column: "todo",
    label: "Idle",
    chipClassName: "bg-slate-800 text-slate-300",
    dotClassName: "bg-slate-400"
  },
  awaiting_input: {
    column: "review",
    label: "Need Input",
    chipClassName: "bg-amber-500/10 text-amber-300",
    dotClassName: "bg-amber-400"
  },
  running: {
    column: "running",
    label: "Running",
    chipClassName: "bg-sky-500/10 text-sky-300",
    dotClassName: "bg-sky-400"
  },
  failed: {
    column: "review",
    label: "Failed",
    chipClassName: "bg-rose-500/10 text-rose-300",
    dotClassName: "bg-rose-400"
  },
  completed: {
    column: "done",
    label: "Done",
    chipClassName: "bg-emerald-500/10 text-emerald-300",
    dotClassName: "bg-emerald-400"
  }
};

function readStoredSession() {
  for (const key of [LOCAL_STORAGE_KEY, SESSION_STORAGE_KEY]) {
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

function summarizeProjects(projects) {
  if (projects.length === 0) {
    return "프로젝트가 아직 없습니다.";
  }

  if (projects.length === 1) {
    return `${projects[0].name} 1개 프로젝트`;
  }

  return `${projects[0].name} 외 ${projects.length - 1}개 프로젝트`;
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
    <div className="relative min-h-screen overflow-hidden bg-brand-dark text-slate-200">
      <div className="fixed inset-0 -z-10 overflow-hidden">
        <div className="bg-mesh absolute inset-0" />
        <div className="absolute left-[-10%] top-[-8%] h-[24rem] w-[24rem] rounded-full bg-brand-accent/10 blur-[120px]" />
        <div className="absolute bottom-[-12%] right-[-12%] h-[28rem] w-[28rem] rounded-full bg-emerald-500/10 blur-[160px]" />
      </div>

      <div className="mx-auto flex min-h-screen max-w-6xl items-center justify-center px-4 py-10 lg:px-8">
        <div className="grid w-full gap-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <section className="hidden rounded-[2rem] border border-white/8 bg-slate-950/55 p-8 shadow-2xl shadow-slate-950/40 backdrop-blur xl:block">
            <div className="mb-10 flex items-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500 to-violet-500 shadow-lg shadow-sky-500/20">
                <svg className="h-7 w-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M13 10V3L4 14h7v7l9-11h-7z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                </svg>
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.32em] text-slate-500">OctOP Control Plane</p>
                <h1 className="mt-2 text-3xl font-semibold text-white">AI orchestration workspace</h1>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5">
                <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Runtime</p>
                <p className="mt-3 text-3xl font-semibold text-white">24/7</p>
                <p className="mt-2 text-sm leading-6 text-slate-400">
                  숨겨진 로컬 bridge와 app-server 상태를 원격 보드에서 계속 추적합니다.
                </p>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5">
                <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Threads</p>
                <p className="mt-3 text-3xl font-semibold text-white">Live</p>
                <p className="mt-2 text-sm leading-6 text-slate-400">
                  실행 중인 turn, diff, 마지막 메시지를 칸반과 모바일 체크리스트에서 동시에 확인합니다.
                </p>
              </div>
            </div>

            <div className="mt-8 rounded-3xl border border-slate-800 bg-slate-900/70 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Workspace Snapshot</p>
                  <h2 className="mt-2 text-xl font-semibold text-white">운영 팀을 위한 단일 관제 화면</h2>
                </div>
                <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-medium text-emerald-300">
                  Bridge Online Ready
                </span>
              </div>
              <div className="mt-6 grid gap-4 sm:grid-cols-3">
                {[
                  ["Issue intake", "보드에서 바로 등록하고 즉시 thread 생성"],
                  ["Event stream", "SSE 기반으로 plan/diff/완료 상태 반영"],
                  ["Agent runtime", "Codex app-server 상태와 계정 정보를 한 곳에서 확인"]
                ].map(([title, description]) => (
                  <div key={title} className="rounded-2xl border border-slate-800 bg-slate-950/75 p-4">
                    <p className="text-sm font-medium text-white">{title}</p>
                    <p className="mt-2 text-sm leading-6 text-slate-400">{description}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <main className="mx-auto w-full max-w-md">
            <header className="mb-10 text-center">
              <div className="inline-flex h-16 w-16 items-center justify-center rounded-3xl bg-gradient-to-tr from-brand-accent to-violet-500 shadow-lg shadow-brand-accent/20">
                <svg className="h-9 w-9 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M13 10V3L4 14h7v7l9-11h-7z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                </svg>
              </div>
              <h1 className="mt-6 text-3xl font-semibold tracking-tight text-white">OctOP</h1>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                LicenseHub 계정의 <span className="font-medium text-slate-200">ID</span>로 로그인해 작업 보드를 여십시오.
              </p>
            </header>

            <section className="glass-effect rounded-[2rem] p-8 shadow-2xl shadow-slate-950/35">
              <form className="space-y-6" onSubmit={handleSubmit}>
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
                    placeholder="관리자 ID를 입력하세요"
                    value={loginId}
                    onChange={(event) => setLoginId(event.target.value)}
                    className="w-full rounded-2xl border border-slate-700 bg-brand-dark px-4 py-3 text-white outline-none transition duration-200 focus:border-sky-400 focus:ring-2 focus:ring-sky-400/40"
                  />
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <label className="block text-sm font-medium text-slate-300" htmlFor="password">
                      Password
                    </label>
                    <span className="text-xs text-slate-500">LicenseHub 계정 비밀번호</span>
                  </div>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    placeholder="••••••••"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="w-full rounded-2xl border border-slate-700 bg-brand-dark px-4 py-3 text-white outline-none transition duration-200 focus:border-sky-400 focus:ring-2 focus:ring-sky-400/40"
                  />
                </div>

                <label className="flex items-center gap-3 rounded-2xl border border-slate-800 bg-slate-950/50 px-4 py-3 text-sm text-slate-400">
                  <input
                    id="remember-device"
                    name="remember-device"
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-700 bg-brand-dark text-sky-400 focus:ring-sky-400"
                    checked={rememberDevice}
                    onChange={(event) => setRememberDevice(event.target.checked)}
                  />
                  이 기기에서 로그인 상태 유지
                </label>

                {error ? (
                  <div className="rounded-2xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                    {error}
                  </div>
                ) : null}

                <button
                  type="submit"
                  disabled={loading}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-accent px-4 py-3 text-base font-semibold text-white shadow-lg shadow-brand-accent/20 transition duration-200 hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loading ? (
                    <>
                      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                      로그인 중...
                    </>
                  ) : (
                    "Sign In"
                  )}
                </button>
              </form>

              <div className="mt-8 rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-4 text-sm leading-6 text-slate-400">
                로그인 후 project 목록, thread 진행 상태, app-server 연결 상태가 자동으로 동기화됩니다.
              </div>
            </section>
          </main>
        </div>
      </div>
    </div>
  );
}

function IssueComposer({ open, busy, projects, selectedProjectId, onClose, onSubmit }) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [projectId, setProjectId] = useState(selectedProjectId ?? projects[0]?.id ?? "");

  useEffect(() => {
    if (!open) {
      return;
    }

    setProjectId(selectedProjectId ?? projects[0]?.id ?? "");
  }, [open, projects, selectedProjectId]);

  useEffect(() => {
    if (!open) {
      setTitle("");
      setPrompt("");
    }
  }, [open]);

  if (!open) {
    return null;
  }

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 px-4 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-[2rem] border border-slate-800 bg-slate-950/95 p-6 shadow-2xl shadow-slate-950/60">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-slate-500">New Issue</p>
            <h2 className="mt-2 text-2xl font-semibold text-white">새 thread 등록</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              제목은 칸반 카드의 이슈명으로 사용되고, 설명은 Codex turn 입력으로 전달됩니다.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-800 bg-slate-900/80 px-3 py-1.5 text-sm text-slate-300 transition hover:border-slate-700 hover:text-white"
          >
            닫기
          </button>
        </div>

        <form className="mt-6 space-y-5" onSubmit={handleSubmit}>
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="issue-title">
              이슈 제목
            </label>
            <input
              id="issue-title"
              type="text"
              required
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="예: Codex bridge 상태 전이를 정리해 주세요"
              className="w-full rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-white outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/30"
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
              className="w-full rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-white outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/30"
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
              placeholder="필요한 작업 내용이나 확인하고 싶은 내용을 입력해 주세요."
              className="w-full rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-white outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/30"
            />
          </div>

          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-2xl border border-slate-800 px-4 py-3 text-sm font-medium text-slate-300 transition hover:border-slate-700 hover:text-white"
            >
              취소
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-2xl bg-emerald-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "등록 중..." : "이슈 등록"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ThreadCard({ thread, selected, onSelect }) {
  const status = getStatusMeta(thread.status);

  return (
    <button
      type="button"
      onClick={() => onSelect(thread.id)}
      className={`issue-card w-full rounded-2xl border p-4 text-left transition ${
        selected
          ? "border-sky-400/50 bg-slate-900 shadow-lg shadow-sky-950/20"
          : "border-slate-800 bg-slate-900/90 hover:border-slate-700"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <span className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-medium ${status.chipClassName}`}>
          <span className={`h-2 w-2 rounded-full ${status.dotClassName}`} />
          {status.label}
        </span>
        <span className="font-mono text-[11px] text-slate-500">{thread.id.slice(0, 8)}</span>
      </div>

      <h4 className="mt-4 text-sm font-semibold leading-6 text-white">{thread.title}</h4>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between text-[11px] text-slate-400">
          <span>{thread.last_event ?? "thread.started"}</span>
          <span>{thread.progress}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-slate-800">
          <div className="h-1.5 rounded-full bg-gradient-to-r from-sky-400 to-violet-400" style={{ width: `${thread.progress}%` }} />
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between text-[11px] text-slate-500">
        <span>{thread.source === "appServer" ? "app-server" : thread.source}</span>
        <span>{formatRelativeTime(thread.updated_at)}</span>
      </div>
    </button>
  );
}

function MainPage({
  session,
  status,
  projects,
  threads,
  selectedProjectId,
  selectedThreadId,
  search,
  recentEvents,
  loadingState,
  issueBusy,
  composerOpen,
  onSearchChange,
  onSelectProject,
  onSelectThread,
  onOpenComposer,
  onCloseComposer,
  onSubmitIssue,
  onRefresh,
  onLogout
}) {
  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? null;
  const projectScopedThreads = threads.filter((thread) => {
    return !selectedProjectId || thread.project_id === selectedProjectId;
  });
  const filteredThreads = projectScopedThreads.filter((thread) => {
    const keyword = search.trim().toLowerCase();
    const matchesSearch =
      !keyword ||
      thread.title.toLowerCase().includes(keyword) ||
      thread.last_event.toLowerCase().includes(keyword) ||
      thread.last_message.toLowerCase().includes(keyword);

    return matchesSearch;
  });
  const selectedThread =
    filteredThreads.find((thread) => thread.id === selectedThreadId) ??
    projectScopedThreads.find((thread) => thread.id === selectedThreadId) ??
    null;
  const projectTree = projects.map((project) => {
    const projectThreads = threads.filter((thread) => thread.project_id === project.id);

    return {
      ...project,
      totalThreads: projectThreads.length,
      runningThreads: projectThreads.filter((thread) => thread.status === "running").length,
      reviewThreads: projectThreads.filter((thread) =>
        ["failed", "awaiting_input"].includes(thread.status)
      ).length,
      latestThreads: [...projectThreads]
        .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
        .slice(0, 3)
    };
  });

  const columns = COLUMN_ORDER.map((column) => ({
    ...column,
    threads: filteredThreads.filter((thread) => getStatusMeta(thread.status).column === column.id)
  }));

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <div className="flex min-h-screen flex-col">
        <div className="flex flex-1 flex-col lg:flex-row">
          <aside className="border-b border-slate-800 bg-slate-950/95 px-4 py-5 lg:w-80 lg:border-b-0 lg:border-r lg:px-5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500 to-violet-500 shadow-lg shadow-sky-500/20">
              <svg className="h-5 w-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M13 10V3L4 14h7v7l9-11h-7z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-slate-500">OctOP IDE</p>
              <h1 className="text-xl font-semibold text-white">Thread Workspace</h1>
            </div>
          </div>

          <div className="mt-6">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Projects</p>
                <h2 className="mt-2 text-lg font-semibold text-white">{summarizeProjects(projects)}</h2>
              </div>
              <button
                type="button"
                onClick={onRefresh}
                className="rounded-full border border-slate-800 px-3 py-1 text-xs text-slate-400 transition hover:border-slate-700 hover:text-white"
              >
                새로고침
              </button>
            </div>

            <div className="custom-scrollbar space-y-3 overflow-y-auto pr-1 lg:max-h-[calc(100vh-8.75rem)]">
              {projectTree.map((project) => {
                const active = project.id === selectedProjectId;

                return (
                  <div
                    key={project.id}
                    className={`rounded-[1.5rem] border transition ${
                      active
                        ? "border-sky-400/40 bg-sky-500/10"
                        : "border-slate-800 bg-slate-900/40 hover:border-slate-700"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectProject(project.id)}
                      className="w-full px-4 py-4 text-left"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className={`text-sm font-semibold ${active ? "text-white" : "text-slate-200"}`}>
                            {project.name}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">{project.key}</p>
                        </div>
                        <span className="rounded-full bg-slate-950/70 px-2 py-1 text-[11px] text-slate-400">
                          {project.totalThreads}
                        </span>
                      </div>

                      <div className="mt-4 flex flex-wrap gap-2 text-[11px]">
                        <span className="rounded-full bg-slate-950/80 px-2 py-1 text-slate-400">
                          전체 {project.totalThreads}
                        </span>
                        <span className="rounded-full bg-sky-500/10 px-2 py-1 text-sky-300">
                          실행 {project.runningThreads}
                        </span>
                        <span className="rounded-full bg-violet-500/10 px-2 py-1 text-violet-300">
                          검토 {project.reviewThreads}
                        </span>
                      </div>
                    </button>

                    {active ? (
                      <div className="border-t border-white/6 px-4 py-4">
                        <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.24em] text-slate-500">
                          Project Tree
                        </p>
                        <div className="space-y-2">
                          {project.latestThreads.length === 0 ? (
                            <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-950/50 px-3 py-4 text-xs text-slate-500">
                              아직 등록된 이슈가 없습니다.
                            </div>
                          ) : (
                            project.latestThreads.map((thread) => (
                              <button
                                key={thread.id}
                                type="button"
                                onClick={() => onSelectThread(thread.id)}
                                className={`flex w-full items-start gap-3 rounded-2xl px-3 py-3 text-left transition ${
                                  thread.id === selectedThreadId
                                    ? "bg-slate-950/90 text-white"
                                    : "bg-slate-950/50 text-slate-300 hover:bg-slate-950/80"
                                }`}
                              >
                                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${getStatusMeta(thread.status).dotClassName}`} />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm font-medium">{thread.title}</span>
                                  <span className="mt-1 block font-mono text-[11px] text-slate-500">
                                    {thread.last_event}
                                  </span>
                                </span>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
          </aside>

          <main className="flex min-h-screen flex-1 flex-col">
          <header className="border-b border-slate-800 bg-slate-950/70 px-4 py-5 backdrop-blur md:px-6 lg:px-8">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-slate-500">Project Board</p>
                <h2 className="mt-2 text-2xl font-semibold text-white">{selectedProject?.name ?? "프로젝트 선택 필요"}</h2>
                <p className="mt-2 text-sm text-slate-400">
                  선택한 프로젝트의 thread만 칸반에 표시됩니다. 마지막 갱신 {formatRelativeTime(status.updated_at)}
                </p>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <label className="relative block w-full sm:w-72">
                  <span className="pointer-events-none absolute inset-y-0 left-4 flex items-center text-slate-500">
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                    </svg>
                  </span>
                  <input
                    type="text"
                    value={search}
                    onChange={(event) => onSearchChange(event.target.value)}
                    placeholder="thread 제목, 이벤트 검색"
                    className="w-full rounded-2xl border border-slate-800 bg-slate-900/80 py-3 pl-11 pr-4 text-sm text-white outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/30"
                  />
                </label>

                <button
                  type="button"
                  onClick={onOpenComposer}
                  disabled={projects.length === 0}
                  className="flex items-center justify-center gap-2 rounded-2xl bg-emerald-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path d="M12 4v16m8-8H4" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                  </svg>
                  이슈 등록
                </button>
              </div>
            </div>
          </header>

          <div className="flex flex-1 flex-col xl:flex-row">
            <section className="min-w-0 flex-1 overflow-x-auto px-4 py-6 md:px-6 lg:px-8">
              <div className="flex min-h-full gap-5 pb-3">
                {columns.map((column) => (
                  <div key={column.id} className="kanban-column w-[20rem] shrink-0 rounded-[1.75rem] border border-slate-800 bg-slate-950/60 p-4">
                    <div className="mb-4 flex items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className={`h-2.5 w-2.5 rounded-full ${column.accent === "slate" ? "bg-slate-400" : column.accent === "blue" ? "bg-sky-400" : column.accent === "violet" ? "bg-violet-400" : "bg-emerald-400"}`} />
                          <h3 className="text-sm font-semibold uppercase tracking-[0.24em] text-slate-300">{column.label}</h3>
                        </div>
                        <p className="mt-2 text-xs text-slate-500">
                          {column.id === "todo"
                            ? "등록되었지만 아직 실행이 시작되지 않은 항목"
                            : column.id === "running"
                              ? "turn이 실행 중이거나 agent 응답이 들어오는 항목"
                              : column.id === "review"
                                ? "실패 또는 사용자 입력이 필요한 항목"
                                : "완료된 thread"}
                        </p>
                      </div>
                      <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${column.countClassName}`}>
                        {column.threads.length}
                      </span>
                    </div>

                    <div className="custom-scrollbar flex max-h-[calc(100vh-20rem)] flex-col gap-3 overflow-y-auto pr-1">
                      {column.threads.length === 0 ? (
                        <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 px-4 py-6 text-sm text-slate-500">
                          해당 상태의 thread가 없습니다.
                        </div>
                      ) : (
                        column.threads.map((thread) => (
                          <ThreadCard
                            key={thread.id}
                            thread={thread}
                            selected={thread.id === selectedThreadId}
                            onSelect={onSelectThread}
                          />
                        ))
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <aside className="border-t border-slate-800 bg-slate-950/90 px-4 py-6 xl:w-[22rem] xl:border-l xl:border-t-0">
              <div className="rounded-[1.75rem] border border-slate-800 bg-slate-900/70 p-5">
                <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Thread Detail</p>
                {selectedThread ? (
                  <div className="mt-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="text-lg font-semibold text-white">{selectedThread.title}</h3>
                        <p className="mt-2 font-mono text-xs text-slate-500">{selectedThread.id}</p>
                      </div>
                      <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${getStatusMeta(selectedThread.status).chipClassName}`}>
                        {getStatusMeta(selectedThread.status).label}
                      </span>
                    </div>

                    <div className="mt-6 space-y-4 text-sm">
                      <div className="rounded-2xl border border-slate-800 bg-slate-950/80 p-4">
                        <div className="flex items-center justify-between text-slate-400">
                          <span>진행률</span>
                          <span>{selectedThread.progress}%</span>
                        </div>
                        <div className="mt-3 h-2 rounded-full bg-slate-800">
                          <div
                            className="h-2 rounded-full bg-gradient-to-r from-sky-400 to-violet-400"
                            style={{ width: `${selectedThread.progress}%` }}
                          />
                        </div>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                        <div className="rounded-2xl border border-slate-800 bg-slate-950/80 p-4">
                          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Project</p>
                          <p className="mt-2 text-sm font-medium text-white">
                            {projects.find((project) => project.id === selectedThread.project_id)?.name ?? "미지정"}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-slate-800 bg-slate-950/80 p-4">
                          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Last Event</p>
                          <p className="mt-2 text-sm font-medium text-white">{selectedThread.last_event}</p>
                        </div>
                        <div className="rounded-2xl border border-slate-800 bg-slate-950/80 p-4">
                          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Created</p>
                          <p className="mt-2 text-sm font-medium text-white">{formatDateTime(selectedThread.created_at)}</p>
                        </div>
                        <div className="rounded-2xl border border-slate-800 bg-slate-950/80 p-4">
                          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Updated</p>
                          <p className="mt-2 text-sm font-medium text-white">{formatDateTime(selectedThread.updated_at)}</p>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-slate-800 bg-slate-950/80 p-4">
                        <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Last Message</p>
                        <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-300">
                          {selectedThread.last_message || "아직 agent 메시지가 수신되지 않았습니다."}
                        </p>
                      </div>

                      <div className="rounded-2xl border border-slate-800 bg-slate-950/80 p-4">
                        <div className="flex items-center justify-between">
                          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Recent Events</p>
                          <span className="text-[11px] text-slate-500">{loadingState === "loading" ? "동기화 중" : "실시간"}</span>
                        </div>
                        <div className="custom-scrollbar mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
                          {recentEvents.length === 0 ? (
                            <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 px-3 py-4 text-xs text-slate-500">
                              아직 수신된 이벤트가 없습니다.
                            </div>
                          ) : (
                            recentEvents.map((event) => (
                              <div key={event.id} className="rounded-2xl border border-slate-800 bg-slate-900/50 px-3 py-3">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="text-xs font-medium text-white">{event.type}</p>
                                  <span className="text-[10px] text-slate-500">{formatRelativeTime(event.timestamp)}</span>
                                </div>
                                <p className="mt-1 text-xs leading-5 text-slate-400">{summarizeEvent(event)}</p>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 rounded-2xl border border-dashed border-slate-800 bg-slate-950/50 px-4 py-8 text-sm leading-6 text-slate-500">
                    좌측 보드에서 thread를 선택하면 상세 정보가 여기에 표시됩니다.
                  </div>
                )}
              </div>
            </aside>
          </div>
          </main>
        </div>

        <footer className="border-t border-slate-800 bg-slate-950/95 px-4 py-2.5 backdrop-blur md:px-6 lg:px-8">
          <div className="flex flex-col gap-2 text-[11px] text-slate-400 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-200">{session.displayName || session.loginId}</span>
              <span className="text-slate-600">/</span>
              <span>{session.loginId}</span>
              <span className="text-slate-600">/</span>
              <span>{session.role || "viewer"}</span>
              <span className="text-slate-600">/</span>
              <span>{status.app_server?.account?.plan_type ?? "Unknown"}</span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 ${
                  status.app_server?.connected
                    ? "bg-emerald-500/10 text-emerald-300"
                    : "bg-rose-500/10 text-rose-300"
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    status.app_server?.connected ? "bg-emerald-400" : "bg-rose-400"
                  }`}
                />
                {status.app_server?.connected ? "Bridge OK" : "Bridge Down"}
              </span>
              <span className="rounded-full bg-slate-900/80 px-2.5 py-1">Projects {projects.length}</span>
              <span className="rounded-full bg-slate-900/80 px-2.5 py-1">Threads {threads.length}</span>
              <span className="rounded-full bg-slate-900/80 px-2.5 py-1">
                {loadingState === "loading" ? "동기화 중" : `마지막 갱신 ${formatRelativeTime(status.updated_at)}`}
              </span>
              <button
                type="button"
                onClick={onLogout}
                className="rounded-xl border border-slate-800 px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:border-slate-700 hover:text-white"
              >
                로그아웃
              </button>
            </div>
          </div>
        </footer>
      </div>

      <IssueComposer
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
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [search, setSearch] = useState("");
  const [recentEvents, setRecentEvents] = useState([]);
  const [loadingState, setLoadingState] = useState("idle");
  const [composerOpen, setComposerOpen] = useState(false);
  const [issueBusy, setIssueBusy] = useState(false);

  async function loadDashboard(sessionArg) {
    if (!sessionArg?.userId) {
      return;
    }

    setLoadingState("loading");

    try {
      const [nextStatus, nextProjects, nextThreads] = await Promise.all([
        apiRequest(`/api/bridge/status?user_id=${encodeURIComponent(sessionArg.userId)}`),
        apiRequest(`/api/projects?user_id=${encodeURIComponent(sessionArg.userId)}`),
        apiRequest(`/api/threads?user_id=${encodeURIComponent(sessionArg.userId)}`)
      ]);

      setStatus(nextStatus);
      setProjects(nextProjects.projects ?? []);
      setThreads(mergeThreads([], nextThreads.threads ?? []));
      setSelectedProjectId((current) => current || nextProjects.projects?.[0]?.id || "");
      setSelectedThreadId((current) => current || nextThreads.threads?.[0]?.id || "");
      setLoadingState("ready");
    } catch (error) {
      setLoadingState("error");
      setRecentEvents((current) => [
        {
          id: createId(),
          type: "dashboard.load.failed",
          timestamp: new Date().toISOString(),
          summary: error.message
        },
        ...current
      ].slice(0, 20));
    }
  }

  useEffect(() => {
    if (!session?.userId) {
      return;
    }

    void loadDashboard(session);
  }, [session]);

  useEffect(() => {
    if (!session?.userId) {
      return undefined;
    }

    const eventSource = new EventSource(
      `${API_BASE_URL}/api/events?user_id=${encodeURIComponent(session.userId)}`
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
        const summary =
          payload?.payload?.thread?.title ??
          payload?.payload?.error ??
          payload?.payload?.projects?.[0]?.name ??
          payload?.payload?.threads?.[0]?.title ??
          payload?.type;

        appendEvent(payload.type, summary);

        if (payload.type === "bridge.status.updated") {
          setStatus(payload.payload);
          return;
        }

        if (payload.type === "bridge.projects.updated") {
          const nextProjects = payload.payload?.projects ?? [];
          setProjects(nextProjects);
          setSelectedProjectId((current) => current || nextProjects[0]?.id || "");
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
  }, [session]);

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
    setProjects([]);
    setThreads([]);
    setRecentEvents([]);
    setSelectedProjectId("");
    setSelectedThreadId("");
    setSearch("");
  };

  const handleCreateIssue = async (payload) => {
    if (!session?.userId) {
      return;
    }

    setIssueBusy(true);

    try {
      const response = await apiRequest(
        `/api/commands/ping?user_id=${encodeURIComponent(session.userId)}`,
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
      status={status}
      projects={projects}
      threads={threads}
      selectedProjectId={selectedProjectId}
      selectedThreadId={selectedThreadId}
      search={search}
      recentEvents={recentEvents}
      loadingState={loadingState}
      issueBusy={issueBusy}
      composerOpen={composerOpen}
      onSearchChange={setSearch}
      onSelectProject={setSelectedProjectId}
      onSelectThread={setSelectedThreadId}
      onOpenComposer={() => setComposerOpen(true)}
      onCloseComposer={() => setComposerOpen(false)}
      onSubmitIssue={handleCreateIssue}
      onRefresh={() => void loadDashboard(session)}
      onLogout={handleLogout}
    />
  );
}
