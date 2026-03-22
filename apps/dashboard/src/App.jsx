import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  mergeIncomingIssueSnapshot,
  resolveRealtimeIssuePayloadScope,
  shouldApplyRealtimeIssueToSelectedThread
} from "./realtimeIssue";
import PushNotificationCard from "./PushNotificationCard.jsx";

const LOCAL_STORAGE_KEY = "octop.dashboard.session";
const SESSION_STORAGE_KEY = "octop.dashboard.session.ephemeral";
const LANGUAGE_STORAGE_KEY = "octop.dashboard.language";
const SIDEBAR_WIDTH_STORAGE_KEY = "octop.dashboard.sidebar.width";
const ARCHIVE_STORAGE_KEY = "octop.dashboard.archives";
const SELECTED_BRIDGE_STORAGE_KEY = "octop.dashboard.selectedBridge";
const ISSUE_SOURCE_APP_ID = "dashboard-web";
const DEFAULT_API_BASE_URL =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
    ? "http://127.0.0.1:4000"
    : "https://octop.ilycode.app";
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
const STREAM_SILENCE_START_MS = 60_000;
const STREAM_SILENCE_STEP_MS = 30_000;
const STREAM_SILENCE_MAX_MS = 180_000;
const BRIDGE_STATUS_POLL_INTERVAL_MS = 10_000;
const BRIDGE_STALE_DISCONNECT_MS = 150_000;
const ACTIVE_ISSUE_POLL_INTERVAL_MS = 2_000;
const ACTIVE_ISSUE_POLL_SUPPRESS_AFTER_LIVE_MS = 6_000;
const ACTIVE_ISSUE_POLL_RESUME_GRACE_MS = 8_000;
const DASHBOARD_RESUME_ENABLE_DELAY_MS = 5_000;
const DASHBOARD_RESUME_COALESCE_MS = 400;
const BRIDGE_TRANSPORT_ERROR_STATUS_CODES = new Set([503, 504]);
const MAX_ISSUE_ATTACHMENTS = 8;
const MAX_ISSUE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ISSUE_ATTACHMENT_TEXT_CHARS = 20_000;
const TEXT_ATTACHMENT_FILE_PATTERN =
  /\.(?:txt|md|markdown|json|jsonc|ya?ml|xml|csv|ts|tsx|js|jsx|mjs|cjs|css|scss|sass|html|htm|cs|java|kt|swift|py|rb|php|go|rs|sh|zsh|bash|ps1|sql|toml|ini|cfg|conf|env|gitignore|dockerfile)$/i;
const ISSUE_ATTACHMENT_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
const ISSUE_ATTACHMENT_DOCUMENT_EXTENSIONS = ["pdf", "doc", "docx", "pptx"];
const ISSUE_ATTACHMENT_SPREADSHEET_EXTENSIONS = ["csv", "tsv", "xlsx"];
const ISSUE_ATTACHMENT_ARCHIVE_EXTENSIONS = ["zip", "tar"];
const ISSUE_ATTACHMENT_BINARY_DATA_EXTENSIONS = ["pkl"];
const ISSUE_ATTACHMENT_TEXT_EXTENSIONS = [
  "txt",
  "md",
  "markdown",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "xml",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "css",
  "scss",
  "sass",
  "html",
  "htm",
  "c",
  "cpp",
  "cs",
  "java",
  "kt",
  "swift",
  "py",
  "rb",
  "php",
  "go",
  "rs",
  "sh",
  "zsh",
  "bash",
  "ps1",
  "sql",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "tex"
];
const ISSUE_ATTACHMENT_SPECIAL_FILE_NAMES = [".gitignore", "dockerfile"];
const ISSUE_ATTACHMENT_SUPPORTED_EXTENSIONS = [
  ...ISSUE_ATTACHMENT_IMAGE_EXTENSIONS,
  ...ISSUE_ATTACHMENT_DOCUMENT_EXTENSIONS,
  ...ISSUE_ATTACHMENT_SPREADSHEET_EXTENSIONS,
  ...ISSUE_ATTACHMENT_ARCHIVE_EXTENSIONS,
  ...ISSUE_ATTACHMENT_BINARY_DATA_EXTENSIONS,
  ...ISSUE_ATTACHMENT_TEXT_EXTENSIONS
];
const ISSUE_ATTACHMENT_SUPPORTED_EXTENSION_SET = new Set(ISSUE_ATTACHMENT_SUPPORTED_EXTENSIONS);
const ISSUE_ATTACHMENT_SPECIAL_FILE_NAME_SET = new Set(ISSUE_ATTACHMENT_SPECIAL_FILE_NAMES);
const ISSUE_ATTACHMENT_ACCEPT = [
  ...ISSUE_ATTACHMENT_SUPPORTED_EXTENSIONS.map((extension) => `.${extension}`),
  ...ISSUE_ATTACHMENT_SPECIAL_FILE_NAMES
].join(",");
const bridgeRequestFailureListeners = new Set();

function createEmptyBridgeStatus() {
  return {
    app_server: {
      connected: false,
      initialized: false,
      account: null,
      last_error: null,
      last_socket_activity_at: null
    },
    capabilities: {
      thread_developer_instructions: false
    },
    counts: {
      projects: 0,
      threads: 0
    },
    updated_at: null
  };
}

function normalizeBridgeStatus(nextStatus) {
  const base = createEmptyBridgeStatus();
  const resolved = nextStatus && typeof nextStatus === "object" ? nextStatus : {};

  return {
    ...base,
    ...resolved,
    app_server: {
      ...base.app_server,
      ...(resolved.app_server ?? {})
    },
    capabilities: {
      ...base.capabilities,
      ...(resolved.capabilities ?? {})
    },
    counts: {
      projects: Number.isFinite(Number(resolved.counts?.projects))
        ? Number(resolved.counts.projects)
        : base.counts.projects,
      threads: Number.isFinite(Number(resolved.counts?.threads))
        ? Number(resolved.counts.threads)
        : base.counts.threads
    }
  };
}

function bridgeSupportsThreadDeveloperInstructions(status) {
  return status?.capabilities?.thread_developer_instructions === true;
}

function subscribeBridgeRequestFailures(listener) {
  if (typeof listener !== "function") {
    return () => {};
  }

  bridgeRequestFailureListeners.add(listener);
  return () => {
    bridgeRequestFailureListeners.delete(listener);
  };
}

function notifyBridgeRequestFailure(event) {
  for (const listener of bridgeRequestFailureListeners) {
    try {
      listener(event);
    } catch {
      // ignore listener failures
    }
  }
}

function extractBridgeIdFromPath(path) {
  const queryIndex = String(path ?? "").indexOf("?");

  if (queryIndex < 0) {
    return "";
  }

  const query = String(path).slice(queryIndex + 1);
  const params = new URLSearchParams(query);
  return String(params.get("bridge_id") ?? "").trim();
}

function readPushDeepLink() {
  if (typeof window === "undefined") {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  const bridgeId = String(params.get("bridge_id") ?? "").trim();
  const projectId = String(params.get("project_id") ?? "").trim();
  const threadId = String(params.get("thread_id") ?? "").trim();
  const issueId = String(params.get("issue_id") ?? "").trim();

  if (!bridgeId && !projectId && !threadId && !issueId) {
    return null;
  }

  return {
    bridgeId,
    projectId,
    threadId,
    issueId
  };
}

function clearPushDeepLink() {
  if (typeof window === "undefined" || !window.history?.replaceState) {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.delete("bridge_id");
  url.searchParams.delete("project_id");
  url.searchParams.delete("thread_id");
  url.searchParams.delete("issue_id");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function formatBridgeSilentDuration(ms, language = "en") {
  const safeMs = Math.max(0, Number(ms) || 0);
  const totalSeconds = Math.floor(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (language === "ko") {
    if (minutes <= 0) {
      return `${seconds}초`;
    }

    if (seconds === 0) {
      return `${minutes}분`;
    }

    return `${minutes}분 ${seconds}초`;
  }

  if (minutes <= 0) {
    return `${seconds}s`;
  }

  if (seconds === 0) {
    return `${minutes}m`;
  }

  return `${minutes}m ${seconds}s`;
}

function buildBridgeSignal({ connected, lastSocketActivityAt, statusUpdatedAt, now, language, connectedLabel, disconnectedLabel }) {
  if (!connected) {
    return {
      label: disconnectedLabel,
      title: language === "ko" ? "브릿지 연결이 끊어졌습니다." : "Bridge connection is down.",
      dotColor: "#fb7185",
      chipStyle: {
        backgroundColor: "rgba(244, 63, 94, 0.14)",
        borderColor: "rgba(244, 63, 94, 0.3)",
        color: "#fecdd3"
      }
    };
  }

  const socketActivityAt = Number.isFinite(lastSocketActivityAt) ? lastSocketActivityAt : 0;
  const statusActivityAt = Number.isFinite(statusUpdatedAt) ? statusUpdatedAt : 0;
  const effectiveActivityAt = Math.max(socketActivityAt, statusActivityAt);
  const bridgeSilentMs = effectiveActivityAt > 0 ? Math.max(0, now - effectiveActivityAt) : 0;
  if (effectiveActivityAt > 0 && bridgeSilentMs >= BRIDGE_STALE_DISCONNECT_MS) {
    return {
      label: disconnectedLabel,
      title:
        language === "ko"
          ? `브릿지 소켓 응답이 ${formatBridgeSilentDuration(bridgeSilentMs, language)} 동안 없습니다.`
          : `No bridge socket response for ${formatBridgeSilentDuration(bridgeSilentMs, language)}.`,
      dotColor: "#fb7185",
      chipStyle: {
        backgroundColor: "rgba(244, 63, 94, 0.14)",
        borderColor: "rgba(244, 63, 94, 0.3)",
        color: "#fecdd3"
      }
    };
  }

  const silentMs = effectiveActivityAt > 0 ? Math.max(0, now - effectiveActivityAt) : 0;
  const ratio =
    silentMs <= STREAM_SILENCE_START_MS
      ? 0
      : Math.min(1, (silentMs - STREAM_SILENCE_START_MS) / (STREAM_SILENCE_MAX_MS - STREAM_SILENCE_START_MS));
  const hue = Math.round(145 - 140 * ratio);
  const dotColor = `hsl(${hue} 82% 58%)`;
  const stage =
    silentMs < STREAM_SILENCE_START_MS
      ? 0
      : Math.min(5, Math.floor((silentMs - STREAM_SILENCE_START_MS) / STREAM_SILENCE_STEP_MS) + 1);
  const durationLabel = formatBridgeSilentDuration(silentMs, language);

  return {
    label:
      stage === 0
        ? connectedLabel
        : language === "ko"
          ? `${connectedLabel} · ${durationLabel} 무응답`
          : `${connectedLabel} · silent ${durationLabel}`,
    title:
      stage === 0
        ? language === "ko"
          ? "최근 이벤트 응답이 정상입니다."
          : "Recent event responses look healthy."
        : language === "ko"
          ? `최근 ${durationLabel} 동안 이벤트 응답이 없습니다. 필요하면 수동 새로고침으로 복구해 주세요.`
          : `No event response for ${durationLabel}. Refresh manually if recovery is needed.`,
    dotColor,
    chipStyle: {
      backgroundColor: `hsla(${hue}, 82%, 58%, 0.14)`,
      borderColor: `hsla(${hue}, 82%, 58%, 0.3)`,
      color: `hsl(${Math.max(hue - 8, 0)} 70% 88%)`
    }
  };
}

function buildThreadResponseSignal({ thread, now, language }) {
  if (!thread || thread.status !== "running" || thread.last_event !== "item.agentMessage.delta") {
    return null;
  }

  const activityAt = Date.parse(thread.updated_at ?? thread.created_at ?? "");

  if (!Number.isFinite(activityAt)) {
    return null;
  }

  const silentMs = Math.max(0, now - activityAt);
  const ratio =
    silentMs <= STREAM_SILENCE_START_MS
      ? 0
      : Math.min(1, (silentMs - STREAM_SILENCE_START_MS) / (STREAM_SILENCE_MAX_MS - STREAM_SILENCE_START_MS));
  const hue = Math.round(145 - 140 * ratio);
  const durationLabel = formatBridgeSilentDuration(silentMs, language);

  return {
    title:
      silentMs < STREAM_SILENCE_START_MS
        ? language === "ko"
          ? "최근 쓰레드 응답이 정상입니다."
          : "Recent thread responses look healthy."
        : language === "ko"
          ? `최근 ${durationLabel} 동안 쓰레드 응답이 없습니다. 필요하면 사용자가 작업을 중단하고 수동 복구해 주세요.`
          : `No thread response for ${durationLabel}. Stop the work manually and recover if needed.`,
    dotColor: `hsl(${hue} 82% 58%)`,
    chipStyle: {
      backgroundColor: `hsla(${hue}, 82%, 58%, 0.14)`,
      borderColor: `hsla(${hue}, 82%, 58%, 0.3)`,
      color: `hsl(${Math.max(hue - 8, 0)} 70% 88%)`
    }
  };
}

const COLUMN_ORDER = [
  { id: "prep", accent: "slate", countClassName: "bg-slate-800 text-slate-300" },
  { id: "todo", accent: "slate", countClassName: "bg-slate-800 text-slate-300" },
  { id: "running", accent: "blue", countClassName: "bg-sky-500/10 text-sky-300" },
  { id: "review", accent: "violet", countClassName: "bg-violet-500/10 text-violet-300" },
  { id: "done", accent: "green", countClassName: "bg-emerald-500/10 text-emerald-300" }
];
const HIDE_EMPTY_COLUMN_IDS = new Set(["prep", "running", "review"]);

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
  interrupted: {
    column: "review",
    labelKey: "interrupted",
    chipClassName: "bg-amber-500/10 text-amber-300",
    dotClassName: "bg-amber-400"
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
      interrupted: "Interrupted",
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
      title: "Create issue",
      issueTitle: "Issue title",
      optional: "optional",
      titlePlaceholder: "Auto-filled from the prompt if left blank",
      project: "Project",
      attachments: "Attachments",
      attachmentsAction: "Add files",
      attachmentsRejected: (count) => `${count} file${count === 1 ? "" : "s"} could not be attached.`,
      attachmentsMaxReached: "Attachment limit reached.",
      prompt: "Prompt",
      promptPlaceholder: "Describe the work to be completed.",
      cancel: "Cancel",
      submit: "Create issue",
      submitting: "Creating..."
    },
    issueEditor: {
      eyebrow: "Edit Issue",
      title: "Update issue",
      subtitle: "Adjust the title or prompt before you move work into the queue.",
      submit: "Save changes",
      submitting: "Saving..."
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
      interrupt: "Interrupt",
      interrupting: "Interrupting...",
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
      archiveSelected: (count) => `Archive${count > 0 ? ` (${count})` : ""}`,
      archivedHidden: (count) => `Archived ${count}`,
      archivedListTitle: "Archived Issues",
      archivedEmpty: "No archived issues.",
      restore: "Restore",
      restoreAll: "Restore all",
      bridge: "Bridge",
      project: "Project",
      drag: "Drag",
      prep: "Preparation",
      queue: "Queue",
      interrupt: "Interrupt",
      interrupting: "Interrupting...",
      delete: "Delete",
      rename: "Rename",
      thread: "Thread",
      newThread: "New Thread",
      logout: "Sign out",
      bridgeOk: "Bridge OK",
      bridgeDown: "Bridge Down",
      projectsChip: (count) => `Projects ${count}`,
      threadsChip: (count) => `Threads ${count}`,
      deleteProjectConfirm: "Delete this project? Its issues will be removed as well.",
      deleteBridge: "Delete Bridge",
      deletingBridge: "Deleting...",
      deleteBridgeConfirm: (name) =>
        `Delete ${name}? Stored projects, threads, and issue history for this bridge will be removed.`
    },
    footer: {
      languageKorean: "Korean",
      languageEnglish: "English",
      generalInstruction: "General Instruction",
      developerInstruction: "Developer Instruction",
      threadEdit: "Edit Thread",
      threadInstruction: "Thread Instruction",
      instructionSet: "Set",
      instructionEdit: "Edit",
      instructionMissingProject: "Select a project first.",
      instructionMissingThread: "Select a thread first.",
      instructionDialogClose: "Close",
      instructionDialogCancel: "Cancel",
      instructionDialogSave: "Save",
      instructionDialogSaving: "Saving...",
      instructionDialogProject: "Project",
      instructionDialogThread: "Thread",
      instructionDialogPlaceholderGeneral: "Enter the base guidance to inject when a Codex thread starts.",
      instructionDialogPlaceholderDeveloper: "Enter the developer guidance to inject when a Codex thread starts.",
      instructionDialogPlaceholderThreadDeveloper: "Enter the thread-specific developer guidance to inject on the next run for this thread.",
      instructionDialogHintGeneral:
        "Saved on the selected project and injected into app-server baseInstructions when a thread starts.",
      instructionDialogHintDeveloper:
        "Saved on the selected project and injected into app-server developerInstructions when a thread starts.",
      instructionDialogHintThreadDeveloper:
        "Saved only on this thread and appended after the project developerInstructions on the next run for this thread.",
      threadEditDialogTitle: "Edit Thread",
      threadEditDialogNameLabel: "Title",
      threadEditDialogNamePlaceholder: "Enter the thread title.",
      threadEditDialogUnsupported:
        "The connected bridge does not support thread-specific developer instructions, so only the title can be changed.",
      threadCreateDialogTitle: "Start New Thread",
      threadCreateDialogProjectHint: "Project",
      threadCreateDialogNameLabel: "Title",
      threadCreateDialogNamePlaceholder: "If left blank, Untitled will be used.",
      threadCreateDialogDeveloperLabel: "Developer Instruction",
      threadCreateDialogDeveloperPlaceholder: "Optionally add the developer guidance to save before the first run.",
      threadCreateDialogHint:
        "Both title and developer instruction are optional. The developer instruction is saved on the thread before you start working in it.",
      threadCreateDialogSubmit: "Start Chat",
      threadCreateDialogSubmitting: "Creating..."
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
      interrupted: "중단됨",
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
      title: "이슈 등록",
      issueTitle: "이슈 제목",
      optional: "선택",
      titlePlaceholder: "비워두면 프롬프트 앞부분으로 자동 생성됩니다",
      project: "프로젝트",
      attachments: "첨부",
      attachmentsAction: "파일 추가",
      attachmentsRejected: (count) => `${count}개 파일은 첨부하지 못했습니다.`,
      attachmentsMaxReached: "첨부는 최대 8개까지 가능합니다.",
      prompt: "프롬프트",
      promptPlaceholder: "수행할 작업을 구체적으로 입력해 주세요.",
      cancel: "취소",
      submit: "이슈 등록",
      submitting: "등록 중..."
    },
    issueEditor: {
      eyebrow: "이슈 수정",
      title: "이슈 업데이트",
      subtitle: "큐에 넣기 전에 제목과 프롬프트를 손볼 수 있습니다.",
      submit: "변경 사항 저장",
      submitting: "저장 중..."
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
      interrupt: "중단",
      interrupting: "중단 중...",
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
      archiveSelected: (count) => `선택 항목 보관${count > 0 ? ` (${count})` : ""}`,
      archivedHidden: (count) => `보관됨 ${count}`,
      archivedListTitle: "보관된 이슈",
      archivedEmpty: "보관 중인 항목이 없습니다.",
      restore: "복원",
      restoreAll: "모두 복원",
      bridge: "브릿지",
      project: "프로젝트",
      drag: "드래그",
      prep: "준비",
      queue: "대기열",
      interrupt: "중단",
      interrupting: "중단 중...",
      delete: "삭제",
      rename: "이름 변경",
      thread: "쓰레드",
      newThread: "새 쓰레드",
      logout: "로그아웃",
      bridgeOk: "브릿지 연결",
      bridgeDown: "브릿지 끊김",
      projectsChip: (count) => `프로젝트 ${count}`,
      threadsChip: (count) => `쓰레드 ${count}`,
      deleteProjectConfirm: "프로젝트를 삭제하시겠습니까? 해당 프로젝트의 이슈도 함께 제거됩니다.",
      deleteBridge: "브릿지 삭제",
      deletingBridge: "삭제 중...",
      deleteBridgeConfirm: (name) =>
        `${name} 브릿지를 삭제하시겠습니까? 이 브릿지에 저장된 프로젝트, 쓰레드, 이슈 기록도 함께 제거됩니다.`
    },
    footer: {
      languageKorean: "한국어",
      languageEnglish: "영어",
      generalInstruction: "일반지침",
      developerInstruction: "개발지침",
      threadEdit: "쓰레드 편집",
      threadInstruction: "Thread 개발지침",
      instructionSet: "설정",
      instructionEdit: "수정",
      instructionMissingProject: "먼저 프로젝트를 선택해 주세요.",
      instructionMissingThread: "먼저 쓰레드를 선택해 주세요.",
      instructionDialogClose: "닫기",
      instructionDialogCancel: "취소",
      instructionDialogSave: "저장",
      instructionDialogSaving: "저장 중...",
      instructionDialogProject: "프로젝트",
      instructionDialogThread: "쓰레드",
      instructionDialogPlaceholderGeneral: "Codex thread 시작 시 주입할 기본 지침을 입력해 주세요.",
      instructionDialogPlaceholderDeveloper: "Codex thread 시작 시 주입할 개발 지침을 입력해 주세요.",
      instructionDialogPlaceholderThreadDeveloper: "이 쓰레드의 다음 실행 흐름부터 적용할 전용 개발지침을 입력해 주세요.",
      instructionDialogHintGeneral:
        "선택한 프로젝트에 저장되며, app-server의 baseInstructions로 thread 시작 시 주입됩니다.",
      instructionDialogHintDeveloper:
        "선택한 프로젝트에 저장되며, app-server의 developerInstructions로 thread 시작 시 주입됩니다.",
      instructionDialogHintThreadDeveloper:
        "현재 쓰레드에만 저장되며, 다음 실행 흐름부터 프로젝트 개발지침 뒤에 이어 붙여 app-server developerInstructions로 주입됩니다.",
      threadEditDialogTitle: "쓰레드 편집",
      threadEditDialogNameLabel: "제목",
      threadEditDialogNamePlaceholder: "쓰레드 제목을 입력해 주세요.",
      threadEditDialogUnsupported:
        "현재 연결된 브리지는 쓰레드 전용 개발지침 저장을 지원하지 않아 제목만 수정할 수 있습니다.",
      threadCreateDialogTitle: "새 쓰레드 시작",
      threadCreateDialogProjectHint: "프로젝트",
      threadCreateDialogNameLabel: "제목",
      threadCreateDialogNamePlaceholder: "비워두면 제목없음으로 생성됩니다.",
      threadCreateDialogDeveloperLabel: "개발지침",
      threadCreateDialogDeveloperPlaceholder: "첫 실행 전에 저장할 채팅창 전용 개발지침이 있으면 입력해 주세요.",
      threadCreateDialogHint:
        "제목과 개발지침은 선택입니다. 개발지침은 먼저 저장한 뒤 이 쓰레드에서 작업을 시작하게 됩니다.",
      threadCreateDialogSubmit: "채팅 시작",
      threadCreateDialogSubmitting: "생성 중..."
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

function readStoredBridgeId() {
  if (typeof window === "undefined") {
    return "";
  }

  try {
    return window.localStorage.getItem(SELECTED_BRIDGE_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeSelectedBridgeId(bridgeId) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (bridgeId) {
      window.localStorage.setItem(SELECTED_BRIDGE_STORAGE_KEY, bridgeId);
    } else {
      window.localStorage.removeItem(SELECTED_BRIDGE_STORAGE_KEY);
    }
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

function normalizeArchivedIssueIds(rawIds) {
  if (!Array.isArray(rawIds)) {
    return [];
  }

  return [...new Set(rawIds.filter((id) => typeof id === "string" && id.length > 0))];
}

function normalizeArchivedIssueTimestamp(rawTimestamp) {
  if (typeof rawTimestamp !== "string" || rawTimestamp.trim().length === 0) {
    return null;
  }

  const timestamp = Date.parse(rawTimestamp);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function normalizeArchivedIssuesEntry(rawEntry) {
  if (Array.isArray(rawEntry)) {
    const issueIds = normalizeArchivedIssueIds(rawEntry);
    return issueIds.length > 0 ? { issueIds, updatedAt: null } : null;
  }

  if (!rawEntry || typeof rawEntry !== "object") {
    return null;
  }

  const issueIds = normalizeArchivedIssueIds(rawEntry.issueIds ?? rawEntry.ids ?? rawEntry.issue_ids);
  const updatedAt = normalizeArchivedIssueTimestamp(rawEntry.updatedAt ?? rawEntry.updated_at);

  if (issueIds.length === 0 && !updatedAt) {
    return null;
  }

  return {
    issueIds,
    updatedAt
  };
}

function buildArchivedIssuesEntry(issueIds, updatedAt = new Date().toISOString(), preserveEmpty = true) {
  const normalizedIds = normalizeArchivedIssueIds(issueIds);
  const normalizedTimestamp = normalizeArchivedIssueTimestamp(updatedAt) ?? new Date().toISOString();

  if (normalizedIds.length === 0 && !preserveEmpty) {
    return null;
  }

  return {
    issueIds: normalizedIds,
    updatedAt: normalizedTimestamp
  };
}

function normalizeArchivedIssuesState(rawState) {
  if (!rawState || typeof rawState !== "object") {
    return {};
  }

  const normalized = {};

  for (const [bridgeId, bridgeValue] of Object.entries(rawState)) {
    if (!bridgeId || typeof bridgeValue !== "object" || bridgeValue === null) {
      continue;
    }

    const threadMap = {};

    for (const [threadId, rawEntry] of Object.entries(bridgeValue)) {
      if (!threadId) {
        continue;
      }

      const normalizedEntry = normalizeArchivedIssuesEntry(rawEntry);

      if (normalizedEntry) {
        threadMap[threadId] = normalizedEntry;
      }
    }

    if (Object.keys(threadMap).length > 0) {
      normalized[bridgeId] = threadMap;
    }
  }

  return normalized;
}

function isArchivedIssuesStateEmpty(state) {
  return Object.keys(normalizeArchivedIssuesState(state)).length === 0;
}

function readStoredArchivedIssuesState() {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(ARCHIVE_STORAGE_KEY);

    if (!raw) {
      return {};
    }

    return normalizeArchivedIssuesState(JSON.parse(raw));
  } catch {
    return {};
  }
}

function writeStoredArchivedIssuesState(state) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(ARCHIVE_STORAGE_KEY, JSON.stringify(normalizeArchivedIssuesState(state)));
  } catch {
    // ignore storage errors
  }
}

function clearStoredArchivedIssuesState() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(ARCHIVE_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

function getArchivedIssueIdsForScope(state, bridgeId = "", threadId = "") {
  if (!bridgeId || !threadId) {
    return [];
  }

  return state?.[bridgeId]?.[threadId]?.issueIds ?? [];
}

function getArchivedIssueColumnId(issue) {
  const columnId = getStatusMeta(issue?.status).column;
  return columnId === "review" || columnId === "done" ? columnId : "";
}

function partitionIssuesByArchiveState(nextIssues, archivedState, bridgeId = "", threadId = "") {
  const archivedIssueIds = new Set(getArchivedIssueIdsForScope(archivedState, bridgeId, threadId));
  const visibleIssues = [];
  const archivedIssues = [];

  for (const issue of nextIssues) {
    const archivedColumnId = getArchivedIssueColumnId(issue);

    if (archivedColumnId && archivedIssueIds.has(issue.id)) {
      archivedIssues.push(issue);
      continue;
    }

    visibleIssues.push(issue);
  }

  return {
    visibleIssues,
    archivedIssues
  };
}

function resolveArchivedIssuesEntryByTimestamp(localEntry, remoteEntry) {
  if (!localEntry) {
    return remoteEntry;
  }

  if (!remoteEntry) {
    return localEntry;
  }

  const localTimestamp = localEntry.updatedAt ? Date.parse(localEntry.updatedAt) : Number.NaN;
  const remoteTimestamp = remoteEntry.updatedAt ? Date.parse(remoteEntry.updatedAt) : Number.NaN;

  if (!Number.isNaN(localTimestamp) && !Number.isNaN(remoteTimestamp) && localTimestamp !== remoteTimestamp) {
    return localTimestamp > remoteTimestamp ? localEntry : remoteEntry;
  }

  if (!Number.isNaN(localTimestamp) && Number.isNaN(remoteTimestamp)) {
    return localEntry;
  }

  if (Number.isNaN(localTimestamp) && !Number.isNaN(remoteTimestamp)) {
    return remoteEntry;
  }

  return remoteEntry ?? localEntry;
}

function mergeArchivedIssuesState(localState, remoteState) {
  const normalizedLocalState = normalizeArchivedIssuesState(localState);
  const normalizedRemoteState = normalizeArchivedIssuesState(remoteState);
  const nextState = {};
  const bridgeIds = new Set([
    ...Object.keys(normalizedLocalState),
    ...Object.keys(normalizedRemoteState)
  ]);

  for (const bridgeId of bridgeIds) {
    const nextBridgeState = {};
    const threadIds = new Set([
      ...Object.keys(normalizedLocalState[bridgeId] ?? {}),
      ...Object.keys(normalizedRemoteState[bridgeId] ?? {})
    ]);

    for (const threadId of threadIds) {
      const nextEntry = resolveArchivedIssuesEntryByTimestamp(
        normalizedLocalState[bridgeId]?.[threadId] ?? null,
        normalizedRemoteState[bridgeId]?.[threadId] ?? null
      );

      if (nextEntry) {
        nextBridgeState[threadId] = nextEntry;
      }
    }

    if (Object.keys(nextBridgeState).length > 0) {
      nextState[bridgeId] = nextBridgeState;
    }
  }

  return nextState;
}

function replaceArchivedIssuesStateForScope(currentState, bridgeId = "", threadId = "", issueIds = [], updatedAt = null) {
  if (!bridgeId || !threadId) {
    return currentState;
  }

  const nextBridgeState = {
    ...(currentState?.[bridgeId] ?? {})
  };

  const nextEntry = buildArchivedIssuesEntry(issueIds, updatedAt ?? new Date().toISOString(), true);

  nextBridgeState[threadId] = nextEntry;
  return {
    ...currentState,
    [bridgeId]: nextBridgeState
  };
}

function removeArchivedIssuesStateScope(currentState, bridgeId = "", threadId = "") {
  if (!bridgeId || !threadId) {
    return currentState;
  }

  const nextBridgeState = {
    ...(currentState?.[bridgeId] ?? {})
  };

  delete nextBridgeState[threadId];

  if (Object.keys(nextBridgeState).length === 0) {
    const nextState = { ...currentState };
    delete nextState[bridgeId];
    return nextState;
  }

  return {
    ...currentState,
    [bridgeId]: nextBridgeState
  };
}

function removeArchivedIssuesStateBridge(currentState, bridgeId = "") {
  if (!bridgeId || !currentState?.[bridgeId]) {
    return currentState;
  }

  const nextState = { ...currentState };
  delete nextState[bridgeId];
  return nextState;
}

function replaceArchivedIssueSnapshotForScope(currentState, bridgeId = "", threadId = "", issues = []) {
  if (!bridgeId || !threadId) {
    return currentState;
  }

  const nextBridgeState = {
    ...(currentState?.[bridgeId] ?? {})
  };

  if (issues.length === 0) {
    delete nextBridgeState[threadId];

    if (Object.keys(nextBridgeState).length === 0) {
      const nextState = { ...currentState };
      delete nextState[bridgeId];
      return nextState;
    }

    return {
      ...currentState,
      [bridgeId]: nextBridgeState
    };
  }

  nextBridgeState[threadId] = issues;
  return {
    ...currentState,
    [bridgeId]: nextBridgeState
  };
}

function replaceVisibleIssueSnapshotForScope(currentState, bridgeId = "", threadId = "", issues = []) {
  if (!bridgeId || !threadId) {
    return currentState;
  }

  const nextBridgeState = {
    ...(currentState?.[bridgeId] ?? {})
  };

  if (issues.length === 0) {
    delete nextBridgeState[threadId];

    if (Object.keys(nextBridgeState).length === 0) {
      const nextState = { ...currentState };
      delete nextState[bridgeId];
      return nextState;
    }

    return {
      ...currentState,
      [bridgeId]: nextBridgeState
    };
  }

  nextBridgeState[threadId] = issues;
  return {
    ...currentState,
    [bridgeId]: nextBridgeState
  };
}

function pruneArchivedIssueSnapshotsForBridge(currentSnapshots, bridgeId = "", validThreadIds = new Set()) {
  if (!bridgeId || !(validThreadIds instanceof Set)) {
    return currentSnapshots;
  }

  const bridgeSnapshots = currentSnapshots?.[bridgeId];

  if (!bridgeSnapshots) {
    return currentSnapshots;
  }

  let changed = false;
  const nextBridgeSnapshots = {};

  for (const [threadId, issues] of Object.entries(bridgeSnapshots)) {
    if (!validThreadIds.has(threadId)) {
      changed = true;
      continue;
    }

    nextBridgeSnapshots[threadId] = issues;
  }

  if (!changed) {
    return currentSnapshots;
  }

  const nextSnapshots = { ...currentSnapshots };

  if (Object.keys(nextBridgeSnapshots).length === 0) {
    delete nextSnapshots[bridgeId];
    return nextSnapshots;
  }

  nextSnapshots[bridgeId] = nextBridgeSnapshots;
  return nextSnapshots;
}

function removeBridgeIssueSnapshots(currentSnapshots, bridgeId = "") {
  if (!bridgeId || !currentSnapshots?.[bridgeId]) {
    return currentSnapshots;
  }

  const nextSnapshots = { ...currentSnapshots };
  delete nextSnapshots[bridgeId];
  return nextSnapshots;
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

const FENCED_CODE_BLOCK_PATTERN = /```([^\n`]*)\n?([\s\S]*?)```/g;
const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;
const SHELL_CODE_LANGUAGES = new Set(["sh", "shell", "bash", "zsh", "console", "terminal", "shellscript"]);

function parseRichMessageContent(content) {
  const normalized = String(content ?? "");

  if (!normalized) {
    return [];
  }

  const segments = [];
  let lastIndex = 0;
  FENCED_CODE_BLOCK_PATTERN.lastIndex = 0;

  for (const match of normalized.matchAll(FENCED_CODE_BLOCK_PATTERN)) {
    const [raw, language = "", code = ""] = match;
    const matchIndex = match.index ?? 0;

    if (matchIndex > lastIndex) {
      segments.push({
        type: "text",
        value: normalized.slice(lastIndex, matchIndex)
      });
    }

    segments.push({
      type: "code",
      language: String(language ?? "").trim(),
      value: String(code ?? "").replace(/\n$/, "")
    });
    lastIndex = matchIndex + raw.length;
  }

  if (lastIndex < normalized.length) {
    segments.push({
      type: "text",
      value: normalized.slice(lastIndex)
    });
  }

  return segments;
}

function inferCodeBlockLabel(language, content) {
  const normalizedLanguage = String(language ?? "").trim().toLowerCase();

  if (normalizedLanguage) {
    if (SHELL_CODE_LANGUAGES.has(normalizedLanguage)) {
      return "shell";
    }

    return normalizedLanguage;
  }

  const normalizedContent = String(content ?? "").trim();
  const looksLikeShell =
    /(^|\n)\s*[$#>]\s/.test(normalizedContent) ||
    /(^|\n)\s*(pnpm|npm|yarn|bun|git|cd|ls|mkdir|rm|cp|mv|cat|sed|awk|curl|wget|ssh|docker|kubectl)\b/.test(
      normalizedContent
    );

  return looksLikeShell ? "shell" : "code";
}

function renderInlineCodeTokens(text, inlineCodeClassName, keyPrefix) {
  const normalized = String(text ?? "");

  if (!normalized) {
    return null;
  }

  INLINE_CODE_PATTERN.lastIndex = 0;
  const nodes = [];
  let lastIndex = 0;
  let tokenIndex = 0;

  for (const match of normalized.matchAll(INLINE_CODE_PATTERN)) {
    const [raw, codeText = ""] = match;
    const matchIndex = match.index ?? 0;

    if (matchIndex > lastIndex) {
      nodes.push(
        <span key={`${keyPrefix}-text-${tokenIndex}`}>{normalized.slice(lastIndex, matchIndex)}</span>
      );
    }

    nodes.push(
      <code
        key={`${keyPrefix}-code-${tokenIndex}`}
        className={`rounded-lg border px-1.5 py-0.5 font-mono text-[0.92em] ${inlineCodeClassName}`}
      >
        {codeText}
      </code>
    );

    lastIndex = matchIndex + raw.length;
    tokenIndex += 1;
  }

  if (lastIndex < normalized.length) {
    nodes.push(<span key={`${keyPrefix}-tail`}>{normalized.slice(lastIndex)}</span>);
  }

  return nodes.length > 0 ? nodes : normalized;
}

function RichMessageContent({ content, tone = "dark" }) {
  const segments = parseRichMessageContent(content);
  const inlineCodeClassName =
    tone === "brand"
      ? "border-slate-950/10 bg-slate-950/10 text-slate-950"
      : "border-white/10 bg-white/5 text-slate-100";

  if (segments.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {segments.map((segment, index) => {
        if (segment.type === "code") {
          const label = inferCodeBlockLabel(segment.language, segment.value);

          return (
            <div
              key={`code-${index}`}
              className="overflow-hidden rounded-2xl border border-white/10 bg-[#050913] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
            >
              <div className="flex items-center justify-between gap-3 border-b border-white/5 bg-white/[0.03] px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-rose-400/90" />
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-300/90" />
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/90" />
                </div>
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                  {label}
                </span>
              </div>
              <div className="overflow-x-auto px-3 py-3">
                <pre className="m-0 w-max min-w-full font-mono text-[13px] leading-6 text-slate-100">
                  <code>{segment.value}</code>
                </pre>
              </div>
            </div>
          );
        }

        if (!String(segment.value ?? "").trim()) {
          return null;
        }

        return (
          <p key={`text-${index}`} className="whitespace-pre-wrap break-words text-sm leading-6">
            {renderInlineCodeTokens(segment.value, inlineCodeClassName, `segment-${index}`)}
          </p>
        );
      })}
    </div>
  );
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

function normalizeNullableInteger(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function getThreadContextUsage(thread) {
  if (!thread) {
    return null;
  }

  const percent = clampProgress(thread.context_usage_percent ?? thread.contextUsagePercent);
  const hasPercent =
    Number.isFinite(Number(thread.context_usage_percent)) || Number.isFinite(Number(thread.contextUsagePercent));
  const usedTokens = normalizeNullableInteger(
    thread.context_used_tokens ?? thread.contextUsedTokens
  );
  const windowTokens = normalizeNullableInteger(
    thread.context_window_tokens ??
      thread.contextWindowTokens ??
      thread.token_usage?.model_context_window ??
      thread.tokenUsage?.modelContextWindow
  );

  if (!hasPercent && usedTokens === null && windowTokens === null) {
    return null;
  }

  return {
    percent: hasPercent ? percent : null,
    usedTokens,
    windowTokens
  };
}

function formatThreadContextUsage(thread, language = "en") {
  const usage = getThreadContextUsage(thread);

  if (!usage || usage.percent === null) {
    return null;
  }

  return language === "ko" ? `컨텍스트 ${usage.percent}%` : `Context ${usage.percent}%`;
}

function getStatusMeta(status) {
  return STATUS_META[status] ?? STATUS_META.queued;
}

function isRetryableIssueStatus(status) {
  return String(status ?? "").trim() === "failed";
}

function getRealtimeProgressText(entity, language) {
  const isKorean = language === "ko";
  const status = entity?.status ?? "queued";
  const lastEvent = entity?.last_event ?? "";

  if (status === "awaiting_input") {
    return isKorean ? "입력 대기 중" : "Waiting for input";
  }

  if (status === "failed") {
    return isKorean ? "실패 확인 필요" : "Needs attention";
  }

  if (status === "interrupted") {
    return isKorean ? "중단됨" : "Interrupted";
  }

  if (status === "completed") {
    return isKorean ? "완료됨" : "Completed";
  }

  if (lastEvent === "turn.starting") {
    return isKorean ? "Codex 실행 요청 중" : "Sending to Codex";
  }

  if (lastEvent === "turn.started") {
    return isKorean ? "작업 시작됨" : "Task started";
  }

  if (lastEvent === "turn.plan.updated") {
    return isKorean ? "계획 수립 중" : "Planning next steps";
  }

  if (lastEvent === "turn.diff.updated") {
    return isKorean ? "변경 적용 중" : "Applying edits";
  }

  if (lastEvent === "item.agentMessage.delta") {
    return isKorean ? "응답 생성 중" : "Streaming response";
  }

  if (lastEvent === "turn.completed") {
    return isKorean ? "마무리 정리 중" : "Wrapping up";
  }

  if (status === "running") {
    return isKorean ? "실행 중" : "Running";
  }

  if (status === "queued") {
    return isKorean ? "대기열에서 대기 중" : "Waiting in queue";
  }

  if (status === "staged") {
    return isKorean ? "준비 단계" : "Ready to queue";
  }

  if (status === "idle") {
    return isKorean ? "다음 작업 대기 중" : "Waiting for next task";
  }

  return isKorean ? "상태 동기화 중" : "Syncing status";
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

function getThreadDeveloperInstructionSaveErrorMessage(error) {
  if (error?.code === "unsupported_bridge_feature" && error?.feature === "thread_developer_instructions") {
    const revision = String(error?.bridgeRevision ?? "").trim();
    return revision
      ? `연결된 브리지(${revision})가 채팅창 개발지침 저장을 지원하지 않습니다. 브리지를 최신 버전으로 업데이트한 뒤 다시 시도해 주세요.`
      : "연결된 브리지가 채팅창 개발지침 저장을 지원하지 않습니다. 브리지를 최신 버전으로 업데이트한 뒤 다시 시도해 주세요.";
  }

  return String(error?.message ?? "저장 중 오류가 발생했습니다.");
}

async function apiRequest(path, options = {}) {
  const method = String(options.method ?? "GET").toUpperCase();
  const requestUrl = `${API_BASE_URL}${path}`;
  const bridgeId = extractBridgeIdFromPath(path);
  let response;

  try {
    response = await fetch(requestUrl, {
      ...options,
      cache: options.cache ?? "no-store",
      headers: {
        Accept: "application/json",
        ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
        ...(options.headers ?? {})
      }
    });
  } catch (error) {
    const rawMessage = String(error?.message ?? error ?? "unknown error").trim() || "unknown error";
    const onlineState =
      typeof navigator === "undefined" || typeof navigator.onLine !== "boolean"
        ? "unknown"
        : navigator.onLine
          ? "online"
          : "offline";
    const lines = [
      `요청 실패: ${method} ${path}`,
      `API: ${requestUrl}`,
      `브라우저 네트워크 상태: ${onlineState}`
    ];

    if (/failed to fetch/i.test(rawMessage)) {
      lines.push("설명: 브라우저에서 API 엔드포인트까지 도달하지 못했습니다.");
    }

    lines.push(`원본 오류: ${rawMessage}`);
    if (bridgeId) {
      notifyBridgeRequestFailure({
        path,
        method,
        bridgeId,
        status: null,
        message: rawMessage
      });
    }
    throw new Error(lines.join("\n"));
  }

  const text = await response.text();
  const payload = parseResponseBody(response, text);

  if (!response.ok) {
    const message =
      payload?.error ??
      payload?.message ??
      payload?.title ??
      getCopy("en").alerts.requestFailed(response.status);
    if (bridgeId && BRIDGE_TRANSPORT_ERROR_STATUS_CODES.has(response.status)) {
      notifyBridgeRequestFailure({
        path,
        method,
        bridgeId,
        status: response.status,
        message
      });
    }
    const requestError = new Error(message);
    requestError.status = response.status;
    requestError.code = payload?.code ?? null;
    requestError.feature = payload?.feature ?? null;
    requestError.bridgeRevision = payload?.bridge_revision ?? null;
    requestError.payload = payload;
    throw requestError;
  }

  return payload;
}

function normalizeProjectThread(thread, fallbackProjectId = null) {
  if (!thread?.id) {
    return null;
  }

  const contextUsage = getThreadContextUsage(thread);

  return {
    id: thread.id,
    name: thread.name ?? thread.title ?? "",
    project_id: thread.project_id ?? fallbackProjectId,
    developer_instructions: thread.developer_instructions ?? "",
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
    codex_thread_id: thread.codex_thread_id ?? null,
    active_physical_thread_id: thread.active_physical_thread_id ?? null,
    continuity_mode: thread.continuity_mode ?? null,
    continuity_status: thread.continuity_status ?? "healthy",
    rollover_count: Number.isFinite(Number(thread.rollover_count)) ? Number(thread.rollover_count) : 0,
    context_usage_percent: contextUsage?.percent ?? null,
    context_used_tokens: contextUsage?.usedTokens ?? null,
    context_window_tokens: contextUsage?.windowTokens ?? null
  };
}

function mergeProjectThreads(currentThreads, nextThreads) {
  const nextById = new Map();

  for (const thread of currentThreads) {
    const normalized = normalizeProjectThread(thread);

    if (normalized) {
      nextById.set(normalized.id, normalized);
    }
  }

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
  if (!issue?.id || issue.deleted_at) {
    return null;
  }

  return {
    id: issue.id,
    thread_id: issue.thread_id ?? fallbackThreadId,
    root_thread_id: issue.root_thread_id ?? issue.thread_id ?? fallbackThreadId,
    project_id: issue.project_id ?? null,
    title: issue.title ?? "",
    status: issue.status ?? "staged",
    progress: clampProgress(issue.progress),
    last_event: issue.last_event ?? "issue.created",
    last_message: issue.last_message ?? "",
    created_at: issue.created_at ?? new Date().toISOString(),
    updated_at: issue.updated_at ?? issue.created_at ?? new Date().toISOString(),
    prompt: issue.prompt ?? "",
    attachments: normalizeIssueAttachments(issue.attachments),
    queue_position: Number.isFinite(Number(issue.queue_position)) ? Number(issue.queue_position) : null,
    prep_position: Number.isFinite(Number(issue.prep_position)) ? Number(issue.prep_position) : null,
    source_app_id: issue.source_app_id ?? null,
    created_physical_thread_id: issue.created_physical_thread_id ?? null,
    executed_physical_thread_id: issue.executed_physical_thread_id ?? null,
    continuity: issue.continuity ?? null
  };
}

function getIssuePhysicalThreadId(issue) {
  return issue?.executed_physical_thread_id ?? issue?.created_physical_thread_id ?? null;
}

function findActiveIssueForThread(issues, activePhysicalThreadId) {
  const normalizedIssues = Array.isArray(issues)
    ? issues
        .map((issue) => normalizeIssue(issue))
        .filter(Boolean)
        .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
    : [];

  if (normalizedIssues.length === 0) {
    return null;
  }

  if (activePhysicalThreadId) {
    const physicalMatch = normalizedIssues.find((issue) => getIssuePhysicalThreadId(issue) === activePhysicalThreadId);

    if (physicalMatch) {
      return physicalMatch;
    }
  }

  return normalizedIssues.find((issue) => ["running", "awaiting_input"].includes(issue.status)) ?? normalizedIssues[0] ?? null;
}

function mergeIssues(currentIssues, nextIssues) {
  const nextById = new Map();

  for (const issue of currentIssues) {
    const normalized = normalizeIssue(issue);

    if (normalized) {
      nextById.set(normalized.id, normalized);
    }
  }

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

function createIssueAttachmentId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isImageAttachmentMimeType(mimeType = "") {
  return String(mimeType ?? "")
    .trim()
    .toLowerCase()
    .startsWith("image/");
}

function getIssueAttachmentFileName(value = "") {
  return String(value ?? "").trim().toLowerCase();
}

function getIssueAttachmentFileExtension(fileName = "") {
  const normalized = getIssueAttachmentFileName(fileName);

  if (!normalized) {
    return "";
  }

  if (ISSUE_ATTACHMENT_SPECIAL_FILE_NAME_SET.has(normalized)) {
    return normalized;
  }

  if (normalized.startsWith(".") && normalized.indexOf(".", 1) < 0) {
    return normalized;
  }

  const extensionIndex = normalized.lastIndexOf(".");

  if (extensionIndex <= 0 || extensionIndex === normalized.length - 1) {
    return "";
  }

  return normalized.slice(extensionIndex + 1);
}

function isSupportedIssueAttachmentFile(file) {
  const fileName = getIssueAttachmentFileName(file?.name);
  const extension = getIssueAttachmentFileExtension(fileName);

  if (!fileName) {
    return false;
  }

  if (ISSUE_ATTACHMENT_SPECIAL_FILE_NAME_SET.has(fileName)) {
    return true;
  }

  if (!extension) {
    return false;
  }

  return ISSUE_ATTACHMENT_SUPPORTED_EXTENSION_SET.has(extension);
}

function resolveIssueAttachmentCategory(fileName = "", mimeType = "") {
  const extension = getIssueAttachmentFileExtension(fileName);
  const normalizedMimeType = String(mimeType ?? "").trim().toLowerCase();

  if (isImageAttachmentMimeType(normalizedMimeType) || ISSUE_ATTACHMENT_IMAGE_EXTENSIONS.includes(extension)) {
    return "image";
  }

  if (extension === "pdf") {
    return "pdf";
  }

  if (extension === "doc" || extension === "docx") {
    return "document";
  }

  if (extension === "pptx") {
    return "presentation";
  }

  if (ISSUE_ATTACHMENT_SPREADSHEET_EXTENSIONS.includes(extension)) {
    return "spreadsheet";
  }

  if (extension === "json" || extension === "jsonc" || extension === "xml" || extension === "yaml" || extension === "yml") {
    return "structured";
  }

  if (ISSUE_ATTACHMENT_ARCHIVE_EXTENSIONS.includes(extension)) {
    return "archive";
  }

  if (ISSUE_ATTACHMENT_BINARY_DATA_EXTENSIONS.includes(extension)) {
    return "binary";
  }

  if (extension === "txt" || extension === "md" || extension === "markdown" || ISSUE_ATTACHMENT_SPECIAL_FILE_NAME_SET.has(extension)) {
    return "text";
  }

  return "code";
}

function resolveIssueAttachmentBadge(fileName = "", mimeType = "") {
  const extension = getIssueAttachmentFileExtension(fileName);
  const category = resolveIssueAttachmentCategory(fileName, mimeType);
  const label = (() => {
    if (extension === ".gitignore") {
      return "GIT";
    }

    if (extension === "dockerfile") {
      return "DKR";
    }

    if (!extension) {
      return "FILE";
    }

    return extension.replace(/^\./, "").slice(0, 4).toUpperCase();
  })();

  switch (category) {
    case "image":
      return {
        label,
        className: "border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-100"
      };
    case "pdf":
      return {
        label,
        className: "border-rose-500/40 bg-rose-500/15 text-rose-100"
      };
    case "document":
      return {
        label,
        className: "border-sky-500/40 bg-sky-500/15 text-sky-100"
      };
    case "presentation":
      return {
        label,
        className: "border-orange-500/40 bg-orange-500/15 text-orange-100"
      };
    case "spreadsheet":
      return {
        label,
        className: "border-emerald-500/40 bg-emerald-500/15 text-emerald-100"
      };
    case "structured":
      return {
        label,
        className: "border-cyan-500/40 bg-cyan-500/15 text-cyan-100"
      };
    case "archive":
      return {
        label,
        className: "border-amber-500/40 bg-amber-500/15 text-amber-100"
      };
    case "binary":
      return {
        label,
        className: "border-indigo-500/40 bg-indigo-500/15 text-indigo-100"
      };
    case "text":
      return {
        label,
        className: "border-slate-500/40 bg-slate-500/15 text-slate-100"
      };
    default:
      return {
        label,
        className: "border-violet-500/40 bg-violet-500/15 text-violet-100"
      };
  }
}

function shouldInlineTextAttachment(file) {
  const mimeType = String(file?.type ?? "")
    .trim()
    .toLowerCase();
  const fileName = String(file?.name ?? "").trim();
  const extension = getIssueAttachmentFileExtension(fileName);

  return (
    mimeType.startsWith("text/") ||
    mimeType.includes("json") ||
    mimeType.includes("xml") ||
    ISSUE_ATTACHMENT_SPECIAL_FILE_NAME_SET.has(getIssueAttachmentFileName(fileName)) ||
    ISSUE_ATTACHMENT_TEXT_EXTENSIONS.includes(extension) ||
    TEXT_ATTACHMENT_FILE_PATTERN.test(fileName)
  );
}

function truncateAttachmentTextContent(text) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");

  if (normalized.length <= MAX_ISSUE_ATTACHMENT_TEXT_CHARS) {
    return {
      text: normalized,
      truncated: false
    };
  }

  return {
    text: normalized.slice(0, MAX_ISSUE_ATTACHMENT_TEXT_CHARS),
    truncated: true
  };
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("파일을 읽지 못했습니다."));
    reader.readAsDataURL(file);
  });
}

async function createImageThumbnailDataUrl(file) {
  const sourceUrl = await fileToDataUrl(file);

  if (typeof document === "undefined") {
    return sourceUrl;
  }

  const image = await new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("이미지 미리보기를 생성하지 못했습니다."));
    element.src = sourceUrl;
  });
  const maxEdge = 240;
  const width = Number(image.width) || maxEdge;
  const height = Number(image.height) || maxEdge;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");

  if (!context) {
    return sourceUrl;
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/webp", 0.82);
}

function normalizeIssueAttachment(attachment) {
  if (!attachment) {
    return null;
  }

  const name = String(attachment.name ?? "").trim();

  if (!name) {
    return null;
  }

  const mimeType = String(attachment.mime_type ?? attachment.mimeType ?? "").trim();
  const textContent = attachment.text_content == null ? null : String(attachment.text_content);
  const previewUrl = attachment.preview_url == null ? null : String(attachment.preview_url);
  const uploadId =
    attachment.upload_id == null && attachment.uploadId == null
      ? null
      : String(attachment.upload_id ?? attachment.uploadId).trim() || null;
  const downloadUrl =
    attachment.download_url == null && attachment.downloadUrl == null
      ? null
      : String(attachment.download_url ?? attachment.downloadUrl).trim() || null;
  const cleanupUrl =
    attachment.cleanup_url == null && attachment.cleanupUrl == null
      ? null
      : String(attachment.cleanup_url ?? attachment.cleanupUrl).trim() || null;
  const uploadedAt =
    attachment.uploaded_at == null && attachment.uploadedAt == null
      ? null
      : String(attachment.uploaded_at ?? attachment.uploadedAt).trim() || null;

  return {
    id: String(attachment.id ?? createIssueAttachmentId()).trim() || createIssueAttachmentId(),
    name,
    kind: attachment.kind === "image" || isImageAttachmentMimeType(mimeType) ? "image" : "file",
    mime_type: mimeType || null,
    size_bytes: Number.isFinite(Number(attachment.size_bytes ?? attachment.sizeBytes))
      ? Number(attachment.size_bytes ?? attachment.sizeBytes)
      : 0,
    preview_url: previewUrl || null,
    text_content: textContent && textContent.length > 0 ? textContent : null,
    text_truncated: Boolean(attachment.text_truncated ?? attachment.textTruncated),
    upload_id: uploadId,
    download_url: downloadUrl,
    cleanup_url: cleanupUrl,
    uploaded_at: uploadedAt
  };
}

function normalizeIssueAttachments(attachments) {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments.map((attachment) => normalizeIssueAttachment(attachment)).filter(Boolean);
}

async function uploadIssueAttachmentFile(file, bridgeId) {
  const formData = new FormData();
  formData.set("file", file);
  const query = bridgeId ? `?bridge_id=${encodeURIComponent(bridgeId)}` : "";
  const response = await apiRequest(`/api/attachments${query}`, {
    method: "POST",
    body: formData
  });

  return normalizeIssueAttachment(response?.attachment) ?? {};
}

async function cleanupIssueAttachmentUpload(attachment) {
  const cleanupUrl = String(attachment?.cleanup_url ?? attachment?.cleanupUrl ?? "").trim();

  if (!cleanupUrl) {
    return;
  }

  try {
    await fetch(cleanupUrl, {
      method: "DELETE",
      keepalive: true
    });
  } catch {
    // noop
  }
}

async function cleanupIssueAttachmentUploads(attachments) {
  const normalizedAttachments = normalizeIssueAttachments(attachments);

  await Promise.allSettled(
    normalizedAttachments
      .filter((attachment) => attachment.cleanup_url)
      .map((attachment) => cleanupIssueAttachmentUpload(attachment))
  );
}

async function createIssueAttachmentFromFile(file, bridgeId) {
  const mimeType = String(file?.type ?? "").trim();
  const attachment = {
    id: createIssueAttachmentId(),
    name: String(file?.name ?? "").trim() || "attachment",
    kind: isImageAttachmentMimeType(mimeType) ? "image" : "file",
    mime_type: mimeType || null,
    size_bytes: Number(file?.size ?? 0) || 0,
    preview_url: null,
    text_content: null,
    text_truncated: false
  };
  const shouldInlineText = shouldInlineTextAttachment(file);

  if (attachment.kind === "image") {
    const uploaded = await uploadIssueAttachmentFile(file, bridgeId);
    attachment.preview_url = await createImageThumbnailDataUrl(file);
    attachment.upload_id = uploaded.upload_id ?? null;
    attachment.download_url = uploaded.download_url ?? null;
    attachment.cleanup_url = uploaded.cleanup_url ?? null;
    attachment.uploaded_at = uploaded.uploaded_at ?? null;
    attachment.size_bytes = Number(uploaded.size_bytes ?? attachment.size_bytes) || attachment.size_bytes;
    return attachment;
  }

  if (shouldInlineText) {
    const { text, truncated } = truncateAttachmentTextContent(await file.text());
    attachment.text_content = text;
    attachment.text_truncated = truncated;

    if (!truncated) {
      return attachment;
    }
  }

  const uploaded = await uploadIssueAttachmentFile(file, bridgeId);
  attachment.upload_id = uploaded.upload_id ?? null;
  attachment.download_url = uploaded.download_url ?? null;
  attachment.cleanup_url = uploaded.cleanup_url ?? null;
  attachment.uploaded_at = uploaded.uploaded_at ?? null;
  attachment.size_bytes = Number(uploaded.size_bytes ?? attachment.size_bytes) || attachment.size_bytes;
  return attachment;
}

async function appendIssueAttachments(currentAttachments, files, bridgeId) {
  const attachments = [...normalizeIssueAttachments(currentAttachments)];
  const dedupeKeys = new Set(
    attachments.map((attachment) => `${attachment.name}:${attachment.size_bytes}:${attachment.mime_type ?? ""}`)
  );
  let rejectedCount = 0;

  for (const file of files) {
    if (attachments.length >= MAX_ISSUE_ATTACHMENTS) {
      rejectedCount += 1;
      continue;
    }

    if (!isSupportedIssueAttachmentFile(file)) {
      rejectedCount += 1;
      continue;
    }

    if ((Number(file?.size ?? 0) || 0) > MAX_ISSUE_ATTACHMENT_BYTES) {
      rejectedCount += 1;
      continue;
    }

    const dedupeKey = `${String(file?.name ?? "").trim()}:${Number(file?.size ?? 0) || 0}:${String(file?.type ?? "").trim()}`;

    if (dedupeKeys.has(dedupeKey)) {
      continue;
    }

    try {
      const attachment = await createIssueAttachmentFromFile(file, bridgeId);
      attachments.push(attachment);
      dedupeKeys.add(dedupeKey);
    } catch {
      rejectedCount += 1;
    }
  }

  return {
    attachments,
    rejectedCount
  };
}

function removeIssueAttachment(attachments, attachmentId) {
  return normalizeIssueAttachments(attachments).filter((attachment) => attachment.id !== attachmentId);
}

function formatIssueAttachmentSize(sizeBytes, language) {
  const size = Math.max(0, Number(sizeBytes) || 0);

  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function IssueAttachmentBadge({ attachment }) {
  const badge = resolveIssueAttachmentBadge(attachment?.name, attachment?.mime_type);

  return (
    <span
      className={`inline-flex h-9 min-w-[3.25rem] items-center justify-center rounded-xl border px-2 text-[11px] font-semibold tracking-[0.18em] ${badge.className}`}
    >
      {badge.label}
    </span>
  );
}

function IssueAttachmentInput({ language, attachments, errorMessage, busy, onAppendFiles, onRemoveAttachment }) {
  const copy = getCopy(language);
  const fileInputRef = useRef(null);
  const normalizedAttachments = normalizeIssueAttachments(attachments);
  const imageAttachments = normalizedAttachments.filter((attachment) => attachment.kind === "image");
  const fileAttachments = normalizedAttachments.filter((attachment) => attachment.kind !== "image");

  const handleFileChange = async (event) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";

    if (files.length > 0) {
      await onAppendFiles(files);
    }
  };

  return (
    <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">{copy.issueComposer.attachments}</p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ISSUE_ATTACHMENT_ACCEPT}
          className="hidden"
          onChange={handleFileChange}
        />
        <button
          type="button"
          disabled={busy || normalizedAttachments.length >= MAX_ISSUE_ATTACHMENTS}
          onClick={() => fileInputRef.current?.click()}
          className="shrink-0 rounded-2xl border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm font-medium text-slate-200 transition hover:border-sky-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {copy.issueComposer.attachmentsAction}
        </button>
      </div>

      {fileAttachments.length > 0 ? (
        <div className="space-y-2">
          {fileAttachments.map((attachment) => (
            <div
              key={attachment.id}
              className="flex max-w-full items-center gap-3 rounded-2xl border border-slate-800 bg-slate-950/80 px-3 py-3 text-xs text-slate-200"
            >
              <IssueAttachmentBadge attachment={attachment} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-white">{attachment.name}</p>
                <p className="mt-1 truncate text-[11px] text-slate-500">
                  {resolveIssueAttachmentBadge(attachment.name, attachment.mime_type).label} ·{" "}
                  {formatIssueAttachmentSize(attachment.size_bytes, language)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onRemoveAttachment(attachment.id)}
                className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-700 text-[11px] text-slate-300 transition hover:border-rose-400 hover:text-rose-200"
                aria-label={`${attachment.name} remove`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {imageAttachments.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {imageAttachments.map((attachment) => (
            <div key={attachment.id} className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/80">
              <div className="absolute left-2 top-2 z-10">
                <IssueAttachmentBadge attachment={attachment} />
              </div>
              {attachment.preview_url ? (
                <img src={attachment.preview_url} alt={attachment.name} className="h-28 w-full object-cover" />
              ) : (
                <div className="flex h-28 items-center justify-center bg-slate-900 text-xs text-slate-500">
                  {attachment.name}
                </div>
              )}
              <button
                type="button"
                onClick={() => onRemoveAttachment(attachment.id)}
                className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-700 bg-slate-950/90 text-sm text-slate-200 transition hover:border-rose-400 hover:text-rose-200"
                aria-label={`${attachment.name} remove`}
              >
                ×
              </button>
              <div className="border-t border-slate-800 px-3 py-2">
                <p className="truncate text-xs font-medium text-white">{attachment.name}</p>
                <p className="mt-1 text-[11px] text-slate-500">
                  {formatIssueAttachmentSize(attachment.size_bytes, language)}
                </p>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {errorMessage ? <p className="text-xs text-rose-300">{errorMessage}</p> : null}
    </div>
  );
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

function reorderIdGroup(items, draggedIds, targetId) {
  if (!Array.isArray(items) || !Array.isArray(draggedIds) || draggedIds.length === 0 || !targetId) {
    return items;
  }

  const normalizedDragged = draggedIds.filter((id) => items.includes(id));

  if (normalizedDragged.length === 0 || normalizedDragged.includes(targetId)) {
    return items;
  }

  const remaining = items.filter((id) => !normalizedDragged.includes(id));
  const targetIndex = remaining.indexOf(targetId);

  if (targetIndex < 0) {
    return items;
  }

  const next = [...remaining];
  next.splice(targetIndex, 0, ...normalizedDragged);
  return next;
}

function buildMessagePreview(thread, language) {
  const copy = getCopy(language);
  const prompt = String(thread.prompt ?? "").trim();
  const lastMessage = String(thread.last_message ?? "").trim();
  return lastMessage || getRealtimeProgressText(thread, language) || prompt || copy.fallback.noPrompt;
}

function getThreadTitle(thread, language) {
  return String(thread?.name ?? thread?.title ?? "").trim() || getCopy(language).fallback.untitledIssue;
}

function getIssueTitle(issue, language) {
  return String(issue?.title ?? "").trim() || getCopy(language).fallback.untitledIssue;
}

function normalizeLiveThreadStatus(statusType, currentStatus = "queued") {
  switch (statusType) {
    case "waitingForInput":
      return "awaiting_input";
    case "error":
      return "failed";
    case "completed":
      return "completed";
    case "idle":
    case "interrupted":
    case "cancelled":
    case "canceled":
      return currentStatus === "running" ? "idle" : currentStatus;
    case "active":
    case "running":
      return "running";
    default:
      return currentStatus;
  }
}

function isTerminalIssueStatus(status) {
  return ["completed", "failed", "interrupted"].includes(status);
}

function isLiveIssueProgressEvent(eventType) {
  return ["turn.started", "turn.starting", "turn.plan.updated", "turn.diff.updated", "item.agentMessage.delta"].includes(
    eventType ?? ""
  );
}

function getLiveEventContext(event) {
  const payload = event?.payload ?? {};
  const { threadId, issueId, projectId } = resolveRealtimeIssuePayloadScope(payload);

  return {
    payload,
    threadId,
    issueId,
    projectId
  };
}

function buildLiveThreadTokenUsagePatch(payload = {}, currentThread = null) {
  const tokenUsage = payload.tokenUsage ?? payload.token_usage ?? null;

  if (!tokenUsage || typeof tokenUsage !== "object") {
    return null;
  }

  const currentTokenUsage = currentThread?.token_usage ?? currentThread?.tokenUsage ?? {};
  const nextContextWindowTokens = normalizeNullableInteger(
    tokenUsage.contextWindowTokens ?? tokenUsage.context_window_tokens ?? currentThread?.context_window_tokens
  );
  const nextContextUsedTokens = normalizeNullableInteger(
    tokenUsage.contextUsedTokens ??
      tokenUsage.context_used_tokens ??
      tokenUsage.contextTokens ??
      tokenUsage.context_tokens ??
      currentThread?.context_used_tokens
  );
  const nextContextUsagePercent = clampProgress(
    tokenUsage.contextUsagePercent ??
      tokenUsage.context_usage_percent ??
      currentThread?.context_usage_percent
  );

  return {
    token_usage: {
      ...currentTokenUsage,
      ...(nextContextWindowTokens !== null ? { model_context_window: nextContextWindowTokens } : {})
    },
    context_window_tokens: nextContextWindowTokens,
    context_used_tokens: nextContextUsedTokens,
    context_usage_percent: nextContextUsagePercent
  };
}

function buildLiveThreadPatch(event, currentThread = null) {
  const { payload, threadId, projectId } = getLiveEventContext(event);

  if (!threadId) {
    return null;
  }

  const currentStatus = currentThread?.status ?? "queued";

  switch (event?.type) {
    case "thread.started":
      return {
        id: threadId,
        project_id: projectId || currentThread?.project_id || null,
        codex_thread_id: payload.codex_thread_id ?? currentThread?.codex_thread_id ?? null,
        progress: Math.max(5, currentThread?.progress ?? 0),
        status: currentStatus,
        last_event: "thread.started",
        updated_at: new Date().toISOString()
      };
    case "thread.status.changed":
      {
        const nextStatus = normalizeLiveThreadStatus(payload.status?.type ?? "", currentStatus);
        const nextMessage = String(payload.status?.message ?? "").trim();

        if (nextStatus === currentStatus && !nextMessage) {
          return null;
        }

        return {
          id: threadId,
          project_id: projectId || currentThread?.project_id || null,
          status: nextStatus,
          last_event: "thread.status.changed",
          ...(nextMessage ? { last_message: nextMessage } : {}),
          updated_at: new Date().toISOString()
        };
      }
    case "thread.tokenUsage.updated":
      {
        const tokenUsagePatch = buildLiveThreadTokenUsagePatch(payload, currentThread);

        if (!tokenUsagePatch) {
          return null;
        }

        return {
          id: threadId,
          project_id: projectId || currentThread?.project_id || null,
          ...tokenUsagePatch,
          updated_at: new Date().toISOString()
        };
      }
    case "turn.started":
      return {
        id: threadId,
        project_id: projectId || currentThread?.project_id || null,
        status: "running",
        progress: Math.max(currentThread?.progress ?? 0, 20),
        last_event: "turn.started",
        updated_at: new Date().toISOString()
      };
    case "turn.starting":
      return {
        id: threadId,
        project_id: projectId || currentThread?.project_id || null,
        status: "running",
        progress: Math.max(currentThread?.progress ?? 0, 10),
        last_event: "turn.starting",
        updated_at: new Date().toISOString()
      };
    case "turn.plan.updated":
      return {
        id: threadId,
        project_id: projectId || currentThread?.project_id || null,
        status: "running",
        progress: Math.max(currentThread?.progress ?? 0, 45),
        last_event: "turn.plan.updated",
        updated_at: new Date().toISOString()
      };
    case "turn.diff.updated":
      return {
        id: threadId,
        project_id: projectId || currentThread?.project_id || null,
        status: "running",
        progress: Math.max(currentThread?.progress ?? 0, 75),
        last_event: "turn.diff.updated",
        updated_at: new Date().toISOString()
      };
    case "item.agentMessage.delta":
      return {
        id: threadId,
        project_id: projectId || currentThread?.project_id || null,
        status: "running",
        progress: Math.max(currentThread?.progress ?? 0, 90),
        last_event: "item.agentMessage.delta",
        last_message: `${currentThread?.last_message ?? ""}${payload.delta ?? ""}`,
        updated_at: new Date().toISOString()
      };
    case "turn.completed":
      return {
        id: threadId,
        project_id: projectId || currentThread?.project_id || null,
        status: payload.turn?.status === "completed" ? "idle" : "failed",
        progress: payload.turn?.status === "completed" ? 100 : 0,
        last_event: "turn.completed",
        ...(payload.turn?.error?.message
          ? {
              last_message: String(payload.turn.error.message).trim()
            }
          : {}),
        updated_at: new Date().toISOString()
      };
    default:
      return null;
  }
}

function buildLiveIssuePatch(event, currentIssue = null) {
  const { payload, issueId, threadId, projectId } = getLiveEventContext(event);

  if (!issueId || !threadId) {
    return null;
  }

  if (isTerminalIssueStatus(currentIssue?.status) && isLiveIssueProgressEvent(event?.type)) {
    return null;
  }

  switch (event?.type) {
    case "turn.started":
      return {
        id: issueId,
        thread_id: threadId,
        project_id: projectId || currentIssue?.project_id || null,
        status: "running",
        progress: Math.max(currentIssue?.progress ?? 0, 20),
        last_event: "turn.started",
        updated_at: new Date().toISOString()
      };
    case "turn.starting":
      return {
        id: issueId,
        thread_id: threadId,
        project_id: projectId || currentIssue?.project_id || null,
        status: "running",
        progress: Math.max(currentIssue?.progress ?? 0, 10),
        last_event: "turn.starting",
        updated_at: new Date().toISOString()
      };
    case "turn.plan.updated":
      return {
        id: issueId,
        thread_id: threadId,
        project_id: projectId || currentIssue?.project_id || null,
        status: "running",
        progress: Math.max(currentIssue?.progress ?? 0, 45),
        last_event: "turn.plan.updated",
        updated_at: new Date().toISOString()
      };
    case "turn.diff.updated":
      return {
        id: issueId,
        thread_id: threadId,
        project_id: projectId || currentIssue?.project_id || null,
        status: "running",
        progress: Math.max(currentIssue?.progress ?? 0, 75),
        last_event: "turn.diff.updated",
        updated_at: new Date().toISOString()
      };
    case "item.agentMessage.delta":
      return {
        id: issueId,
        thread_id: threadId,
        project_id: projectId || currentIssue?.project_id || null,
        status: "running",
        progress: Math.max(currentIssue?.progress ?? 0, 90),
        last_event: "item.agentMessage.delta",
        last_message: `${currentIssue?.last_message ?? ""}${payload.delta ?? ""}`,
        updated_at: new Date().toISOString()
      };
    case "thread.status.changed":
      if ((payload.status?.type ?? "") === "waitingForInput") {
        return {
          id: issueId,
          thread_id: threadId,
          project_id: projectId || currentIssue?.project_id || null,
          status: "awaiting_input",
          last_event: "thread.status.changed",
          updated_at: new Date().toISOString()
        };
      }

      if ((payload.status?.type ?? "") === "error") {
        return {
          id: issueId,
          thread_id: threadId,
          project_id: projectId || currentIssue?.project_id || null,
          status: "failed",
          progress: 0,
          last_event: "thread.status.changed",
          updated_at: new Date().toISOString()
        };
      }

      return null;
    case "turn.completed":
      return {
        id: issueId,
        thread_id: threadId,
        project_id: projectId || currentIssue?.project_id || null,
        status: payload.turn?.status === "completed" ? "completed" : "failed",
        progress: payload.turn?.status === "completed" ? 100 : 0,
        last_event: "turn.completed",
        updated_at: new Date().toISOString()
      };
    default:
      return null;
  }
}

function upsertLiveIssuePatch(currentIssues, event) {
  const { issueId } = getLiveEventContext(event);

  if (!issueId) {
    return currentIssues;
  }

  const currentIssue = currentIssues.find((issue) => issue.id === issueId) ?? null;
  const patch = buildLiveIssuePatch(event, currentIssue);

  if (!patch || !currentIssue) {
    return currentIssues;
  }

  return upsertIssue(currentIssues, {
    ...currentIssue,
    ...patch
  });
}

function upsertLiveThreadPatch(currentThreads, event) {
  const { threadId } = getLiveEventContext(event);

  if (!threadId) {
    return currentThreads;
  }

  const currentThread = currentThreads.find((thread) => thread.id === threadId) ?? null;
  const patch = buildLiveThreadPatch(event, currentThread);

  if (!patch || !currentThread) {
    return currentThreads;
  }

  return upsertProjectThread(currentThreads, {
    ...currentThread,
    ...patch
  });
}

function appendIssueDeltaMessage(messages, event, fallbackIssue) {
  const { payload, issueId } = getLiveEventContext(event);

  if (event?.type !== "item.agentMessage.delta" || !payload.delta) {
    return messages;
  }

  const next = [...messages];
  const lastMessage = next.at(-1);

  if (lastMessage?.role === "assistant" && (lastMessage.issue_id ?? "") === issueId) {
    next[next.length - 1] = {
      ...lastMessage,
      content: `${lastMessage.content ?? ""}${payload.delta}`,
      timestamp: new Date().toISOString()
    };
    return next;
  }

  next.push({
    id: `${issueId || "assistant"}-${Date.now()}`,
    role: "assistant",
    kind: "message",
    content: String(payload.delta ?? ""),
    timestamp: new Date().toISOString(),
    issue_id: issueId || fallbackIssue?.id || null,
    issue_title: fallbackIssue?.title ?? "",
    issue_status: fallbackIssue?.status ?? "running"
  });
  return next;
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
              <img src="/octop-login-icon.png" alt="OctOP" className="h-full w-full rounded-3xl object-contain" />
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

function IssueComposer({ language, open, busy, selectedBridgeId, selectedProject, selectedThread, onClose, onSubmit }) {
  const copy = getCopy(language);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const promptInputRef = useRef(null);
  const skipCleanupOnCloseRef = useRef(false);

  useEffect(() => {
    if (!open) {
      setTitle("");
      setPrompt("");
      setAttachments([]);
      setAttachmentError("");
      setAttachmentBusy(false);
      skipCleanupOnCloseRef.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      promptInputRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const handleAppendFiles = async (files) => {
    setAttachmentBusy(true);

    try {
      const result = await appendIssueAttachments(attachments, files, selectedBridgeId);
      setAttachments(result.attachments);
      setAttachmentError(
        result.rejectedCount > 0
          ? result.attachments.length >= MAX_ISSUE_ATTACHMENTS && result.rejectedCount === files.length
            ? copy.issueComposer.attachmentsMaxReached
            : copy.issueComposer.attachmentsRejected(result.rejectedCount)
          : ""
      );
    } finally {
      setAttachmentBusy(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!prompt.trim() || !selectedThread?.id) {
      return;
    }

    skipCleanupOnCloseRef.current = true;

    try {
      await onSubmit({
        title: title.trim(),
        prompt: prompt.trim(),
        attachments: normalizeIssueAttachments(attachments)
      });
    } catch (error) {
      skipCleanupOnCloseRef.current = false;
      throw error;
    }
  };

  const handleClose = async () => {
    if (!skipCleanupOnCloseRef.current) {
      await cleanupIssueAttachmentUploads(attachments);
    }

    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 px-4 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-[2rem] border border-slate-800 bg-slate-950/95 p-6 shadow-2xl shadow-slate-950/60">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold text-white">{copy.issueComposer.title}</h2>
          </div>
          <button
            type="button"
            onClick={() => void handleClose()}
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

          <IssueAttachmentInput
            language={language}
            attachments={attachments}
            errorMessage={attachmentError}
            busy={busy || attachmentBusy}
            onAppendFiles={handleAppendFiles}
            onRemoveAttachment={(attachmentId) => {
              setAttachments((current) => {
                const target = normalizeIssueAttachments(current).find((attachment) => attachment.id === attachmentId);
                if (target) {
                  void cleanupIssueAttachmentUpload(target);
                }
                return removeIssueAttachment(current, attachmentId);
              });
              setAttachmentError("");
            }}
          />

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="issue-prompt">
              {copy.issueComposer.prompt}
            </label>
            <textarea
              ref={promptInputRef}
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
              onClick={() => void handleClose()}
              className="rounded-2xl border border-slate-800 px-4 py-3 text-sm font-medium text-slate-300 transition hover:border-slate-700 hover:text-white"
            >
              {copy.issueComposer.cancel}
            </button>
            <button
              type="submit"
              disabled={busy || attachmentBusy}
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

function IssueEditor({ language, open, busy, selectedBridgeId, issue, onClose, onSubmit }) {
  const copy = getCopy(language);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const promptInputRef = useRef(null);
  const skipCleanupOnCloseRef = useRef(false);

  useEffect(() => {
    if (!open) {
      setTitle("");
      setPrompt("");
      setAttachments([]);
      setAttachmentError("");
      setAttachmentBusy(false);
      skipCleanupOnCloseRef.current = false;
      return;
    }

    setTitle(issue?.title ?? "");
    setPrompt(issue?.prompt ?? "");
    setAttachments(normalizeIssueAttachments(issue?.attachments));
    setAttachmentError("");
  }, [open, issue]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const frameId = window.requestAnimationFrame(() => {
      promptInputRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [open]);

  if (!open || !issue) {
    return null;
  }

  const handleAppendFiles = async (files) => {
    setAttachmentBusy(true);

    try {
      const result = await appendIssueAttachments(attachments, files, selectedBridgeId);
      setAttachments(result.attachments);
      setAttachmentError(
        result.rejectedCount > 0
          ? result.attachments.length >= MAX_ISSUE_ATTACHMENTS && result.rejectedCount === files.length
            ? copy.issueComposer.attachmentsMaxReached
            : copy.issueComposer.attachmentsRejected(result.rejectedCount)
          : ""
      );
    } finally {
      setAttachmentBusy(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!prompt.trim()) {
      return;
    }

    skipCleanupOnCloseRef.current = true;

    try {
      await onSubmit({
        title: title.trim(),
        prompt: prompt.trim(),
        attachments: normalizeIssueAttachments(attachments)
      });
    } catch (error) {
      skipCleanupOnCloseRef.current = false;
      throw error;
    }
  };

  const handleClose = async () => {
    if (!skipCleanupOnCloseRef.current) {
      await cleanupIssueAttachmentUploads(attachments);
    }

    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 px-4 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-[2rem] border border-slate-800 bg-slate-950/95 p-6 shadow-2xl shadow-slate-950/60">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-slate-500">{copy.issueEditor.eyebrow}</p>
            <h2 className="mt-2 text-2xl font-semibold text-white">{copy.issueEditor.title}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">{copy.issueEditor.subtitle}</p>
          </div>
          <button
            type="button"
            onClick={() => void handleClose()}
            className="rounded-full border border-slate-800 bg-slate-900/80 px-3 py-1.5 text-sm text-slate-300 transition hover:border-slate-700 hover:text-white"
          >
            {copy.projectComposer.close}
          </button>
        </div>

        <form className="mt-6 space-y-5" onSubmit={handleSubmit}>
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="edit-issue-title">
              {copy.issueComposer.issueTitle} <span className="text-slate-500">({copy.issueComposer.optional})</span>
            </label>
            <input
              id="edit-issue-title"
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={copy.issueComposer.titlePlaceholder}
              className="w-full rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-white outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/30"
            />
          </div>

          <div>
            <IssueAttachmentInput
              language={language}
              attachments={attachments}
              errorMessage={attachmentError}
              busy={busy || attachmentBusy}
              onAppendFiles={handleAppendFiles}
              onRemoveAttachment={(attachmentId) => {
                setAttachments((current) => {
                  const target = normalizeIssueAttachments(current).find((attachment) => attachment.id === attachmentId);
                  if (target) {
                    void cleanupIssueAttachmentUpload(target);
                  }
                  return removeIssueAttachment(current, attachmentId);
                });
                setAttachmentError("");
              }}
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="edit-issue-prompt">
              {copy.issueComposer.prompt}
            </label>
            <textarea
              ref={promptInputRef}
              id="edit-issue-prompt"
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
              onClick={() => void handleClose()}
              className="rounded-2xl border border-slate-800 px-4 py-3 text-sm font-medium text-slate-300 transition hover:border-slate-700 hover:text-white"
            >
              {copy.issueComposer.cancel}
            </button>
            <button
              type="submit"
              disabled={busy || attachmentBusy}
              className="rounded-2xl bg-sky-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? copy.issueEditor.submitting : copy.issueEditor.submit}
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

function ProjectInstructionDialog({ language, open, busy, project, instructionType, onClose, onSubmit }) {
  const copy = getCopy(language);
  const [value, setValue] = useState("");

  useEffect(() => {
    if (!open) {
      setValue("");
      return;
    }

    if (instructionType === "developer") {
      setValue(project?.developer_instructions ?? "");
      return;
    }

    setValue(project?.base_instructions ?? "");
  }, [instructionType, open, project]);

  if (!open || !project) {
    return null;
  }

  const isDeveloperInstruction = instructionType === "developer";
  const title = isDeveloperInstruction ? copy.footer.developerInstruction : copy.footer.generalInstruction;
  const placeholder = isDeveloperInstruction
    ? copy.footer.instructionDialogPlaceholderDeveloper
    : copy.footer.instructionDialogPlaceholderGeneral;
  const hint = isDeveloperInstruction
    ? copy.footer.instructionDialogHintDeveloper
    : copy.footer.instructionDialogHintGeneral;

  const handleSubmit = async (event) => {
    event.preventDefault();
    await onSubmit({
      instructionType,
      value
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-[24px] border border-slate-800 bg-slate-950/98 p-5 shadow-2xl shadow-slate-950/60">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.28em] text-slate-500">{copy.footer.instructionDialogProject}</p>
            <h2 className="mt-2 text-xl font-semibold text-white">{title}</h2>
            <p className="mt-2 text-sm text-slate-400">{project.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-800 px-3 py-1.5 text-sm text-slate-300 transition hover:border-slate-700 hover:text-white"
          >
            {copy.footer.instructionDialogClose}
          </button>
        </div>

        <form className="mt-5 space-y-4" onSubmit={handleSubmit}>
          <textarea
            rows="12"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder}
            className="w-full min-w-0 rounded-2xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm leading-6 text-white outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/30"
          />

          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 px-4 py-3 text-xs leading-6 text-slate-400">
            {hint}
          </div>

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-800 px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:border-slate-700 hover:text-white"
            >
              {copy.footer.instructionDialogCancel}
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-xl bg-sky-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? copy.footer.instructionDialogSaving : copy.footer.instructionDialogSave}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ThreadCreateDialog({ language, open, busy, project, onClose, onSubmit }) {
  const copy = getCopy(language);
  const [name, setName] = useState("");
  const [developerInstructions, setDeveloperInstructions] = useState("");

  useEffect(() => {
    if (!open) {
      setName("");
      setDeveloperInstructions("");
    }
  }, [open]);

  if (!open || !project) {
    return null;
  }

  const handleSubmit = async (event) => {
    event.preventDefault();
    const accepted = await onSubmit({
      name,
      developerInstructions
    });

    if (accepted !== false) {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-[24px] border border-slate-800 bg-slate-950/98 p-5 shadow-2xl shadow-slate-950/60">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.28em] text-slate-500">{copy.footer.threadCreateDialogProjectHint}</p>
            <h2 className="mt-2 text-xl font-semibold text-white">{copy.footer.threadCreateDialogTitle}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-800 px-3 py-1.5 text-sm text-slate-300 transition hover:border-slate-700 hover:text-white"
          >
            {copy.footer.instructionDialogClose}
          </button>
        </div>

        <form className="mt-5 space-y-4" onSubmit={handleSubmit}>
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="thread-create-name">
              {copy.footer.threadCreateDialogNameLabel}
            </label>
            <input
              id="thread-create-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={copy.footer.threadCreateDialogNamePlaceholder}
              className="w-full min-w-0 rounded-2xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm leading-6 text-white outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/30"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="thread-create-developer-instructions">
              {copy.footer.threadCreateDialogDeveloperLabel}
            </label>
            <textarea
              id="thread-create-developer-instructions"
              rows="10"
              value={developerInstructions}
              onChange={(event) => setDeveloperInstructions(event.target.value)}
              placeholder={copy.footer.threadCreateDialogDeveloperPlaceholder}
              className="w-full min-w-0 rounded-2xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm leading-6 text-white outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-400/30"
            />
          </div>

          <div className="rounded-2xl border border-emerald-400/15 bg-emerald-500/5 px-4 py-3 text-xs leading-6 text-slate-300">
            {copy.footer.threadCreateDialogHint}
          </div>

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-800 px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:border-slate-700 hover:text-white"
            >
              {copy.footer.instructionDialogCancel}
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-xl bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? copy.footer.threadCreateDialogSubmitting : copy.footer.threadCreateDialogSubmit}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ThreadEditDialog({
  language,
  open,
  busy,
  thread,
  threadInstructionSupported = false,
  errorMessage,
  onClose,
  onSubmit
}) {
  const copy = getCopy(language);
  const [name, setName] = useState("");
  const [developerInstructions, setDeveloperInstructions] = useState("");

  useEffect(() => {
    if (!open) {
      setName("");
      setDeveloperInstructions("");
      return;
    }

    setName(thread?.name ?? "");
    setDeveloperInstructions(thread?.developer_instructions ?? "");
  }, [open, thread]);

  if (!open || !thread) {
    return null;
  }

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!name.trim()) {
      return;
    }

    await onSubmit({
      name: name.trim(),
      developerInstructions
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-[24px] border border-slate-800 bg-slate-950/98 p-5 shadow-2xl shadow-slate-950/60">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.28em] text-slate-500">{copy.footer.instructionDialogThread}</p>
            <h2 className="mt-2 text-xl font-semibold text-white">{copy.footer.threadEditDialogTitle}</h2>
            <p className="mt-2 text-sm text-slate-400">{thread.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-800 px-3 py-1.5 text-sm text-slate-300 transition hover:border-slate-700 hover:text-white"
          >
            {copy.footer.instructionDialogClose}
          </button>
        </div>

        <form className="mt-5 space-y-4" onSubmit={handleSubmit}>
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="thread-edit-name">
              {copy.footer.threadEditDialogNameLabel}
            </label>
            <input
              id="thread-edit-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={copy.footer.threadEditDialogNamePlaceholder}
              className="w-full min-w-0 rounded-2xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm leading-6 text-white outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/30"
            />
          </div>

          {threadInstructionSupported ? (
            <>
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="thread-edit-developer-instructions">
                  {copy.footer.developerInstruction}
                </label>
                <textarea
                  id="thread-edit-developer-instructions"
                  rows="12"
                  value={developerInstructions}
                  onChange={(event) => setDeveloperInstructions(event.target.value)}
                  placeholder={copy.footer.instructionDialogPlaceholderThreadDeveloper}
                  className="w-full min-w-0 rounded-2xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm leading-6 text-white outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-400/30"
                />
              </div>

              <div className="rounded-2xl border border-emerald-400/15 bg-emerald-500/5 px-4 py-3 text-xs leading-6 text-slate-300">
                {copy.footer.instructionDialogHintThreadDeveloper}
              </div>
            </>
          ) : (
            <div className="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-3 text-xs leading-6 text-slate-300">
              {copy.footer.threadEditDialogUnsupported}
            </div>
          )}

          {errorMessage ? (
            <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs leading-6 text-rose-200">
              {errorMessage}
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-800 px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:border-slate-700 hover:text-white"
            >
              {copy.footer.instructionDialogCancel}
            </button>
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="rounded-xl bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? copy.footer.instructionDialogSaving : copy.footer.instructionDialogSave}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ThreadContextMenu({
  language,
  menuState,
  onRename,
  onDelete,
  onClose
}) {
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
        className="fixed z-50 min-w-[10rem] overflow-hidden rounded-xl border border-slate-700 bg-slate-900 p-1.5 shadow-[0_18px_60px_rgba(2,6,23,0.55)] ring-1 ring-black/20"
        style={{ left: menuState.x, top: menuState.y }}
      >
        <button
          type="button"
          onClick={onRename}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-slate-800"
        >
          {copy.footer.threadEdit}
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
  onSelect,
  onEdit,
  onContextMenu,
  issueDropActive,
  canAcceptIssueDrop,
  onIssueDragOver,
  onIssueDragLeave,
  onIssueDrop
}) {
  const compactUpdatedAt = formatCompactRelativeTime(thread.updated_at);
  const updatedAtTitle = formatRelativeTime(thread.updated_at, language);

  return (
    <div
      onContextMenu={(event) => onContextMenu(event, thread)}
      onDragOver={(event) => {
        if (!canAcceptIssueDrop) {
          return;
        }

        event.preventDefault();
        onIssueDragOver?.(thread.id);
      }}
      onDragLeave={() => {
        if (!canAcceptIssueDrop) {
          return;
        }

        onIssueDragLeave?.(thread.id);
      }}
      onDrop={(event) => {
        if (!canAcceptIssueDrop) {
          return;
        }

        event.preventDefault();
        onIssueDrop?.(thread.id);
      }}
      className={`group ml-2.5 flex items-center rounded-md px-1.5 py-1.5 transition ${
        issueDropActive
          ? "border border-emerald-400/40 bg-emerald-500/10 text-white"
          : active
            ? "bg-sky-500/10 text-white"
            : "text-slate-400 hover:bg-slate-800 hover:text-white"
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(thread.id)}
        onDoubleClick={() => onEdit(thread.id)}
        className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
      >
        <OverflowRevealText value={getThreadTitle(thread, language)} className="min-w-0 flex-1 text-sm font-medium" />
        <span className="shrink-0 text-[10px] text-slate-500" title={updatedAtTitle}>
          {compactUpdatedAt}
        </span>
      </button>
    </div>
  );
}

function ThreadDetailModal({ language, open, loading, thread, messages, signalNow, onInterrupt, interruptBusy = false, onClose }) {
  const copy = getCopy(language);
  const contextUsageLabel = formatThreadContextUsage(thread, language);
  const contextUsage = getThreadContextUsage(thread);
  const responseSignal = buildThreadResponseSignal({ thread, now: signalNow, language });
  const interruptible = ["running", "awaiting_input"].includes(String(thread?.status ?? "").trim());
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
            {thread ? (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                <span
                  className={`rounded-full border px-2.5 py-1 ${responseSignal ? "" : "border-slate-800 bg-slate-900/70"}`}
                  style={responseSignal?.chipStyle}
                  title={responseSignal?.title}
                >
                  {copy.status[getStatusMeta(thread.status).labelKey] ?? copy.status.queued}
                </span>
                {contextUsageLabel ? (
                  <span className="rounded-full border border-slate-800 bg-slate-900/70 px-2.5 py-1">
                    {contextUsageLabel}
                    {contextUsage?.usedTokens !== null && contextUsage?.windowTokens !== null
                      ? ` · ${contextUsage.usedTokens.toLocaleString(copy.locale)} / ${contextUsage.windowTokens.toLocaleString(copy.locale)}`
                      : ""}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {interruptible && typeof onInterrupt === "function" ? (
              <button
                type="button"
                disabled={interruptBusy}
                onClick={() => onInterrupt(thread.id)}
                className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-sm text-amber-200 transition hover:border-amber-400/40 hover:bg-amber-500/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {interruptBusy ? copy.detail.interrupting : copy.detail.interrupt}
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-800 px-3 py-1.5 text-sm text-slate-300 transition hover:border-slate-700 hover:text-white"
            >
              {copy.detail.close}
            </button>
          </div>
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
                      <RichMessageContent content={message.content} tone={userMessage ? "brand" : "dark"} />
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

function SettingsDialog({ open, session, bridgeSignal, selectedBridge, pushNotificationCard, onClose, onLogout }) {
  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="w-full max-w-lg rounded-[2rem] border border-slate-800 bg-slate-950/95 p-6 shadow-2xl shadow-slate-950/60">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Workspace</p>
            <h2 className="mt-2 text-2xl font-semibold text-white">설정</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">현재 브릿지 기준 푸시 알림과 계정 상태를 확인할 수 있습니다.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-800 bg-slate-900/80 px-3 py-1.5 text-sm text-slate-300 transition hover:border-slate-700 hover:text-white"
          >
            닫기
          </button>
        </div>

        <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white">{session.displayName || session.loginId}</p>
              <p className="mt-1 truncate text-xs text-slate-500">{session.loginId}</p>
            </div>
            <span className="inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px]" style={bridgeSignal.chipStyle}>
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: bridgeSignal.dotColor }} />
              {bridgeSignal.label}
            </span>
          </div>
          <p className="mt-3 truncate text-xs text-slate-400">
            현재 브릿지: {selectedBridge?.device_name ?? selectedBridge?.bridge_id ?? "선택된 브릿지 없음"}
          </p>
        </section>

        <section className="mt-4">{pushNotificationCard}</section>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onLogout}
            className="rounded-2xl border border-rose-400/20 px-4 py-3 text-sm font-medium text-rose-100 transition hover:bg-rose-500/10"
          >
            로그아웃
          </button>
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
  onDragStart,
  onDragEnd,
  onDrop,
  onEdit,
  onSelectionGesture
}) {
  const copy = getCopy(language);
  const highlighted = active || selected;
  const handleCardClick = (event) => {
    if (onSelectionGesture?.(event, "prep", thread.id)) {
      return;
    }

    onSelect(thread.id);
  };
  return (
    <div
      data-testid={`issue-card-${thread.id}`}
      draggable
      onDragStart={() => onDragStart(thread.id)}
      onDragEnd={() => onDragEnd?.()}
      onDoubleClick={() => onEdit(thread.id)}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop(thread.id);
      }}
      className={`rounded-xl border px-3.5 py-3 transition ${
        highlighted ? "border-sky-400/35 bg-slate-800/95" : "border-slate-800 bg-slate-800/85 hover:border-slate-700"
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
            <button type="button" onClick={handleCardClick} className="min-w-0 flex-1 text-left">
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
  multiSelected,
  columnId = "todo",
  onSelect,
  onOpen,
  onDelete,
  onSelectionGesture,
  onDragStart,
  onDragOver,
  onDrop
}) {
  const copy = getCopy(language);
  const progressText = getRealtimeProgressText(thread, language);
  const contextUsageLabel = formatThreadContextUsage(thread, language);
  const highlighted = active || multiSelected;
  const handleCardClick = (event) => {
    if (onSelectionGesture?.(event, columnId, thread.id)) {
      return;
    }

    onSelect(thread.id);
  };
  return (
    <div
      data-testid={`issue-card-${thread.id}`}
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
        highlighted ? "border-sky-400/35 bg-slate-800/95" : "border-slate-800 bg-slate-800/85 hover:border-slate-700"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <button type="button" onClick={handleCardClick} onDoubleClick={() => onOpen?.(thread.id)} className="min-w-0 flex-1 text-left">
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
        <span className="truncate">{progressText}</span>
        {contextUsageLabel ? (
          <>
            <span className="text-slate-700">•</span>
            <span className="truncate">{contextUsageLabel}</span>
          </>
        ) : null}
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

function ThreadCard({
  language,
  thread,
  signalNow,
  active,
  multiSelected,
  columnId,
  onSelect,
  onOpen,
  onSelectionGesture,
  onInterrupt,
  interruptBusy = false,
  onDelete,
  onDragStart,
  onDragEnd
}) {
  const copy = getCopy(language);
  const status = getStatusMeta(thread.status);
  const responseSignal = buildThreadResponseSignal({ thread, now: signalNow, language });
  const progressText = getRealtimeProgressText(thread, language);
  const contextUsageLabel = formatThreadContextUsage(thread, language);
  const highlighted = active || multiSelected;
  const handleClick = (event) => {
    if (onSelectionGesture?.(event, columnId, thread.id)) {
      return;
    }

    onSelect(thread.id);
  };

  return (
    <div
      data-testid={`issue-card-${thread.id}`}
      draggable={typeof onDragStart === "function"}
      onDragStart={() => onDragStart?.(thread.id, columnId)}
      onDragEnd={() => onDragEnd?.()}
      className={`rounded-xl border px-3.5 py-3 transition ${
        highlighted ? "border-sky-400/35 bg-slate-800/95" : "border-slate-800 bg-slate-800/85 hover:border-slate-700"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <button type="button" onClick={handleClick} onDoubleClick={() => onOpen?.(thread.id)} className="min-w-0 flex-1 text-left">
          <div className="flex items-center justify-between gap-3">
        <span
          className={`inline-flex items-center gap-2 rounded-full border px-2 py-1 text-[11px] ${
            responseSignal ? "" : `${status.chipClassName} border-transparent`
          }`}
          style={responseSignal?.chipStyle}
          title={responseSignal?.title}
        >
          <span
            className={`h-2 w-2 rounded-full ${responseSignal ? "" : status.dotClassName}`}
            style={responseSignal ? { backgroundColor: responseSignal.dotColor } : undefined}
          />
          {copy.status[status.labelKey] ?? copy.status.queued}
        </span>
            <span className="text-[11px] text-slate-500">{thread.progress}%</span>
          </div>
          <OverflowRevealText value={getIssueTitle(thread, language)} className="mt-3 text-sm font-medium text-slate-100" />
          <OverflowRevealText value={buildMessagePreview(thread, language)} className="mt-1 text-xs text-slate-500" />
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {typeof onInterrupt === "function" ? (
            <button
              type="button"
              disabled={interruptBusy}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onInterrupt(thread.id);
              }}
              className="rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-1 text-[10px] text-amber-200 transition hover:border-amber-400/40 hover:bg-amber-500/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {interruptBusy ? copy.board.interrupting : copy.board.interrupt}
            </button>
          ) : null}
          {typeof onDelete === "function" ? (
            <button
              type="button"
              onClick={() => onDelete(thread.id)}
              className="rounded-md border border-slate-700 px-1.5 py-1 text-[10px] text-slate-400 transition hover:border-rose-400/40 hover:text-rose-300"
            >
              {copy.board.delete}
            </button>
          ) : null}
        </div>
      </div>
      <div className="mt-3 h-1 rounded-full bg-slate-900">
        <div
          className="h-1 rounded-full bg-gradient-to-r from-sky-400 to-violet-400"
          style={{ width: `${thread.progress}%` }}
        />
      </div>
      <div className="mt-2 flex items-center gap-2 text-[10px] text-slate-500">
        <span>{formatRelativeTime(thread.updated_at, language)}</span>
        <span className="text-slate-700">•</span>
        <span className="truncate">{progressText}</span>
        {contextUsageLabel ? (
          <>
            <span className="text-slate-700">•</span>
            <span className="truncate">{contextUsageLabel}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

function CompletedThreadCard({
  language,
  thread,
  active,
  multiSelected,
  onSelect,
  onOpen,
  onSelectionGesture,
  columnId,
  onDragStart,
  onDragEnd
}) {
  const copy = getCopy(language);
  const contextUsageLabel = formatThreadContextUsage(thread, language);
  const highlighted = active || multiSelected;
  const handleClick = (event) => {
    if (onSelectionGesture?.(event, columnId ?? "done", thread.id)) {
      return;
    }

    onSelect(thread.id);
  };
  return (
    <button
      data-testid={`issue-card-${thread.id}`}
      type="button"
      onClick={handleClick}
      onDoubleClick={() => onOpen(thread.id)}
      draggable={typeof onDragStart === "function"}
      onDragStart={() => onDragStart?.(thread.id, columnId ?? "done")}
      onDragEnd={() => onDragEnd?.()}
      className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
        highlighted ? "border-emerald-400/35 bg-slate-800/95" : "border-slate-800 bg-slate-900/65 hover:border-slate-700"
      }`}
    >
      <div className="flex items-center gap-3">
        <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
        <OverflowRevealText value={getIssueTitle(thread, language)} className="min-w-0 flex-1 text-sm font-medium text-slate-200" />
        {contextUsageLabel ? (
          <span className="shrink-0 rounded-full bg-slate-800 px-2 py-1 text-[10px] text-slate-300">{contextUsageLabel}</span>
        ) : null}
        <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300">{copy.status.completed}</span>
        <span className="shrink-0 text-[10px] text-slate-500">{formatRelativeTime(thread.updated_at, language)}</span>
      </div>
    </button>
  );
}

function ArchiveBasketButton({ active, count, onClick, onDragOver, onDrop }) {
  return (
    <button
      type="button"
      onClick={onClick}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`relative inline-flex h-8 w-8 items-center justify-center rounded-lg border transition ${
        active
          ? "border-sky-400/40 bg-sky-500/10 text-sky-200"
          : "border-slate-800 bg-slate-900/80 text-slate-400 hover:border-slate-700 hover:text-white"
      }`}
      title="보관함"
    >
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path d="M4 7h16M9 7V5.5A1.5 1.5 0 0110.5 4h3A1.5 1.5 0 0115 5.5V7m-8 0l1 11a2 2 0 001.99 1.82h4.02A2 2 0 0016 18l1-11" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      </svg>
      {count > 0 ? (
        <span className="absolute -right-1.5 -top-1.5 inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-slate-200 px-1 text-[10px] font-semibold text-slate-900">
          {count}
        </span>
      ) : null}
    </button>
  );
}

function MainPage({
  language,
  onChangeLanguage,
  session,
  bridges,
  status,
  bridgeAvailable,
  bridgeSignal,
  signalNow,
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
  onUpdateIssueSelection,
  selectedIssueIds,
  archivedIssues,
  issueQueueOrderIds,
  prepIssueOrderIds,
  detailState,
  search,
  loadingState,
  projectBusy,
  threadBusy,
  projectInstructionBusy,
  threadCreateDialogOpen,
  threadInstructionBusy,
  threadInstructionError,
  issueBusy,
  interruptingIssueId,
  startBusy,
  projectComposerOpen,
  composerOpen,
  issueEditorOpen,
  issueEditorBusy,
  editingIssue,
  threadMenuState,
  onSearchChange,
  onSelectBridge,
  onDeleteBridge,
  onSelectProject,
  onExpandProject,
  onSelectProjectThread,
  onSelectIssue,
  onToggleIssueSelection,
  onArchiveIssues,
  onRestoreArchivedIssues,
  onStartSelectedIssues,
  onOpenIssueDetail,
  onInterruptIssue,
  onDeleteIssue,
  onDeleteProject,
  onRenameProject,
  onCreateThread,
  onCloseThreadCreateDialog,
  onSubmitThreadCreateDialog,
  onOpenThreadInstructionDialog,
  onDeleteThread,
  onOpenThreadMenu,
  onCloseThreadMenu,
  onDragQueueIssue,
  onDragPrepIssues,
  onDragMovableIssue,
  onDragRetryIssues,
  draggingMovableIssueIds,
  draggingRetryIssueIds,
  issueMoveTargetThreadId,
  onIssueMoveTargetOver,
  onIssueMoveTargetLeave,
  onMoveIssuesToThread,
  onDragArchiveIssues,
  onInterruptIssueToPrep,
  onEditPrepIssue,
  onOpenProjectComposer,
  onOpenProjectInstructionDialog,
  onOpenComposer,
  onCloseProjectComposer,
  onCloseComposer,
  onCloseIssueEditor,
  onBrowseWorkspaceRoot,
  onBrowseFolder,
  onSelectWorkspace,
  onSubmitProject,
  projectInstructionDialogOpen,
  projectInstructionType,
  onCloseProjectInstructionDialog,
  onSubmitProjectInstruction,
  threadInstructionDialogOpen,
  threadInstructionSupported,
  onCloseThreadInstructionDialog,
  onSubmitThreadInstruction,
  onSubmitIssue,
  onSubmitIssueEdit,
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
  const [expandedProjectIds, setExpandedProjectIds] = useState({});
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [boardScrollbarVisible, setBoardScrollbarVisible] = useState(false);
  const [boardScrollbarDragging, setBoardScrollbarDragging] = useState(false);
  const [boardScrollState, setBoardScrollState] = useState({
    clientWidth: 0,
    scrollWidth: 0,
    scrollLeft: 0
  });
  const [selectionAnchor, setSelectionAnchor] = useState({
    threadId: "",
    columnId: ""
  });
  const languageMenuRef = useRef(null);
  const boardScrollRef = useRef(null);
  const boardScrollbarTrackRef = useRef(null);
  const boardScrollbarDragRef = useRef({
    active: false,
    pointerId: null,
    pointerOffsetX: 0
  });
  const archiveViewerRef = useRef(null);
  const [archiveViewerColumnId, setArchiveViewerColumnId] = useState("");
  const selectedBridge =
    bridges.find((bridge) => bridge.bridge_id === selectedBridgeId) ?? bridges[0] ?? null;
  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? null;
  const selectedProjectHasBaseInstructions = Boolean(selectedProject?.base_instructions?.trim());
  const selectedProjectHasDeveloperInstructions = Boolean(selectedProject?.developer_instructions?.trim());
  const bridgeUnavailableMessage =
    language === "ko"
      ? "브릿지가 연결되지 않아 프로젝트와 쓰레드를 표시할 수 없습니다."
      : "Projects and threads are unavailable while the bridge is offline.";
  const scopedProjectThreads = projectThreads.filter(
    (thread) => !selectedProjectId || thread.project_id === selectedProjectId
  );
  const keyword = search.trim().toLowerCase();
  const filteredIssues = issues.filter((thread) => {
    if (!keyword) {
      return true;
    }

    return (
      thread.title.toLowerCase().includes(keyword) ||
      String(thread.prompt ?? "").toLowerCase().includes(keyword) ||
      String(thread.last_message ?? "").toLowerCase().includes(keyword)
    );
  });
  const archivedIssuesByColumn = useMemo(() => {
    const grouped = {
      review: [],
      done: []
    };

    for (const issue of archivedIssues) {
      const columnId = getArchivedIssueColumnId(issue);

      if (!columnId) {
        continue;
      }

      grouped[columnId].push(issue);
    }

    return grouped;
  }, [archivedIssues]);
  const archivedCounts = useMemo(
    () => ({
      review: archivedIssuesByColumn.review.length,
      done: archivedIssuesByColumn.done.length
    }),
    [archivedIssuesByColumn]
  );
  const archiveViewerIssues = archiveViewerColumnId ? archivedIssuesByColumn[archiveViewerColumnId] ?? [] : [];
  const selectedProjectThread =
  scopedProjectThreads.find((thread) => thread.id === selectedProjectThreadId) ??
  null;
  const selectedThreadContextUsage = getThreadContextUsage(selectedProjectThread);
  const selectedThreadUsageLabel =
    selectedThreadContextUsage?.percent != null
      ? language === "ko"
        ? `사용률 ${selectedThreadContextUsage.percent}%`
        : `Usage ${selectedThreadContextUsage.percent}%`
      : "";
  const selectedThreadUsageTitle =
    selectedThreadContextUsage?.percent != null
      ? [
          selectedProjectThread ? getThreadTitle(selectedProjectThread, language) : "",
          selectedThreadUsageLabel,
          selectedThreadContextUsage.usedTokens !== null && selectedThreadContextUsage.windowTokens !== null
            ? `${selectedThreadContextUsage.usedTokens.toLocaleString()} / ${selectedThreadContextUsage.windowTokens.toLocaleString()}`
            : ""
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
  const markProjectsExpanded = useCallback((projectIds = []) => {
    setExpandedProjectIds((current) => {
      let changed = false;
      const next = { ...current };

      for (const projectId of projectIds) {
        if (!projectId || next[projectId] === true) {
          continue;
        }

        next[projectId] = true;
        changed = true;
      }

      return changed ? next : current;
    });
  }, []);
  const handleSelectProject = useCallback((projectId) => {
    onSelectProject(projectId);
    markProjectsExpanded([selectedProjectId, projectId]);
  }, [markProjectsExpanded, onSelectProject, selectedProjectId]);
  const handleSelectSidebarThread = useCallback((threadId) => {
    if (!threadId) {
      onSelectProjectThread("");
      return;
    }

    const thread = projectThreads.find((item) => item.id === threadId) ?? null;
    const targetProjectId = thread?.project_id ?? "";

    if (targetProjectId && targetProjectId !== selectedProjectId) {
      onSelectProject(targetProjectId);
    }

    markProjectsExpanded([selectedProjectId, targetProjectId]);
    onSelectProjectThread(threadId);
  }, [markProjectsExpanded, onSelectProject, onSelectProjectThread, projectThreads, selectedProjectId]);
  const handleToggleProjectExpanded = useCallback((projectId) => {
    let nextExpanded = false;

    setExpandedProjectIds((current) => {
      nextExpanded = !(current[projectId] ?? (projectId === selectedProjectId));
      return {
        ...current,
        [projectId]: nextExpanded
      };
    });

    if (nextExpanded) {
      void onExpandProject(projectId);
    }
  }, [onExpandProject, selectedProjectId]);

  const columns = COLUMN_ORDER.map((column) => {
    const columnThreads = filteredIssues.filter((thread) => getStatusMeta(thread.status).column === column.id);

    if (column.id === "prep") {
      const orderedIds = prepIssueOrderIds.filter((threadId) => columnThreads.some((thread) => thread.id === threadId));
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
  }).filter((column) => !HIDE_EMPTY_COLUMN_IDS.has(column.id) || column.threads.length > 0);
  const columnThreadOrder = useMemo(() => {
    const map = new Map();

    for (const column of columns) {
      map.set(
        column.id,
        column.threads.map((thread) => thread.id)
      );
    }

    return map;
  }, [columns]);
  const boardContentWidth = Math.max(columns.length * 320 + Math.max(columns.length - 1, 0) * 24 + 128, 0);
  const prepSelectedCount = filteredIssues.filter(
    (thread) => selectedIssueIds.includes(thread.id) && getStatusMeta(thread.status).column === "prep"
  ).length;
  const handleExclusiveIssueSelection = useCallback(
    (threadId, columnId = "") => {
      if (!threadId) {
        onUpdateIssueSelection([]);
        setSelectionAnchor({
          threadId: "",
          columnId: ""
        });
        onSelectIssue("");
        return;
      }

      onUpdateIssueSelection([threadId]);
      setSelectionAnchor({
        threadId,
        columnId
      });
      onSelectIssue(threadId);
    },
    [onSelectIssue, onUpdateIssueSelection]
  );
  const handleIssueSelectionGesture = useCallback(
    (event, columnId, threadId) => {
      if (!event || !threadId) {
        return false;
      }

      const metaKey = event.metaKey || event.ctrlKey;
      const shiftKey = event.shiftKey;

      if (!metaKey && !shiftKey) {
        return false;
      }

      event.preventDefault();
      event.stopPropagation();

      let computedSelection = [];
      onUpdateIssueSelection((currentSelection) => {
        let nextSelection = currentSelection;

        if (shiftKey) {
          const order = columnThreadOrder.get(columnId) ?? [];
          const anchorId = selectionAnchor.threadId;

          if (!anchorId || selectionAnchor.columnId !== columnId) {
            nextSelection = [threadId];
          } else {
            const anchorIndex = order.indexOf(anchorId);
            const targetIndex = order.indexOf(threadId);

            if (anchorIndex === -1 || targetIndex === -1) {
              nextSelection = [threadId];
            } else {
              const [start, end] =
                anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
              const idsInRange = order.slice(start, end + 1);
              const combined = new Set(currentSelection);

              for (const id of idsInRange) {
                combined.add(id);
              }

              nextSelection = Array.from(combined);
            }
          }
        } else if (metaKey) {
          nextSelection = currentSelection.includes(threadId)
            ? currentSelection.filter((id) => id !== threadId)
            : [...currentSelection, threadId];
        }

        computedSelection = nextSelection;
        return nextSelection;
      });

      setSelectionAnchor((current) => {
        if (shiftKey && current.threadId && current.columnId === columnId) {
          return current;
        }

        return {
          threadId,
          columnId
        };
      });

      if (computedSelection.length === 0) {
        onSelectIssue("");
      } else if (computedSelection.includes(threadId)) {
        onSelectIssue(threadId);
      } else {
        onSelectIssue(computedSelection[computedSelection.length - 1]);
      }

      return true;
    },
    [columnThreadOrder, onSelectIssue, onUpdateIssueSelection, selectionAnchor]
  );
  const handleTogglePrepSelection = useCallback(
    (threadId) => {
      setSelectionAnchor({
        threadId,
        columnId: "prep"
      });
      onToggleIssueSelection(threadId);
    },
    [onToggleIssueSelection]
  );
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
    if (!archiveViewerColumnId) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (!archiveViewerRef.current?.contains(event.target)) {
        setArchiveViewerColumnId("");
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [archiveViewerColumnId]);
  useEffect(() => {
    if (archiveViewerColumnId && archiveViewerIssues.length === 0) {
      setArchiveViewerColumnId("");
    }
  }, [archiveViewerColumnId, archiveViewerIssues.length]);

  useEffect(() => {
    markProjectsExpanded([selectedProjectId]);
  }, [markProjectsExpanded, selectedProjectId]);

  useEffect(() => {
    setExpandedProjectIds((current) => {
      let changed = false;
      const next = {};

      for (const project of projects) {
        if (Object.prototype.hasOwnProperty.call(current, project.id)) {
          next[project.id] = current[project.id];
        } else {
          next[project.id] = false;
          changed = true;
        }
      }

      if (Object.keys(current).length !== Object.keys(next).length) {
        changed = true;
      }

      return changed ? next : current;
    });
  }, [projects]);

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
              {bridgeAvailable ? (
                <>
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
                        disabled={!selectedProject || threadBusy}
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
                        const expanded = expandedProjectIds[project.id] ?? active;

                        return (
                          <div key={project.id} className="rounded-md px-0.5 py-0.5">
                            <div
                              className={`w-full rounded-md px-1.5 py-1.5 transition ${
                                active ? "bg-slate-800 text-white" : "text-slate-400 hover:bg-slate-800 hover:text-white"
                              }`}
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      handleToggleProjectExpanded(project.id);
                                    }}
                                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-500 transition hover:bg-slate-900 hover:text-slate-200"
                                    aria-label={expanded ? "collapse project tree" : "expand project tree"}
                                  >
                                    {expanded ? (
                                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path
                                          d="M3 9.5A2.5 2.5 0 015.5 7H9l1.4-1.6a2 2 0 011.5-.7h2.8A2.3 2.3 0 0116.5 6H18a3 3 0 013 3v1.5a2.5 2.5 0 01-2.5 2.5H10"
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                          strokeWidth="1.8"
                                        />
                                        <path
                                          d="M3.5 11.5h8.7a2.2 2.2 0 011.7.8l1.2 1.5h3.4a2 2 0 012 2v1.2A2.5 2.5 0 0118 19.5H6A2.5 2.5 0 013.5 17z"
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                          strokeWidth="1.8"
                                        />
                                      </svg>
                                    ) : (
                                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path
                                          d="M3.5 8.5A2.5 2.5 0 016 6h3.3l1.4-1.6a2 2 0 011.5-.7h5.3A2.5 2.5 0 0120 6.2V8"
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                          strokeWidth="1.8"
                                        />
                                        <path
                                          d="M3.5 8.5h17v7A2.5 2.5 0 0118 18H6a2.5 2.5 0 01-2.5-2.5z"
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                          strokeWidth="1.8"
                                        />
                                      </svg>
                                    )}
                                  </button>
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
                                      onClick={() => handleSelectProject(project.id)}
                                      onDoubleClick={() => beginProjectRename(project)}
                                      className="min-w-0 flex-1 text-left"
                                    >
                                      <OverflowRevealText value={project.name} className="text-sm font-medium" />
                                    </button>
                                  )}
                                </div>
                                <div className="flex items-center gap-2">
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
                            {expanded ? (
                              <div className="mt-1.5 space-y-1">
                                {sidebarThreads.map((thread) => (
                                  <SidebarThreadItem
                                    key={thread.id}
                                    language={language}
                                    thread={thread}
                                    active={thread.id === selectedProjectThreadId}
                                    onSelect={handleSelectSidebarThread}
                                    onEdit={onOpenThreadInstructionDialog}
                                    onContextMenu={onOpenThreadMenu}
                                    issueDropActive={issueMoveTargetThreadId === thread.id}
                                    canAcceptIssueDrop={draggingMovableIssueIds.length > 0 && thread.id !== selectedProjectThreadId}
                                    onIssueDragOver={onIssueMoveTargetOver}
                                    onIssueDragLeave={onIssueMoveTargetLeave}
                                    onIssueDrop={onMoveIssuesToThread}
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
                </>
              ) : (
                <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 px-4 py-4 text-sm text-slate-400">
                  {bridgeUnavailableMessage}
                </div>
              )}
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
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  {bridgeAvailable && selectedProject ? (
                    <>
                      <div className="max-w-[14rem] shrink-0 md:max-w-[18rem] lg:max-w-[22rem]">
                        <OverflowRevealText value={selectedProject.name} className="font-medium text-white" />
                      </div>
                    </>
                  ) : null}
                  {bridgeAvailable && selectedProject && selectedProjectThread ? (
                    <>
                      <span className="text-slate-700">/</span>
                      <div className="min-w-0 flex-1">
                        <OverflowRevealText value={selectedProjectThread.name} className="font-medium text-sky-200" />
                      </div>
                    </>
                  ) : null}
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
                  disabled={!bridgeAvailable || prepSelectedCount === 0 || startBusy}
                  className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-300 transition hover:border-emerald-400/40 hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {startBusy ? copy.board.moving : copy.board.moveSelectedToTodo(prepSelectedCount)}
                </button>

                <button
                  type="button"
                  onClick={onOpenComposer}
                  disabled={!bridgeAvailable || !selectedProjectThread}
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
                {bridgeAvailable ? (
                  <>
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
                  </>
                ) : (
                  <div className="rounded-lg border border-dashed border-slate-800 bg-slate-900/40 px-3 py-3 text-sm text-slate-400">
                    {bridgeUnavailableMessage}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3 text-xs text-slate-500 md:px-8">
              <div className="flex items-center gap-3">
                {bridgeAvailable ? (
                  <>
                    <span>{selectedProjectThread ? copy.board.issueCount(filteredIssues.length) : copy.board.selectProject}</span>
                    <span className="text-slate-700">•</span>
                    <span>{copy.board.prepHint}</span>
                  </>
                ) : (
                  <span>{bridgeUnavailableMessage}</span>
                )}
              </div>
              <div className="hidden items-center gap-2 md:flex">
                {bridgeAvailable && selectedProjectThread && selectedThreadContextUsage?.percent != null ? (
                  <span className="text-slate-500" title={selectedThreadUsageTitle}>
                    {selectedThreadUsageLabel}
                  </span>
                ) : null}
                {loadingState === "loading" ? <span>{copy.board.syncing}</span> : null}
              </div>
            </div>

            <div className="octop-board-page flex flex-1 min-h-0 flex-col">
              {bridgeAvailable ? (
                <>
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
                    data-testid={`board-column-${column.id}`}
                    className={`flex w-80 flex-col rounded-2xl ${column.id === "todo" ? "ring-1 ring-transparent" : ""}`}
                    onDragOver={(event) => {
                      if (column.id === "todo" || column.id === "prep") {
                        event.preventDefault();
                      }
                    }}
                    onDrop={(event) => {
                      if (column.id === "todo") {
                        event.preventDefault();
                        if (draggingRetryIssueIds.length > 0) {
                          onDragRetryIssues.drop();
                          return;
                        }
                        onDragPrepIssues.drop();
                        return;
                      }

                      if (column.id === "prep") {
                        event.preventDefault();
                        onInterruptIssueToPrep();
                        return;
                      }
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
                      {column.id === "review" || column.id === "done" ? (
                        <div className="relative" ref={archiveViewerColumnId === column.id ? archiveViewerRef : undefined}>
                          <ArchiveBasketButton
                            active={archiveViewerColumnId === column.id}
                            count={archivedCounts[column.id]}
                            onClick={() => setArchiveViewerColumnId((current) => (current === column.id ? "" : column.id))}
                            onDragOver={(event) => {
                              event.preventDefault();
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              onDragArchiveIssues.drop();
                            }}
                          />
                          {archiveViewerColumnId === column.id ? (
                            <div className="absolute right-0 top-full z-20 mt-2 w-80 rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl shadow-slate-950/60">
                              <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
                                <p className="text-xs font-semibold text-slate-200">{copy.board.archivedListTitle}</p>
                                <button
                                  type="button"
                                  onClick={() => setArchiveViewerColumnId("")}
                                  className="text-[10px] lowercase text-slate-500 transition hover:text-slate-200"
                                >
                                  {copy.detail.close}
                                </button>
                              </div>
                              <div className="custom-scrollbar max-h-72 space-y-3 overflow-y-auto px-4 py-3">
                                {archiveViewerIssues.length === 0 ? (
                                  <p className="text-xs text-slate-500">{copy.board.archivedEmpty}</p>
                                ) : (
                                  archiveViewerIssues.map((thread) => (
                                    <div key={`archived-${column.id}-${thread.id}`} className="rounded-xl border border-slate-800/80 bg-slate-900/80 px-3 py-3">
                                      <p className="text-sm font-medium text-white">
                                        <OverflowRevealText value={getIssueTitle(thread, language)} />
                                      </p>
                                      <p className="mt-1 text-[11px] text-slate-500">
                                        {copy.columns[column.id]} • {formatRelativeTime(thread.updated_at, language)}
                                      </p>
                                      <div className="mt-3 flex items-center justify-between">
                                        <span className="text-[11px] text-slate-500">{copy.status[getStatusMeta(thread.status).labelKey]}</span>
                                        <button
                                          type="button"
                                          onClick={() => onRestoreArchivedIssues([thread.id])}
                                          className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 transition hover:border-emerald-400/40 hover:text-emerald-200"
                                        >
                                          {copy.board.restore}
                                        </button>
                                      </div>
                                    </div>
                                  ))
                                )}
                              </div>
                              {archiveViewerIssues.length > 0 ? (
                                <div className="border-t border-slate-800 px-4 py-3">
                                  <button
                                    type="button"
                                    onClick={() => onRestoreArchivedIssues(archiveViewerIssues.map((thread) => thread.id))}
                                    className="w-full rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200 transition hover:border-emerald-400/40 hover:text-emerald-200"
                                  >
                                    {copy.board.restoreAll}
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-[10px] text-transparent">–</span>
                      )}
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
                              onSelect={(threadId) => handleExclusiveIssueSelection(threadId, column.id)}
                              onToggle={handleTogglePrepSelection}
                              onDelete={onDeleteIssue}
                              onDragStart={onDragPrepIssues.start}
                              onDragEnd={onDragMovableIssue.clear}
                              onDrop={(threadId) => onInterruptIssueToPrep(threadId)}
                              onEdit={onEditPrepIssue}
                              onSelectionGesture={handleIssueSelectionGesture}
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
                                multiSelected={selectedIssueIds.includes(thread.id)}
                                columnId={column.id}
                                onSelect={(threadId) => handleExclusiveIssueSelection(threadId, column.id)}
                                onOpen={onOpenIssueDetail}
                                onDelete={onDeleteIssue}
                                onSelectionGesture={handleIssueSelectionGesture}
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
                                active={thread.id === selectedIssueId}
                                multiSelected={selectedIssueIds.includes(thread.id)}
                                columnId={column.id}
                                onSelect={(threadId) => handleExclusiveIssueSelection(threadId, column.id)}
                                onOpen={onOpenIssueDetail}
                                onSelectionGesture={handleIssueSelectionGesture}
                                onDragStart={onDragArchiveIssues.start}
                                onDragEnd={onDragArchiveIssues.clear}
                              />
                            );
                          }

                          return (
                            <ThreadCard
                              key={thread.id}
                              language={language}
                              thread={thread}
                              signalNow={signalNow}
                              active={thread.id === selectedIssueId}
                              multiSelected={selectedIssueIds.includes(thread.id)}
                              columnId={column.id}
                              onSelect={(threadId) => handleExclusiveIssueSelection(threadId, column.id)}
                              onOpen={onOpenIssueDetail}
                              onInterrupt={column.id === "running" ? onInterruptIssue : undefined}
                              interruptBusy={interruptingIssueId === thread.id}
                              onSelectionGesture={handleIssueSelectionGesture}
                              onDelete={column.id === "review" ? onDeleteIssue : undefined}
                              onDragStart={
                                column.id === "review"
                                  ? isRetryableIssueStatus(thread.status)
                                    ? onDragRetryIssues.start
                                    : onDragArchiveIssues.start
                                  : column.id === "running"
                                    ? onDragMovableIssue.start
                                    : undefined
                              }
                              onDragEnd={
                                column.id === "review"
                                  ? isRetryableIssueStatus(thread.status)
                                    ? onDragRetryIssues.clear
                                    : onDragArchiveIssues.clear
                                  : column.id === "running"
                                    ? onDragMovableIssue.clear
                                    : undefined
                              }
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
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center px-6 py-10">
                  <div className="max-w-md rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 px-6 py-8 text-center text-sm text-slate-400">
                    {bridgeUnavailableMessage}
                  </div>
                </div>
              )}
            </div>
            
          </main>
        </div>

        <footer className="sticky bottom-0 z-30 border-t border-slate-800 bg-slate-950/95 px-4 py-2.5 backdrop-blur md:px-6 lg:px-8">
          <div className="flex flex-col gap-2 text-[11px] text-slate-400 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="inline-flex items-center gap-2 rounded-full border px-2.5 py-1"
                style={bridgeSignal.chipStyle}
                title={
                  selectedBridge
                    ? `${bridgeSignal.title} ${language === "ko" ? "우클릭으로 브릿지를 삭제할 수 있습니다." : "Right-click to delete this bridge."}`
                    : bridgeSignal.title
                }
                onContextMenu={(event) => {
                  if (!selectedBridge) {
                    return;
                  }

                  event.preventDefault();
                  onDeleteBridge();
                }}
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: bridgeSignal.dotColor }} />
                {bridgeSignal.label}
              </span>
              {bridgeAvailable ? (
                <>
                  <span className="rounded-full bg-slate-900/80 px-2.5 py-1">
                    {copy.board.projectsChip(status.counts?.projects ?? projects.length)}
                  </span>
                  <span className="rounded-full bg-slate-900/80 px-2.5 py-1">
                    {copy.board.threadsChip(status.counts?.threads ?? projectThreads.length)}
                  </span>
                  <button
                    type="button"
                    onClick={() => onOpenProjectInstructionDialog("base")}
                    disabled={!selectedProject}
                    title={selectedProject ? copy.footer.generalInstruction : copy.footer.instructionMissingProject}
                    className={`rounded-full border px-2.5 py-1 transition ${
                      selectedProjectHasBaseInstructions
                        ? "border-sky-400/30 bg-sky-500/10 text-sky-200 hover:border-sky-300/40"
                        : "border-slate-800 bg-slate-900/80 text-slate-300 hover:border-slate-700 hover:text-white"
                    } disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    {copy.footer.generalInstruction} ·{" "}
                    {selectedProjectHasBaseInstructions ? copy.footer.instructionEdit : copy.footer.instructionSet}
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenProjectInstructionDialog("developer")}
                    disabled={!selectedProject}
                    title={selectedProject ? copy.footer.developerInstruction : copy.footer.instructionMissingProject}
                    className={`rounded-full border px-2.5 py-1 transition ${
                      selectedProjectHasDeveloperInstructions
                        ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200 hover:border-emerald-300/40"
                        : "border-slate-800 bg-slate-900/80 text-slate-300 hover:border-slate-700 hover:text-white"
                    } disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    {copy.footer.developerInstruction} ·{" "}
                    {selectedProjectHasDeveloperInstructions ? copy.footer.instructionEdit : copy.footer.instructionSet}
                  </button>
                </>
              ) : null}
            </div>

	            <div className="flex flex-wrap items-center justify-end gap-2">
	              <button
	                type="button"
	                onClick={() => setSettingsOpen(true)}
	                className="rounded-full border border-slate-700 px-3 py-1.5 text-[11px] font-medium text-slate-200 transition hover:border-slate-500 hover:text-white"
	              >
	                설정
	              </button>
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
        selectedBridgeId={selectedBridgeId}
        selectedProject={selectedProject}
        selectedThread={selectedProjectThread}
        onClose={onCloseComposer}
        onSubmit={onSubmitIssue}
      />
      <IssueEditor
        language={language}
        open={issueEditorOpen}
        busy={issueEditorBusy}
        selectedBridgeId={selectedBridgeId}
        issue={editingIssue}
        onClose={onCloseIssueEditor}
        onSubmit={onSubmitIssueEdit}
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
	      <ProjectInstructionDialog
	        language={language}
	        open={projectInstructionDialogOpen}
        busy={projectInstructionBusy}
        project={selectedProject}
        instructionType={projectInstructionType}
	        onClose={onCloseProjectInstructionDialog}
	        onSubmit={onSubmitProjectInstruction}
	      />
      <ThreadEditDialog
        language={language}
        open={threadInstructionDialogOpen}
        busy={threadInstructionBusy}
        thread={selectedProjectThread}
        threadInstructionSupported={threadInstructionSupported}
        errorMessage={threadInstructionError}
        onClose={onCloseThreadInstructionDialog}
        onSubmit={onSubmitThreadInstruction}
      />
      <ThreadCreateDialog
        language={language}
        open={threadCreateDialogOpen}
        busy={threadBusy}
        project={selectedProject}
        onClose={onCloseThreadCreateDialog}
        onSubmit={onSubmitThreadCreateDialog}
      />
	      <SettingsDialog
	        open={settingsOpen}
	        session={session}
	        bridgeSignal={bridgeSignal}
	        selectedBridge={selectedBridge}
	        pushNotificationCard={
	          <PushNotificationCard
	            apiRequest={apiRequest}
	            session={session}
	            selectedBridgeId={selectedBridgeId}
	          />
	        }
	        onClose={() => setSettingsOpen(false)}
	        onLogout={onLogout}
	      />
	      <ThreadDetailModal
	        language={language}
        open={detailState.open}
        loading={detailState.loading}
        thread={detailState.thread}
        messages={detailState.messages}
        signalNow={signalNow}
        onInterrupt={onInterruptIssue}
        interruptBusy={interruptingIssueId === detailState.thread?.id}
        onClose={onCloseDetail}
      />
      <ThreadContextMenu
        language={language}
        menuState={threadMenuState}
        onRename={() => {
          onCloseThreadMenu();
          if (threadMenuState.thread) {
            onOpenThreadInstructionDialog(threadMenuState.thread.id);
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
  const [bridgeDeleteBusy, setBridgeDeleteBusy] = useState(false);
  const [bridgeStatusById, setBridgeStatusById] = useState({});
  const [projects, setProjects] = useState([]);
  const [projectThreads, setProjectThreads] = useState([]);
  const [issues, setIssues] = useState([]);
  const [workspaceRoots, setWorkspaceRoots] = useState([]);
  const [folderState, setFolderState] = useState({ path: "", parent_path: null, entries: [] });
  const [folderLoading, setFolderLoading] = useState(false);
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState("");
  const [selectedBridgeId, setSelectedBridgeId] = useState(() =>
    typeof window === "undefined" ? "" : readStoredBridgeId()
  );
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedProjectThreadId, setSelectedProjectThreadId] = useState("");
  const [selectedIssueId, setSelectedIssueId] = useState("");
  const [selectedIssueIds, setSelectedIssueIds] = useState([]);
  const pendingPushDeepLinkRef = useRef(readPushDeepLink());
  const [issueQueueOrderIds, setIssueQueueOrderIds] = useState([]);
  const [prepIssueOrderIds, setPrepIssueOrderIds] = useState([]);
  const [draggingIssueId, setDraggingIssueId] = useState("");
  const [draggingPrepIssueIds, setDraggingPrepIssueIds] = useState([]);
  const [draggingMovableIssueIds, setDraggingMovableIssueIds] = useState([]);
  const [draggingRetryIssueIds, setDraggingRetryIssueIds] = useState([]);
  const [issueMoveTargetThreadId, setIssueMoveTargetThreadId] = useState("");
  const [draggingArchiveIssueIds, setDraggingArchiveIssueIds] = useState([]);
  const [archivedIssuesState, setArchivedIssuesState] = useState({});
  const [archivedIssues, setArchivedIssues] = useState([]);
  const [archivesHydrated, setArchivesHydrated] = useState(false);
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
  const [streamActivityAt, setStreamActivityAt] = useState(null);
  const [streamNow, setStreamNow] = useState(() => Date.now());
  const [eventStreamReconnectToken, setEventStreamReconnectToken] = useState(0);
  const [bridgeDisconnectOverrideById, setBridgeDisconnectOverrideById] = useState({});
  const [projectComposerOpen, setProjectComposerOpen] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [threadCreateDialogOpen, setThreadCreateDialogOpen] = useState(false);
  const [projectInstructionDialogOpen, setProjectInstructionDialogOpen] = useState(false);
  const [projectInstructionBusy, setProjectInstructionBusy] = useState(false);
  const [projectInstructionType, setProjectInstructionType] = useState("base");
  const [threadInstructionDialogOpen, setThreadInstructionDialogOpen] = useState(false);
  const [threadInstructionBusy, setThreadInstructionBusy] = useState(false);
  const [threadInstructionError, setThreadInstructionError] = useState("");
  const [threadBusy, setThreadBusy] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [issueBusy, setIssueBusy] = useState(false);
  const [interruptingIssueId, setInterruptingIssueId] = useState("");
  const [startBusy, setStartBusy] = useState(false);
  const [issueEditorOpen, setIssueEditorOpen] = useState(false);
  const [issueEditorBusy, setIssueEditorBusy] = useState(false);
  const [editingIssueId, setEditingIssueId] = useState("");
  const issuesRef = useRef([]);
  const issueLoadRequestIdRef = useRef(0);
  const loadedProjectThreadsRef = useRef({});
  const pendingProjectThreadLoadsRef = useRef(new Map());
  const selectedBridgeIdRef = useRef("");
  const selectedProjectIdRef = useRef("");
  const bridgeWorkspaceRequestIdRef = useRef(0);
  const selectedProjectThreadIdRef = useRef("");
  const projectThreadsRef = useRef([]);
  const archivedIssuesStateRef = useRef({});
  const archivedIssueSnapshotsRef = useRef({});
  const visibleIssueSnapshotsRef = useRef({});
  const threadLiveProgressAtByIdRef = useRef(new Map());
  const activeIssueSyncStateRef = useRef({ inFlight: false, issueId: "" });
  const lastForegroundResumeAtRef = useRef(0);
  const activeIssuePollPausedUntilRef = useRef(0);
  const eventStreamConnectedAtRef = useRef(0);
  const foregroundResumeEnabledAtRef = useRef(0);
  const scheduledResumeTimerRef = useRef(null);
  const scheduledResumeReasonsRef = useRef(new Set());
  const detailStateRef = useRef({
    open: false,
    loading: false,
    thread: null,
    messages: []
  });
  const copy = getCopy(language);
  const status = useMemo(
    () => normalizeBridgeStatus(selectedBridgeId ? bridgeStatusById[selectedBridgeId] : null),
    [bridgeStatusById, selectedBridgeId]
  );
  const threadInstructionSupported = bridgeSupportsThreadDeveloperInstructions(status);
  const bridgeConnected = Boolean(status.app_server?.connected) &&
    !Boolean(selectedBridgeId && bridgeDisconnectOverrideById[selectedBridgeId]);
  const bridgeAvailable = Boolean(selectedBridgeId) && bridgeConnected;
  const bridgeSignal = useMemo(
    () =>
      buildBridgeSignal({
        connected: bridgeConnected,
        lastSocketActivityAt: Date.parse(status.app_server?.last_socket_activity_at ?? ""),
        statusUpdatedAt: Date.parse(status.updated_at ?? ""),
        now: streamNow,
        language,
        connectedLabel: copy.board.bridgeOk,
        disconnectedLabel: copy.board.bridgeDown
      }),
    [
      bridgeDisconnectOverrideById,
      bridgeConnected,
      copy.board.bridgeDown,
      copy.board.bridgeOk,
      language,
      status.app_server?.last_socket_activity_at,
      status.updated_at,
      streamNow
    ]
  );
  const markStreamActivity = useCallback(() => {
    setStreamActivityAt(Date.now());
  }, []);
  const markBridgeDisconnectedOverride = useCallback((bridgeId) => {
    const normalized = String(bridgeId ?? "").trim();

    if (!normalized) {
      return;
    }

    setBridgeDisconnectOverrideById((current) => ({
      ...current,
      [normalized]: Date.now()
    }));
  }, []);
  const clearBridgeDisconnectedOverride = useCallback((bridgeId) => {
    const normalized = String(bridgeId ?? "").trim();

    if (!normalized) {
      return;
    }

    setBridgeDisconnectOverrideById((current) => {
      if (!current[normalized]) {
        return current;
      }

      const next = { ...current };
      delete next[normalized];
      return next;
    });
  }, []);
  const selectedProjectThread = useMemo(
    () => projectThreads.find((thread) => thread.id === selectedProjectThreadId) ?? null,
    [projectThreads, selectedProjectThreadId]
  );
  const selectedActiveIssue = useMemo(
    () => findActiveIssueForThread(issues, selectedProjectThread?.active_physical_thread_id ?? null),
    [issues, selectedProjectThread?.active_physical_thread_id]
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStreamNow(Date.now());
    }, 5000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const orderedPrepIssueIds = useMemo(() => {
    const prepIssues = issues
      .filter((issue) => getStatusMeta(issue.status).column === "prep")
      .sort((left, right) => {
        const leftHasOrder = Number.isFinite(left.prep_position);
        const rightHasOrder = Number.isFinite(right.prep_position);

        if (leftHasOrder && rightHasOrder && left.prep_position !== right.prep_position) {
          return left.prep_position - right.prep_position;
        }

        if (leftHasOrder && !rightHasOrder) {
          return -1;
        }

        if (!leftHasOrder && rightHasOrder) {
          return 1;
        }

        return Date.parse(right.updated_at) - Date.parse(left.updated_at);
      })
      .map((issue) => issue.id);

    if (prepIssueOrderIds.length === 0) {
      return prepIssues;
    }

    const normalized = prepIssueOrderIds.filter((issueId) => prepIssues.includes(issueId));
    const trailing = prepIssues.filter((issueId) => !normalized.includes(issueId));
    return [...normalized, ...trailing];
  }, [issues, prepIssueOrderIds]);
  const editingIssue = useMemo(() => {
    if (!issueEditorOpen || !editingIssueId) {
      return null;
    }

    return issues.find((issue) => issue.id === editingIssueId) ?? null;
  }, [issueEditorOpen, editingIssueId, issues]);
  const updateArchivedIssuesState = useCallback((updater) => {
    setArchivedIssuesState((current) => {
      const nextState = normalizeArchivedIssuesState(typeof updater === "function" ? updater(current) : updater);
      archivedIssuesStateRef.current = nextState;
      writeStoredArchivedIssuesState(nextState);
      return nextState;
    });
  }, []);
  const persistArchivedIssuesState = useCallback(async (sessionArg, nextState, requestOptions = {}) => {
    if (!sessionArg?.loginId) {
      return;
    }

    const normalizedState = normalizeArchivedIssuesState(nextState);
    await apiRequest(`/api/dashboard/archives?login_id=${encodeURIComponent(sessionArg.loginId)}`, {
      method: "PUT",
      ...requestOptions,
      body: JSON.stringify({
        archives: normalizedState
      })
    });
  }, []);
  const syncArchivedIssuesState = useCallback((sessionArg, nextState, requestOptions = {}) => {
    if (!sessionArg?.loginId) {
      return;
    }

    void persistArchivedIssuesState(sessionArg, nextState, requestOptions).catch((error) => {
      setRecentEvents((current) => [
        {
          id: createId(),
          type: "dashboard.archives.save.failed",
          timestamp: new Date().toISOString(),
          summary: error.message
        },
        ...current
      ].slice(0, 20));
    });
  }, [persistArchivedIssuesState]);
  const loadArchivedIssuesState = useCallback(async (sessionArg) => {
    if (!sessionArg?.loginId) {
      archivedIssuesStateRef.current = {};
      setArchivedIssuesState({});
      setArchivesHydrated(false);
      return {};
    }

    setArchivesHydrated(false);
    const localState = readStoredArchivedIssuesState();
    archivedIssuesStateRef.current = localState;
    setArchivedIssuesState(localState);
    setArchivesHydrated(true);

    const payload = await apiRequest(`/api/dashboard/archives?login_id=${encodeURIComponent(sessionArg.loginId)}`);
    const remoteState = normalizeArchivedIssuesState(payload?.archives);
    const nextState = mergeArchivedIssuesState(archivedIssuesStateRef.current, remoteState);
    const serializedRemoteState = JSON.stringify(remoteState);
    const serializedNextState = JSON.stringify(nextState);

    archivedIssuesStateRef.current = nextState;
    setArchivedIssuesState(nextState);
    writeStoredArchivedIssuesState(nextState);

    if (serializedNextState !== serializedRemoteState) {
      syncArchivedIssuesState(sessionArg, nextState);
    }

    return nextState;
  }, [syncArchivedIssuesState]);
  const markProjectThreadsLoaded = useCallback((bridgeId, projectId) => {
    if (!bridgeId || !projectId) {
      return;
    }

    loadedProjectThreadsRef.current = {
      ...loadedProjectThreadsRef.current,
      [bridgeId]: {
        ...(loadedProjectThreadsRef.current[bridgeId] ?? {}),
        [projectId]: true
      }
    };
  }, []);
  const replaceArchivedIssuesForCurrentScope = useCallback((bridgeId, threadId, nextIssues) => {
    archivedIssueSnapshotsRef.current = replaceArchivedIssueSnapshotForScope(
      archivedIssueSnapshotsRef.current,
      bridgeId,
      threadId,
      nextIssues
    );

    if (selectedBridgeIdRef.current === bridgeId && selectedProjectThreadIdRef.current === threadId) {
      setArchivedIssues(nextIssues);
    }
  }, []);
  const replaceVisibleIssuesForCurrentScope = useCallback((bridgeId, threadId, nextIssues) => {
    visibleIssueSnapshotsRef.current = replaceVisibleIssueSnapshotForScope(
      visibleIssueSnapshotsRef.current,
      bridgeId,
      threadId,
      nextIssues
    );

    if (selectedBridgeIdRef.current === bridgeId && selectedProjectThreadIdRef.current === threadId) {
      setIssues(nextIssues);
    }
  }, []);
  const clearArchivedIssuesForScope = useCallback((bridgeId, threadId) => {
    if (!bridgeId || !threadId) {
      return;
    }

    const nextArchivedState = removeArchivedIssuesStateScope(
      archivedIssuesStateRef.current,
      bridgeId,
      threadId
    );

    updateArchivedIssuesState(nextArchivedState);
    replaceArchivedIssuesForCurrentScope(bridgeId, threadId, []);
    syncArchivedIssuesState(session, nextArchivedState, { keepalive: true });
  }, [replaceArchivedIssuesForCurrentScope, session, syncArchivedIssuesState, updateArchivedIssuesState]);
  const applyIssueStateForScope = useCallback((bridgeId, threadId, nextIssues) => {
    const normalizedIssues = mergeIssues([], nextIssues ?? []);
    const { visibleIssues, archivedIssues: nextArchivedIssues } = partitionIssuesByArchiveState(
      normalizedIssues,
      archivedIssuesStateRef.current,
      bridgeId,
      threadId
    );

    replaceArchivedIssuesForCurrentScope(bridgeId, threadId, nextArchivedIssues);
    replaceVisibleIssuesForCurrentScope(bridgeId, threadId, visibleIssues);

    return {
      visibleIssues,
      archivedIssues: nextArchivedIssues,
      allIssues: normalizedIssues
    };
  }, [replaceArchivedIssuesForCurrentScope, replaceVisibleIssuesForCurrentScope]);

  const setBridgeStatus = useCallback((bridgeId, updater) => {
    const normalizedBridgeId = String(bridgeId ?? "").trim();

    if (!normalizedBridgeId) {
      return;
    }

    setBridgeStatusById((current) => {
      const currentStatus = normalizeBridgeStatus(current[normalizedBridgeId]);
      const nextStatus = typeof updater === "function" ? updater(currentStatus) : updater;

      return {
        ...current,
        [normalizedBridgeId]: normalizeBridgeStatus(nextStatus)
      };
    });
  }, []);

  const updateStatusCounts = useCallback((nextCounts, bridgeId = selectedBridgeIdRef.current) => {
    setBridgeStatus(bridgeId, (current) => ({
      ...current,
      counts: {
        projects: nextCounts.projects ?? current.counts?.projects ?? 0,
        threads: nextCounts.threads ?? current.counts?.threads ?? 0
      }
    }));
  }, [setBridgeStatus]);

  useEffect(() => {
    storeLanguage(language);
  }, [language]);

  useEffect(() => {
    issuesRef.current = issues;
  }, [issues]);

  useEffect(() => {
    projectThreadsRef.current = projectThreads;
  }, [projectThreads]);

  useEffect(() => {
    archivedIssuesStateRef.current = archivedIssuesState;
  }, [archivedIssuesState]);

  useEffect(() => {
    if (!session?.loginId) {
      archivedIssuesStateRef.current = {};
      setArchivedIssuesState({});
      setArchivesHydrated(false);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        await loadArchivedIssuesState(session);
      } catch (error) {
        if (cancelled) {
          return;
        }

        const fallbackState = readStoredArchivedIssuesState();
        archivedIssuesStateRef.current = fallbackState;
        setArchivedIssuesState(fallbackState);
        setArchivesHydrated(true);
        setRecentEvents((current) => [
          {
            id: createId(),
            type: "dashboard.archives.load.failed",
            timestamp: new Date().toISOString(),
            summary: error.message
          },
          ...current
        ].slice(0, 20));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadArchivedIssuesState, session]);

  useEffect(() => {
    if (!selectedBridgeId) {
      return;
    }

    const validThreadIds = new Set(
      projectThreads.map((thread) => thread.id).filter((threadId) => typeof threadId === "string" && threadId.length > 0)
    );

    archivedIssueSnapshotsRef.current = pruneArchivedIssueSnapshotsForBridge(
      archivedIssueSnapshotsRef.current,
      selectedBridgeId,
      validThreadIds
    );
    visibleIssueSnapshotsRef.current = pruneArchivedIssueSnapshotsForBridge(
      visibleIssueSnapshotsRef.current,
      selectedBridgeId,
      validThreadIds
    );
  }, [projectThreads, selectedBridgeId]);

  useEffect(() => {
    selectedBridgeIdRef.current = selectedBridgeId;
    storeSelectedBridgeId(selectedBridgeId);
  }, [selectedBridgeId]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  useEffect(() => {
    selectedProjectThreadIdRef.current = selectedProjectThreadId;
  }, [selectedProjectThreadId]);

  useEffect(() => {
    setIssues(visibleIssueSnapshotsRef.current[selectedBridgeId]?.[selectedProjectThreadId] ?? []);
    setArchivedIssues(archivedIssueSnapshotsRef.current[selectedBridgeId]?.[selectedProjectThreadId] ?? []);
  }, [selectedBridgeId, selectedProjectThreadId]);

  useEffect(() => {
    if (!selectedBridgeId || !selectedProjectThreadId) {
      return;
    }

    const combinedIssues = mergeIssues(
      issuesRef.current,
      archivedIssueSnapshotsRef.current[selectedBridgeId]?.[selectedProjectThreadId] ?? []
    );

    if (combinedIssues.length === 0) {
      replaceArchivedIssuesForCurrentScope(selectedBridgeId, selectedProjectThreadId, []);
      replaceVisibleIssuesForCurrentScope(selectedBridgeId, selectedProjectThreadId, []);
      return;
    }

    applyIssueStateForScope(selectedBridgeId, selectedProjectThreadId, combinedIssues);
  }, [applyIssueStateForScope, archivedIssuesState, replaceArchivedIssuesForCurrentScope, replaceVisibleIssuesForCurrentScope, selectedBridgeId, selectedProjectThreadId]);

  useEffect(() => {
    detailStateRef.current = detailState;
  }, [detailState]);

  async function loadBridges(sessionArg) {
    if (!sessionArg?.loginId) {
      return [];
    }

    const nextBridges = (await apiRequest(
      `/api/bridges?login_id=${encodeURIComponent(sessionArg.loginId)}`
    )).bridges ?? [];

    setBridges(nextBridges);
    const storedBridgeId = readStoredBridgeId();
    setSelectedBridgeId((current) => {
      if (current && nextBridges.some((bridge) => bridge.bridge_id === current)) {
        return current;
      }

      if (storedBridgeId && nextBridges.some((bridge) => bridge.bridge_id === storedBridgeId)) {
        return storedBridgeId;
      }

      return nextBridges[0]?.bridge_id ?? "";
    });

    return nextBridges;
  }

  async function loadBridgeWorkspace(sessionArg, bridgeId) {
    if (!sessionArg?.loginId || !bridgeId) {
      setProjects([]);
      setProjectThreads([]);
      loadedProjectThreadsRef.current = {};
      pendingProjectThreadLoadsRef.current.clear();
      setIssues([]);
      archivedIssueSnapshotsRef.current = {};
      visibleIssueSnapshotsRef.current = {};
      setArchivedIssues([]);
      setStreamActivityAt(null);
      return;
    }

    const requestId = bridgeWorkspaceRequestIdRef.current + 1;
    bridgeWorkspaceRequestIdRef.current = requestId;
    setLoadingState("loading");

    try {
      const nextStatus = await apiRequest(
        `/api/bridge/status?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
      );

      if (bridgeWorkspaceRequestIdRef.current !== requestId || selectedBridgeIdRef.current !== bridgeId) {
        return;
      }

      if (nextStatus?.app_server?.connected) {
        clearBridgeDisconnectedOverride(bridgeId);
      } else {
        markBridgeDisconnectedOverride(bridgeId);
      }
      setBridgeStatus(bridgeId, nextStatus);
      markStreamActivity();

      if (!nextStatus?.app_server?.connected) {
        setProjects([]);
        setProjectThreads([]);
        loadedProjectThreadsRef.current = {};
        pendingProjectThreadLoadsRef.current.clear();
        setIssues([]);
        archivedIssueSnapshotsRef.current = {};
        visibleIssueSnapshotsRef.current = {};
        setArchivedIssues([]);
        setSelectedProjectId("");
        setSelectedProjectThreadId("");
        setSelectedIssueId("");
        setSelectedIssueIds([]);
        setIssueQueueOrderIds([]);
        setPrepIssueOrderIds([]);
        setLoadingState("ready");
        return;
      }

      const nextProjects = await apiRequest(
        `/api/projects?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
      );

      if (bridgeWorkspaceRequestIdRef.current !== requestId || selectedBridgeIdRef.current !== bridgeId) {
        return;
      }

      setProjects(nextProjects.projects ?? []);
      setSelectedProjectId((current) => {
        if (current && nextProjects.projects?.some((project) => project.id === current)) {
          return current;
        }

        return nextProjects.projects?.[0]?.id || "";
      });
      setProjectThreads([]);
      loadedProjectThreadsRef.current = {};
      pendingProjectThreadLoadsRef.current.clear();
      setIssues([]);
      archivedIssueSnapshotsRef.current = {};
      visibleIssueSnapshotsRef.current = {};
      setArchivedIssues([]);
      setLoadingState("ready");
    } catch (error) {
      if (bridgeWorkspaceRequestIdRef.current !== requestId || selectedBridgeIdRef.current !== bridgeId) {
        return;
      }

      markBridgeDisconnectedOverride(bridgeId);
      setBridgeStatus(bridgeId, (current) => ({
        ...current,
        app_server: {
          ...(current?.app_server ?? {}),
          connected: false,
          initialized: false,
          last_error: error.message
        },
        updated_at: new Date().toISOString()
      }));
      setProjects([]);
      setProjectThreads([]);
      loadedProjectThreadsRef.current = {};
      pendingProjectThreadLoadsRef.current.clear();
      setIssues([]);
      archivedIssueSnapshotsRef.current = {};
      visibleIssueSnapshotsRef.current = {};
      setArchivedIssues([]);
      setSelectedProjectId("");
      setSelectedProjectThreadId("");
      setSelectedIssueId("");
      setSelectedIssueIds([]);
      setIssueQueueOrderIds([]);
      setPrepIssueOrderIds([]);
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

  const handleDeleteBridge = async () => {
    if (!session?.loginId || !selectedBridgeId || bridgeDeleteBusy) {
      return;
    }

    const bridgeLabel =
      bridges.find((bridge) => bridge.bridge_id === selectedBridgeId)?.device_name ?? selectedBridgeId;

    if (!window.confirm(copy.board.deleteBridgeConfirm(bridgeLabel))) {
      return;
    }

    setBridgeDeleteBusy(true);

    try {
      const response = await apiRequest(
        `/api/bridges/${encodeURIComponent(selectedBridgeId)}?login_id=${encodeURIComponent(session.loginId)}`,
        {
          method: "DELETE"
        }
      );

      const deletedBridgeId = response?.deleted_bridge_id ?? selectedBridgeId;
      const nextBridges = Array.isArray(response?.bridges) ? response.bridges : [];
      const nextArchivedState = removeArchivedIssuesStateBridge(archivedIssuesStateRef.current, deletedBridgeId);
      const nextLoadedProjectThreads = { ...loadedProjectThreadsRef.current };

      delete nextLoadedProjectThreads[deletedBridgeId];
      loadedProjectThreadsRef.current = nextLoadedProjectThreads;

      const nextPendingProjectThreadLoads = new Map(pendingProjectThreadLoadsRef.current);
      for (const cacheKey of nextPendingProjectThreadLoads.keys()) {
        if (cacheKey.startsWith(`${deletedBridgeId}:`)) {
          nextPendingProjectThreadLoads.delete(cacheKey);
        }
      }
      pendingProjectThreadLoadsRef.current = nextPendingProjectThreadLoads;

      setBridgeStatusById((current) => {
        if (!current[deletedBridgeId]) {
          return current;
        }

        const next = { ...current };
        delete next[deletedBridgeId];
        return next;
      });

      archivedIssueSnapshotsRef.current = removeBridgeIssueSnapshots(archivedIssueSnapshotsRef.current, deletedBridgeId);
      visibleIssueSnapshotsRef.current = removeBridgeIssueSnapshots(visibleIssueSnapshotsRef.current, deletedBridgeId);
      updateArchivedIssuesState(nextArchivedState);
      syncArchivedIssuesState(session, nextArchivedState);

      setBridges(nextBridges);
      setSelectedBridgeId((current) => {
        if (current && current !== deletedBridgeId && nextBridges.some((bridge) => bridge.bridge_id === current)) {
          return current;
        }

        return nextBridges[0]?.bridge_id ?? "";
      });
      setProjectComposerOpen(false);
      setProjectInstructionDialogOpen(false);
      setThreadInstructionDialogOpen(false);
      setComposerOpen(false);
      setIssueEditorOpen(false);
      setEditingIssueId("");
    } catch (error) {
      setRecentEvents((current) => [
        {
          id: createId(),
          type: "bridge.delete.failed",
          timestamp: new Date().toISOString(),
          summary: error.message
        },
        ...current
      ].slice(0, 20));
    } finally {
      setBridgeDeleteBusy(false);
    }
  };

  async function loadProjectThreads(sessionArg, bridgeId, projectId) {
    if (!sessionArg?.loginId || !bridgeId || !projectId) {
      setProjectThreads([]);
      return [];
    }

    const payload = await apiRequest(
      `/api/projects/${encodeURIComponent(projectId)}/threads?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
    );
    const nextThreads = mergeProjectThreads([], payload?.threads ?? []);

    if (selectedBridgeIdRef.current !== bridgeId) {
      return [];
    }

    setProjectThreads((current) => replaceProjectThreadsForProject(current, nextThreads, projectId));
    markProjectThreadsLoaded(bridgeId, projectId);
    return nextThreads;
  }

  async function ensureProjectThreadsLoaded(sessionArg, bridgeId, projectId) {
    if (!sessionArg?.loginId || !bridgeId || !projectId) {
      return [];
    }

    if (loadedProjectThreadsRef.current[bridgeId]?.[projectId]) {
      return [];
    }

    const cacheKey = `${bridgeId}:${projectId}`;
    const pendingRequest = pendingProjectThreadLoadsRef.current.get(cacheKey);

    if (pendingRequest) {
      return pendingRequest;
    }

    const request = loadProjectThreads(sessionArg, bridgeId, projectId).finally(() => {
      pendingProjectThreadLoadsRef.current.delete(cacheKey);
    });

    pendingProjectThreadLoadsRef.current.set(cacheKey, request);
    return request;
  }

  const loadThreadIssues = useCallback(async (sessionArg, bridgeId, threadId) => {
    if (!sessionArg?.loginId || !bridgeId || !threadId) {
      setIssues([]);
      return [];
    }

    const requestId = issueLoadRequestIdRef.current + 1;
    issueLoadRequestIdRef.current = requestId;
    replaceVisibleIssuesForCurrentScope(
      bridgeId,
      threadId,
      visibleIssueSnapshotsRef.current[bridgeId]?.[threadId] ?? []
    );

    const payload = await apiRequest(
      `/api/threads/${encodeURIComponent(threadId)}/issues?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
    );
    const nextIssues = mergeIssues([], payload?.issues ?? []);

    if (issueLoadRequestIdRef.current !== requestId || selectedProjectThreadIdRef.current !== threadId) {
      return nextIssues;
    }

    applyIssueStateForScope(bridgeId, threadId, nextIssues);
    return nextIssues;
  }, [applyIssueStateForScope, replaceVisibleIssuesForCurrentScope]);

  const loadIssueDetail = useCallback(async (sessionArg, bridgeId, issueId) => {
    if (!sessionArg?.loginId || !bridgeId || !issueId) {
      return null;
    }

    return apiRequest(
      `/api/issues/${encodeURIComponent(issueId)}?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
    );
  }, []);

  const syncActiveIssueDetail = useCallback(async (sessionArg, bridgeId, threadId, issueId, options = {}) => {
    if (!sessionArg?.loginId || !bridgeId || !threadId || !issueId) {
      return null;
    }

    const { force = false } = options;
    const syncState = activeIssueSyncStateRef.current;

    if (syncState.inFlight && !force && syncState.issueId === issueId) {
      return null;
    }

    activeIssueSyncStateRef.current = {
      inFlight: true,
      issueId
    };

    try {
      const payload = await loadIssueDetail(sessionArg, bridgeId, issueId);
      const nextIssue = normalizeIssue(payload?.issue, threadId);

      if (nextIssue) {
        const currentScopedIssues = mergeIssues(
          visibleIssueSnapshotsRef.current[bridgeId]?.[threadId] ?? [],
          archivedIssueSnapshotsRef.current[bridgeId]?.[threadId] ?? []
        );
        applyIssueStateForScope(bridgeId, threadId, mergeIssues(currentScopedIssues, [nextIssue]));
      }

      if (payload?.thread) {
        setProjectThreads((current) => upsertProjectThread(current, payload.thread));
      }

      if (detailStateRef.current.open && detailStateRef.current.thread?.id === issueId) {
        setDetailState((current) => ({
          ...current,
          loading: false,
          thread: payload?.issue ?? current.thread,
          messages: payload?.messages ?? current.messages
        }));
      }

      return payload;
    } finally {
      activeIssueSyncStateRef.current = {
        inFlight: false,
        issueId: ""
      };
    }
  }, [applyIssueStateForScope, loadIssueDetail]);

  const handleDashboardForegroundResume = useCallback(async (reason = "foreground_resume") => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }

    if (!session?.loginId || !selectedBridgeId) {
      return;
    }

    const now = Date.now();

    if (now - lastForegroundResumeAtRef.current < 1500) {
      return;
    }

    if (reason.startsWith("dashboard_resume:") && now < foregroundResumeEnabledAtRef.current) {
      return;
    }

    lastForegroundResumeAtRef.current = now;
    activeIssuePollPausedUntilRef.current = now + ACTIVE_ISSUE_POLL_RESUME_GRACE_MS;

    const streamConnectedRecently =
      eventStreamConnectedAtRef.current > 0 &&
      now - eventStreamConnectedAtRef.current < ACTIVE_ISSUE_POLL_SUPPRESS_AFTER_LIVE_MS;
    const streamActiveRecently =
      Number.isFinite(streamActivityAt) &&
      streamActivityAt > 0 &&
      now - streamActivityAt < ACTIVE_ISSUE_POLL_SUPPRESS_AFTER_LIVE_MS;
    const shouldReconnectStream = !streamConnectedRecently && !streamActiveRecently;

    if (shouldReconnectStream) {
      setEventStreamReconnectToken((current) => current + 1);
    }

    if (!selectedProjectId) {
      return;
    }

    const nextThreads = await loadProjectThreads(session, selectedBridgeId, selectedProjectId);
    const activeThreadId = selectedProjectThreadIdRef.current;

    if (!activeThreadId) {
      return;
    }

    threadLiveProgressAtByIdRef.current.delete(activeThreadId);
    const nextIssues = await loadThreadIssues(session, selectedBridgeId, activeThreadId);
    const resumedThread =
      nextThreads.find((thread) => thread.id === activeThreadId) ??
      projectThreadsRef.current.find((thread) => thread.id === activeThreadId) ??
      null;
    const resumedActiveIssue = findActiveIssueForThread(nextIssues, resumedThread?.active_physical_thread_id ?? null);

    if (resumedActiveIssue?.id) {
      await syncActiveIssueDetail(session, selectedBridgeId, activeThreadId, resumedActiveIssue.id, { force: true });
    }

    if (detailStateRef.current.open && detailStateRef.current.thread?.id && detailStateRef.current.thread.id !== resumedActiveIssue?.id) {
      await syncActiveIssueDetail(session, selectedBridgeId, activeThreadId, detailStateRef.current.thread.id, { force: true });
    }
  }, [
    loadProjectThreads,
    loadThreadIssues,
    selectedBridgeId,
    selectedProjectId,
    session,
    streamActivityAt,
    syncActiveIssueDetail
  ]);

  const scheduleDashboardForegroundResume = useCallback((reason = "foreground_resume") => {
    if (typeof window === "undefined") {
      return;
    }

    scheduledResumeReasonsRef.current.add(reason);

    if (scheduledResumeTimerRef.current) {
      return;
    }

    scheduledResumeTimerRef.current = window.setTimeout(() => {
      const reasonLabel = [...scheduledResumeReasonsRef.current].join(",");
      scheduledResumeReasonsRef.current.clear();
      scheduledResumeTimerRef.current = null;
      void handleDashboardForegroundResume(reasonLabel || reason);
    }, DASHBOARD_RESUME_COALESCE_MS);
  }, [handleDashboardForegroundResume]);

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

  const refreshBridgeStatus = useCallback(
    async (sessionArg = session, bridgeId = selectedBridgeId) => {
      if (!sessionArg?.loginId || !bridgeId) {
        return false;
      }

      try {
        const nextStatus = await apiRequest(
          `/api/bridge/status?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
        );

        if (selectedBridgeIdRef.current !== bridgeId) {
          return false;
        }

        if (nextStatus?.app_server?.connected) {
          clearBridgeDisconnectedOverride(bridgeId);
        } else {
          markBridgeDisconnectedOverride(bridgeId);
        }
        setBridgeStatus(bridgeId, nextStatus);
        return true;
      } catch (error) {
        if (selectedBridgeIdRef.current !== bridgeId) {
          return false;
        }

        markBridgeDisconnectedOverride(bridgeId);
        setBridgeStatus(bridgeId, (current) => ({
          ...current,
          app_server: {
            ...(current?.app_server ?? {}),
            connected: false,
            initialized: false,
            last_error: error.message
          },
          updated_at: new Date().toISOString()
        }));
        return false;
      }
    },
    [selectedBridgeId, session, clearBridgeDisconnectedOverride, markBridgeDisconnectedOverride, setBridgeStatus]
  );
  useEffect(() => {
    return subscribeBridgeRequestFailures((event) => {
      if (!event?.bridgeId || event.bridgeId !== selectedBridgeIdRef.current) {
        return;
      }

      markBridgeDisconnectedOverride(event.bridgeId);
      setBridgeStatus(event.bridgeId, (current) => ({
        ...current,
        app_server: {
          ...(current?.app_server ?? {}),
          connected: false,
          initialized: false,
          last_error: event.message ?? "bridge transport unavailable"
        },
        updated_at: new Date().toISOString()
      }));
    });
  }, [markBridgeDisconnectedOverride, setBridgeStatus]);

  useEffect(() => {
    if (!session?.loginId) {
      return;
    }

    void loadBridges(session);
  }, [session]);

  useEffect(() => {
    setStreamActivityAt(null);
    eventStreamConnectedAtRef.current = 0;
    foregroundResumeEnabledAtRef.current = Date.now() + DASHBOARD_RESUME_ENABLE_DELAY_MS;
  }, [selectedBridgeId]);

  useEffect(() => {
    if (!session?.loginId || !selectedBridgeId) {
      return undefined;
    }

    const eventSource = new EventSource(
      `${API_BASE_URL}/api/events?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`
    );
    eventStreamConnectedAtRef.current = Date.now();

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

    eventSource.addEventListener("ready", () => {
      markStreamActivity();
    });

    eventSource.addEventListener("snapshot", (event) => {
      try {
        markStreamActivity();
        const payload = JSON.parse(event.data);
        if (selectedBridgeIdRef.current) {
          if (payload?.app_server?.connected) {
            clearBridgeDisconnectedOverride(selectedBridgeIdRef.current);
          } else {
            markBridgeDisconnectedOverride(selectedBridgeIdRef.current);
          }
          setBridgeStatus(selectedBridgeIdRef.current, payload);
        }
      } catch {
        // ignore malformed snapshot
      }
    });

    eventSource.addEventListener("message", (event) => {
      try {
        markStreamActivity();
        const payload = JSON.parse(event.data);
        const activeBridgeId = selectedBridgeIdRef.current;
        const activeThreadId = selectedProjectThreadIdRef.current;
        const { threadId: eventThreadId, issueId: eventIssueId, projectId: eventProjectId } = getLiveEventContext(payload);
        const summary =
          payload?.payload?.thread?.title ??
          issuesRef.current.find((issue) => issue.id === eventIssueId)?.title ??
          payload?.payload?.error ??
          payload?.payload?.projects?.[0]?.name ??
          payload?.payload?.threads?.[0]?.name ??
          payload?.payload?.issues?.[0]?.title ??
          payload?.type;

        appendEvent(payload.type, summary);

        if (payload.type === "bridge.status.updated") {
          if (selectedBridgeIdRef.current) {
            if (payload.payload?.app_server?.connected) {
              clearBridgeDisconnectedOverride(selectedBridgeIdRef.current);
            } else {
              markBridgeDisconnectedOverride(selectedBridgeIdRef.current);
            }
            setBridgeStatus(selectedBridgeIdRef.current, payload.payload);
          }
          return;
        }

        if (eventThreadId && eventThreadId === activeThreadId && isLiveIssueProgressEvent(payload.type)) {
          threadLiveProgressAtByIdRef.current.set(eventThreadId, Date.now());
        }

        if (
          eventThreadId &&
          eventThreadId === activeThreadId &&
          (
            payload.type === "turn.completed" ||
            (
              payload.type === "thread.status.changed" &&
              ["waitingForInput", "idle", "error"].includes(String(payload.payload?.status?.type ?? "").trim())
            )
          )
        ) {
          threadLiveProgressAtByIdRef.current.delete(eventThreadId);
        }

        if (eventThreadId) {
          setProjectThreads((current) => upsertLiveThreadPatch(current, payload));
        }

        if (eventThreadId && eventThreadId === activeThreadId) {
          setIssues((current) => upsertLiveIssuePatch(current, payload));
        }

        if (
          detailStateRef.current.open &&
          detailStateRef.current.thread?.id &&
          eventIssueId &&
          detailStateRef.current.thread.id === eventIssueId
        ) {
          setDetailState((current) => {
            const nextThread = current.thread
              ? {
                  ...current.thread,
                  ...(buildLiveIssuePatch(payload, current.thread) ?? {})
                }
              : current.thread;

            return {
              ...current,
              thread: nextThread,
              messages: appendIssueDeltaMessage(current.messages, payload, nextThread)
            };
          });
        }

        if (payload.type === "bridge.projects.updated") {
          const nextProjects = payload.payload?.projects ?? [];
          setProjects(nextProjects);
          updateStatusCounts({ projects: nextProjects.length }, activeBridgeId);
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
          const projectId = payload.payload?.project_id ?? nextThreads[0]?.project_id ?? eventProjectId ?? "";
          const scope = payload.payload?.scope ?? "project";
          const activeProjectId = selectedProjectIdRef.current;
          if (scope === "all") {
            for (const thread of nextThreads) {
              if (thread.project_id) {
                markProjectThreadsLoaded(activeBridgeId, thread.project_id);
              }
            }
          } else if (projectId) {
            markProjectThreadsLoaded(activeBridgeId, projectId);
          }
          if (scope === "all") {
            updateStatusCounts({ threads: nextThreads.length }, activeBridgeId);
          }
          setProjectThreads((current) =>
            scope === "all" ? mergeProjectThreads([], nextThreads) : replaceProjectThreadsForProject(current, nextThreads, projectId)
          );
          setSelectedProjectThreadId((current) => {
            const candidateThreads =
              scope === "all"
                ? nextThreads.filter((thread) => !activeProjectId || thread.project_id === activeProjectId)
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

          if (!shouldApplyRealtimeIssueToSelectedThread(activeThreadId, targetThreadId)) {
            return;
          }

          const nextIssues = mergeIssues([], payload.payload?.issues ?? []);
          applyIssueStateForScope(activeBridgeId, targetThreadId || activeThreadId, nextIssues);

          if (!findActiveIssueForThread(nextIssues, projectThreadsRef.current.find((thread) => thread.id === (targetThreadId || activeThreadId))?.active_physical_thread_id ?? null)) {
            threadLiveProgressAtByIdRef.current.delete(targetThreadId || activeThreadId);
          }
          return;
        }

        if (payload.payload?.thread) {
          setProjectThreads((current) => upsertProjectThread(current, payload.payload.thread));
          return;
        }

        if (payload.payload?.issue) {
          const { threadId: targetThreadId } = resolveRealtimeIssuePayloadScope(payload.payload);

          if (!shouldApplyRealtimeIssueToSelectedThread(activeThreadId, targetThreadId)) {
            return;
          }

          const currentVisibleIssue = issuesRef.current.find((issue) => issue.id === payload.payload.issue.id) ?? null;
          const currentArchivedIssue =
            archivedIssueSnapshotsRef.current[activeBridgeId]?.[targetThreadId]?.find(
              (issue) => issue.id === payload.payload.issue.id
            ) ?? null;
          const nextIssue = normalizeIssue(
            mergeIncomingIssueSnapshot(payload.payload.issue, {
              currentIssue: currentVisibleIssue ?? currentArchivedIssue,
              fallbackThreadId: targetThreadId
            })
          );

          if (!nextIssue) {
            return;
          }

          const archivedIds = new Set(
            getArchivedIssueIdsForScope(archivedIssuesStateRef.current, activeBridgeId, targetThreadId)
          );
          const isArchived = Boolean(getArchivedIssueColumnId(nextIssue)) && archivedIds.has(nextIssue.id);

          if (isArchived) {
            replaceArchivedIssuesForCurrentScope(
              activeBridgeId,
              targetThreadId,
              upsertIssue(archivedIssueSnapshotsRef.current[activeBridgeId]?.[targetThreadId] ?? [], nextIssue)
            );
            setIssues((current) => current.filter((issue) => issue.id !== nextIssue.id));
            return;
          }

          replaceArchivedIssuesForCurrentScope(
            activeBridgeId,
            targetThreadId,
            (archivedIssueSnapshotsRef.current[activeBridgeId]?.[targetThreadId] ?? []).filter(
              (issue) => issue.id !== nextIssue.id
            )
          );
          setIssues((current) => upsertIssue(current, nextIssue));
        }
      } catch {
        // ignore malformed event payload
      }
    });

    eventSource.addEventListener("error", () => {
      appendEvent("sse.error", copy.alerts.sseReconnect);
      setStreamActivityAt(null);
      markBridgeDisconnectedOverride(selectedBridgeId);
      setBridgeStatus(selectedBridgeId, (current) => ({
        ...current,
        app_server: {
          ...(current?.app_server ?? {}),
          connected: false,
          initialized: false
        },
        updated_at: new Date().toISOString()
      }));
      void refreshBridgeStatus(session, selectedBridgeId);
    });

    return () => {
      eventSource.close();
    };
  }, [
    copy.alerts.sseReconnect,
    eventStreamReconnectToken,
    clearBridgeDisconnectedOverride,
    markBridgeDisconnectedOverride,
    markStreamActivity,
    refreshBridgeStatus,
    session,
    setBridgeStatus,
    selectedBridgeId
  ]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return undefined;
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleDashboardForegroundResume("dashboard_resume:visibility");
      }
    };

    const handleWindowFocus = () => {
      scheduleDashboardForegroundResume("dashboard_resume:focus");
    };

    const handlePageShow = () => {
      scheduleDashboardForegroundResume("dashboard_resume:pageshow");
    };

    const handleOnline = () => {
      scheduleDashboardForegroundResume("dashboard_resume:online");
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("online", handleOnline);

    return () => {
      if (scheduledResumeTimerRef.current) {
        window.clearTimeout(scheduledResumeTimerRef.current);
        scheduledResumeTimerRef.current = null;
      }
      scheduledResumeReasonsRef.current.clear();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("online", handleOnline);
    };
  }, [scheduleDashboardForegroundResume]);

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
      const preferredPath = roots[0]?.path || "";

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
    setPrepIssueOrderIds([]);
    setDraggingIssueId("");
    setDraggingPrepIssueIds([]);
    setDraggingMovableIssueIds([]);
    setIssueMoveTargetThreadId("");
    setDraggingArchiveIssueIds([]);
    setWorkspaceRoots([]);
    setFolderState({ path: "", parent_path: null, entries: [] });
    setSelectedWorkspacePath("");
    setProjectThreads([]);
    loadedProjectThreadsRef.current = {};
    pendingProjectThreadLoadsRef.current.clear();
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
    const pending = pendingPushDeepLinkRef.current;

    if (!pending || !session?.loginId) {
      return;
    }

    if (pending.bridgeId && bridges.some((bridge) => bridge.bridge_id === pending.bridgeId) && selectedBridgeId !== pending.bridgeId) {
      setSelectedBridgeId(pending.bridgeId);
      return;
    }

    if (
      pending.projectId &&
      projects.some((project) => project.id === pending.projectId) &&
      selectedProjectId !== pending.projectId
    ) {
      setSelectedProjectId(pending.projectId);
      return;
    }

    const scopedThreads = projectThreads.filter((thread) => !pending.projectId || thread.project_id === pending.projectId);

    if (pending.threadId && scopedThreads.some((thread) => thread.id === pending.threadId) && selectedProjectThreadId !== pending.threadId) {
      setSelectedProjectThreadId(pending.threadId);
      return;
    }

    if (pending.issueId && issues.some((issue) => issue.id === pending.issueId)) {
      setSelectedIssueId(pending.issueId);
      setSelectedIssueIds([pending.issueId]);
    }

    if (!pending.threadId || selectedProjectThreadId === pending.threadId) {
      pendingPushDeepLinkRef.current = null;
      clearPushDeepLink();
    }
  }, [
    bridges,
    issues,
    projectThreads,
    projects,
    selectedBridgeId,
    selectedProjectId,
    selectedProjectThreadId,
    session?.loginId
  ]);

  useEffect(() => {
    if (!session?.loginId || !selectedBridgeId || !selectedProjectId) {
      setProjectThreads([]);
      setSelectedProjectThreadId("");
      return;
    }

    void loadProjectThreads(session, selectedBridgeId, selectedProjectId);
  }, [session, selectedBridgeId, selectedProjectId]);

  useEffect(() => {
    if (!session?.loginId || !selectedBridgeId) {
      return undefined;
    }

    let cancelled = false;
    void refreshBridgeStatus(session, selectedBridgeId);

    const timer = window.setInterval(() => {
      if (cancelled) {
        return;
      }
      void refreshBridgeStatus(session, selectedBridgeId);
    }, BRIDGE_STATUS_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshBridgeStatus, selectedBridgeId, session]);

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
    if (!session?.loginId || !selectedBridgeId || !selectedProjectThreadId || !archivesHydrated) {
      issueLoadRequestIdRef.current += 1;
      setIssues([]);
      return;
    }

    void loadThreadIssues(session, selectedBridgeId, selectedProjectThreadId);
  }, [archivesHydrated, loadThreadIssues, session, selectedBridgeId, selectedProjectThreadId]);

  useEffect(() => {
    if (
      !session?.loginId ||
      !selectedBridgeId ||
      !selectedProjectThreadId ||
      !selectedActiveIssue ||
      !["running", "awaiting_input"].includes(selectedActiveIssue.status ?? "")
    ) {
      return undefined;
    }

    const pollActiveIssue = () => {
      if (Date.now() < activeIssuePollPausedUntilRef.current) {
        return;
      }

      const lastLiveProgressAt = Number(threadLiveProgressAtByIdRef.current.get(selectedProjectThreadId) ?? 0);

      if (lastLiveProgressAt > 0 && Date.now() - lastLiveProgressAt < ACTIVE_ISSUE_POLL_SUPPRESS_AFTER_LIVE_MS) {
        return;
      }

      void syncActiveIssueDetail(session, selectedBridgeId, selectedProjectThreadId, selectedActiveIssue.id);
    };

    const intervalId = window.setInterval(pollActiveIssue, ACTIVE_ISSUE_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [selectedActiveIssue, selectedBridgeId, selectedProjectThreadId, session, syncActiveIssueDetail]);

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

    const prepIds = issues
      .filter((thread) => getStatusMeta(thread.status).column === "prep")
      .sort((left, right) => {
        const leftHasOrder = Number.isFinite(left.prep_position);
        const rightHasOrder = Number.isFinite(right.prep_position);

        if (leftHasOrder && rightHasOrder && left.prep_position !== right.prep_position) {
          return left.prep_position - right.prep_position;
        }

        if (leftHasOrder && !rightHasOrder) {
          return -1;
        }

        if (!leftHasOrder && rightHasOrder) {
          return 1;
        }

        return Date.parse(right.updated_at) - Date.parse(left.updated_at);
      })
      .map((thread) => thread.id);

    setIssueQueueOrderIds((current) => {
      const preserved = current.filter((threadId) => todoIds.includes(threadId));
      const appended = todoIds.filter((threadId) => !preserved.includes(threadId));
      return [...preserved, ...appended];
    });
    setPrepIssueOrderIds((current) => {
      const preserved = current.filter((threadId) => prepIds.includes(threadId));
      const appended = prepIds.filter((threadId) => !preserved.includes(threadId));
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
            thread.id === threadId && thread.thread_id === selectedProjectThreadId
        )
      )
    );
    setSelectedIssueId((current) => (current && issues.some((issue) => issue.id === current) ? current : ""));
  }, [selectedProjectThreadId, issues]);
  useEffect(() => {
    if (!issueEditorOpen || !editingIssueId) {
      return;
    }

    const exists = issues.some(
      (issue) => issue.id === editingIssueId && getStatusMeta(issue.status).column === "prep"
    );

    if (!exists) {
      setIssueEditorOpen(false);
      setEditingIssueId("");
      setIssueEditorBusy(false);
    }
  }, [issueEditorOpen, editingIssueId, issues]);

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
    clearStoredArchivedIssuesState();
    setSession(null);
    setSelectedBridgeId("");
    setBridges([]);
    setProjects([]);
    setProjectThreads([]);
    setIssues([]);
    archivedIssuesStateRef.current = {};
    setArchivedIssuesState({});
    setArchivesHydrated(false);
    archivedIssueSnapshotsRef.current = {};
    visibleIssueSnapshotsRef.current = {};
    setArchivedIssues([]);
    setWorkspaceRoots([]);
    setFolderState({ path: "", parent_path: null, entries: [] });
    setSelectedWorkspacePath("");
    setRecentEvents([]);
    setStreamActivityAt(null);
    setSelectedProjectId("");
    setSelectedProjectThreadId("");
    setSelectedIssueId("");
    setSelectedIssueIds([]);
    setIssueQueueOrderIds([]);
    setPrepIssueOrderIds([]);
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
          body: JSON.stringify({
            ...payload,
            source_app_id: ISSUE_SOURCE_APP_ID
          })
        }
      );

      if (response?.issue) {
        setIssues((current) => upsertIssue(current, response.issue));
        replaceArchivedIssuesForCurrentScope(
          selectedBridgeId,
          selectedProjectThreadId,
          (archivedIssueSnapshotsRef.current[selectedBridgeId]?.[selectedProjectThreadId] ?? []).filter(
            (issue) => issue.id !== response.issue.id
          )
        );
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

  const handleArchiveIssues = (threadIds) => {
    if (!selectedBridgeId || !selectedProjectThreadId || threadIds.length === 0) {
      return;
    }

    const archiveableIds = threadIds.filter((threadId) => {
      const thread = issues.find((item) => item.id === threadId);

      if (!thread) {
        return false;
      }

      const columnId = getStatusMeta(thread.status).column;
      return columnId === "review" || columnId === "done";
    });

    if (archiveableIds.length === 0) {
      return;
    }

    const nextArchivedState = replaceArchivedIssuesStateForScope(
      archivedIssuesStateRef.current,
      selectedBridgeId,
      selectedProjectThreadId,
      [
        ...getArchivedIssueIdsForScope(archivedIssuesStateRef.current, selectedBridgeId, selectedProjectThreadId),
        ...archiveableIds
      ],
      new Date().toISOString()
    );
    const currentArchivedIssuesForScope =
      selectedBridgeIdRef.current === selectedBridgeId && selectedProjectThreadIdRef.current === selectedProjectThreadId
        ? archivedIssues
        : (archivedIssueSnapshotsRef.current[selectedBridgeId]?.[selectedProjectThreadId] ?? []);

    updateArchivedIssuesState(nextArchivedState);
    replaceArchivedIssuesForCurrentScope(
      selectedBridgeId,
      selectedProjectThreadId,
      mergeIssues(
        currentArchivedIssuesForScope,
        archiveableIds
          .map((threadId) => issues.find((item) => item.id === threadId))
          .filter(Boolean)
      )
    );
    setIssues((current) => current.filter((issue) => !archiveableIds.includes(issue.id)));
    setSelectedIssueIds((current) => current.filter((threadId) => !archiveableIds.includes(threadId)));
    setDraggingArchiveIssueIds([]);

    syncArchivedIssuesState(session, nextArchivedState, { keepalive: true });
  };

  const handleRestoreArchivedIssues = (threadIds) => {
    if (!selectedBridgeId || !selectedProjectThreadId || threadIds.length === 0) {
      return;
    }

    const archived = getArchivedIssueIdsForScope(archivedIssuesStateRef.current, selectedBridgeId, selectedProjectThreadId);
    const remaining = archived.filter((threadId) => !threadIds.includes(threadId));

    if (remaining.length === archived.length) {
      return;
    }

    const nextArchivedState = replaceArchivedIssuesStateForScope(
      archivedIssuesStateRef.current,
      selectedBridgeId,
      selectedProjectThreadId,
      remaining,
      new Date().toISOString()
    );
    const currentArchivedIssuesForScope =
      selectedBridgeIdRef.current === selectedBridgeId && selectedProjectThreadIdRef.current === selectedProjectThreadId
        ? archivedIssues
        : (archivedIssueSnapshotsRef.current[selectedBridgeId]?.[selectedProjectThreadId] ?? []);

    updateArchivedIssuesState(nextArchivedState);
    const restoredIssues = currentArchivedIssuesForScope.filter((issue) =>
      threadIds.includes(issue.id)
    );
    replaceArchivedIssuesForCurrentScope(
      selectedBridgeId,
      selectedProjectThreadId,
      currentArchivedIssuesForScope.filter(
        (issue) => !threadIds.includes(issue.id)
      )
    );
    setIssues((current) => mergeIssues(current, restoredIssues));
    setDraggingArchiveIssueIds([]);

    syncArchivedIssuesState(session, nextArchivedState, { keepalive: true });
  };

  const handleStartSelectedIssues = async () => {
    await movePrepIssuesToTodo(selectedIssueIds);
  };

  const handleOpenIssueDetail = async (issueId) => {
    if (!session?.loginId || !selectedBridgeId || !issueId) {
      return;
    }

    const issue = issues.find((item) => item.id === issueId) ?? null;
    const fallbackThreadId = issue?.thread_id ?? selectedProjectThreadId;
    setSelectedIssueId(issueId);
    setDetailState({
      open: true,
      loading: true,
      thread: issue,
      messages: []
    });

    try {
      const payload = await apiRequest(
        `/api/issues/${encodeURIComponent(issueId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`
      );
      setDetailState({
        open: true,
        loading: false,
        thread: normalizeIssue(payload?.issue, fallbackThreadId) ?? issue,
        messages: payload?.messages ?? []
      });
    } catch (error) {
      setDetailState({
        open: true,
        loading: false,
        thread: issue,
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

  const handleOpenIssueEditor = (threadId) => {
    const issue = issues.find(
      (item) => item.id === threadId && getStatusMeta(item.status).column === "prep"
    );

    if (!issue) {
      return;
    }

    setEditingIssueId(threadId);
    setIssueEditorOpen(true);
  };

  const handleCloseIssueEditor = () => {
    setIssueEditorOpen(false);
    setEditingIssueId("");
    setIssueEditorBusy(false);
  };

  const handleUpdateIssue = async ({ title, prompt, attachments }) => {
    if (!session?.loginId || !selectedBridgeId || !editingIssueId) {
      return;
    }

    setIssueEditorBusy(true);

    try {
      const response = await apiRequest(
        `/api/issues/${encodeURIComponent(editingIssueId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ title, prompt, attachments })
        }
      );

      if (response?.issue) {
        setIssues((current) => upsertIssue(current, response.issue));
        replaceArchivedIssuesForCurrentScope(
          selectedBridgeId,
          selectedProjectThreadId,
          (archivedIssueSnapshotsRef.current[selectedBridgeId]?.[selectedProjectThreadId] ?? []).filter(
            (issue) => issue.id !== response.issue.id
          )
        );
      }

      handleCloseIssueEditor();
    } catch (error) {
      setRecentEvents((current) => [
        {
          id: createId(),
          type: "issue.update.failed",
          timestamp: new Date().toISOString(),
          summary: error.message
        },
        ...current
      ].slice(0, 20));
      setIssueEditorBusy(false);
    }
  };

  const clearMovableIssueDrag = useCallback(() => {
    setDraggingMovableIssueIds([]);
    setIssueMoveTargetThreadId("");
  }, []);

  const clearRetryIssueDrag = useCallback(() => {
    setDraggingRetryIssueIds([]);
  }, []);

  const handleDragQueueIssue = {
    start: (threadId) => {
      setDraggingIssueId(threadId);
      setDraggingPrepIssueIds([]);
      clearMovableIssueDrag();
      clearRetryIssueDrag();
      setDraggingArchiveIssueIds([]);
    },
    over: () => {},
    drop: (targetId) => {
      if (draggingRetryIssueIds.length > 0) {
        void requeueFailedIssuesToTodo(draggingRetryIssueIds, targetId);
        return;
      }

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
            applyIssueStateForScope(selectedBridgeId, selectedProjectThreadId, response.issues);
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

  const placeTodoIssuesBeforeTarget = async (issueIds, targetId, nextThreads) => {
    if (!targetId || nextThreads.length === 0 || !session?.loginId || !selectedBridgeId || !selectedProjectThreadId) {
      return;
    }

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

    const insertedIds = issueIds.filter((threadId) => visibleTodoIds.includes(threadId));

    if (insertedIds.length === 0 || !visibleTodoIds.includes(targetId)) {
      return;
    }

    const reorderedIds = visibleTodoIds.filter((threadId) => !insertedIds.includes(threadId));
    const targetIndex = reorderedIds.indexOf(targetId);

    if (targetIndex < 0) {
      return;
    }

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
      applyIssueStateForScope(selectedBridgeId, selectedProjectThreadId, reorderResponse.issues);
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

    const normalizedQueuedThreadIds = (() => {
      const ordered = orderedPrepIssueIds.filter((threadId) => queuedThreadIds.includes(threadId));
      return ordered.length > 0 ? ordered : queuedThreadIds;
    })();

    if (normalizedQueuedThreadIds.length === 0) {
      setDraggingPrepIssueIds([]);
      clearMovableIssueDrag();
      return;
    }

    setStartBusy(true);

    try {
      const response = await apiRequest(
        `/api/threads/${encodeURIComponent(selectedProjectThreadId)}/issues/start?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify({
            issue_ids: normalizedQueuedThreadIds
          })
        }
      );

      const nextThreads = Array.isArray(response?.issues) ? mergeIssues([], response.issues) : [];

      if (nextThreads.length > 0) {
        applyIssueStateForScope(selectedBridgeId, selectedProjectThreadId, nextThreads);
      }

      await placeTodoIssuesBeforeTarget(normalizedQueuedThreadIds, targetId, nextThreads);

      setSelectedIssueIds((current) => current.filter((threadId) => !normalizedQueuedThreadIds.includes(threadId)));
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
      clearMovableIssueDrag();
    }
  };

  const requeueFailedIssuesToTodo = async (threadIds, targetId = "") => {
    if (!session?.loginId || !selectedBridgeId || !selectedProjectThreadId) {
      return;
    }

    const retryableIssueIds = threadIds.filter((threadId) => {
      const issue = issues.find((item) => item.id === threadId);
      return (
        issue &&
        issue.thread_id === selectedProjectThreadId &&
        getStatusMeta(issue.status).column === "review" &&
        isRetryableIssueStatus(issue.status)
      );
    });

    if (retryableIssueIds.length === 0) {
      clearRetryIssueDrag();
      setDraggingArchiveIssueIds([]);
      return;
    }

    setStartBusy(true);

    try {
      for (const issueId of retryableIssueIds) {
        await apiRequest(
          `/api/issues/${encodeURIComponent(issueId)}/interrupt?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
          {
            method: "POST",
            body: JSON.stringify({
              reason: "drag_to_prep"
            })
          }
        );
      }

      const response = await apiRequest(
        `/api/threads/${encodeURIComponent(selectedProjectThreadId)}/issues/start?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify({
            issue_ids: retryableIssueIds
          })
        }
      );

      const nextThreads = Array.isArray(response?.issues) ? mergeIssues([], response.issues) : [];

      if (nextThreads.length > 0) {
        applyIssueStateForScope(selectedBridgeId, selectedProjectThreadId, nextThreads);
      }

      await placeTodoIssuesBeforeTarget(retryableIssueIds, targetId, nextThreads);
      setSelectedIssueIds((current) => current.filter((threadId) => !retryableIssueIds.includes(threadId)));
    } catch (error) {
      setRecentEvents((current) => [
        {
          id: createId(),
          type: "issues.retry.failed",
          timestamp: new Date().toISOString(),
          summary: error.message
        },
        ...current
      ].slice(0, 20));
    } finally {
      setStartBusy(false);
      clearRetryIssueDrag();
      setDraggingArchiveIssueIds([]);
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
      const normalizeIds = (ids) => {
        const ordered = orderedPrepIssueIds.filter((threadId) => ids.includes(threadId));
        return ordered.length > 0 ? ordered : ids;
      };
      const draggedIds = currentPrepIds.includes(threadId) ? normalizeIds(currentPrepIds) : normalizeIds([threadId]);
      setDraggingIssueId("");
      setDraggingPrepIssueIds(draggedIds);
      clearRetryIssueDrag();
      setDraggingArchiveIssueIds([]);
      setDraggingMovableIssueIds(draggedIds);
      setIssueMoveTargetThreadId("");
    },
    reorder: (targetId) => {
      const draggedIds = draggingPrepIssueIds.length > 0 ? draggingPrepIssueIds : [];

      if (draggedIds.length === 0 || !targetId || draggedIds.includes(targetId)) {
        return;
      }

      const nextOrder = reorderIdGroup(orderedPrepIssueIds, draggedIds, targetId);

      if (nextOrder === orderedPrepIssueIds) {
        return;
      }

      setPrepIssueOrderIds(nextOrder);

      if (!session?.loginId || !selectedBridgeId || !selectedProjectThreadId) {
        return;
      }

      const projectPrepIds = nextOrder.filter((threadId) =>
        issues.some(
          (thread) =>
            thread.id === threadId &&
            thread.thread_id === selectedProjectThreadId &&
            getStatusMeta(thread.status).column === "prep"
        )
      );

      void (async () => {
        try {
          const response = await apiRequest(
            `/api/threads/${encodeURIComponent(selectedProjectThreadId)}/issues/reorder?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
            {
              method: "POST",
              body: JSON.stringify({
                issue_ids: projectPrepIds,
                stage: "prep"
              })
            }
          );

          if (Array.isArray(response?.issues)) {
            applyIssueStateForScope(selectedBridgeId, selectedProjectThreadId, response.issues);
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
    },
    drop: (targetId = "") => {
      void movePrepIssuesToTodo(draggingPrepIssueIds, targetId);
    }
  };

  const handleDragMovableIssue = {
    start: (threadId) => {
      const selectedIdsInRunning = selectedIssueIds.filter((selectedId) => {
        const issue = issues.find((item) => item.id === selectedId);
        return (
          issue &&
          issue.thread_id === selectedProjectThreadId &&
          getStatusMeta(issue.status).column === "running"
        );
      });
      const draggedIds = selectedIdsInRunning.includes(threadId) ? selectedIdsInRunning : [threadId];
      setDraggingIssueId("");
      setDraggingPrepIssueIds([]);
      clearRetryIssueDrag();
      setDraggingArchiveIssueIds([]);
      setDraggingMovableIssueIds(draggedIds);
      setIssueMoveTargetThreadId("");
    },
    clear: clearMovableIssueDrag
  };

  const handleDragRetryIssues = {
    start: (threadId) => {
      const selectedRetryIds = selectedIssueIds.filter((selectedId) => {
        const issue = issues.find((item) => item.id === selectedId);
        return (
          issue &&
          issue.thread_id === selectedProjectThreadId &&
          getStatusMeta(issue.status).column === "review" &&
          isRetryableIssueStatus(issue.status)
        );
      });
      const draggedIds = selectedRetryIds.includes(threadId) ? selectedRetryIds : [threadId];
      setDraggingIssueId("");
      setDraggingPrepIssueIds([]);
      clearMovableIssueDrag();
      setDraggingArchiveIssueIds(draggedIds);
      setDraggingRetryIssueIds(draggedIds);
      setIssueMoveTargetThreadId("");
    },
    clear: () => {
      setDraggingArchiveIssueIds([]);
      clearRetryIssueDrag();
    },
    drop: (targetId = "") => {
      void requeueFailedIssuesToTodo(draggingRetryIssueIds, targetId);
    }
  };

  const handleDragArchiveIssues = {
    start: (threadId, columnId) => {
      const selectedIdsInColumn = selectedIssueIds.filter((selectedId) => {
        const issue = issues.find((item) => item.id === selectedId);
        return issue && getStatusMeta(issue.status).column === columnId;
      });
      const draggedIds = selectedIdsInColumn.includes(threadId) ? selectedIdsInColumn : [threadId];
      setDraggingIssueId("");
      setDraggingPrepIssueIds([]);
      clearRetryIssueDrag();
      clearMovableIssueDrag();
      setSelectedIssueIds(draggedIds);
      setSelectedIssueId(threadId);
      setDraggingArchiveIssueIds(draggedIds);
    },
    clear: () => {
      setDraggingArchiveIssueIds([]);
    },
    drop: () => {
      if (draggingArchiveIssueIds.length === 0) {
        return;
      }

      handleArchiveIssues(draggingArchiveIssueIds);
      setDraggingArchiveIssueIds([]);
    }
  };

  const handleIssueMoveTargetOver = useCallback((threadId) => {
    if (!threadId || draggingMovableIssueIds.length === 0) {
      return;
    }

    setIssueMoveTargetThreadId(threadId);
  }, [draggingMovableIssueIds]);

  const handleIssueMoveTargetLeave = useCallback((threadId) => {
    setIssueMoveTargetThreadId((current) => (current === threadId ? "" : current));
  }, []);

  const handleCreateProject = async (payload) => {
    if (!session?.loginId || !selectedBridgeId) {
      return;
    }

    const bridgeId = selectedBridgeId;
    setProjectBusy(true);

    try {
      const response = await apiRequest(
        `/api/projects?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify(payload)
        }
      );

      const nextProjects = response?.projects ?? null;
      const createdProject = response?.project ?? null;

      if (Array.isArray(nextProjects)) {
        setProjects(nextProjects);
        updateStatusCounts({ projects: nextProjects.length }, bridgeId);
      } else if (createdProject?.id) {
        let didInsert = false;
        setProjects((current) => {
          const exists = current.some((project) => project.id === createdProject.id);
          didInsert = !exists;
          return exists ? current : [createdProject, ...current];
        });
        if (didInsert) {
          setBridgeStatus(bridgeId, (current) => ({
            ...current,
            counts: {
              ...current.counts,
              projects: (current.counts?.projects ?? 0) + 1
            }
          }));
        }
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

    const bridgeId = selectedBridgeId;
    try {
      const response = await apiRequest(
        `/api/threads/${encodeURIComponent(threadId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`,
        {
          method: "DELETE"
        }
      );

      if (Array.isArray(response?.threads)) {
        setProjectThreads(mergeProjectThreads([], response.threads));
      } else {
        setProjectThreads((current) => current.filter((thread) => thread.id !== threadId));
      }
      clearArchivedIssuesForScope(bridgeId, threadId);
      setBridgeStatus(bridgeId, (current) => ({
        ...current,
        counts: {
          ...current.counts,
          threads: Math.max((current.counts?.threads ?? 0) - 1, 0)
        }
      }));

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

    const bridgeId = selectedBridgeId;
    try {
      const response = await apiRequest(
        `/api/projects/${encodeURIComponent(projectId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`,
        {
          method: "DELETE"
        }
      );

      if (Array.isArray(response?.projects)) {
        setProjects(response.projects);
        updateStatusCounts({ projects: response.projects.length }, bridgeId);
      } else {
        setProjects((current) => current.filter((project) => project.id !== projectId));
        setBridgeStatus(bridgeId, (current) => ({
          ...current,
          counts: {
            ...current.counts,
            projects: Math.max((current.counts?.projects ?? 0) - 1, 0)
          }
        }));
      }

      if (Array.isArray(response?.threads)) {
        setProjectThreads(mergeProjectThreads([], response.threads));
        updateStatusCounts({ threads: response.threads.length }, bridgeId);
      } else {
        setProjectThreads((current) => current.filter((thread) => thread.project_id !== projectId));
      }

      setSelectedProjectId((current) => (current === projectId ? "" : current));
      setSelectedIssueIds([]);
      setIssueQueueOrderIds([]);
      setPrepIssueOrderIds([]);
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

  const handleOpenProjectInstructionDialog = (instructionType) => {
    if (!selectedProjectId) {
      return;
    }

    setProjectInstructionType(instructionType === "developer" ? "developer" : "base");
    setProjectInstructionDialogOpen(true);
  };

  const handleCloseProjectInstructionDialog = () => {
    if (projectInstructionBusy) {
      return;
    }

    setProjectInstructionDialogOpen(false);
  };

  const handleSubmitProjectInstruction = async ({ instructionType, value }) => {
    if (!session?.loginId || !selectedBridgeId || !selectedProjectId) {
      return;
    }

    setProjectInstructionBusy(true);

    try {
      const isDeveloperInstruction = instructionType === "developer";
      const response = await apiRequest(
        `/api/projects/${encodeURIComponent(selectedProjectId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "PATCH",
          body: JSON.stringify(
            isDeveloperInstruction
              ? {
                  developer_instructions: value,
                  update_developer_instructions: true
                }
              : {
                  base_instructions: value,
                  update_base_instructions: true
                }
          )
        }
      );

      if (Array.isArray(response?.projects)) {
        setProjects(response.projects);
      } else if (response?.project?.id) {
        setProjects((current) =>
          current.map((project) => (project.id === response.project.id ? { ...project, ...response.project } : project))
        );
      }

      setProjectInstructionDialogOpen(false);
    } catch (error) {
      setRecentEvents((current) => [
        {
          id: createId(),
          type: "project.instructions.update.failed",
          timestamp: new Date().toISOString(),
          summary: error.message
        },
        ...current
      ].slice(0, 20));
    } finally {
      setProjectInstructionBusy(false);
    }
  };

  const handleOpenThreadInstructionDialog = (threadId = "") => {
    const normalizedThreadId = String(threadId ?? "").trim();

    if (!normalizedThreadId) {
      return;
    }

    setSelectedProjectThreadId(normalizedThreadId);
    setThreadInstructionError("");
    setThreadInstructionDialogOpen(true);
  };

  const handleCloseThreadInstructionDialog = () => {
    if (threadInstructionBusy) {
      return;
    }

    setThreadInstructionError("");
    setThreadInstructionDialogOpen(false);
  };

  const handleSubmitThreadInstruction = async ({ name, developerInstructions }) => {
    if (!session?.loginId || !selectedBridgeId || !selectedProjectThreadId) {
      return;
    }

    setThreadInstructionBusy(true);
    setThreadInstructionError("");

    try {
      const requestBody = {
        name: String(name ?? "").trim()
      };

      if (threadInstructionSupported) {
        requestBody.developer_instructions = String(developerInstructions ?? "");
        requestBody.update_developer_instructions = true;
      }

      const response = await apiRequest(
        `/api/threads/${encodeURIComponent(selectedProjectThreadId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "PATCH",
          body: JSON.stringify(requestBody)
        }
      );

      if (Array.isArray(response?.threads)) {
        setProjectThreads((current) => replaceProjectThreadsForProject(current, response.threads, selectedProjectIdRef.current));
      } else if (response?.thread?.id) {
        setProjectThreads((current) => upsertProjectThread(current, response.thread));
      }

      setThreadInstructionError("");
      setThreadInstructionDialogOpen(false);
    } catch (error) {
      const message = getThreadDeveloperInstructionSaveErrorMessage(error);
      setThreadInstructionError(message);
      setRecentEvents((current) => [
        {
          id: createId(),
          type: "thread.instructions.update.failed",
          timestamp: new Date().toISOString(),
          summary: message
        },
        ...current
      ].slice(0, 20));
    } finally {
      setThreadInstructionBusy(false);
    }
  };

  const handleOpenThreadCreateDialog = () => {
    if (!selectedProjectId) {
      return;
    }

    setThreadCreateDialogOpen(true);
  };

  const handleCloseThreadCreateDialog = () => {
    if (threadBusy) {
      return;
    }

    setThreadCreateDialogOpen(false);
  };

  const handleSubmitThreadCreateDialog = async ({ name, developerInstructions }) => {
    if (!session?.loginId || !selectedBridgeId || !selectedProjectId) {
      return false;
    }

    const bridgeId = selectedBridgeId;
    const projectId = selectedProjectId;
    const nextName = String(name ?? "").trim() || "제목없음";
    const nextDeveloperInstructions = String(developerInstructions ?? "");
    setThreadBusy(true);

    try {
      const createResponse = await apiRequest(
        `/api/projects/${encodeURIComponent(projectId)}/threads?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify({
            name: nextName
          })
        }
      );

      const createdThreadId = String(createResponse?.thread?.id ?? "").trim();

      if (!createdThreadId) {
        throw new Error("쓰레드를 생성하지 못했습니다.");
      }

      let nextThread =
        normalizeProjectThread(createResponse?.thread, projectId) ??
        mergeProjectThreads([], createResponse?.threads ?? []).find((thread) => thread.id === createdThreadId) ??
        null;

      const trimmedDeveloperInstructions = nextDeveloperInstructions.trim();

      if (trimmedDeveloperInstructions) {
        try {
          const updateResponse = await apiRequest(
            `/api/threads/${encodeURIComponent(createdThreadId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`,
            {
              method: "PATCH",
              body: JSON.stringify({
                developer_instructions: nextDeveloperInstructions,
                update_developer_instructions: true
              })
            }
          );

          nextThread =
            normalizeProjectThread(updateResponse?.thread, projectId) ??
            mergeProjectThreads([], updateResponse?.threads ?? []).find((thread) => thread.id === createdThreadId) ??
            nextThread;
        } catch (error) {
          const message = getThreadDeveloperInstructionSaveErrorMessage(error);
          setRecentEvents((current) => [
            {
              id: createId(),
              type: "thread.instructions.update.failed",
              timestamp: new Date().toISOString(),
              summary: `${nextName} 쓰레드는 생성됐지만 개발지침 저장에는 실패했습니다. ${message}`
            },
            ...current
          ].slice(0, 20));
        }
      }

      if (!nextThread) {
        nextThread = {
          id: createdThreadId,
          name: nextName,
          project_id: projectId,
          developer_instructions: trimmedDeveloperInstructions,
          status: "idle",
          progress: 0,
          last_event: "thread.created",
          last_message: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
      }

      setProjectThreads((current) => upsertProjectThread(current, nextThread));
      setSelectedProjectThreadId(createdThreadId);
      setBridgeStatus(bridgeId, (current) => ({
        ...current,
        counts: {
          ...current.counts,
          threads: (current.counts?.threads ?? 0) + 1
        }
      }));
      setThreadCreateDialogOpen(false);
      return true;
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
      return false;
    } finally {
      setThreadBusy(false);
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
        applyIssueStateForScope(selectedBridgeId, selectedProjectThreadId, response.issues);
      } else {
        setIssues((current) => current.filter((issue) => issue.id !== issueId));
        replaceArchivedIssuesForCurrentScope(
          selectedBridgeId,
          selectedProjectThreadId,
          (archivedIssueSnapshotsRef.current[selectedBridgeId]?.[selectedProjectThreadId] ?? []).filter(
            (issue) => issue.id !== issueId
          )
        );
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

  const handleInterruptIssueToPrep = async (targetId = "") => {
    if (!draggingIssueId) {
      if (draggingPrepIssueIds.length > 0) {
        handleDragPrepIssues.reorder(targetId);
      }
      return;
    }

    const issueId = draggingIssueId;

    if (!session?.loginId || !selectedBridgeId || !selectedProjectThreadId || !issueId) {
      setDraggingIssueId("");
      return;
    }

    setDraggingIssueId("");

    try {
      const response = await apiRequest(
        `/api/issues/${encodeURIComponent(issueId)}/interrupt?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify({
            reason: "drag_to_prep"
          })
        }
      );

      if (Array.isArray(response?.issues)) {
        applyIssueStateForScope(selectedBridgeId, selectedProjectThreadId, response.issues);
      } else {
        await loadThreadIssues(session, selectedBridgeId, selectedProjectThreadId);
      }
    } catch (error) {
      setRecentEvents((current) => [
        {
          id: createId(),
          type: "issue.interrupt.failed",
          timestamp: new Date().toISOString(),
          summary: error.message
        },
        ...current
      ].slice(0, 20));
    }
  };

  const handleInterruptIssue = useCallback(async (issueId, reason = "manual_interrupt") => {
    if (!session?.loginId || !selectedBridgeId || !selectedProjectThreadId || !issueId) {
      return;
    }

    setInterruptingIssueId(issueId);

    try {
      const response = await apiRequest(
        `/api/issues/${encodeURIComponent(issueId)}/interrupt?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify({
            reason
          })
        }
      );

      if (Array.isArray(response?.issues)) {
        applyIssueStateForScope(selectedBridgeId, selectedProjectThreadId, response.issues);
        const nextIssue = response.issues
          .map((issue) => normalizeIssue(issue, selectedProjectThreadId))
          .find((issue) => issue?.id === issueId) ?? null;

        if (nextIssue && detailStateRef.current.open && detailStateRef.current.thread?.id === issueId) {
          setDetailState((current) => ({
            ...current,
            loading: false,
            thread: nextIssue
          }));
        }
      } else {
        await loadThreadIssues(session, selectedBridgeId, selectedProjectThreadId);
      }

      if (response?.thread?.id) {
        setProjectThreads((current) => upsertProjectThread(current, response.thread));
      }
    } catch (error) {
      setRecentEvents((current) => [
        {
          id: createId(),
          type: "issue.interrupt.failed",
          timestamp: new Date().toISOString(),
          summary: error.message
        },
        ...current
      ].slice(0, 20));
    } finally {
      setInterruptingIssueId((current) => (current === issueId ? "" : current));
    }
  }, [
    applyIssueStateForScope,
    loadThreadIssues,
    selectedBridgeId,
    selectedProjectThreadId,
    session
  ]);

  const handleMoveIssuesToThread = useCallback(async (targetThreadId) => {
    const issueIds = draggingMovableIssueIds.filter(Boolean);
    clearMovableIssueDrag();

    if (!session?.loginId || !selectedBridgeId || !selectedProjectThreadId || !targetThreadId || issueIds.length === 0) {
      return;
    }

    const movableIssueIds = issueIds.filter((issueId) => {
      const issue = issues.find((item) => item.id === issueId);
      const columnId = getStatusMeta(issue?.status).column;
      return issue && issue.thread_id === selectedProjectThreadId && ["prep", "running"].includes(columnId);
    });

    if (movableIssueIds.length === 0) {
      return;
    }

    try {
      let latestSourceIssues = null;
      let latestTargetIssues = null;
      let latestSourceThread = null;
      let latestTargetThread = null;

      for (const issueId of movableIssueIds) {
        const response = await apiRequest(
          `/api/issues/${encodeURIComponent(issueId)}/move?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
          {
            method: "POST",
            body: JSON.stringify({
              target_thread_id: targetThreadId
            })
          }
        );

        if (Array.isArray(response?.source_issues)) {
          latestSourceIssues = response.source_issues;
        }

        if (Array.isArray(response?.target_issues)) {
          latestTargetIssues = response.target_issues;
        }

        if (response?.source_thread?.id) {
          latestSourceThread = response.source_thread;
        }

        if (response?.target_thread?.id) {
          latestTargetThread = response.target_thread;
        }
      }

      if (Array.isArray(latestSourceIssues)) {
        applyIssueStateForScope(selectedBridgeId, selectedProjectThreadId, latestSourceIssues);
      } else {
        await loadThreadIssues(session, selectedBridgeId, selectedProjectThreadId);
      }

      if (Array.isArray(latestTargetIssues)) {
        applyIssueStateForScope(selectedBridgeId, targetThreadId, latestTargetIssues);
      }

      setProjectThreads((current) => {
        let next = current;

        if (latestSourceThread?.id) {
          next = upsertProjectThread(next, latestSourceThread);
        }

        if (latestTargetThread?.id) {
          next = upsertProjectThread(next, latestTargetThread);
        }

        return next;
      });

      setSelectedIssueIds((current) => current.filter((issueId) => !movableIssueIds.includes(issueId)));
      setSelectedIssueId((current) => (movableIssueIds.includes(current) ? "" : current));
    } catch (error) {
      setRecentEvents((current) => [
        {
          id: createId(),
          type: "issue.move.failed",
          timestamp: new Date().toISOString(),
          summary: error.message
        },
        ...current
      ].slice(0, 20));
    }
  }, [
    applyIssueStateForScope,
    clearMovableIssueDrag,
    draggingMovableIssueIds,
    issues,
    loadThreadIssues,
    selectedBridgeId,
    selectedProjectThreadId,
    session
  ]);

  const handleRefresh = async () => {
    if (!session?.loginId) {
      return;
    }

    const activeProjectId = selectedProjectIdRef.current;
    const activeThreadId = selectedProjectThreadIdRef.current;
    const openIssueId = detailStateRef.current.open ? detailStateRef.current.thread?.id ?? "" : "";
    const nextBridges = await loadBridges(session);
    const targetBridgeId = selectedBridgeId || nextBridges[0]?.bridge_id;

    if (targetBridgeId) {
      await loadBridgeWorkspace(session, targetBridgeId);

      if (activeProjectId) {
        await loadProjectThreads(session, targetBridgeId, activeProjectId);
      }

      if (activeThreadId) {
        await loadThreadIssues(session, targetBridgeId, activeThreadId);
      }

      if (openIssueId) {
        try {
          const payload = await loadIssueDetail(session, targetBridgeId, openIssueId);

          if (!payload) {
            return;
          }

          setDetailState((current) => ({
            ...current,
            loading: false,
            thread: payload.issue ?? current.thread,
            messages: payload.messages ?? []
          }));
        } catch (error) {
          setRecentEvents((current) => [
            {
              id: createId(),
              type: "thread.detail.refresh.failed",
              timestamp: new Date().toISOString(),
              summary: error.message
            },
            ...current
          ].slice(0, 20));
        }
      }
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
    const preferredPath = roots[0]?.path ?? "";

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
      bridgeAvailable={bridgeAvailable}
      bridgeSignal={bridgeSignal}
      signalNow={streamNow}
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
      prepIssueOrderIds={orderedPrepIssueIds}
      loadingState={loadingState}
      projectBusy={projectBusy}
      threadBusy={threadBusy}
      threadCreateDialogOpen={threadCreateDialogOpen}
      projectInstructionBusy={projectInstructionBusy}
      threadInstructionBusy={threadInstructionBusy}
      issueBusy={issueBusy}
      interruptingIssueId={interruptingIssueId}
      startBusy={startBusy}
      projectComposerOpen={projectComposerOpen}
      projectInstructionDialogOpen={projectInstructionDialogOpen}
      projectInstructionType={projectInstructionType}
      threadInstructionDialogOpen={threadInstructionDialogOpen}
      threadInstructionSupported={threadInstructionSupported}
      composerOpen={composerOpen}
      issueEditorOpen={issueEditorOpen}
      issueEditorBusy={issueEditorBusy}
      editingIssue={editingIssue}
      threadMenuState={threadMenuState}
      onSearchChange={setSearch}
      onSelectBridge={setSelectedBridgeId}
      onDeleteBridge={() => void handleDeleteBridge()}
      onSelectProject={setSelectedProjectId}
      onExpandProject={(projectId) => ensureProjectThreadsLoaded(session, selectedBridgeId, projectId)}
      onSelectProjectThread={setSelectedProjectThreadId}
      onSelectIssue={setSelectedIssueId}
      onUpdateIssueSelection={setSelectedIssueIds}
      selectedIssueIds={selectedIssueIds}
      archivedIssues={archivedIssues}
      detailState={detailState}
      onToggleIssueSelection={handleToggleIssueSelection}
      onArchiveIssues={handleArchiveIssues}
      onRestoreArchivedIssues={handleRestoreArchivedIssues}
      onStartSelectedIssues={() => void handleStartSelectedIssues()}
      onOpenIssueDetail={(threadId) => void handleOpenIssueDetail(threadId)}
      onInterruptIssue={(threadId) => void handleInterruptIssue(threadId)}
      onDeleteIssue={(threadId) => void handleDeleteIssue(threadId)}
      onDeleteProject={(projectId) => void handleDeleteProject(projectId)}
      onRenameProject={(projectId, name) => handleRenameProject(projectId, name)}
      onCreateThread={handleOpenThreadCreateDialog}
      onCloseThreadCreateDialog={handleCloseThreadCreateDialog}
      onSubmitThreadCreateDialog={handleSubmitThreadCreateDialog}
      onOpenThreadInstructionDialog={handleOpenThreadInstructionDialog}
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
      onDragMovableIssue={handleDragMovableIssue}
      onDragRetryIssues={handleDragRetryIssues}
      draggingMovableIssueIds={draggingMovableIssueIds}
      draggingRetryIssueIds={draggingRetryIssueIds}
      issueMoveTargetThreadId={issueMoveTargetThreadId}
      onIssueMoveTargetOver={handleIssueMoveTargetOver}
      onIssueMoveTargetLeave={handleIssueMoveTargetLeave}
      onMoveIssuesToThread={(threadId) => void handleMoveIssuesToThread(threadId)}
      onDragArchiveIssues={handleDragArchiveIssues}
      onInterruptIssueToPrep={(threadId) => void handleInterruptIssueToPrep(threadId)}
      onEditPrepIssue={(threadId) => handleOpenIssueEditor(threadId)}
      onOpenProjectComposer={() => void handleOpenProjectComposer()}
      onOpenProjectInstructionDialog={handleOpenProjectInstructionDialog}
      onOpenComposer={() => setComposerOpen(true)}
      onCloseProjectComposer={handleCloseProjectComposer}
      onCloseProjectInstructionDialog={handleCloseProjectInstructionDialog}
      onCloseThreadInstructionDialog={handleCloseThreadInstructionDialog}
      onCloseComposer={() => setComposerOpen(false)}
      onCloseIssueEditor={handleCloseIssueEditor}
      onBrowseWorkspaceRoot={(path) => browseWorkspacePath(path)}
      onBrowseFolder={(path) => browseWorkspacePath(path)}
      onSelectWorkspace={setSelectedWorkspacePath}
      onSubmitProject={handleCreateProject}
      onSubmitProjectInstruction={handleSubmitProjectInstruction}
      onSubmitThreadInstruction={handleSubmitThreadInstruction}
      onSubmitIssue={handleCreateIssue}
      onSubmitIssueEdit={handleUpdateIssue}
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
