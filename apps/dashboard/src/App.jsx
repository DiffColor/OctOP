import { useEffect, useState } from "react";

const LOCAL_STORAGE_KEY = "octop.dashboard.session";
const SESSION_STORAGE_KEY = "octop.dashboard.session.ephemeral";
const LANGUAGE_STORAGE_KEY = "octop.dashboard.language";
const DEFAULT_API_BASE_URL =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
    ? "http://127.0.0.1:4000"
    : "https://octop.ilycode.app";
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");

const COLUMN_ORDER = [
  { id: "prep", accent: "slate", countClassName: "bg-slate-800 text-slate-300" },
  { id: "todo", accent: "slate", countClassName: "bg-slate-800 text-slate-300" },
  { id: "running", accent: "blue", countClassName: "bg-sky-500/10 text-sky-300" },
  { id: "review", accent: "violet", countClassName: "bg-violet-500/10 text-violet-300" },
  { id: "done", accent: "green", countClassName: "bg-emerald-500/10 text-emerald-300" }
];

const STATUS_META = {
  staged: {
    column: "prep",
    labelKey: "staged",
    chipClassName: "bg-slate-800 text-slate-300",
    dotClassName: "bg-slate-400"
  },
  queued: {
    column: "todo",
    labelKey: "queued",
    chipClassName: "bg-slate-800 text-slate-300",
    dotClassName: "bg-slate-400"
  },
  idle: {
    column: "todo",
    labelKey: "idle",
    chipClassName: "bg-slate-800 text-slate-300",
    dotClassName: "bg-slate-400"
  },
  awaiting_input: {
    column: "review",
    labelKey: "awaiting_input",
    chipClassName: "bg-amber-500/10 text-amber-300",
    dotClassName: "bg-amber-400"
  },
  running: {
    column: "running",
    labelKey: "running",
    chipClassName: "bg-sky-500/10 text-sky-300",
    dotClassName: "bg-sky-400"
  },
  failed: {
    column: "review",
    labelKey: "failed",
    chipClassName: "bg-rose-500/10 text-rose-300",
    dotClassName: "bg-rose-400"
  },
  completed: {
    column: "done",
    labelKey: "completed",
    chipClassName: "bg-emerald-500/10 text-emerald-300",
    dotClassName: "bg-emerald-400"
  }
};

const COPY = {
  en: {
    locale: "en-US",
    columns: {
      prep: "Prep",
      todo: "To Do",
      running: "In Progress",
      review: "Review",
      done: "Done"
    },
    status: {
      staged: "Prep",
      queued: "Queued",
      idle: "Idle",
      awaiting_input: "Need Input",
      running: "Running",
      failed: "Failed",
      completed: "Done"
    },
    fallback: {
      untitledIssue: "Untitled issue",
      noPrompt: "No prompt yet.",
      noProjects: "No projects yet.",
      noBridges: "No connected bridge.",
      bridgeUpdated: "Bridge state updated.",
      justNow: "just now",
      noSelection: "Select a project",
      noBridge: "No bridge"
    },
    alerts: {
      requestFailed: (status) => `Request failed. (${status})`,
      sseReconnect: "Realtime event stream is reconnecting."
    },
    login: {
      eyebrow: "OctOP Workspace",
      title: "Sign in",
      subtitle: "Use your LicenseHub login ID to open the project board.",
      loginId: "Login ID",
      loginIdPlaceholder: "Enter your account ID",
      password: "Password",
      passwordHint: "LicenseHub password",
      rememberDevice: "Keep me signed in on this device",
      submitting: "Signing in...",
      submit: "Sign in",
      helper: "After sign-in, your connected bridge, projects, and thread board sync automatically."
    },
    issueComposer: {
      eyebrow: "New Issue",
      title: "Create issue",
      subtitle: "Title is optional. If empty, the prompt opening line becomes the issue title.",
      issueTitle: "Issue title",
      optional: "optional",
      titlePlaceholder: "Auto-filled from the prompt if left blank",
      project: "Project",
      prompt: "Prompt",
      promptPlaceholder: "Describe the work to be completed.",
      cancel: "Cancel",
      submit: "Create issue",
      submitting: "Creating..."
    },
    projectComposer: {
      eyebrow: "New Project",
      title: "New Project",
      close: "Close",
      browserTitle: "Select Workspace",
      foldersLoading: "Loading folders",
      noRoots: "No browsable roots are available.",
      parentFolder: "Up",
      workspace: "Workspace",
      registered: "Added",
      selected: "Selected",
      noChildren: "No subfolders.",
      workspacePath: "Workspace Path",
      name: "Project name",
      namePlaceholder: "Auto-filled from the selected folder",
      description: "Project description",
      descriptionPlaceholder: "Describe the project scope briefly.",
      cancel: "Cancel",
      submit: "Create project",
      submitting: "Creating..."
    },
    detail: {
      eyebrow: "Issue History",
      emptyTitle: "Completed issue",
      close: "Close",
      loading: "Loading thread history.",
      empty: "No conversation history to display.",
      request: "Request",
      response: "Response"
    },
    board: {
      sidebarEyebrow: "Projects",
      projectsCount: (count) => `${count} projects`,
      addProject: "Add",
      noProjects: "No projects.",
      queuedCount: (count) => `Queued ${count}`,
      searchPlaceholder: "Search issues",
      refresh: "Refresh",
      newIssue: "New Issue",
      noBridgeOption: "No connected bridge",
      noProjectOption: "No project",
      issueCount: (count) => `${count} issues`,
      selectProject: "Select a project.",
      prepHint:
        "Select issues in Prep and move them to To Do. Items in To Do run sequentially, and you can reorder them by drag and drop.",
      syncing: "Syncing",
      updatedAt: (value) => `Updated ${value}`,
      emptyColumn: "No issues in this state.",
      moveSelectedToTodo: (count) => `Move to To Do${count > 0 ? ` (${count})` : ""}`,
      moving: "Moving...",
      bridge: "Bridge",
      project: "Project",
      drag: "Drag",
      prep: "Prep",
      queue: "Queue",
      delete: "Delete",
      logout: "Sign out",
      bridgeOk: "Bridge OK",
      bridgeDown: "Bridge Down",
      projectsChip: (count) => `Projects ${count}`,
      threadsChip: (count) => `Threads ${count}`,
      deleteProjectConfirm: "Delete this project? Its issues will be removed as well."
    },
    footer: {
      languageKorean: "한국어",
      languageEnglish: "영어"
    }
  },
  ko: {
    locale: "ko-KR",
    columns: {
      prep: "준비",
      todo: "할 일",
      running: "진행 중",
      review: "검토",
      done: "완료"
    },
    status: {
      staged: "준비",
      queued: "대기",
      idle: "대기",
      awaiting_input: "입력 필요",
      running: "진행 중",
      failed: "실패",
      completed: "완료"
    },
    fallback: {
      untitledIssue: "제목 없는 이슈",
      noPrompt: "프롬프트가 아직 없습니다.",
      noProjects: "프로젝트가 아직 없습니다.",
      noBridges: "연결된 브릿지가 없습니다.",
      bridgeUpdated: "브릿지 상태가 갱신되었습니다.",
      justNow: "방금 전",
      noSelection: "프로젝트를 선택해 주세요",
      noBridge: "브릿지 없음"
    },
    alerts: {
      requestFailed: (status) => `요청에 실패했습니다. (${status})`,
      sseReconnect: "실시간 이벤트 스트림이 재연결을 시도하고 있습니다."
    },
    login: {
      eyebrow: "OctOP Workspace",
      title: "로그인",
      subtitle: "LicenseHub 로그인 아이디로 프로젝트 보드를 엽니다.",
      loginId: "로그인 아이디",
      loginIdPlaceholder: "계정 아이디를 입력해 주세요",
      password: "비밀번호",
      passwordHint: "LicenseHub 비밀번호",
      rememberDevice: "이 기기에서 로그인 상태 유지",
      submitting: "로그인 중...",
      submit: "로그인",
      helper: "로그인 후 연결된 브릿지, 프로젝트, 스레드 보드가 자동으로 동기화됩니다."
    },
    issueComposer: {
      eyebrow: "새 이슈",
      title: "이슈 등록",
      subtitle: "제목은 선택 입력입니다. 비워두면 프롬프트 앞부분이 이슈 제목이 됩니다.",
      issueTitle: "이슈 제목",
      optional: "선택",
      titlePlaceholder: "비워두면 프롬프트 앞부분으로 자동 생성됩니다",
      project: "프로젝트",
      prompt: "프롬프트",
      promptPlaceholder: "수행할 작업을 구체적으로 입력해 주세요.",
      cancel: "취소",
      submit: "이슈 등록",
      submitting: "등록 중..."
    },
    projectComposer: {
      eyebrow: "새 프로젝트",
      title: "New Project",
      close: "닫기",
      browserTitle: "Select Workspace",
      foldersLoading: "폴더 불러오는 중",
      noRoots: "탐색 가능한 루트가 없습니다.",
      parentFolder: "상위",
      workspace: "워크스페이스",
      registered: "등록됨",
      selected: "선택됨",
      noChildren: "하위 폴더가 없습니다.",
      workspacePath: "워크스페이스 경로",
      name: "프로젝트 이름",
      namePlaceholder: "선택한 폴더명으로 자동 입력됩니다",
      description: "프로젝트 설명",
      descriptionPlaceholder: "프로젝트 목적과 관리 범위를 간단히 적어 주세요.",
      cancel: "취소",
      submit: "프로젝트 등록",
      submitting: "등록 중..."
    },
    detail: {
      eyebrow: "이슈 기록",
      emptyTitle: "완료된 이슈",
      close: "닫기",
      loading: "작업 기록을 불러오는 중입니다.",
      empty: "표시할 대화 기록이 없습니다.",
      request: "요청",
      response: "응답"
    },
    board: {
      sidebarEyebrow: "프로젝트",
      projectsCount: (count) => `${count}개 프로젝트`,
      addProject: "추가",
      noProjects: "프로젝트가 없습니다.",
      queuedCount: (count) => `대기 ${count}`,
      searchPlaceholder: "이슈 검색",
      refresh: "새로고침",
      newIssue: "새 이슈",
      noBridgeOption: "연결된 브릿지 없음",
      noProjectOption: "프로젝트 없음",
      issueCount: (count) => `${count}개 이슈`,
      selectProject: "프로젝트를 선택해 주세요.",
      prepHint:
        "준비 컬럼에서 이슈를 선택해 할 일로 옮기면 순차 진행됩니다. 할 일 컬럼에서는 드래그로 순서를 조정할 수 있습니다.",
      syncing: "동기화 중",
      updatedAt: (value) => `마지막 갱신 ${value}`,
      emptyColumn: "해당 상태의 이슈가 없습니다.",
      moveSelectedToTodo: (count) => `선택 항목 할 일로 이동${count > 0 ? ` (${count})` : ""}`,
      moving: "이동 중...",
      bridge: "브릿지",
      project: "프로젝트",
      drag: "드래그",
      prep: "준비",
      queue: "대기열",
      delete: "삭제",
      logout: "로그아웃",
      bridgeOk: "브릿지 연결",
      bridgeDown: "브릿지 끊김",
      projectsChip: (count) => `프로젝트 ${count}`,
      threadsChip: (count) => `이슈 ${count}`,
      deleteProjectConfirm: "프로젝트를 삭제하시겠습니까? 해당 프로젝트의 이슈도 함께 제거됩니다."
    },
    footer: {
      languageKorean: "한국어",
      languageEnglish: "영어"
    }
  }
};

function readStoredLanguage() {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return stored === "ko" || stored === "en" ? stored : "en";
  } catch {
    return "en";
  }
}

function storeLanguage(language) {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // ignore storage errors
  }
}

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

function getCopy(language) {
  return COPY[language] ?? COPY.en;
}

function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `octop-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatDateTime(value, language) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return new Intl.DateTimeFormat(getCopy(language).locale, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function formatRelativeTime(value, language) {
  const copy = getCopy(language);

  if (!value) {
    return copy.fallback.justNow;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return copy.fallback.justNow;
  }

  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(copy.locale, { numeric: "auto" });
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

function shortenPath(value) {
  if (!value) {
    return "-";
  }

  const normalized = String(value);

  if (normalized.length <= 48) {
    return normalized;
  }

  return `...${normalized.slice(-45)}`;
}

function OverflowRevealText({ value, className = "", mono = false, truncateAt = "end" }) {
  const text = value ? String(value) : "-";
  return (
    <span
      className={`overflow-reveal overflow-reveal--${truncateAt} ${className}`.trim()}
      title={text}
    >
      <span className={`overflow-reveal__track ${mono ? "font-mono" : ""}`.trim()}>
        {text}
      </span>
    </span>
  );
}

function getPathLabel(value) {
  if (!value) {
    return "";
  }

  const normalized = String(value).replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments.at(-1) ?? normalized;
}

function getRelativeWorkspacePath(value, roots) {
  if (!value) {
    return "-";
  }

  const normalized = String(value).replace(/\\/g, "/").replace(/\/+$/, "");
  const matchedRoot = roots.find((root) => {
    const rootPath = String(root.path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    return normalized === rootPath || normalized.startsWith(`${rootPath}/`);
  });

  if (!matchedRoot?.path) {
    return getPathLabel(normalized) || "-";
  }

  const rootPath = String(matchedRoot.path).replace(/\\/g, "/").replace(/\/+$/, "");
  const relative = normalized.slice(rootPath.length).replace(/^\/+/, "");

  return relative ? `${matchedRoot.name}/${relative}` : matchedRoot.name;
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
      getCopy("en").alerts.requestFailed(response.status);
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
    title: thread.title ?? thread.name ?? "",
    project_id: thread.project_id ?? fallbackProjectId,
    status: thread.status ?? "queued",
    progress: clampProgress(thread.progress),
    last_event: thread.last_event ?? "thread.started",
    last_message: thread.last_message ?? "",
    created_at: thread.created_at ?? new Date().toISOString(),
    updated_at: thread.updated_at ?? thread.created_at ?? new Date().toISOString(),
    source: thread.source ?? "appServer",
    turn_id: thread.turn_id ?? null,
    prompt: thread.prompt ?? "",
    queue_position: Number.isFinite(Number(thread.queue_position)) ? Number(thread.queue_position) : null
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

function reorderIds(items, draggedId, targetId) {
  if (!draggedId || !targetId || draggedId === targetId) {
    return items;
  }

  const next = [...items];
  const fromIndex = next.indexOf(draggedId);
  const targetIndex = next.indexOf(targetId);

  if (fromIndex === -1 || targetIndex === -1) {
    return items;
  }

  const [moved] = next.splice(fromIndex, 1);
  next.splice(targetIndex, 0, moved);
  return next;
}

function buildMessagePreview(thread, language) {
  const copy = getCopy(language);
  const prompt = String(thread.prompt ?? "").trim();
  const lastMessage = String(thread.last_message ?? "").trim();
  return lastMessage || prompt || copy.fallback.noPrompt;
}

function getThreadTitle(thread, language) {
  return String(thread?.title ?? "").trim() || getCopy(language).fallback.untitledIssue;
}

function summarizeProjects(projects, language) {
  const copy = getCopy(language);
  if (projects.length === 0) {
    return copy.fallback.noProjects;
  }

  if (projects.length === 1) {
    return `${projects[0].name} · ${copy.board.projectsCount(1)}`;
  }

  return `${projects[0].name} +${projects.length - 1}`;
}

function summarizeBridges(bridges, language) {
  const copy = getCopy(language);
  if (bridges.length === 0) {
    return copy.fallback.noBridges;
  }

  if (bridges.length === 1) {
    return `${bridges[0].device_name ?? bridges[0].bridge_id}`;
  }

  return `${bridges[0].device_name ?? bridges[0].bridge_id} +${bridges.length - 1}`;
}

function summarizeEvent(event, language) {
  const copy = getCopy(language);
  return (
    event?.summary ??
    event?.payload?.thread?.title ??
    event?.payload?.error ??
    event?.payload?.projects?.[0]?.name ??
    event?.payload?.threads?.[0]?.title ??
    event?.type ??
    copy.fallback.bridgeUpdated
  );
}

function LoginPage({ language, initialLoginId, loading, error, onSubmit }) {
  const copy = getCopy(language);
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
        <div className="absolute left-[-6%] top-[-8%] h-[22rem] w-[22rem] rounded-full bg-sky-500/8 blur-[140px]" />
        <div className="absolute bottom-[-14%] right-[-10%] h-[26rem] w-[26rem] rounded-full bg-emerald-500/8 blur-[160px]" />
      </div>

      <div className="mx-auto flex min-h-screen max-w-5xl items-center justify-center px-4 py-10 lg:px-8">
        <main className="w-full max-w-md">
          <header className="mb-10 text-center">
            <div className="inline-flex h-14 w-14 items-center justify-center rounded-3xl border border-white/10 bg-slate-950/70">
              <svg className="h-8 w-8 text-sky-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M13 10V3L4 14h7v7l9-11h-7z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
            </div>
            <p className="mt-6 text-[11px] uppercase tracking-[0.34em] text-slate-500">{copy.login.eyebrow}</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">{copy.login.title}</h1>
            <p className="mt-3 text-sm leading-6 text-slate-400">{copy.login.subtitle}</p>
          </header>

          <section className="rounded-[28px] border border-white/8 bg-slate-950/72 p-8 shadow-2xl shadow-slate-950/30 backdrop-blur">
            <form className="space-y-6" onSubmit={handleSubmit}>
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="loginId">
                  {copy.login.loginId}
                </label>
                <input
                  id="loginId"
                  name="loginId"
                  type="text"
                  autoComplete="username"
                  required
                  placeholder={copy.login.loginIdPlaceholder}
                  value={loginId}
                  onChange={(event) => setLoginId(event.target.value)}
                  className="w-full rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-white outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/30"
                />
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label className="block text-sm font-medium text-slate-300" htmlFor="password">
                    {copy.login.password}
                  </label>
                  <span className="text-xs text-slate-500">{copy.login.passwordHint}</span>
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
                  className="w-full rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-white outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/30"
                />
              </div>

              <label className="flex items-center gap-3 text-sm text-slate-400">
                <input
                  id="remember-device"
                  name="remember-device"
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-700 bg-slate-950 text-sky-400 focus:ring-sky-400"
                  checked={rememberDevice}
                  onChange={(event) => setRememberDevice(event.target.checked)}
                />
                {copy.login.rememberDevice}
              </label>

              {error ? (
                <div className="rounded-2xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                  {error}
                </div>
              ) : null}

              <button
                type="submit"
                disabled={loading}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-sky-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? (
                  <>
                    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-950/25 border-t-slate-950" />
                    {copy.login.submitting}
                  </>
                ) : (
                  copy.login.submit
                )}
              </button>
            </form>

            <div className="mt-6 border-t border-slate-800 pt-4 text-xs leading-6 text-slate-500">
              {copy.login.helper}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

function IssueComposer({ language, open, busy, projects, selectedProjectId, onClose, onSubmit }) {
  const copy = getCopy(language);
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

    if (!prompt.trim() || !projectId) {
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
            <p className="text-xs uppercase tracking-[0.28em] text-slate-500">{copy.issueComposer.eyebrow}</p>
            <h2 className="mt-2 text-2xl font-semibold text-white">{copy.issueComposer.title}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">{copy.issueComposer.subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-800 bg-slate-900/80 px-3 py-1.5 text-sm text-slate-300 transition hover:border-slate-700 hover:text-white"
          >
            {copy.projectComposer.close}
          </button>
        </div>

        <form className="mt-6 space-y-5" onSubmit={handleSubmit}>
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="issue-title">
              {copy.issueComposer.issueTitle} <span className="text-slate-500">({copy.issueComposer.optional})</span>
            </label>
            <input
              id="issue-title"
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={copy.issueComposer.titlePlaceholder}
              className="w-full rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-white outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/30"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="issue-project">
              {copy.issueComposer.project}
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
              {copy.issueComposer.prompt}
            </label>
            <textarea
              id="issue-prompt"
              rows="5"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={copy.issueComposer.promptPlaceholder}
              className="w-full rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-white outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/30"
            />
          </div>

          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-2xl border border-slate-800 px-4 py-3 text-sm font-medium text-slate-300 transition hover:border-slate-700 hover:text-white"
            >
              {copy.issueComposer.cancel}
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-2xl bg-emerald-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? copy.issueComposer.submitting : copy.issueComposer.submit}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ProjectComposer({
  language,
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
  const copy = getCopy(language);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [treeState, setTreeState] = useState({});
  const [expandedPaths, setExpandedPaths] = useState({});

  useEffect(() => {
    if (!open) {
      setName("");
      setDescription("");
      setTreeState({});
      setExpandedPaths({});
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    if (folderState?.path) {
      setTreeState((current) => ({
        ...current,
        [folderState.path]: {
          parent_path: folderState.parent_path ?? null,
          entries: folderState.entries ?? []
        }
      }));
      setExpandedPaths((current) => ({
        ...current,
        [folderState.path]: true
      }));
    }
  }, [open, folderState]);

  useEffect(() => {
    if (!open || !selectedWorkspacePath) {
      return;
    }

    if (!name.trim()) {
      setName(getPathLabel(selectedWorkspacePath));
    }
  }, [open, selectedWorkspacePath]);

  if (!open) {
    return null;
  }

  const loadBranch = async (path) => {
    const payload = await onBrowseFolder(path);

    if (!payload) {
      return null;
    }

    setTreeState((current) => ({
      ...current,
      [path]: {
        parent_path: payload.parent_path ?? null,
        entries: payload.entries ?? []
      }
    }));

    return payload;
  };

  const togglePath = async (path) => {
    const nextExpanded = !expandedPaths[path];

    setExpandedPaths((current) => ({
      ...current,
      [path]: nextExpanded
    }));

    if (nextExpanded && !treeState[path]) {
      await loadBranch(path);
    }
  };

  const handleSelectPath = (path) => {
    onSelectWorkspace(path);
    setName(getPathLabel(path));
  };

  const renderTreeNode = (entry, depth = 0) => {
    const branch = treeState[entry.path];
    const expanded = Boolean(expandedPaths[entry.path]);
    const selected = selectedWorkspacePath === entry.path;
    const hasLoadedChildren = Boolean(branch);
    const children = branch?.entries ?? [];

    return (
      <div key={entry.path} className="space-y-1">
        <div
          className={`group flex min-h-[3.25rem] cursor-pointer items-stretch gap-2 rounded-2xl border px-3 py-2.5 transition ${
            selected
              ? "border-sky-400/40 bg-sky-500/10"
              : "border-slate-800/80 bg-slate-900/30 hover:border-slate-700"
          }`}
          style={{ marginLeft: `${depth * 12}px` }}
          onClick={() => handleSelectPath(entry.path)}
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void togglePath(entry.path);
            }}
            className="flex h-7 w-7 items-center justify-center rounded-xl border border-slate-800 bg-slate-950/70 text-slate-400 transition hover:border-slate-700 hover:text-white"
            aria-label={expanded ? copy.projectComposer.parentFolder : copy.projectComposer.browserTitle}
          >
            <svg
              className={`h-3.5 w-3.5 transition ${expanded ? "rotate-90" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
            </svg>
          </button>

          <div className="flex min-w-0 flex-1 items-center text-left">
            <div className="flex items-center gap-2">
              <svg className="h-4 w-4 shrink-0 text-sky-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M3 7h5l2 2h11v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
              </svg>
              <OverflowRevealText value={entry.name} className="text-sm font-medium text-white" />
            </div>
          </div>

          <div className="pointer-events-none flex shrink-0 flex-wrap items-center gap-1">
            {entry.is_workspace ? (
              <span className="rounded-full bg-sky-500/10 px-2 py-1 text-[10px] text-sky-300">{copy.projectComposer.workspace}</span>
            ) : null}
            {entry.is_registered ? (
              <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300">{copy.projectComposer.registered}</span>
            ) : null}
            {selected ? (
              <span className="rounded-full bg-white/10 px-2 py-1 text-[10px] text-white">{copy.projectComposer.selected}</span>
            ) : null}
          </div>
        </div>

        {expanded && hasLoadedChildren ? (
          children.length === 0 ? (
            <div
              className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/20 px-3 py-3 text-[11px] text-slate-500"
              style={{ marginLeft: `${(depth + 1) * 12 + 36}px` }}
            >
              {copy.projectComposer.noChildren}
            </div>
          ) : (
            <div className="space-y-1">
              {children.map((child) => renderTreeNode(child, depth + 1))}
            </div>
          )
        ) : null}
      </div>
    );
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!name.trim() || !selectedWorkspacePath) {
      return;
    }

    await onSubmit({
      name: name.trim(),
      key: "",
      description: description.trim(),
      workspace_path: selectedWorkspacePath
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 backdrop-blur-sm">
      <div className="w-full max-w-5xl rounded-[24px] border border-slate-800 bg-slate-950/98 p-5 shadow-2xl shadow-slate-950/60">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="mt-2 text-xl font-semibold text-white">{copy.projectComposer.title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-800 px-3 py-1.5 text-sm text-slate-300 transition hover:border-slate-700 hover:text-white"
          >
            {copy.projectComposer.close}
          </button>
        </div>

        <form className="mt-5 grid gap-0 xl:min-h-[34rem] xl:grid-cols-2" onSubmit={handleSubmit}>
          <div className="min-w-0 border-b border-slate-800 pb-4 xl:h-[34rem] xl:border-b-0 xl:border-r xl:pb-0 xl:pr-5">
            <div className="flex items-center justify-between gap-3 pb-3">
              <div>
                <p className="mt-2 text-sm font-medium text-white">{copy.projectComposer.browserTitle}</p>
              </div>
              <div className="flex items-center gap-2">
                {folderLoading ? (
                  <span className="text-[11px] text-slate-500">{copy.projectComposer.foldersLoading}</span>
                ) : null}
              </div>
            </div>

            <div className="custom-scrollbar h-[34rem] space-y-1 overflow-y-auto pr-1">
              {roots.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-800 px-3 py-4 text-xs text-slate-500">
                  {copy.projectComposer.noRoots}
                </div>
              ) : (
                roots.map((root) =>
                  renderTreeNode({
                    name: root.name,
                    path: root.path,
                    is_workspace: root.is_workspace,
                    is_registered: root.is_registered,
                    project_id: root.project_id
                  })
                )
              )}
            </div>
          </div>

          <div className="min-w-0 pt-4 xl:h-[34rem] xl:pl-5 xl:pt-0">
            <div className="flex h-full min-w-0 flex-col justify-between gap-4">
              <div className="grid min-w-0 gap-4">
              <div className="min-w-0">
                <p className="mb-2 block text-[11px] font-medium uppercase tracking-[0.22em] text-slate-500">
                  {copy.projectComposer.workspacePath}
                </p>
                <OverflowRevealText
                  value={getRelativeWorkspacePath(selectedWorkspacePath, roots)}
                  className="rounded-xl border border-slate-800 bg-slate-900 px-3.5 py-2.5 text-sm text-slate-300"
                  mono
                  truncateAt="end"
                />
              </div>

              <div className="min-w-0">
                <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="project-name">
                  {copy.projectComposer.name}
                </label>
                <input
                  id="project-name"
                  type="text"
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={copy.projectComposer.namePlaceholder}
                  className="w-full min-w-0 rounded-xl border border-slate-800 bg-slate-900 px-3.5 py-2.5 text-white outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/30"
                />
              </div>

              <div className="min-w-0">
                <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="project-description">
                  {copy.projectComposer.description}
                </label>
                <textarea
                  id="project-description"
                  rows="6"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={copy.projectComposer.descriptionPlaceholder}
                  className="w-full min-w-0 rounded-xl border border-slate-800 bg-slate-900 px-3.5 py-2.5 text-white outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/30"
                />
              </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-xl border border-slate-800 px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:border-slate-700 hover:text-white"
                >
                  {copy.projectComposer.cancel}
                </button>
                <button
                  type="submit"
                  disabled={busy || !selectedWorkspacePath}
                  className="rounded-xl bg-sky-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy ? copy.projectComposer.submitting : copy.projectComposer.submit}
                </button>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

function ThreadDetailModal({ language, open, loading, thread, messages, onClose }) {
  const copy = getCopy(language);
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 backdrop-blur-sm">
      <div className="flex h-[min(80vh,760px)] w-full max-w-3xl flex-col overflow-hidden rounded-[28px] border border-slate-800 bg-slate-950 shadow-2xl shadow-slate-950/60">
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.28em] text-slate-500">{copy.detail.eyebrow}</p>
            <h2 className="mt-2 truncate text-lg font-semibold text-white">
              {thread ? getThreadTitle(thread, language) : copy.detail.emptyTitle}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-800 px-3 py-1.5 text-sm text-slate-300 transition hover:border-slate-700 hover:text-white"
          >
            {copy.detail.close}
          </button>
        </div>

        <div className="custom-scrollbar flex-1 overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-900/50 px-4 py-6 text-sm text-slate-400">
              {copy.detail.loading}
            </div>
          ) : messages.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 px-4 py-6 text-sm text-slate-500">
              {copy.detail.empty}
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((message) => {
                const userMessage = message.role === "user";

                return (
                  <div key={message.id} className={`flex ${userMessage ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[85%] rounded-3xl px-4 py-3 ${
                        userMessage
                          ? "bg-sky-500 text-slate-950"
                          : "border border-slate-800 bg-slate-900 text-slate-100"
                      }`}
                    >
                      <div className="mb-2 flex items-center gap-2 text-[11px]">
                        <span className={`font-semibold ${userMessage ? "text-slate-950/80" : "text-slate-400"}`}>
                          {userMessage ? copy.detail.request : copy.detail.response}
                        </span>
                        <span className={userMessage ? "text-slate-950/60" : "text-slate-500"}>
                          {formatDateTime(message.timestamp, language)}
                        </span>
                      </div>
                      <p className="whitespace-pre-wrap break-words text-sm leading-6">{message.content}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PrepThreadCard({
  language,
  thread,
  selected,
  active,
  onSelect,
  onToggle,
  onDelete
}) {
  const copy = getCopy(language);
  return (
    <div
      className={`rounded-xl border px-3.5 py-3 transition ${
        active ? "border-sky-400/35 bg-slate-800/95" : "border-slate-800 bg-slate-800/85 hover:border-slate-700"
      }`}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(thread.id)}
          className="mt-0.5 h-4 w-4 rounded border-slate-700 bg-slate-950 text-sky-400 focus:ring-sky-400"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <button type="button" onClick={() => onSelect(thread.id)} className="min-w-0 flex-1 text-left">
              <OverflowRevealText value={getThreadTitle(thread, language)} className="text-sm font-medium text-slate-100" />
              <OverflowRevealText value={buildMessagePreview(thread, language)} className="mt-1 text-xs text-slate-500" />
            </button>
            <button
              type="button"
              onClick={() => onDelete(thread.id)}
              className="rounded-md border border-slate-700 px-1.5 py-1 text-[10px] text-slate-400 transition hover:border-rose-400/40 hover:text-rose-300"
            >
              {copy.board.delete}
            </button>
          </div>

          <div className="mt-2 flex items-center gap-2 text-[10px] text-slate-500">
            <span>{formatRelativeTime(thread.updated_at, language)}</span>
            <span className="text-slate-700">•</span>
            <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[10px] text-slate-400">{copy.board.prep}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function TodoThreadCard({
  language,
  thread,
  active,
  onSelect,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop
}) {
  const copy = getCopy(language);
  return (
    <div
      draggable
      onDragStart={() => onDragStart(thread.id)}
      onDragOver={(event) => {
        event.preventDefault();
        onDragOver(thread.id);
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop(thread.id);
      }}
      className={`rounded-xl border px-3.5 py-3 transition ${
        active ? "border-sky-400/35 bg-slate-800/95" : "border-slate-800 bg-slate-800/85 hover:border-slate-700"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <button type="button" onClick={() => onSelect(thread.id)} className="min-w-0 flex-1 text-left">
          <OverflowRevealText value={getThreadTitle(thread, language)} className="text-sm font-medium text-slate-100" />
          <OverflowRevealText value={buildMessagePreview(thread, language)} className="mt-1 text-xs text-slate-500" />
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => onDelete(thread.id)}
            className="rounded-md border border-slate-700 px-1.5 py-1 text-[10px] text-slate-400 transition hover:border-rose-400/40 hover:text-rose-300"
          >
            {copy.board.delete}
          </button>
          {thread.queue_position ? (
            <span className="rounded-full bg-sky-500/10 px-2 py-1 text-[10px] font-semibold text-sky-300">
              #{thread.queue_position}
            </span>
          ) : null}
          <span className="cursor-grab rounded-md border border-slate-700 px-1.5 py-1 text-[10px] text-slate-400">
            {copy.board.drag}
          </span>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2 text-[10px] text-slate-500">
        <span>{formatRelativeTime(thread.updated_at, language)}</span>
        <span className="text-slate-700">•</span>
        <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[10px] text-slate-400">{copy.board.queue}</span>
      </div>
    </div>
  );
}

function getColumnAccentClassName(columnId) {
  switch (columnId) {
    case "prep":
    case "todo":
      return "text-slate-400";
    case "running":
      return "text-sky-400";
    case "review":
      return "text-violet-400";
    case "done":
      return "text-emerald-400";
    default:
      return "text-slate-400";
  }
}

function getColumnDotClassName(columnId) {
  switch (columnId) {
    case "prep":
    case "todo":
      return "bg-slate-400";
    case "running":
      return "bg-sky-400";
    case "review":
      return "bg-violet-400";
    case "done":
      return "bg-emerald-400";
    default:
      return "bg-slate-400";
  }
}

function ThreadCard({ language, thread, selected, onSelect }) {
  const copy = getCopy(language);
  const status = getStatusMeta(thread.status);

  return (
    <button
      type="button"
      onClick={() => onSelect(thread.id)}
      className={`w-full rounded-xl border px-3.5 py-3 text-left transition ${
        selected ? "border-sky-400/35 bg-slate-800/95" : "border-slate-800 bg-slate-800/85 hover:border-slate-700"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className={`inline-flex items-center gap-2 rounded-full px-2 py-1 text-[11px] ${status.chipClassName}`}>
          <span className={`h-2 w-2 rounded-full ${status.dotClassName}`} />
          {copy.status[status.labelKey] ?? copy.status.queued}
        </span>
        <span className="text-[11px] text-slate-500">{thread.progress}%</span>
      </div>
      <OverflowRevealText value={getThreadTitle(thread, language)} className="mt-3 text-sm font-medium text-slate-100" />
      <OverflowRevealText value={buildMessagePreview(thread, language)} className="mt-1 text-xs text-slate-500" />
      <div className="mt-3 h-1 rounded-full bg-slate-900">
        <div
          className="h-1 rounded-full bg-gradient-to-r from-sky-400 to-violet-400"
          style={{ width: `${thread.progress}%` }}
        />
      </div>
      <div className="mt-2 flex items-center gap-2 text-[10px] text-slate-500">
        <span>{formatRelativeTime(thread.updated_at, language)}</span>
        <span className="text-slate-700">•</span>
        <span className="font-mono">{thread.id.slice(0, 8)}</span>
      </div>
    </button>
  );
}

function CompletedThreadCard({ language, thread, selected, onSelect, onOpen }) {
  const copy = getCopy(language);
  return (
    <button
      type="button"
      onClick={() => onSelect(thread.id)}
      onDoubleClick={() => onOpen(thread.id)}
      className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
        selected ? "border-emerald-400/35 bg-slate-800/95" : "border-slate-800 bg-slate-900/65 hover:border-slate-700"
      }`}
    >
      <div className="flex items-center gap-3">
        <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
        <OverflowRevealText value={getThreadTitle(thread, language)} className="min-w-0 flex-1 text-sm font-medium text-slate-200" />
        <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300">{copy.status.completed}</span>
        <span className="shrink-0 text-[10px] text-slate-500">{formatRelativeTime(thread.updated_at, language)}</span>
      </div>
    </button>
  );
}

function MainPage({
  language,
  onChangeLanguage,
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
  selectedThreadIds,
  queueOrderIds,
  detailState,
  search,
  loadingState,
  projectBusy,
  issueBusy,
  startBusy,
  projectComposerOpen,
  composerOpen,
  onSearchChange,
  onSelectBridge,
  onSelectProject,
  onSelectThread,
  onToggleThreadSelection,
  onStartSelectedThreads,
  onOpenCompletedThread,
  onDeleteThread,
  onDeleteProject,
  onRenameProject,
  onDragQueueThread,
  onOpenProjectComposer,
  onOpenComposer,
  onCloseProjectComposer,
  onCloseComposer,
  onBrowseWorkspaceRoot,
  onBrowseFolder,
  onSelectWorkspace,
  onSubmitProject,
  onSubmitIssue,
  onRefresh,
  onLogout,
  onCloseDetail
}) {
  const copy = getCopy(language);
  const [editingProjectId, setEditingProjectId] = useState("");
  const [editingProjectName, setEditingProjectName] = useState("");
  const selectedBridge =
    bridges.find((bridge) => bridge.bridge_id === selectedBridgeId) ?? bridges[0] ?? null;
  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? null;
  const projectScopedThreads = threads.filter((thread) => !selectedProjectId || thread.project_id === selectedProjectId);
  const keyword = search.trim().toLowerCase();
  const filteredThreads = projectScopedThreads.filter((thread) => {
    return (
      !keyword ||
      thread.title.toLowerCase().includes(keyword) ||
      String(thread.prompt ?? "").toLowerCase().includes(keyword) ||
      String(thread.last_message ?? "").toLowerCase().includes(keyword)
    );
  });
  const selectedThread =
    filteredThreads.find((thread) => thread.id === selectedThreadId) ??
    projectScopedThreads.find((thread) => thread.id === selectedThreadId) ??
    null;

  const columns = COLUMN_ORDER.map((column) => {
    const columnThreads = filteredThreads.filter((thread) => getStatusMeta(thread.status).column === column.id);

    if (column.id === "todo") {
      const orderedIds = queueOrderIds.filter((threadId) => columnThreads.some((thread) => thread.id === threadId));
      const trailingIds = columnThreads
        .map((thread) => thread.id)
        .filter((threadId) => !orderedIds.includes(threadId));

      return {
        ...column,
        threads: [...orderedIds, ...trailingIds]
          .map((threadId) => columnThreads.find((thread) => thread.id === threadId))
          .filter(Boolean)
      };
    }

    return {
      ...column,
      threads: [...columnThreads].sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
    };
  });
  const prepSelectedCount = filteredThreads.filter(
    (thread) => selectedThreadIds.includes(thread.id) && getStatusMeta(thread.status).column === "prep"
  ).length;

  const beginProjectRename = (project) => {
    setEditingProjectId(project.id);
    setEditingProjectName(project.name);
  };

  const cancelProjectRename = () => {
    setEditingProjectId("");
    setEditingProjectName("");
  };

  const submitProjectRename = async (project) => {
    const nextName = editingProjectName.trim();

    if (!nextName || nextName === project.name) {
      cancelProjectRename();
      return;
    }

    const accepted = await onRenameProject(project.id, nextName);

    if (accepted) {
      cancelProjectRename();
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <div className="flex min-h-screen flex-col">
        <div className="flex flex-1 overflow-hidden">
          <aside className="hidden w-64 shrink-0 border-r border-slate-800 bg-[#0f172a] md:flex md:flex-col">
            <div className="flex items-center space-x-3 px-6 py-6">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-violet-500">
                <svg className="h-5 w-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M13 10V3L4 14h7v7l9-11h-7z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                </svg>
              </div>
              <span className="text-xl font-bold tracking-tight text-white">OctOP</span>
            </div>

            <div className="mt-4 flex-1 px-4">
              <div className="mb-4 flex items-center justify-between px-3">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">{copy.board.sidebarEyebrow}</p>
                  <p className="mt-2 text-sm font-medium text-white">{copy.board.projectsCount(projects.length)}</p>
                </div>
                <button
                  type="button"
                  onClick={onOpenProjectComposer}
                  disabled={!selectedBridge}
                  className="rounded-md border border-slate-800 px-2 py-1 text-[10px] text-slate-300 transition hover:border-slate-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {copy.board.addProject}
                </button>
              </div>

              <div className="custom-scrollbar max-h-[calc(100vh-15rem)] space-y-1 overflow-y-auto px-2">
                {projects.length === 0 ? (
                  <div className="rounded-md px-3 py-3 text-xs text-slate-500">{copy.board.noProjects}</div>
                ) : (
                  projects.map((project) => {
                    const active = project.id === selectedProjectId;
                    const projectThreads = threads.filter((thread) => thread.project_id === project.id);
                    const queuedCount = projectThreads.filter(
                      (thread) => getStatusMeta(thread.status).column === "todo"
                    ).length;

                    return (
                      <div
                        key={project.id}
                        className={`w-full rounded-md px-3 py-3 transition ${
                          active ? "bg-slate-800 text-white" : "text-slate-400 hover:bg-slate-800 hover:text-white"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          {editingProjectId === project.id ? (
                            <input
                              type="text"
                              autoFocus
                              value={editingProjectName}
                              onChange={(event) => setEditingProjectName(event.target.value)}
                              onBlur={() => void submitProjectRename(project)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void submitProjectRename(project);
                                }

                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  cancelProjectRename();
                                }
                              }}
                              className="min-w-0 flex-1 rounded-md border border-sky-400/40 bg-slate-900 px-2 py-1 text-sm font-medium text-white outline-none ring-1 ring-sky-400/20"
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => onSelectProject(project.id)}
                              onDoubleClick={() => beginProjectRename(project)}
                              className="min-w-0 flex-1 text-left"
                            >
                              <OverflowRevealText value={project.name} className="text-sm font-medium" />
                            </button>
                          )}
                          <div className="flex items-center gap-2">
                            <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[10px] text-slate-500">
                              {projectThreads.length}
                            </span>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                onDeleteProject(project.id);
                              }}
                              className="rounded-md border border-slate-800 px-1.5 py-1 text-[10px] text-slate-500 transition hover:border-rose-400/40 hover:text-rose-300"
                            >
                              {copy.board.delete}
                            </button>
                          </div>
                        </div>
                        <div className="mt-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-slate-500">
                          <span>{project.key}</span>
                          <span className="text-slate-700">•</span>
                          <span>{copy.board.queuedCount(queuedCount)}</span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </aside>

          <main className="flex min-h-screen min-w-0 flex-1 flex-col pb-14">
            <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-slate-800 bg-[#0f172a]/80 px-4 backdrop-blur-md md:px-8">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-slate-500">{copy.board.project}</span>
                  <span className="text-slate-700">/</span>
                  <OverflowRevealText value={selectedProject?.name ?? copy.fallback.noSelection} className="font-medium text-white" />
                </div>
                <OverflowRevealText
                  value={selectedBridge?.device_name ?? selectedBridge?.bridge_id ?? copy.fallback.noBridge}
                  className="mt-1 text-[11px] text-slate-500"
                />
              </div>

              <div className="flex items-center space-x-3">
                <div className="relative hidden sm:block">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    <svg className="h-4 w-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                    </svg>
                  </div>
                  <input
                    type="text"
                    value={search}
                    onChange={(event) => onSearchChange(event.target.value)}
                    placeholder={copy.board.searchPlaceholder}
                    className="w-64 rounded-lg border-transparent bg-slate-800 py-2 pl-10 pr-4 text-sm text-slate-300 outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
                  />
                </div>

                <select
                  value={selectedBridgeId}
                  onChange={(event) => onSelectBridge(event.target.value)}
                  className="hidden rounded-lg border-transparent bg-slate-800 px-3 py-2 text-sm text-slate-200 outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400 md:block"
                >
                  {bridges.length === 0 ? (
                    <option value="">{copy.board.noBridgeOption}</option>
                  ) : (
                    bridges.map((bridge) => (
                      <option key={bridge.bridge_id} value={bridge.bridge_id}>
                        {bridge.device_name ?? bridge.bridge_id}
                      </option>
                    ))
                  )}
                </select>

                <button
                  type="button"
                  onClick={onRefresh}
                  className="hidden rounded-lg border border-slate-800 px-3 py-2 text-sm font-medium text-slate-300 transition hover:border-slate-700 hover:text-white md:inline-flex"
                >
                  {copy.board.refresh}
                </button>

                <button
                  type="button"
                  onClick={onStartSelectedThreads}
                  disabled={prepSelectedCount === 0 || startBusy}
                  className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-300 transition hover:border-emerald-400/40 hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {startBusy ? copy.board.moving : copy.board.moveSelectedToTodo(prepSelectedCount)}
                </button>

                <button
                  type="button"
                  onClick={onOpenComposer}
                  disabled={projects.length === 0}
                  className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-sky-500/20 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {copy.board.newIssue}
                </button>
              </div>
            </header>

            <div className="border-b border-slate-800 px-4 py-3 md:hidden">
              <div className="grid gap-3">
                <label className="block">
                  <span className="mb-2 block text-[11px] uppercase tracking-[0.24em] text-slate-500">{copy.board.bridge}</span>
                  <select
                    value={selectedBridgeId}
                    onChange={(event) => onSelectBridge(event.target.value)}
                    className="w-full rounded-lg border-transparent bg-slate-800 px-3 py-2 text-sm text-slate-200 outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
                  >
                    {bridges.length === 0 ? (
                      <option value="">{copy.board.noBridgeOption}</option>
                    ) : (
                      bridges.map((bridge) => (
                        <option key={bridge.bridge_id} value={bridge.bridge_id}>
                          {bridge.device_name ?? bridge.bridge_id}
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-2 block text-[11px] uppercase tracking-[0.24em] text-slate-500">{copy.board.project}</span>
                  <select
                    value={selectedProjectId}
                    onChange={(event) => onSelectProject(event.target.value)}
                    className="w-full rounded-lg border-transparent bg-slate-800 px-3 py-2 text-sm text-slate-200 outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
                  >
                    {projects.length === 0 ? (
                      <option value="">{copy.board.noProjectOption}</option>
                    ) : (
                      projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))
                    )}
                  </select>
                </label>
              </div>
            </div>

            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3 text-xs text-slate-500 md:px-8">
              <div className="flex items-center gap-3">
                <span>{selectedProject ? copy.board.issueCount(projectScopedThreads.length) : copy.board.selectProject}</span>
                <span className="text-slate-700">•</span>
                <span>{copy.board.prepHint}</span>
              </div>
              <div className="hidden items-center gap-2 md:flex">
                <span>{loadingState === "loading" ? copy.board.syncing : copy.board.updatedAt(formatRelativeTime(status.updated_at, language))}</span>
              </div>
            </div>

            <div className="custom-scrollbar flex-1 overflow-x-auto p-4 md:p-8">
              <div className="flex h-full min-w-max space-x-6">
                {columns.map((column) => (
                  <section key={column.id} className="flex w-80 flex-col">
                    <div className="mb-4 flex items-center justify-between">
                      <h3
                        className={`flex items-center text-sm font-bold uppercase tracking-widest ${getColumnAccentClassName(column.id)}`}
                      >
                        <span
                          className={`mr-2 h-2 w-2 rounded-full ${getColumnDotClassName(column.id)} ${column.id === "running" ? "animate-pulse" : ""}`}
                        />
                        {copy.columns[column.id]}
                        <span className="ml-2 rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">
                          {column.threads.length}
                        </span>
                      </h3>
                    </div>

                    <div className="space-y-3">
                      {column.threads.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-slate-800 px-4 py-5 text-sm text-slate-500">
                          {copy.board.emptyColumn}
                        </div>
                      ) : (
                        column.threads.map((thread) => {
                          if (column.id === "prep") {
                            return (
                              <PrepThreadCard
                                key={thread.id}
                                language={language}
                                thread={thread}
                                selected={selectedThreadIds.includes(thread.id)}
                                active={thread.id === selectedThreadId}
                                onSelect={onSelectThread}
                                onToggle={onToggleThreadSelection}
                                onDelete={onDeleteThread}
                              />
                            );
                          }

                          if (column.id === "todo") {
                            return (
                              <TodoThreadCard
                                key={thread.id}
                                language={language}
                                thread={thread}
                                active={thread.id === selectedThreadId}
                                onSelect={onSelectThread}
                                onDelete={onDeleteThread}
                                onDragStart={onDragQueueThread.start}
                                onDragOver={onDragQueueThread.over}
                                onDrop={onDragQueueThread.drop}
                              />
                            );
                          }

                          if (column.id === "done") {
                            return (
                              <CompletedThreadCard
                                key={thread.id}
                                language={language}
                                thread={thread}
                                selected={thread.id === selectedThreadId}
                                onSelect={onSelectThread}
                                onOpen={onOpenCompletedThread}
                              />
                            );
                          }

                          return (
                            <ThreadCard
                              key={thread.id}
                              language={language}
                              thread={thread}
                              selected={thread.id === selectedThreadId}
                              onSelect={onSelectThread}
                            />
                          );
                        })
                      )}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          </main>
        </div>

        <footer className="sticky bottom-0 z-30 border-t border-slate-800 bg-slate-950/95 px-4 py-2.5 backdrop-blur md:px-6 lg:px-8">
          <div className="flex flex-col gap-2 text-[11px] text-slate-400 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <div className="mr-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onChangeLanguage("ko")}
                  className={`flex h-11 w-11 items-center justify-center rounded-full border px-1 text-[9px] font-semibold leading-tight transition ${
                    language === "ko"
                      ? "border-sky-400 bg-sky-500/15 text-sky-200"
                      : "border-slate-700 text-slate-500 hover:border-slate-500 hover:text-slate-200"
                  }`}
                  title={copy.footer.languageKorean}
                >
                  {copy.footer.languageKorean}
                </button>
                <button
                  type="button"
                  onClick={() => onChangeLanguage("en")}
                  className={`flex h-11 w-11 items-center justify-center rounded-full border px-1 text-[9px] font-semibold leading-tight transition ${
                    language === "en"
                      ? "border-sky-400 bg-sky-500/15 text-sky-200"
                      : "border-slate-700 text-slate-500 hover:border-slate-500 hover:text-slate-200"
                  }`}
                  title={copy.footer.languageEnglish}
                >
                  {copy.footer.languageEnglish}
                </button>
              </div>
              <span className="font-medium text-slate-200">{session.displayName || session.loginId}</span>
              <span className="text-slate-600">/</span>
              <span>{session.loginId}</span>
              <span className="text-slate-600">/</span>
              <OverflowRevealText
                value={selectedBridge?.device_name ?? selectedBridge?.bridge_id ?? copy.fallback.noBridge}
                className="max-w-[18rem]"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 ${
                  status.app_server?.connected ? "bg-emerald-500/10 text-emerald-300" : "bg-rose-500/10 text-rose-300"
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${status.app_server?.connected ? "bg-emerald-400" : "bg-rose-400"}`} />
                {status.app_server?.connected ? copy.board.bridgeOk : copy.board.bridgeDown}
              </span>
              <span className="rounded-full bg-slate-900/80 px-2.5 py-1">{copy.board.projectsChip(projects.length)}</span>
              <span className="rounded-full bg-slate-900/80 px-2.5 py-1">{copy.board.threadsChip(threads.length)}</span>
              <button
                type="button"
                onClick={onLogout}
                className="rounded-xl border border-slate-800 px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:border-slate-700 hover:text-white"
              >
                {copy.board.logout}
              </button>
            </div>
          </div>
        </footer>
      </div>

      <IssueComposer
        language={language}
        open={composerOpen}
        busy={issueBusy}
        projects={projects}
        selectedProjectId={selectedProjectId}
        onClose={onCloseComposer}
        onSubmit={onSubmitIssue}
      />
      <ProjectComposer
        language={language}
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
      <ThreadDetailModal
        language={language}
        open={detailState.open}
        loading={detailState.loading}
        thread={detailState.thread}
        messages={detailState.messages}
        onClose={onCloseDetail}
      />
    </div>
  );
}

export default function App() {
  const [language, setLanguage] = useState(() => (typeof window === "undefined" ? "en" : readStoredLanguage()));
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
  const [selectedThreadIds, setSelectedThreadIds] = useState([]);
  const [queueOrderIds, setQueueOrderIds] = useState([]);
  const [draggingThreadId, setDraggingThreadId] = useState("");
  const [detailState, setDetailState] = useState({
    open: false,
    loading: false,
    thread: null,
    messages: []
  });
  const [search, setSearch] = useState("");
  const [recentEvents, setRecentEvents] = useState([]);
  const [loadingState, setLoadingState] = useState("idle");
  const [projectComposerOpen, setProjectComposerOpen] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [issueBusy, setIssueBusy] = useState(false);
  const [startBusy, setStartBusy] = useState(false);
  const copy = getCopy(language);

  useEffect(() => {
    storeLanguage(language);
  }, [language]);

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
          type: "dashboard.load.failed",
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
          setThreads((current) => {
            if (nextThreads.length === 0 && current.length > 0) {
              return current;
            }

            return nextThreads;
          });
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
      appendEvent("sse.error", copy.alerts.sseReconnect);
    });

    return () => {
      eventSource.close();
    };
  }, [copy.alerts.sseReconnect, session, selectedBridgeId]);

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
  }, [session, selectedBridgeId, projectComposerOpen]);

  useEffect(() => {
    setSelectedProjectId("");
    setSelectedThreadId("");
    setSelectedThreadIds([]);
    setQueueOrderIds([]);
    setDraggingThreadId("");
    setWorkspaceRoots([]);
    setFolderState({ path: "", parent_path: null, entries: [] });
    setSelectedWorkspacePath("");
    setDetailState({
      open: false,
      loading: false,
      thread: null,
      messages: []
    });
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
    const todoIds = threads
      .filter((thread) => getStatusMeta(thread.status).column === "todo")
      .sort((left, right) => {
        const leftOrder = left.queue_position ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = right.queue_position ?? Number.MAX_SAFE_INTEGER;

        if (leftOrder !== rightOrder) {
          return leftOrder - rightOrder;
        }

        return Date.parse(right.updated_at) - Date.parse(left.updated_at);
      })
      .map((thread) => thread.id);

    setQueueOrderIds((current) => {
      const preserved = current.filter((threadId) => todoIds.includes(threadId));
      const appended = todoIds.filter((threadId) => !preserved.includes(threadId));
      return [...preserved, ...appended];
    });
    setSelectedThreadIds((current) => current.filter((threadId) => threads.some((thread) => thread.id === threadId)));
  }, [threads]);

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

  useEffect(() => {
    if (!selectedProjectId) {
      setSelectedThreadIds([]);
      return;
    }

    setSelectedThreadIds((current) =>
      current.filter((threadId) =>
        threads.some(
          (thread) =>
            thread.id === threadId &&
            thread.project_id === selectedProjectId &&
            getStatusMeta(thread.status).column === "prep"
        )
      )
    );
  }, [selectedProjectId, threads]);

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
    setSelectedThreadIds([]);
    setQueueOrderIds([]);
    setDraggingThreadId("");
    setDetailState({
      open: false,
      loading: false,
      thread: null,
      messages: []
    });
    setSearch("");
  };

  const handleCreateIssue = async (payload) => {
    if (!session?.loginId) {
      return;
    }

    setIssueBusy(true);

    try {
      const response = await apiRequest(
        `/api/issues?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
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

  const handleToggleThreadSelection = (threadId) => {
    const thread = threads.find((item) => item.id === threadId);

    if (!thread || getStatusMeta(thread.status).column !== "prep") {
      return;
    }

    setSelectedThreadIds((current) =>
      current.includes(threadId) ? current.filter((item) => item !== threadId) : [...current, threadId]
    );
  };

  const handleStartSelectedThreads = async () => {
    if (!session?.loginId || !selectedBridgeId) {
      return;
    }

    const queuedThreadIds = selectedThreadIds.filter((threadId) => {
      const thread = threads.find((item) => item.id === threadId);
      return (
        thread &&
        thread.project_id === selectedProjectId &&
        getStatusMeta(thread.status).column === "prep"
      );
    });

    if (queuedThreadIds.length === 0) {
      return;
    }

    setStartBusy(true);

    try {
      const response = await apiRequest(
        `/api/threads/start?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify({
            thread_ids: queuedThreadIds
          })
        }
      );

      if (Array.isArray(response?.threads)) {
        setThreads(mergeThreads([], response.threads));
      }

      setSelectedThreadIds((current) => current.filter((threadId) => !queuedThreadIds.includes(threadId)));
    } catch (error) {
      setRecentEvents((current) => [
        {
          id: createId(),
          type: "threads.start.failed",
          timestamp: new Date().toISOString(),
          summary: error.message
        },
        ...current
      ].slice(0, 20));
    } finally {
      setStartBusy(false);
    }
  };

  const handleOpenCompletedThread = async (threadId) => {
    if (!session?.loginId || !selectedBridgeId || !threadId) {
      return;
    }

    const thread = threads.find((item) => item.id === threadId) ?? null;
    setDetailState({
      open: true,
      loading: true,
      thread,
      messages: []
    });

    try {
      const payload = await apiRequest(
        `/api/threads/${encodeURIComponent(threadId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`
      );
      setDetailState({
        open: true,
        loading: false,
        thread: payload.thread ?? thread,
        messages: payload.messages ?? []
      });
    } catch (error) {
      setDetailState({
        open: true,
        loading: false,
        thread,
        messages: [
          {
            id: createId(),
            role: "assistant",
            timestamp: new Date().toISOString(),
            content: error.message
          }
        ]
      });
    }
  };

  const handleDragQueueThread = {
    start: (threadId) => {
      setDraggingThreadId(threadId);
      setSelectedThreadId(threadId);
    },
    over: () => {},
    drop: (targetId) => {
      const nextOrder = reorderIds(queueOrderIds, draggingThreadId, targetId);
      setQueueOrderIds(nextOrder);
      setDraggingThreadId("");

      if (!session?.loginId || !selectedBridgeId) {
        return;
      }

      const projectQueueIds = nextOrder.filter((threadId) => {
        const thread = threads.find((item) => item.id === threadId);
        return (
          thread &&
          thread.project_id === selectedProjectId &&
          getStatusMeta(thread.status).column === "todo"
        );
      });

      void (async () => {
        try {
          const response = await apiRequest(
            `/api/threads/reorder?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
            {
              method: "POST",
              body: JSON.stringify({
                thread_ids: projectQueueIds
              })
            }
          );

          if (Array.isArray(response?.threads)) {
            setThreads(mergeThreads([], response.threads));
          }
        } catch (error) {
          setRecentEvents((current) => [
            {
              id: createId(),
              type: "threads.reorder.failed",
              timestamp: new Date().toISOString(),
              summary: error.message
            },
            ...current
          ].slice(0, 20));
        }
      })();
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

  const handleDeleteThread = async (threadId) => {
    if (!session?.loginId || !selectedBridgeId || !threadId) {
      return;
    }

    try {
      const response = await apiRequest(
        `/api/threads/${encodeURIComponent(threadId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "DELETE"
        }
      );

      if (Array.isArray(response?.threads)) {
        setThreads(mergeThreads([], response.threads));
      } else {
        setThreads((current) => current.filter((thread) => thread.id !== threadId));
      }

      setSelectedThreadIds((current) => current.filter((item) => item !== threadId));
      setQueueOrderIds((current) => current.filter((item) => item !== threadId));
      setSelectedThreadId((current) => (current === threadId ? "" : current));
    } catch (error) {
      setRecentEvents((current) => [
        {
          id: createId(),
          type: "thread.delete.failed",
          timestamp: new Date().toISOString(),
          summary: error.message
        },
        ...current
      ].slice(0, 20));
    }
  };

  const handleDeleteProject = async (projectId) => {
    if (!session?.loginId || !selectedBridgeId || !projectId) {
      return;
    }

    if (!window.confirm(copy.board.deleteProjectConfirm)) {
      return;
    }

    try {
      const response = await apiRequest(
        `/api/projects/${encodeURIComponent(projectId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "DELETE"
        }
      );

      if (Array.isArray(response?.projects)) {
        setProjects(response.projects);
      } else {
        setProjects((current) => current.filter((project) => project.id !== projectId));
      }

      if (Array.isArray(response?.threads)) {
        setThreads(mergeThreads([], response.threads));
      } else {
        setThreads((current) => current.filter((thread) => thread.project_id !== projectId));
      }

      setSelectedProjectId((current) => (current === projectId ? "" : current));
      setSelectedThreadIds((current) =>
        current.filter((threadId) => threads.find((thread) => thread.id === threadId)?.project_id !== projectId)
      );
      setQueueOrderIds((current) =>
        current.filter((threadId) => threads.find((thread) => thread.id === threadId)?.project_id !== projectId)
      );
    } catch (error) {
      setRecentEvents((current) => [
        {
          id: createId(),
          type: "project.delete.failed",
          timestamp: new Date().toISOString(),
          summary: error.message
        },
        ...current
      ].slice(0, 20));
    }
  };

  const handleRenameProject = async (projectId, name) => {
    if (!session?.loginId || !selectedBridgeId || !projectId) {
      return false;
    }

    try {
      const response = await apiRequest(
        `/api/projects/${encodeURIComponent(projectId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name
          })
        }
      );

      if (Array.isArray(response?.projects)) {
        setProjects(response.projects);
      } else if (response?.project?.id) {
        setProjects((current) =>
          current.map((project) => (project.id === response.project.id ? { ...project, ...response.project } : project))
        );
      }

      return true;
    } catch (error) {
      setRecentEvents((current) => [
        {
          id: createId(),
          type: "project.rename.failed",
          timestamp: new Date().toISOString(),
          summary: error.message
        },
        ...current
      ].slice(0, 20));
      return false;
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

  if (!session) {
    return (
      <LoginPage
        language={language}
        initialLoginId=""
        loading={loginState.loading}
        error={loginState.error}
        onSubmit={handleLogin}
      />
    );
  }

  return (
    <MainPage
      language={language}
      onChangeLanguage={setLanguage}
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
      queueOrderIds={queueOrderIds}
      loadingState={loadingState}
      projectBusy={projectBusy}
      issueBusy={issueBusy}
      startBusy={startBusy}
      projectComposerOpen={projectComposerOpen}
      composerOpen={composerOpen}
      onSearchChange={setSearch}
      onSelectBridge={setSelectedBridgeId}
      onSelectProject={setSelectedProjectId}
      onSelectThread={setSelectedThreadId}
      selectedThreadIds={selectedThreadIds}
      detailState={detailState}
      onToggleThreadSelection={handleToggleThreadSelection}
      onStartSelectedThreads={() => void handleStartSelectedThreads()}
      onOpenCompletedThread={(threadId) => void handleOpenCompletedThread(threadId)}
      onDeleteThread={(threadId) => void handleDeleteThread(threadId)}
      onDeleteProject={(projectId) => void handleDeleteProject(projectId)}
      onRenameProject={(projectId, name) => handleRenameProject(projectId, name)}
      onDragQueueThread={handleDragQueueThread}
      onOpenProjectComposer={() => void handleOpenProjectComposer()}
      onOpenComposer={() => setComposerOpen(true)}
      onCloseProjectComposer={handleCloseProjectComposer}
      onCloseComposer={() => setComposerOpen(false)}
      onBrowseWorkspaceRoot={(path) => browseWorkspacePath(path)}
      onBrowseFolder={(path) => browseWorkspacePath(path)}
      onSelectWorkspace={setSelectedWorkspacePath}
      onSubmitProject={handleCreateProject}
      onSubmitIssue={handleCreateIssue}
      onRefresh={() => void handleRefresh()}
      onLogout={handleLogout}
      onCloseDetail={() =>
        setDetailState({
          open: false,
          loading: false,
          thread: null,
          messages: []
        })
      }
    />
  );
}
