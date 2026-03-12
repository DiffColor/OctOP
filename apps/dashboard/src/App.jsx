import { useEffect, useMemo, useState } from "react";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "https://gateway.example.com";

const BOARD_COLUMNS = [
  { id: "queued", title: "Queued", subtitle: "대기 중인 스레드" },
  { id: "running", title: "In Progress", subtitle: "현재 처리 중" },
  { id: "attention", title: "Needs Review", subtitle: "입력 또는 확인 필요" },
  { id: "completed", title: "Done", subtitle: "완료된 작업" },
  { id: "failed", title: "Blocked", subtitle: "복구가 필요한 항목" }
];

const STATUS_META = {
  queued: { label: "Queued", tone: "queued", progressTone: "cool" },
  idle: { label: "Idle", tone: "idle", progressTone: "cool" },
  running: { label: "Running", tone: "running", progressTone: "warm" },
  awaiting_input: { label: "Needs Input", tone: "attention", progressTone: "warm" },
  completed: { label: "Completed", tone: "done", progressTone: "done" },
  failed: { label: "Blocked", tone: "failed", progressTone: "failed" }
};

function formatTime(value) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function summarizeMessage(thread) {
  if (thread.last_message?.trim()) {
    return thread.last_message.trim();
  }

  if (thread.status === "completed") {
    return "최종 응답이 수집되었습니다.";
  }

  if (thread.status === "failed") {
    return "오류 확인 후 재시도가 필요합니다.";
  }

  if (thread.status === "awaiting_input") {
    return "추가 입력 또는 승인 대기가 있습니다.";
  }

  return "작업 로그를 수집하는 중입니다.";
}

function mapThreadToColumn(thread) {
  if (thread.status === "completed") {
    return "completed";
  }

  if (thread.status === "failed") {
    return "failed";
  }

  if (thread.status === "awaiting_input") {
    return "attention";
  }

  if (thread.status === "running") {
    return "running";
  }

  return "queued";
}

function buildTodoItems(thread) {
  const progress = Number(thread.progress ?? 0);
  const lastEvent = thread.last_event ?? "";

  return [
    {
      id: "intake",
      label: "요청 캡처",
      hint: "thread가 생성되고 담당 프로젝트에 연결됩니다.",
      done: Boolean(thread.created_at)
    },
    {
      id: "plan",
      label: "실행 계획 수립",
      hint: "작업 플랜과 우선순위가 정리됩니다.",
      done: progress >= 25 || lastEvent.includes("plan") || thread.status === "completed"
    },
    {
      id: "execution",
      label: "변경 반영",
      hint: "diff 또는 답변이 생성되며 실행 상태가 업데이트됩니다.",
      done:
        progress >= 70 ||
        lastEvent.includes("diff") ||
        lastEvent.includes("agentMessage") ||
        thread.status === "completed"
    },
    {
      id: "review",
      label: "종료 및 검수",
      hint: "최종 응답을 확인하고 종료 상태를 확정합니다.",
      done: thread.status === "completed"
    }
  ];
}

function resolveThreadEventId(event) {
  return (
    event?.payload?.threadId ??
    event?.payload?.thread?.id ??
    event?.payload?.thread_id ??
    event?.payload?.conversationId ??
    null
  );
}

function IconBoard() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5.5h16v3H4zm0 5h9v3H4zm11 0h5v8h-5zm-11 5h9v3H4z" fill="currentColor" />
    </svg>
  );
}

function IconMobile() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m0 4v11h8V6zm4 14.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2"
        fill="currentColor"
      />
    </svg>
  );
}

function IconPulse() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3 12h4l2.2-5.2L13 18l2.1-5H21"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconSpark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="m12 3 1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9zM6 15l.9 2.1L9 18l-2.1.9L6 21l-.9-2.1L3 18l2.1-.9z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconInstall() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 4v9m0 0 3.5-3.5M12 13 8.5 9.5M5 18.5h14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StatusChip({ status }) {
  const meta = STATUS_META[status] ?? STATUS_META.queued;

  return <span className={`status-chip tone-${meta.tone}`}>{meta.label}</span>;
}

function ThreadCard({ thread, onSelect, selected }) {
  const todoItems = buildTodoItems(thread);
  const completed = todoItems.filter((item) => item.done).length;

  return (
    <button
      type="button"
      className={`thread-card ${selected ? "is-selected" : ""}`}
      onClick={() => onSelect(thread.id)}
    >
      <div className="thread-card__header">
        <StatusChip status={thread.status} />
        <span>{formatTime(thread.updated_at)}</span>
      </div>
      <strong>{thread.title}</strong>
      <p>{summarizeMessage(thread)}</p>
      <div className="thread-card__footer">
        <span>{thread.progress}% synced</span>
        <span>{completed}/4 checkpoints</span>
      </div>
    </button>
  );
}

function MobileThreadCard({ thread, onSelect, selected }) {
  const todos = buildTodoItems(thread);

  return (
    <button
      type="button"
      className={`mobile-thread-card ${selected ? "is-selected" : ""}`}
      onClick={() => onSelect(thread.id)}
    >
      <div className="mobile-thread-card__top">
        <StatusChip status={thread.status} />
        <span>{formatTime(thread.updated_at)}</span>
      </div>
      <strong>{thread.title}</strong>
      <p>{summarizeMessage(thread)}</p>
      <div className={`progress-bar tone-${STATUS_META[thread.status]?.progressTone ?? "cool"}`}>
        <span style={{ width: `${Math.max(thread.progress ?? 0, 8)}%` }} />
      </div>
      <ul className="todo-checklist">
        {todos.map((item) => (
          <li key={item.id} className={item.done ? "is-done" : ""}>
            <span className="todo-bullet" />
            <div>
              <strong>{item.label}</strong>
              <small>{item.hint}</small>
            </div>
          </li>
        ))}
      </ul>
    </button>
  );
}

export default function App() {
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [auth, setAuth] = useState(null);
  const [authError, setAuthError] = useState("");
  const [status, setStatus] = useState(null);
  const [bootstrap, setBootstrap] = useState(null);
  const [projects, setProjects] = useState([]);
  const [threads, setThreads] = useState([]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [commandPrompt, setCommandPrompt] = useState(
    '연결 상태 점검입니다. "pong" 또는 현재 상태를 짧게 답해 주세요.'
  );
  const [installPrompt, setInstallPrompt] = useState(null);
  const [installState, setInstallState] = useState("available");
  const [streamState, setStreamState] = useState("idle");
  const [isOnline, setIsOnline] = useState(() => window.navigator.onLine);

  const userId = auth?.userId ?? "";

  const eventsUrl = useMemo(
    () =>
      userId ? `${API_BASE_URL}/api/events?user_id=${encodeURIComponent(userId)}` : null,
    [userId]
  );

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? threads[0] ?? null,
    [selectedThreadId, threads]
  );

  const groupedThreads = useMemo(() => {
    return BOARD_COLUMNS.map((column) => ({
      ...column,
      items: threads.filter((thread) => mapThreadToColumn(thread) === column.id)
    }));
  }, [threads]);

  const selectedThreadEvents = useMemo(() => {
    if (!selectedThread) {
      return [];
    }

    return events.filter((event) => resolveThreadEventId(event) === selectedThread.id).slice(0, 8);
  }, [events, selectedThread]);

  const summaryCards = useMemo(() => {
    return [
      {
        label: "프로젝트",
        value: projects.length,
        icon: IconBoard,
        tone: "blue"
      },
      {
        label: "실행 중",
        value: threads.filter((thread) => thread.status === "running").length,
        icon: IconPulse,
        tone: "orange"
      },
      {
        label: "모바일 준비",
        value: installPrompt ? "Install" : "Ready",
        icon: IconMobile,
        tone: "slate"
      },
      {
        label: "라이선스",
        value: bootstrap?.licenses?.length ?? 0,
        icon: IconSpark,
        tone: "green"
      }
    ];
  }, [bootstrap?.licenses?.length, installPrompt, projects.length, threads]);

  async function loadSnapshot() {
    if (!userId) {
      return;
    }

    setLoading(true);

    try {
      const [statusResponse, projectResponse, threadResponse] = await Promise.all([
        fetch(`${API_BASE_URL}/api/bridge/status?user_id=${encodeURIComponent(userId)}`),
        fetch(`${API_BASE_URL}/api/projects?user_id=${encodeURIComponent(userId)}`),
        fetch(`${API_BASE_URL}/api/threads?user_id=${encodeURIComponent(userId)}`)
      ]);

      const [statusPayload, projectPayload, threadPayload] = await Promise.all([
        statusResponse.json(),
        projectResponse.json(),
        threadResponse.json()
      ]);

      setStatus(statusPayload);
      setProjects(projectPayload.projects ?? []);
      setThreads(threadPayload.threads ?? []);
    } finally {
      setLoading(false);
    }
  }

  async function loadBootstrap(accessToken) {
    const response = await fetch(`${API_BASE_URL}/api/auth/bootstrap`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      setBootstrap(null);
      return;
    }

    setBootstrap(await response.json());
  }

  async function handleLogin(event) {
    event.preventDefault();
    setAuthError("");

    const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        loginId,
        password
      })
    });

    if (!response.ok) {
      setAuth(null);
      setBootstrap(null);
      setAuthError("로그인에 실패했습니다.");
      return;
    }

    const payload = await response.json();
    setAuth(payload);
  }

  async function startPingCommand() {
    if (!userId) {
      return;
    }

    await fetch(`${API_BASE_URL}/api/commands/ping?user_id=${encodeURIComponent(userId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt: commandPrompt,
        project_id: projects[0]?.id
      })
    });
  }

  async function handleInstall() {
    if (!installPrompt) {
      return;
    }

    await installPrompt.prompt();
    setInstallState("requested");
    setInstallPrompt(null);
  }

  useEffect(() => {
    if (!auth?.accessToken || !auth?.userId) {
      setStatus(null);
      setProjects([]);
      setThreads([]);
      setEvents([]);
      setBootstrap(null);
      return;
    }

    loadSnapshot();
    loadBootstrap(auth.accessToken);
  }, [auth?.accessToken, auth?.userId]);

  useEffect(() => {
    if (!threads.length) {
      setSelectedThreadId("");
      return;
    }

    const nextSelected =
      threads.find((thread) => thread.id === selectedThreadId)?.id ?? threads[0].id;

    if (nextSelected !== selectedThreadId) {
      setSelectedThreadId(nextSelected);
    }
  }, [selectedThreadId, threads]);

  useEffect(() => {
    function handleOnline() {
      setIsOnline(true);
    }

    function handleOffline() {
      setIsOnline(false);
    }

    function handleBeforeInstallPrompt(event) {
      event.preventDefault();
      setInstallPrompt(event);
      setInstallState("ready");
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    };
  }, []);

  useEffect(() => {
    if (!eventsUrl) {
      return undefined;
    }

    const stream = new EventSource(eventsUrl);
    setStreamState("live");

    stream.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);

      setStreamState("live");
      setEvents((current) => [payload, ...current].slice(0, 40));

      if (payload.type === "bridge.status.updated") {
        setStatus(payload.payload);
      }

      if (payload.type === "bridge.projects.updated") {
        setProjects(payload.payload.projects ?? []);
      }

      if (payload.type === "bridge.threads.updated") {
        setThreads(payload.payload.threads ?? []);
      }
    });

    stream.addEventListener("error", () => {
      setStreamState("reconnecting");
    });

    return () => stream.close();
  }, [eventsUrl]);

  return (
    <div className="shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <IconSpark />
          </span>
          <div>
            <p>OctOP</p>
            <strong>Threads Workspace</strong>
          </div>
        </div>

        <div className="topbar-actions">
          <span className={`live-pill ${isOnline ? "is-online" : "is-offline"}`}>
            {isOnline ? "Online" : "Offline"}
          </span>
          <span className={`live-pill ${streamState === "live" ? "is-live" : ""}`}>
            {streamState === "live" ? "Stream Live" : "Reconnecting"}
          </span>
          {installPrompt ? (
            <button type="button" className="ghost-button" onClick={handleInstall}>
              <IconInstall />
              <span>PWA 설치</span>
            </button>
          ) : null}
        </div>
      </header>

      {!auth ? (
        <main className="login-layout">
          <section className="intro-panel">
            <div className="intro-copy">
              <p className="eyebrow">PWA + Desktop Workspace</p>
              <h1>모바일에서는 thread todo, 데스크톱에서는 칸반 보드로 관리합니다.</h1>
              <p>
                OctOP는 로컬 bridge와 원격 gateway를 연결해 thread 실행을 추적합니다. 모바일은
                빠른 체크리스트 중심, 데스크톱은 Linear 같은 컬럼 보드 중심으로 설계했습니다.
              </p>
            </div>

            <div className="preview-grid">
              <article className="preview-card preview-card--desktop">
                <div className="preview-card__title">
                  <IconBoard />
                  <span>Desktop Board</span>
                </div>
                <div className="mini-board">
                  {["Queued", "In Progress", "Review", "Done"].map((label, index) => (
                    <div key={label} className="mini-column">
                      <strong>{label}</strong>
                      <div className="mini-ticket" />
                      <div className="mini-ticket dimmed" />
                      {index === 1 ? <div className="mini-ticket accent" /> : null}
                    </div>
                  ))}
                </div>
              </article>

              <article className="preview-card preview-card--mobile">
                <div className="preview-card__title">
                  <IconMobile />
                  <span>Mobile Todo Stack</span>
                </div>
                <div className="mini-phone">
                  <div className="mini-phone__card" />
                  <div className="mini-phone__card accent" />
                  <div className="mini-phone__list">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              </article>
            </div>
          </section>

          <section className="login-panel">
            <form className="login-form" onSubmit={handleLogin}>
              <div>
                <p className="eyebrow">LicenseHub Access</p>
                <h2>워크스페이스에 로그인</h2>
              </div>

              <label>
                Login ID
                <input value={loginId} onChange={(event) => setLoginId(event.target.value)} />
              </label>

              <label>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>

              <button type="submit" className="primary-button">
                Dashboard 진입
              </button>

              {authError ? <p className="error-text">{authError}</p> : null}
            </form>
          </section>
        </main>
      ) : (
        <main className="workspace">
          <section className="workspace-hero">
            <div className="workspace-hero__copy">
              <p className="eyebrow">Thread Command Center</p>
              <h1>프로젝트 단위로 thread를 분배하고, 모바일과 데스크톱에서 다른 밀도로 관리합니다.</h1>
              <p>
                현재 선택 사용자 <strong>{auth.displayName}</strong>의 실행 상태를 바탕으로 모바일
                체크리스트와 데스크톱 칸반 보드를 동시에 제공합니다.
              </p>
            </div>

            <div className="hero-command-card">
              <div className="hero-command-card__header">
                <div>
                  <small>빠른 명령 등록</small>
                  <strong>{projects[0]?.name ?? "프로젝트를 불러오는 중"}</strong>
                </div>
                <StatusChip status={status?.app_server?.connected ? "running" : "failed"} />
              </div>

              <label>
                Thread 입력
                <textarea
                  rows="4"
                  value={commandPrompt}
                  onChange={(event) => setCommandPrompt(event.target.value)}
                />
              </label>

              <div className="hero-command-card__actions">
                <button type="button" className="primary-button" onClick={startPingCommand}>
                  연결 점검 실행
                </button>
                <button type="button" className="ghost-button" onClick={loadSnapshot} disabled={loading}>
                  새로고침
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => {
                    setAuth(null);
                    setPassword("");
                  }}
                >
                  로그아웃
                </button>
              </div>
            </div>
          </section>

          <section className="summary-strip">
            {summaryCards.map((card) => {
              const Icon = card.icon;

              return (
                <article key={card.label} className={`summary-card tone-${card.tone}`}>
                  <span className="summary-card__icon">
                    <Icon />
                  </span>
                  <div>
                    <small>{card.label}</small>
                    <strong>{card.value}</strong>
                  </div>
                </article>
              );
            })}
          </section>

          <section className="workspace-panels">
            <div className="insight-panel">
              <article className="surface-card">
                <div className="surface-card__title">
                  <h2>인프라 상태</h2>
                  <span>{formatDateTime(status?.updated_at)}</span>
                </div>
                <dl className="facts-grid">
                  <div>
                    <dt>Bridge</dt>
                    <dd>{status?.bridge_mode ?? "-"}</dd>
                  </div>
                  <div>
                    <dt>App Server</dt>
                    <dd>{status?.app_server?.connected ? "connected" : "offline"}</dd>
                  </div>
                  <div>
                    <dt>NATS</dt>
                    <dd>{status?.nats?.connected ? "live" : "down"}</dd>
                  </div>
                  <div>
                    <dt>Plan</dt>
                    <dd>{status?.app_server?.account?.plan_type ?? "-"}</dd>
                  </div>
                </dl>
              </article>

              <article className="surface-card">
                <div className="surface-card__title">
                  <h2>프로젝트 컨텍스트</h2>
                  <span>{projects.length} active</span>
                </div>
                <ul className="project-list">
                  {projects.map((project) => (
                    <li key={project.id}>
                      <strong>{project.name}</strong>
                      <span>{project.description}</span>
                    </li>
                  ))}
                </ul>
              </article>
            </div>

            <section className="mobile-pwa-view">
              <div className="surface-card mobile-surface">
                <div className="surface-card__title">
                  <h2>모바일 PWA Todo</h2>
                  <span>{threads.length} threads</span>
                </div>

                {selectedThread ? (
                  <div className="mobile-focus-card">
                    <div className="mobile-focus-card__header">
                      <div>
                        <small>현재 포커스</small>
                        <strong>{selectedThread.title}</strong>
                      </div>
                      <StatusChip status={selectedThread.status} />
                    </div>
                    <p>{summarizeMessage(selectedThread)}</p>
                    <div className="progress-bar tone-warm">
                      <span style={{ width: `${Math.max(selectedThread.progress ?? 0, 8)}%` }} />
                    </div>
                  </div>
                ) : (
                  <div className="empty-state">표시할 thread가 아직 없습니다.</div>
                )}

                <div className="mobile-thread-stack">
                  {threads.map((thread) => (
                    <MobileThreadCard
                      key={thread.id}
                      thread={thread}
                      selected={thread.id === selectedThread?.id}
                      onSelect={setSelectedThreadId}
                    />
                  ))}
                </div>
              </div>
            </section>

            <section className="desktop-board-view">
              <div className="desktop-layout">
                <div className="board-shell surface-card">
                  <div className="surface-card__title board-shell__title">
                    <div>
                      <h2>Desktop Kanban</h2>
                      <span>Linear-style thread board</span>
                    </div>
                    <div className="board-shell__meta">
                      <span>{threads.length} total</span>
                    </div>
                  </div>

                  <div className="board-columns">
                    {groupedThreads.map((column) => (
                      <section key={column.id} className="board-column">
                        <header className="board-column__header">
                          <div>
                            <strong>{column.title}</strong>
                            <small>{column.subtitle}</small>
                          </div>
                          <span>{column.items.length}</span>
                        </header>

                        <div className="board-column__body">
                          {column.items.length ? (
                            column.items.map((thread) => (
                              <ThreadCard
                                key={thread.id}
                                thread={thread}
                                selected={thread.id === selectedThread?.id}
                                onSelect={setSelectedThreadId}
                              />
                            ))
                          ) : (
                            <div className="empty-column">비어 있습니다.</div>
                          )}
                        </div>
                      </section>
                    ))}
                  </div>
                </div>

                <aside className="detail-rail surface-card">
                  <div className="surface-card__title">
                    <h2>Thread Detail</h2>
                    <span>{selectedThread ? formatDateTime(selectedThread.updated_at) : "-"}</span>
                  </div>

                  {selectedThread ? (
                    <>
                      <div className="detail-rail__header">
                        <div>
                          <strong>{selectedThread.title}</strong>
                          <p>{summarizeMessage(selectedThread)}</p>
                        </div>
                        <StatusChip status={selectedThread.status} />
                      </div>

                      <div className="detail-progress">
                        <div className="progress-bar tone-cool">
                          <span style={{ width: `${Math.max(selectedThread.progress ?? 0, 8)}%` }} />
                        </div>
                        <span>{selectedThread.progress}% complete</span>
                      </div>

                      <ul className="detail-checklist">
                        {buildTodoItems(selectedThread).map((item) => (
                          <li key={item.id} className={item.done ? "is-done" : ""}>
                            <span className="todo-bullet" />
                            <div>
                              <strong>{item.label}</strong>
                              <small>{item.hint}</small>
                            </div>
                          </li>
                        ))}
                      </ul>

                      <div className="detail-events">
                        <div className="surface-card__title">
                          <h3>최근 이벤트</h3>
                          <span>{selectedThreadEvents.length} items</span>
                        </div>
                        <ul className="event-list">
                          {selectedThreadEvents.length ? (
                            selectedThreadEvents.map((event, index) => (
                              <li key={`${event.type}-${index}`}>
                                <strong>{event.type}</strong>
                                <span>{formatDateTime(event.timestamp)}</span>
                              </li>
                            ))
                          ) : (
                            <li className="empty-state">선택한 thread의 이벤트가 아직 없습니다.</li>
                          )}
                        </ul>
                      </div>
                    </>
                  ) : (
                    <div className="empty-state">상세 보기를 위한 thread를 선택해 주세요.</div>
                  )}
                </aside>
              </div>
            </section>
          </section>
        </main>
      )}
    </div>
  );
}
