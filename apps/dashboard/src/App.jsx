import { useEffect, useRef, useState } from "react";

const LOCAL_STORAGE_KEY = "octop.dashboard.session";
const SESSION_STORAGE_KEY = "octop.dashboard.session.ephemeral";
const LANGUAGE_STORAGE_KEY = "octop.dashboard.language";
const SIDEBAR_WIDTH_STORAGE_KEY = "octop.dashboard.sidebar.width";
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
      prep: "Preparation",
      todo: "To Do",
      running: "In Progress",
      review: "Review",
      done: "Done"
    },
    status: {
      staged: "Preparation",
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
      addThread: "Add Thread",
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
        "Select issues in Preparation and move them to To Do. Items in To Do run sequentially, and you can reorder them by drag and drop.",
      syncing: "Syncing",
      updatedAt: (value) => `Updated ${value}`,
      emptyColumn: "No issues in this state.",
      moveSelectedToTodo: (count) => `Move to To Do${count > 0 ? ` (${count})` : ""}`,
      moving: "Moving...",
      bridge: "Bridge",
      project: "Project",
      drag: "Drag",
      prep: "Preparation",
      queue: "Queue",
      delete: "Delete",
      rename: "Rename",
      thread: "Thread",
      newThread: "New Thread",
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
      addThread: "쓰레드 추가",
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
      rename: "이름 변경",
      thread: "쓰레드",
      newThread: "새 쓰레드",
      logout: "로그아웃",
      bridgeOk: "브릿지 연결",
      bridgeDown: "브릿지 끊김",
      projectsChip: (count) => `프로젝트 ${count}`,
      threadsChip: (count) => `쓰레드 ${count}`,
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

function readStoredSidebarWidth() {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const width = Number(raw);

    if (Number.isFinite(width) && width >= 220 && width <= 420) {
      return width;
    }
  } catch {
    // ignore storage errors
  }

  return 272;
}

function storeSidebarWidth(width) {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
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

function formatCompactRelativeTime(value) {
  if (!value) {
    return "0m";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "0m";
  }

  const diffSeconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));

  if (diffSeconds < 60) {
    return "1m";
  }

  if (diffSeconds < 3600) {
    return `${Math.max(1, Math.floor(diffSeconds / 60))}m`;
  }

  if (diffSeconds < 86400) {
    return `${Math.max(1, Math.floor(diffSeconds / 3600))}h`;
  }

  if (diffSeconds < 604800) {
    return `${Math.max(1, Math.floor(diffSeconds / 86400))}d`;
  }

  return `${Math.max(1, Math.floor(diffSeconds / 604800))}w`;
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

function normalizeProjectThread(thread, fallbackProjectId = null) {
  if (!thread?.id) {
    return null;
  }

  return {
    id: thread.id,
    name: thread.name ?? thread.title ?? "",
    project_id: thread.project_id ?? fallbackProjectId,
    status: thread.status ?? "queued",
    progress: clampProgress(thread.progress),
    last_event: thread.last_event ?? "thread.started",
    last_message: thread.last_message ?? "",
    created_at: thread.created_at ?? new Date().toISOString(),
    updated_at: thread.updated_at ?? thread.created_at ?? new Date().toISOString(),
    source: thread.source ?? "appServer",
    turn_id: thread.turn_id ?? null,
    prompt: "",
    queue_position: null,
    issue_count: Number.isFinite(Number(thread.issue_count)) ? Number(thread.issue_count) : 0,
    queued_count: Number.isFinite(Number(thread.queued_count)) ? Number(thread.queued_count) : 0,
    codex_thread_id: thread.codex_thread_id ?? null
  };
}

function mergeProjectThreads(currentThreads, nextThreads) {
  const nextById = new Map();

  for (const thread of nextThreads) {
    const normalized = normalizeProjectThread(thread);

    if (normalized) {
      nextById.set(normalized.id, normalized);
    }
  }

  return [...nextById.values()].sort(
    (left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at)
  );
}

function replaceProjectThreadsForProject(currentThreads, nextThreads, projectId = "") {
  const normalizedThreads = mergeProjectThreads([], nextThreads);

  if (!projectId) {
    return normalizedThreads;
  }

  return mergeProjectThreads(
    currentThreads.filter((thread) => thread.project_id !== projectId),
    normalizedThreads
  );
}

function upsertProjectThread(currentThreads, thread) {
  const normalized = normalizeProjectThread(thread);

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

function normalizeIssue(issue, fallbackThreadId = null) {
  if (!issue?.id) {
    return null;
  }

  return {
    id: issue.id,
    thread_id: issue.thread_id ?? fallbackThreadId,
    project_id: issue.project_id ?? null,
    title: issue.title ?? "",
    status: issue.status ?? "staged",
    progress: clampProgress(issue.progress),
    last_event: issue.last_event ?? "issue.created",
    last_message: issue.last_message ?? "",
    created_at: issue.created_at ?? new Date().toISOString(),
    updated_at: issue.updated_at ?? issue.created_at ?? new Date().toISOString(),
    prompt: issue.prompt ?? "",
    queue_position: Number.isFinite(Number(issue.queue_position)) ? Number(issue.queue_position) : null
  };
}

function mergeIssues(currentIssues, nextIssues) {
  const nextById = new Map();

  for (const issue of nextIssues) {
    const normalized = normalizeIssue(issue);

    if (normalized) {
      nextById.set(normalized.id, normalized);
    }
  }

  return [...nextById.values()].sort(
    (left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at)
  );
}

function upsertIssue(currentIssues, issue) {
  const normalized = normalizeIssue(issue);

  if (!normalized) {
    return currentIssues;
  }

  const next = [...currentIssues];
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
  return String(thread?.name ?? thread?.title ?? "").trim() || getCopy(language).fallback.untitledIssue;
}

function getIssueTitle(issue, language) {
  return String(issue?.title ?? "").trim() || getCopy(language).fallback.untitledIssue;
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
    event?.payload?.threads?.[0]?.name ??
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

function IssueComposer({ language, open, busy, selectedProject, selectedThread, onClose, onSubmit }) {
  const copy = getCopy(language);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");

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

    if (!prompt.trim() || !selectedThread?.id) {
      return;
    }

    await onSubmit({
      title: title.trim(),
      prompt: prompt.trim()
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

          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3">
            <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">{copy.board.project}</p>
            <p className="mt-2 text-sm font-medium text-white">{selectedProject?.name ?? copy.fallback.noSelection}</p>
            <p className="mt-1 text-xs text-slate-500">{selectedThread?.name ?? copy.fallback.noBridge}</p>
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

            <div className="custom-scrollbar h-[34rem] space-y-1 overflow-y-scroll pr-1">
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

function ThreadContextMenu({ language, menuState, onRename, onDelete, onClose }) {
  const copy = getCopy(language);

  if (!menuState.open) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        aria-label="close thread menu"
        className="fixed inset-0 z-40 cursor-default"
        onClick={onClose}
      />
      <div
        className="fixed z-50 min-w-[10rem] overflow-hidden rounded-xl border border-slate-800 bg-slate-950/98 p-1.5 shadow-2xl shadow-slate-950/60"
        style={{ left: menuState.x, top: menuState.y }}
      >
        <button
          type="button"
          onClick={onRename}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-slate-800"
        >
          {copy.board.rename}
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-rose-300 transition hover:bg-rose-500/10"
        >
          {copy.board.delete}
        </button>
      </div>
    </>
  );
}

function SidebarThreadItem({
  language,
  thread,
  active,
  editing,
  editingName,
  onSelect,
  onBeginRename,
  onChangeRename,
  onSubmitRename,
  onCancelRename,
  onContextMenu
}) {
  return (
    <div
      onContextMenu={(event) => onContextMenu(event, thread)}
      className={`group ml-5 flex items-center gap-2 rounded-md px-2 py-1.5 transition ${
        active ? "bg-sky-500/10 text-white" : "text-slate-400 hover:bg-slate-800 hover:text-white"
      }`}
    >
      <svg className="h-4 w-4 shrink-0 text-sky-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path d="M8 10h8M8 14h5m6 6H5a2 2 0 01-2-2V8a2 2 0 012-2h3l2-2h4l2 2h3a2 2 0 012 2v10a2 2 0 01-2 2z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      </svg>
      {editing ? (
        <input
          type="text"
          autoFocus
          value={editingName}
          onChange={(event) => onChangeRename(event.target.value)}
          onBlur={() => void onSubmitRename(thread)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void onSubmitRename(thread);
            }

            if (event.key === "Escape") {
              event.preventDefault();
              onCancelRename();
            }
          }}
          className="min-w-0 flex-1 rounded-md border border-sky-400/40 bg-slate-900 px-2 py-1 text-sm text-white outline-none ring-1 ring-sky-400/20"
        />
      ) : (
        <button
          type="button"
          onClick={() => onSelect(thread.id)}
          onDoubleClick={() => onBeginRename(thread)}
          className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
        >
          <OverflowRevealText value={getThreadTitle(thread, language)} className="min-w-0 flex-1 text-sm font-medium" />
          <span
            className="shrink-0 text-[10px] text-slate-500"
            title={formatRelativeTime(thread.updated_at, language)}
          >
            {formatCompactRelativeTime(thread.updated_at)}
          </span>
        </button>
      )}
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

        <div className="custom-scrollbar flex-1 overflow-y-scroll px-6 py-5">
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
  onDelete,
  onDragStart
}) {
  const copy = getCopy(language);
  return (
    <div
      draggable
      onDragStart={() => onDragStart(thread.id)}
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
              <OverflowRevealText value={getIssueTitle(thread, language)} className="text-sm font-medium text-slate-100" />
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
          <OverflowRevealText value={getIssueTitle(thread, language)} className="text-sm font-medium text-slate-100" />
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
      <OverflowRevealText value={getIssueTitle(thread, language)} className="mt-3 text-sm font-medium text-slate-100" />
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
        <OverflowRevealText value={getIssueTitle(thread, language)} className="min-w-0 flex-1 text-sm font-medium text-slate-200" />
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
  projectThreads,
  issues,
  workspaceRoots,
  folderState,
  folderLoading,
  selectedWorkspacePath,
  selectedBridgeId,
  selectedProjectId,
  selectedProjectThreadId,
  selectedIssueId,
  selectedIssueIds,
  issueQueueOrderIds,
  detailState,
  search,
  loadingState,
  projectBusy,
  issueBusy,
  startBusy,
  projectComposerOpen,
  composerOpen,
  threadMenuState,
  onSearchChange,
  onSelectBridge,
  onSelectProject,
  onSelectProjectThread,
  onSelectIssue,
  onToggleIssueSelection,
  onStartSelectedIssues,
  onOpenCompletedIssue,
  onDeleteIssue,
  onDeleteProject,
  onRenameProject,
  onCreateThread,
  onRenameThread,
  onDeleteThread,
  onOpenThreadMenu,
  onCloseThreadMenu,
  onDragQueueIssue,
  onDragPrepIssues,
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
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    typeof window === "undefined" ? 272 : readStoredSidebarWidth()
  );
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const [boardScrollbarVisible, setBoardScrollbarVisible] = useState(false);
  const [boardScrollbarDragging, setBoardScrollbarDragging] = useState(false);
  const [boardScrollState, setBoardScrollState] = useState({
    clientWidth: 0,
    scrollWidth: 0,
    scrollLeft: 0
  });
  const languageMenuRef = useRef(null);
  const boardScrollRef = useRef(null);
  const boardScrollbarTrackRef = useRef(null);
  const boardScrollbarDragRef = useRef({
    active: false,
    pointerId: null,
    pointerOffsetX: 0
  });
  const selectedBridge =
    bridges.find((bridge) => bridge.bridge_id === selectedBridgeId) ?? bridges[0] ?? null;
  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? null;
  const scopedProjectThreads = projectThreads.filter(
    (thread) => !selectedProjectId || thread.project_id === selectedProjectId
  );
  const keyword = search.trim().toLowerCase();
  const filteredIssues = issues.filter((thread) => {
    return (
      !keyword ||
      thread.title.toLowerCase().includes(keyword) ||
      String(thread.prompt ?? "").toLowerCase().includes(keyword) ||
      String(thread.last_message ?? "").toLowerCase().includes(keyword)
    );
  });
  const selectedProjectThread =
    scopedProjectThreads.find((thread) => thread.id === selectedProjectThreadId) ??
    null;

  const columns = COLUMN_ORDER.map((column) => {
    const columnThreads = filteredIssues.filter((thread) => getStatusMeta(thread.status).column === column.id);

    if (column.id === "todo") {
      const orderedIds = issueQueueOrderIds.filter((threadId) => columnThreads.some((thread) => thread.id === threadId));
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
  }).filter((column) => column.id !== "review" || column.threads.length > 0);
  const boardContentWidth = Math.max(columns.length * 320 + Math.max(columns.length - 1, 0) * 24 + 128, 0);
  const prepSelectedCount = filteredIssues.filter(
    (thread) => selectedIssueIds.includes(thread.id) && getStatusMeta(thread.status).column === "prep"
  ).length;
  const [editingThreadId, setEditingThreadId] = useState("");
  const [editingThreadName, setEditingThreadName] = useState("");

  useEffect(() => {
    storeSidebarWidth(sidebarWidth);
  }, [sidebarWidth]);

  useEffect(() => {
    if (!languageMenuOpen) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (!languageMenuRef.current?.contains(event.target)) {
        setLanguageMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [languageMenuOpen]);

  useEffect(() => {
    const syncBoardScrollbarState = () => {
      const scrollNode = boardScrollRef.current;

      if (!scrollNode) {
        setBoardScrollbarVisible(false);
        setBoardScrollState({
          clientWidth: 0,
          scrollWidth: 0,
          scrollLeft: 0
        });
        return;
      }

      const nextState = {
        clientWidth: scrollNode.clientWidth,
        scrollWidth: scrollNode.scrollWidth,
        scrollLeft: scrollNode.scrollLeft
      };

      setBoardScrollbarVisible(nextState.scrollWidth > nextState.clientWidth + 1);
      setBoardScrollState(nextState);
    };

    const scrollNode = boardScrollRef.current;

    syncBoardScrollbarState();

    if (!scrollNode) {
      return undefined;
    }

    scrollNode.addEventListener("scroll", syncBoardScrollbarState, { passive: true });

    if (typeof window === "undefined" || typeof window.ResizeObserver !== "function") {
      window.addEventListener("resize", syncBoardScrollbarState);
      return () => {
        scrollNode.removeEventListener("scroll", syncBoardScrollbarState);
        window.removeEventListener("resize", syncBoardScrollbarState);
      };
    }

    const resizeObserver = new window.ResizeObserver(() => {
      syncBoardScrollbarState();
    });

    resizeObserver.observe(scrollNode);

    return () => {
      scrollNode.removeEventListener("scroll", syncBoardScrollbarState);
      resizeObserver.disconnect();
    };
  }, [boardContentWidth]);

  const scrollbarTrackWidth = boardScrollState.clientWidth;
  const scrollbarThumbWidth = boardScrollbarVisible
    ? Math.max((boardScrollState.clientWidth / boardScrollState.scrollWidth) * scrollbarTrackWidth, 56)
    : 0;
  const scrollbarThumbMaxOffset = Math.max(scrollbarTrackWidth - scrollbarThumbWidth, 0);
  const scrollbarMaxScrollLeft = Math.max(boardScrollState.scrollWidth - boardScrollState.clientWidth, 1);
  const scrollbarThumbOffset = boardScrollbarVisible
    ? (boardScrollState.scrollLeft / scrollbarMaxScrollLeft) * scrollbarThumbMaxOffset
    : 0;

  const updateBoardScrollFromPointer = (clientX, pointerOffsetX = 0) => {
    const scrollNode = boardScrollRef.current;
    const trackNode = boardScrollbarTrackRef.current;

    if (!scrollNode || !trackNode) {
      return false;
    }

    const rect = trackNode.getBoundingClientRect();
    const pointerX = clientX - rect.left - pointerOffsetX;
    const boundedX = Math.max(0, Math.min(scrollbarThumbMaxOffset, pointerX));
    const maxScrollLeft = Math.max(scrollNode.scrollWidth - scrollNode.clientWidth, 0);
    const nextScrollLeft = scrollbarThumbMaxOffset > 0 ? (boundedX / scrollbarThumbMaxOffset) * maxScrollLeft : 0;

    scrollNode.scrollLeft = nextScrollLeft;
    return true;
  };

  const stopBoardScrollbarDrag = (pointerId, releaseTarget = null) => {
    if (!boardScrollbarDragRef.current.active) {
      return;
    }

    if (releaseTarget && typeof releaseTarget.releasePointerCapture === "function" && pointerId !== null) {
      try {
        releaseTarget.releasePointerCapture(pointerId);
      } catch {
        // ignore failed capture release
      }
    }

    boardScrollbarDragRef.current = {
      active: false,
      pointerId: null,
      pointerOffsetX: 0
    };
    setBoardScrollbarDragging(false);
  };

  const handleBoardScrollbarPointerDown = (event) => {
    const trackNode = boardScrollbarTrackRef.current;

    if (!trackNode) {
      return;
    }

    event.preventDefault();

    const thumbNode = event.target.closest(".octop-board-scrollbar-thumb");
    const thumbRect = thumbNode?.getBoundingClientRect?.();
    const pointerOffsetX = thumbRect ? event.clientX - thumbRect.left : scrollbarThumbWidth / 2;

    boardScrollbarDragRef.current = {
      active: true,
      pointerId: event.pointerId,
      pointerOffsetX
    };
    setBoardScrollbarDragging(true);

    if (typeof trackNode.setPointerCapture === "function") {
      try {
        trackNode.setPointerCapture(event.pointerId);
      } catch {
        // ignore failed capture request
      }
    }

    updateBoardScrollFromPointer(event.clientX, pointerOffsetX);
  };

  const handleBoardScrollbarPointerMove = (event) => {
    if (!boardScrollbarDragRef.current.active || boardScrollbarDragRef.current.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    updateBoardScrollFromPointer(event.clientX, boardScrollbarDragRef.current.pointerOffsetX);
  };

  const handleBoardScrollbarPointerUp = (event) => {
    if (boardScrollbarDragRef.current.pointerId !== event.pointerId) {
      return;
    }

    stopBoardScrollbarDrag(event.pointerId, event.currentTarget);
  };

  const handleBoardScrollbarPointerCancel = (event) => {
    if (boardScrollbarDragRef.current.pointerId !== event.pointerId) {
      return;
    }

    stopBoardScrollbarDrag(event.pointerId, event.currentTarget);
  };

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

  const beginThreadRename = (thread) => {
    setEditingThreadId(thread.id);
    setEditingThreadName(thread.name);
  };

  const cancelThreadRename = () => {
    setEditingThreadId("");
    setEditingThreadName("");
  };

  const submitThreadRename = async (thread) => {
    const nextName = editingThreadName.trim();

    if (!nextName || nextName === thread.name) {
      cancelThreadRename();
      return;
    }

    const accepted = await onRenameThread(thread.id, nextName);

    if (accepted) {
      cancelThreadRename();
    }
  };

  const startSidebarResize = (event) => {
    event.preventDefault();
    const originX = event.clientX;
    const originWidth = sidebarWidth;

    const handleMouseMove = (moveEvent) => {
      const delta = moveEvent.clientX - originX;
      setSidebarWidth(Math.max(220, Math.min(420, originWidth + delta)));
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <div className="flex min-h-screen flex-col">
        <div className="flex flex-1 overflow-hidden">
          <aside
            className="hidden shrink-0 border-r border-slate-800 bg-[#0f172a] md:flex md:flex-col"
            style={{ width: `${sidebarWidth}px` }}
          >
            <div className="flex items-center justify-between gap-3 px-4 py-4">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-violet-500">
                <svg className="h-5 w-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M13 10V3L4 14h7v7l9-11h-7z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                </svg>
              </div>
              <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                <span className="truncate text-lg font-bold tracking-tight text-white">OctOP</span>
              </div>
            </div>

            <div className="flex flex-1 flex-col px-3 pb-3">
              <div className="mb-3 px-2">
                <p className="mb-2 text-[11px] uppercase tracking-[0.24em] text-slate-500">{copy.board.bridge}</p>
                <select
                  value={selectedBridgeId}
                  onChange={(event) => onSelectBridge(event.target.value)}
                  className="w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-200 outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
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
              </div>

              <div className="mb-2 flex items-center justify-between gap-2 px-2 text-[11px] uppercase tracking-[0.24em] text-slate-500">
                <div className="flex items-center gap-2">
                  <span>{copy.board.sidebarEyebrow}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={onOpenProjectComposer}
                    disabled={!selectedBridge}
                    className="rounded-md border border-slate-800 px-2 py-1 text-[11px] font-medium normal-case tracking-normal text-slate-300 transition hover:border-slate-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {copy.board.addProject}
                  </button>
                  <button
                    type="button"
                    onClick={onCreateThread}
                    disabled={!selectedProject}
                    className="rounded-md border border-slate-800 px-2 py-1 text-[11px] font-medium normal-case tracking-normal text-slate-300 transition hover:border-slate-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {copy.board.addThread}
                  </button>
                </div>
              </div>

              <div className="custom-scrollbar max-h-[calc(100vh-11rem)] space-y-0.5 overflow-y-scroll px-1">
                {projects.length === 0 ? (
                  <div className="rounded-md px-3 py-3 text-xs text-slate-500">{copy.board.noProjects}</div>
                ) : (
                  projects.map((project) => {
                    const active = project.id === selectedProjectId;
                    const sidebarThreads = projectThreads.filter((thread) => thread.project_id === project.id);

                    return (
                      <div key={project.id} className="rounded-md px-1 py-0.5">
                        <div
                          className={`w-full rounded-md px-2.5 py-2 transition ${
                            active ? "bg-slate-800 text-white" : "text-slate-400 hover:bg-slate-800 hover:text-white"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                              <svg className="h-4 w-4 shrink-0 text-amber-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path d="M3 7h5l2 2h11v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                              </svg>
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
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[10px] text-slate-500">
                                {sidebarThreads.length}
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
                        {active ? (
                          <div className="mt-1.5 space-y-1">
                            {sidebarThreads.map((thread) => (
                              <SidebarThreadItem
                                key={thread.id}
                                language={language}
                                thread={thread}
                                active={thread.id === selectedProjectThreadId}
                                editing={editingThreadId === thread.id}
                                editingName={editingThreadName}
                                onSelect={onSelectProjectThread}
                                onBeginRename={beginThreadRename}
                                onChangeRename={setEditingThreadName}
                                onSubmitRename={submitThreadRename}
                                onCancelRename={cancelThreadRename}
                                onContextMenu={onOpenThreadMenu}
                              />
                            ))}
                          </div>
                        ) : null}
                      </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </aside>
          <div
            className="hidden w-2 shrink-0 cursor-col-resize border-r border-transparent bg-slate-950/70 transition hover:border-sky-400/40 hover:bg-sky-500/10 md:block"
            onMouseDown={startSidebarResize}
            aria-hidden="true"
          />

          <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-slate-800 bg-[#0f172a]/80 px-4 backdrop-blur-md md:px-8">
              <div className="min-w-0 flex-1 pr-4">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-slate-500">{copy.board.project}</span>
                  <span className="text-slate-700">/</span>
                  <OverflowRevealText value={selectedProject?.name ?? copy.fallback.noSelection} className="font-medium text-white" />
                  <span className="text-slate-700">/</span>
                  <OverflowRevealText value={selectedProjectThread?.name ?? copy.fallback.noSelection} className="font-medium text-sky-200" />
                </div>
              </div>

              <div className="ml-4 flex shrink-0 items-center space-x-3">
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

                <button
                  type="button"
                  onClick={onRefresh}
                  className="hidden rounded-lg border border-slate-800 px-3 py-2 text-sm font-medium text-slate-300 transition hover:border-slate-700 hover:text-white md:inline-flex"
                >
                  {copy.board.refresh}
                </button>

                <button
                  type="button"
                  onClick={onStartSelectedIssues}
                  disabled={prepSelectedCount === 0 || startBusy}
                  className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-300 transition hover:border-emerald-400/40 hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {startBusy ? copy.board.moving : copy.board.moveSelectedToTodo(prepSelectedCount)}
                </button>

                <button
                  type="button"
                  onClick={onOpenComposer}
                  disabled={!selectedProjectThread}
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
                <label className="block">
                  <span className="mb-2 block text-[11px] uppercase tracking-[0.24em] text-slate-500">{copy.board.thread}</span>
                  <select
                    value={selectedProjectThreadId}
                    onChange={(event) => onSelectProjectThread(event.target.value)}
                    className="w-full rounded-lg border-transparent bg-slate-800 px-3 py-2 text-sm text-slate-200 outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
                  >
                    {scopedProjectThreads.length === 0 ? (
                      <option value="">{copy.board.noProjectOption}</option>
                    ) : (
                      scopedProjectThreads.map((thread) => (
                        <option key={thread.id} value={thread.id}>
                          {thread.name}
                        </option>
                      ))
                    )}
                  </select>
                </label>
              </div>
            </div>

            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3 text-xs text-slate-500 md:px-8">
              <div className="flex items-center gap-3">
                <span>{selectedProjectThread ? copy.board.issueCount(filteredIssues.length) : copy.board.selectProject}</span>
                <span className="text-slate-700">•</span>
                <span>{copy.board.prepHint}</span>
              </div>
              <div className="hidden items-center gap-2 md:flex">
                <span>{loadingState === "loading" ? copy.board.syncing : copy.board.updatedAt(formatRelativeTime(status.updated_at, language))}</span>
              </div>
            </div>

            <div className="octop-board-page flex flex-1 min-h-0 flex-col">
              <div
                ref={boardScrollRef}
                id="octop-board-scroll-region"
                className="octop-board-scroll h-full min-h-0 flex-1"
              >
                <section
                  className="octop-board-frame flex h-full min-h-0"
                  style={{ width: `${boardContentWidth}px`, minWidth: "100%" }}
                >
                  <div className="octop-board-columns flex h-full min-w-0 space-x-6 px-4 py-4 pb-3 pr-8 md:px-8 md:py-6 md:pb-4 md:pr-12">
                {columns.map((column) => (
                  <section
                    key={column.id}
                    className={`flex w-80 flex-col rounded-2xl ${column.id === "todo" ? "ring-1 ring-transparent" : ""}`}
                    onDragOver={(event) => {
                      if (column.id === "todo") {
                        event.preventDefault();
                      }
                    }}
                    onDrop={(event) => {
                      if (column.id !== "todo") {
                        return;
                      }

                      event.preventDefault();
                      onDragPrepThreads.drop();
                    }}
                  >
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
                                selected={selectedIssueIds.includes(thread.id)}
                                active={thread.id === selectedIssueId}
                                onSelect={onSelectIssue}
                                onToggle={onToggleIssueSelection}
                                onDelete={onDeleteIssue}
                                onDragStart={onDragPrepIssues.start}
                              />
                            );
                          }

                          if (column.id === "todo") {
                            return (
                              <TodoThreadCard
                                key={thread.id}
                                language={language}
                                thread={thread}
                                active={thread.id === selectedIssueId}
                                onSelect={onSelectIssue}
                                onDelete={onDeleteIssue}
                                onDragStart={onDragQueueIssue.start}
                                onDragOver={onDragQueueIssue.over}
                                onDrop={onDragQueueIssue.drop}
                              />
                            );
                          }

                          if (column.id === "done") {
                            return (
                              <CompletedThreadCard
                                key={thread.id}
                                language={language}
                                thread={thread}
                                selected={thread.id === selectedIssueId}
                                onSelect={onSelectIssue}
                                onOpen={onOpenCompletedIssue}
                              />
                            );
                          }

                          return (
                            <ThreadCard
                              key={thread.id}
                              language={language}
                              thread={thread}
                              selected={thread.id === selectedIssueId}
                              onSelect={onSelectIssue}
                            />
                          );
                        })
                      )}
                    </div>
                  </section>
                ))}
                  </div>
                </section>
              </div>
              {boardScrollbarVisible ? (
                <div className="octop-board-scrollbar custom-scrollbar">
                  <div
                    ref={boardScrollbarTrackRef}
                    onPointerDown={handleBoardScrollbarPointerDown}
                    onPointerMove={handleBoardScrollbarPointerMove}
                    onPointerUp={handleBoardScrollbarPointerUp}
                    onPointerCancel={handleBoardScrollbarPointerCancel}
                    className={`octop-board-scrollbar-track ${
                      boardScrollbarDragging ? "octop-board-scrollbar-track--dragging" : ""
                    }`}
                    role="scrollbar"
                    aria-controls="octop-board-scroll-region"
                    aria-label="가로 스크롤 이동"
                    aria-valuemin={0}
                    aria-valuemax={Math.max(boardScrollState.scrollWidth - boardScrollState.clientWidth, 0)}
                    aria-valuenow={Math.round(boardScrollState.scrollLeft)}
                    tabIndex={0}
                  >
                    <span
                      className={`octop-board-scrollbar-thumb ${
                        boardScrollbarDragging ? "octop-board-scrollbar-thumb--dragging" : ""
                      }`}
                      style={{
                        width: `${scrollbarThumbWidth}px`,
                        transform: `translateX(${scrollbarThumbOffset}px)`
                      }}
                    />
                  </div>
                </div>
              ) : null}
            </div>
            
          </main>
        </div>

        <footer className="sticky bottom-0 z-30 border-t border-slate-800 bg-slate-950/95 px-4 py-2.5 backdrop-blur md:px-6 lg:px-8">
          <div className="flex flex-col gap-2 text-[11px] text-slate-400 md:flex-row md:items-center md:justify-between">
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
              <span className="rounded-full bg-slate-900/80 px-2.5 py-1">{copy.board.threadsChip(projectThreads.length)}</span>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <div className="relative mr-2" ref={languageMenuRef}>
                {languageMenuOpen ? (
                  <div className="absolute bottom-full left-0 mb-2 min-w-[9rem] rounded-xl border border-slate-800 bg-slate-950/98 p-1.5 shadow-2xl shadow-slate-950/60">
                    {[
                      { value: "en", label: copy.footer.languageEnglish },
                      { value: "ko", label: copy.footer.languageKorean }
                    ].map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => {
                          onChangeLanguage(option.value);
                          setLanguageMenuOpen(false);
                        }}
                        className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition ${
                          language === option.value
                            ? "bg-sky-500/12 text-sky-200"
                            : "text-slate-300 hover:bg-slate-900 hover:text-white"
                        }`}
                      >
                        <span>{option.label}</span>
                        {language === option.value ? <span className="text-[10px] text-sky-300">●</span> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => setLanguageMenuOpen((current) => !current)}
                  className="inline-flex items-center gap-2 rounded-full border border-slate-700 px-3 py-1.5 text-[11px] font-medium text-slate-200 transition hover:border-slate-500 hover:text-white"
                  title={language === "ko" ? copy.footer.languageKorean : copy.footer.languageEnglish}
                >
                  <span>{language === "ko" ? copy.footer.languageKorean : copy.footer.languageEnglish}</span>
                  <svg className="h-3.5 w-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                  </svg>
                </button>
              </div>
              {session.displayName && session.displayName !== session.loginId ? (
                <>
                  <span className="font-medium text-slate-200">{session.displayName}</span>
                  <span className="text-slate-600">/</span>
                </>
              ) : null}
              <span className="font-medium text-slate-200">{session.loginId}</span>
              <span className="text-slate-600">/</span>
              <OverflowRevealText value={selectedBridge?.device_name ?? selectedBridge?.bridge_id ?? copy.fallback.noBridge} className="max-w-[18rem]" />
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
        selectedProject={selectedProject}
        selectedThread={selectedProjectThread}
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
      <ThreadContextMenu
        language={language}
        menuState={threadMenuState}
        onRename={() => {
          onCloseThreadMenu();
          if (threadMenuState.thread) {
            beginThreadRename(threadMenuState.thread);
          }
        }}
        onDelete={() => {
          onCloseThreadMenu();
          if (threadMenuState.thread) {
            void onDeleteThread(threadMenuState.thread.id);
          }
        }}
        onClose={onCloseThreadMenu}
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
  const [projectThreads, setProjectThreads] = useState([]);
  const [issues, setIssues] = useState([]);
  const [workspaceRoots, setWorkspaceRoots] = useState([]);
  const [folderState, setFolderState] = useState({ path: "", parent_path: null, entries: [] });
  const [folderLoading, setFolderLoading] = useState(false);
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState("");
  const [selectedBridgeId, setSelectedBridgeId] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedProjectThreadId, setSelectedProjectThreadId] = useState("");
  const [selectedIssueId, setSelectedIssueId] = useState("");
  const [selectedIssueIds, setSelectedIssueIds] = useState([]);
  const [issueQueueOrderIds, setIssueQueueOrderIds] = useState([]);
  const [draggingIssueId, setDraggingIssueId] = useState("");
  const [draggingPrepIssueIds, setDraggingPrepIssueIds] = useState([]);
  const [threadMenuState, setThreadMenuState] = useState({
    open: false,
    x: 0,
    y: 0,
    thread: null
  });
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
      setProjectThreads([]);
      setIssues([]);
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
      const [nextStatus, nextProjects] = await Promise.all([
        apiRequest(
          `/api/bridge/status?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
        ),
        apiRequest(`/api/projects?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`)
      ]);

      setStatus(nextStatus);
      setProjects(nextProjects.projects ?? []);
      setSelectedProjectId((current) => {
        if (current && nextProjects.projects?.some((project) => project.id === current)) {
          return current;
        }

        return nextProjects.projects?.[0]?.id || "";
      });
      setProjectThreads([]);
      setIssues([]);
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

  async function loadProjectThreads(sessionArg, bridgeId, projectId) {
    if (!sessionArg?.loginId || !bridgeId || !projectId) {
      setProjectThreads([]);
      return [];
    }

    const payload = await apiRequest(
      `/api/projects/${encodeURIComponent(projectId)}/threads?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
    );
    const nextThreads = mergeProjectThreads([], payload?.threads ?? []);
    setProjectThreads((current) => replaceProjectThreadsForProject(current, nextThreads, projectId));
    return nextThreads;
  }

  async function loadThreadIssues(sessionArg, bridgeId, threadId) {
    if (!sessionArg?.loginId || !bridgeId || !threadId) {
      setIssues([]);
      return [];
    }

    const payload = await apiRequest(
      `/api/threads/${encodeURIComponent(threadId)}/issues?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
    );
    const nextIssues = mergeIssues([], payload?.issues ?? []);
    setIssues(nextIssues);
    return nextIssues;
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
          payload?.payload?.threads?.[0]?.name ??
          payload?.payload?.issues?.[0]?.title ??
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

        if (payload.type === "bridge.projectThreads.updated") {
          const nextThreads = mergeProjectThreads([], payload.payload?.threads ?? []);
          const projectId = payload.payload?.project_id ?? nextThreads[0]?.project_id ?? "";
          const scope = payload.payload?.scope ?? "project";
          setProjectThreads((current) =>
            scope === "all" ? mergeProjectThreads([], nextThreads) : replaceProjectThreadsForProject(current, nextThreads, projectId)
          );
          setSelectedProjectThreadId((current) => {
            const candidateThreads =
              scope === "all"
                ? nextThreads.filter((thread) => !selectedProjectId || thread.project_id === selectedProjectId)
                : nextThreads;

            if (current && candidateThreads.some((thread) => thread.id === current)) {
              return current;
            }

            return candidateThreads[0]?.id || current || "";
          });
          return;
        }

        if (payload.type === "bridge.threadIssues.updated") {
          const targetThreadId = payload.payload?.thread_id ?? "";

          if (targetThreadId && targetThreadId !== selectedProjectThreadId) {
            return;
          }

          const nextIssues = mergeIssues([], payload.payload?.issues ?? []);
          setIssues(nextIssues);
          return;
        }

        if (payload.payload?.thread) {
          setProjectThreads((current) => upsertProjectThread(current, payload.payload.thread));
          return;
        }

        if (payload.payload?.issue) {
          setIssues((current) => upsertIssue(current, payload.payload.issue));
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
  }, [copy.alerts.sseReconnect, session, selectedBridgeId, selectedProjectId, selectedProjectThreadId]);

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
    setSelectedProjectThreadId("");
    setSelectedIssueId("");
    setSelectedIssueIds([]);
    setIssueQueueOrderIds([]);
    setDraggingIssueId("");
    setDraggingPrepIssueIds([]);
    setWorkspaceRoots([]);
    setFolderState({ path: "", parent_path: null, entries: [] });
    setSelectedWorkspacePath("");
    setProjectThreads([]);
    setIssues([]);
    setDetailState({
      open: false,
      loading: false,
      thread: null,
      messages: []
    });
    setThreadMenuState({
      open: false,
      x: 0,
      y: 0,
      thread: null
    });
  }, [selectedBridgeId]);

  useEffect(() => {
    if (!selectedProjectId && projects.length > 0) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  useEffect(() => {
    if (!session?.loginId || !selectedBridgeId || !selectedProjectId) {
      setProjectThreads([]);
      setSelectedProjectThreadId("");
      return;
    }

    void loadProjectThreads(session, selectedBridgeId, selectedProjectId);
  }, [session, selectedBridgeId, selectedProjectId]);

  useEffect(() => {
    const scopedThreads = projectThreads.filter(
      (thread) => !selectedProjectId || thread.project_id === selectedProjectId
    );

    if (!selectedProjectId) {
      setSelectedProjectThreadId("");
      return;
    }

    if (!selectedProjectThreadId || !scopedThreads.some((thread) => thread.id === selectedProjectThreadId)) {
      setSelectedProjectThreadId(scopedThreads[0]?.id ?? "");
    }
  }, [selectedProjectId, selectedProjectThreadId, projectThreads]);

  useEffect(() => {
    if (!session?.loginId || !selectedBridgeId || !selectedProjectThreadId) {
      setIssues([]);
      return;
    }

    void loadThreadIssues(session, selectedBridgeId, selectedProjectThreadId);
  }, [session, selectedBridgeId, selectedProjectThreadId]);

  useEffect(() => {
    const todoIds = issues
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

    setIssueQueueOrderIds((current) => {
      const preserved = current.filter((threadId) => todoIds.includes(threadId));
      const appended = todoIds.filter((threadId) => !preserved.includes(threadId));
      return [...preserved, ...appended];
    });
    setSelectedIssueIds((current) => current.filter((threadId) => issues.some((thread) => thread.id === threadId)));
  }, [issues]);

  useEffect(() => {
    if (!selectedProjectThreadId) {
      setSelectedIssueIds([]);
      setSelectedIssueId("");
      return;
    }

    setSelectedIssueIds((current) =>
      current.filter((threadId) =>
        issues.some(
          (thread) =>
            thread.id === threadId &&
            thread.thread_id === selectedProjectThreadId &&
            getStatusMeta(thread.status).column === "prep"
        )
      )
    );
    setSelectedIssueId((current) => (current && issues.some((issue) => issue.id === current) ? current : ""));
  }, [selectedProjectThreadId, issues]);

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
    setProjectThreads([]);
    setIssues([]);
    setWorkspaceRoots([]);
    setFolderState({ path: "", parent_path: null, entries: [] });
    setSelectedWorkspacePath("");
    setRecentEvents([]);
    setSelectedProjectId("");
    setSelectedProjectThreadId("");
    setSelectedIssueId("");
    setSelectedIssueIds([]);
    setIssueQueueOrderIds([]);
    setDraggingIssueId("");
    setDetailState({
      open: false,
      loading: false,
      thread: null,
      messages: []
    });
    setThreadMenuState({
      open: false,
      x: 0,
      y: 0,
      thread: null
    });
    setSearch("");
  };

  const handleCreateIssue = async (payload) => {
    if (!session?.loginId || !selectedBridgeId || !selectedProjectThreadId) {
      return;
    }

    setIssueBusy(true);

    try {
      const response = await apiRequest(
        `/api/threads/${encodeURIComponent(selectedProjectThreadId)}/issues?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify(payload)
        }
      );

      if (response?.issue) {
        setIssues((current) => upsertIssue(current, response.issue));
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

  const handleToggleIssueSelection = (threadId) => {
    const thread = issues.find((item) => item.id === threadId);

    if (!thread || getStatusMeta(thread.status).column !== "prep") {
      return;
    }

    setSelectedIssueIds((current) =>
      current.includes(threadId) ? current.filter((item) => item !== threadId) : [...current, threadId]
    );
  };

  const handleStartSelectedIssues = async () => {
    await movePrepIssuesToTodo(selectedIssueIds);
  };

  const handleOpenCompletedIssue = async (threadId) => {
    if (!session?.loginId || !selectedBridgeId || !threadId) {
      return;
    }

    const thread = issues.find((item) => item.id === threadId) ?? null;
    setSelectedIssueId(threadId);
    setDetailState({
      open: true,
      loading: true,
      thread,
      messages: []
    });

    try {
      const payload = await apiRequest(
        `/api/issues/${encodeURIComponent(threadId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`
      );
      setDetailState({
        open: true,
        loading: false,
        thread: payload.issue ?? thread,
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

  const handleDragQueueIssue = {
    start: (threadId) => {
      setDraggingIssueId(threadId);
      setDraggingPrepIssueIds([]);
    },
    over: () => {},
    drop: (targetId) => {
      if (draggingPrepIssueIds.length > 0) {
        void movePrepIssuesToTodo(draggingPrepIssueIds, targetId);
        return;
      }

      const nextOrder = reorderIds(issueQueueOrderIds, draggingIssueId, targetId);
      setIssueQueueOrderIds(nextOrder);
      setDraggingIssueId("");

      if (!session?.loginId || !selectedBridgeId || !selectedProjectThreadId) {
        return;
      }

      const projectQueueIds = nextOrder.filter((threadId) =>
        issues.some((item) => item.id === threadId && item.thread_id === selectedProjectThreadId)
      );

      void (async () => {
        try {
          const response = await apiRequest(
            `/api/threads/${encodeURIComponent(selectedProjectThreadId)}/issues/reorder?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
            {
              method: "POST",
              body: JSON.stringify({
                issue_ids: projectQueueIds
              })
            }
          );

          if (Array.isArray(response?.issues)) {
            setIssues(mergeIssues([], response.issues));
          }
        } catch (error) {
          setRecentEvents((current) => [
            {
              id: createId(),
              type: "issues.reorder.failed",
              timestamp: new Date().toISOString(),
              summary: error.message
            },
            ...current
          ].slice(0, 20));
        }
      })();
    }
  };

  const movePrepIssuesToTodo = async (threadIds, targetId = "") => {
    if (!session?.loginId || !selectedBridgeId || !selectedProjectThreadId) {
      return;
    }

    const queuedThreadIds = threadIds.filter((threadId) => {
      const thread = issues.find((item) => item.id === threadId);
      return (
        thread &&
        thread.thread_id === selectedProjectThreadId &&
        getStatusMeta(thread.status).column === "prep"
      );
    });

    if (queuedThreadIds.length === 0) {
      setDraggingPrepIssueIds([]);
      return;
    }

    setStartBusy(true);

    try {
      const response = await apiRequest(
        `/api/threads/${encodeURIComponent(selectedProjectThreadId)}/issues/start?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify({
            issue_ids: queuedThreadIds
          })
        }
      );

      const nextThreads = Array.isArray(response?.issues) ? mergeIssues([], response.issues) : [];

      if (nextThreads.length > 0) {
        setIssues(nextThreads);
      }

      if (targetId && nextThreads.length > 0) {
        const visibleTodoIds = nextThreads
          .filter(
            (thread) => thread.thread_id === selectedProjectThreadId && getStatusMeta(thread.status).column === "todo"
          )
          .sort((left, right) => {
            const leftOrder = left.queue_position ?? Number.MAX_SAFE_INTEGER;
            const rightOrder = right.queue_position ?? Number.MAX_SAFE_INTEGER;

            if (leftOrder !== rightOrder) {
              return leftOrder - rightOrder;
            }

            return Date.parse(left.updated_at) - Date.parse(right.updated_at);
          })
          .map((thread) => thread.id);

        const insertedIds = queuedThreadIds.filter((threadId) => visibleTodoIds.includes(threadId));

        if (insertedIds.length > 0 && visibleTodoIds.includes(targetId)) {
          const reorderedIds = visibleTodoIds.filter((threadId) => !insertedIds.includes(threadId));
          const targetIndex = reorderedIds.indexOf(targetId);

          if (targetIndex >= 0) {
            reorderedIds.splice(targetIndex, 0, ...insertedIds);
            setIssueQueueOrderIds(reorderedIds);

            const reorderResponse = await apiRequest(
              `/api/threads/${encodeURIComponent(selectedProjectThreadId)}/issues/reorder?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
              {
                method: "POST",
                body: JSON.stringify({
                  issue_ids: reorderedIds
                })
              }
            );

            if (Array.isArray(reorderResponse?.issues)) {
              setIssues(mergeIssues([], reorderResponse.issues));
            }
          }
        }
      }

      setSelectedIssueIds((current) => current.filter((threadId) => !queuedThreadIds.includes(threadId)));
    } catch (error) {
      setRecentEvents((current) => [
        {
          id: createId(),
          type: "issues.start.failed",
          timestamp: new Date().toISOString(),
          summary: error.message
        },
        ...current
      ].slice(0, 20));
    } finally {
      setStartBusy(false);
      setDraggingPrepIssueIds([]);
    }
  };

  const handleDragPrepIssues = {
    start: (threadId) => {
      const currentPrepIds = selectedIssueIds.filter((selectedId) => {
        const thread = issues.find((item) => item.id === selectedId);
        return (
          thread &&
          thread.thread_id === selectedProjectThreadId &&
          getStatusMeta(thread.status).column === "prep"
        );
      });
      const draggedIds = currentPrepIds.includes(threadId) ? currentPrepIds : [threadId];
      setDraggingIssueId("");
      setDraggingPrepIssueIds(draggedIds);
    },
    drop: (targetId = "") => {
      void movePrepIssuesToTodo(draggingPrepIssueIds, targetId);
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
        setProjectThreads(mergeProjectThreads([], response.threads));
      } else {
        setProjectThreads((current) => current.filter((thread) => thread.id !== threadId));
      }

      if (selectedProjectThreadId === threadId) {
        setIssues([]);
        setSelectedProjectThreadId("");
      }
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
        setProjectThreads(mergeProjectThreads([], response.threads));
      } else {
        setProjectThreads((current) => current.filter((thread) => thread.project_id !== projectId));
      }

      setSelectedProjectId((current) => (current === projectId ? "" : current));
      setSelectedIssueIds([]);
      setIssueQueueOrderIds([]);
      if (selectedProjectId === projectId) {
        setSelectedProjectThreadId("");
        setIssues([]);
      }
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

  const handleRenameThread = async (threadId, name) => {
    if (!session?.loginId || !selectedBridgeId || !threadId) {
      return false;
    }

    try {
      const response = await apiRequest(
        `/api/threads/${encodeURIComponent(threadId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ name })
        }
      );

      if (Array.isArray(response?.threads)) {
        setProjectThreads(mergeProjectThreads([], response.threads));
      } else if (response?.thread?.id) {
        setProjectThreads((current) => upsertProjectThread(current, response.thread));
      }

      return true;
    } catch (error) {
      setRecentEvents((current) => [
        {
          id: createId(),
          type: "thread.rename.failed",
          timestamp: new Date().toISOString(),
          summary: error.message
        },
        ...current
      ].slice(0, 20));
      return false;
    }
  };

  const handleCreateThread = async () => {
    if (!session?.loginId || !selectedBridgeId || !selectedProjectId) {
      return;
    }

    try {
      const response = await apiRequest(
        `/api/projects/${encodeURIComponent(selectedProjectId)}/threads?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify({
            name: copy.board.newThread
          })
        }
      );

      if (Array.isArray(response?.threads)) {
        setProjectThreads((current) => {
          const preserved = current.filter((thread) => thread.project_id !== selectedProjectId);
          return [...preserved, ...mergeProjectThreads([], response.threads)];
        });
      }

      if (response?.thread?.id) {
        setProjectThreads((current) => upsertProjectThread(current, response.thread));
        setSelectedProjectThreadId(response.thread.id);
      }
    } catch (error) {
      setRecentEvents((current) => [
        {
          id: createId(),
          type: "thread.create.failed",
          timestamp: new Date().toISOString(),
          summary: error.message
        },
        ...current
      ].slice(0, 20));
    }
  };

  const handleDeleteIssue = async (issueId) => {
    if (!session?.loginId || !selectedBridgeId || !issueId) {
      return;
    }

    try {
      const response = await apiRequest(
        `/api/issues/${encodeURIComponent(issueId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "DELETE"
        }
      );

      if (Array.isArray(response?.issues)) {
        setIssues(mergeIssues([], response.issues));
      } else {
        setIssues((current) => current.filter((issue) => issue.id !== issueId));
      }

      setSelectedIssueIds((current) => current.filter((item) => item !== issueId));
      setIssueQueueOrderIds((current) => current.filter((item) => item !== issueId));
      setSelectedIssueId((current) => (current === issueId ? "" : current));
    } catch (error) {
      setRecentEvents((current) => [
        {
          id: createId(),
          type: "issue.delete.failed",
          timestamp: new Date().toISOString(),
          summary: error.message
        },
        ...current
      ].slice(0, 20));
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
      projectThreads={projectThreads}
      issues={issues}
      workspaceRoots={workspaceRoots}
      folderState={folderState}
      folderLoading={folderLoading}
      selectedWorkspacePath={selectedWorkspacePath}
      selectedBridgeId={selectedBridgeId}
      selectedProjectId={selectedProjectId}
      selectedProjectThreadId={selectedProjectThreadId}
      selectedIssueId={selectedIssueId}
      search={search}
      recentEvents={recentEvents}
      issueQueueOrderIds={issueQueueOrderIds}
      loadingState={loadingState}
      projectBusy={projectBusy}
      issueBusy={issueBusy}
      startBusy={startBusy}
      projectComposerOpen={projectComposerOpen}
      composerOpen={composerOpen}
      threadMenuState={threadMenuState}
      onSearchChange={setSearch}
      onSelectBridge={setSelectedBridgeId}
      onSelectProject={setSelectedProjectId}
      onSelectProjectThread={setSelectedProjectThreadId}
      onSelectIssue={setSelectedIssueId}
      selectedIssueIds={selectedIssueIds}
      detailState={detailState}
      onToggleIssueSelection={handleToggleIssueSelection}
      onStartSelectedIssues={() => void handleStartSelectedIssues()}
      onOpenCompletedIssue={(threadId) => void handleOpenCompletedIssue(threadId)}
      onDeleteIssue={(threadId) => void handleDeleteIssue(threadId)}
      onDeleteProject={(projectId) => void handleDeleteProject(projectId)}
      onRenameProject={(projectId, name) => handleRenameProject(projectId, name)}
      onCreateThread={() => void handleCreateThread()}
      onRenameThread={(threadId, name) => handleRenameThread(threadId, name)}
      onDeleteThread={(threadId) => void handleDeleteThread(threadId)}
      onOpenThreadMenu={(event, thread) => {
        event.preventDefault();
        setThreadMenuState({
          open: true,
          x: event.clientX,
          y: event.clientY,
          thread
        });
      }}
      onCloseThreadMenu={() =>
        setThreadMenuState({
          open: false,
          x: 0,
          y: 0,
          thread: null
        })
      }
      onDragQueueIssue={handleDragQueueIssue}
      onDragPrepIssues={handleDragPrepIssues}
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
