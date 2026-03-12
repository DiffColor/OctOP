import { useEffect, useMemo, useState } from "react";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "https://gateway.example.com";

function formatTime(value) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
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
  const [commandPrompt, setCommandPrompt] = useState(
    '연결 상태 점검입니다. "pong" 또는 현재 상태를 짧게 답해 주세요.'
  );

  const userId = auth?.userId ?? "";

  const eventsUrl = useMemo(
    () =>
      userId ? `${API_BASE_URL}/api/events?user_id=${encodeURIComponent(userId)}` : null,
    [userId]
  );

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
    if (!eventsUrl) {
      return undefined;
    }

    const stream = new EventSource(eventsUrl);

    stream.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);

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
      stream.close();
    });

    return () => stream.close();
  }, [eventsUrl]);

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">OctOP Phase 1</p>
          <h1>LicenseHub 계정 기반 OctOP Dashboard</h1>
          <p className="lede">
            Dashboard는 LicenseHub 인증 API로 로그인하고, gateway를 통해 NATS 이벤트와
            bridge 상태를 읽습니다. app-server와 bridge는 내부망에 두는 구성이 전제입니다.
          </p>
        </div>
        <div className="controls">
          {!auth ? (
            <form className="login-form" onSubmit={handleLogin}>
              <label>
                LicenseHub Login ID
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
              <button type="submit">로그인</button>
              {authError ? <p className="error-text">{authError}</p> : null}
            </form>
          ) : (
            <>
              <div className="auth-summary">
                <strong>{auth.displayName}</strong>
                <span>
                  {auth.role} / {auth.userId}
                </span>
              </div>
              <label>
                점검 명령
                <input
                  value={commandPrompt}
                  onChange={(event) => setCommandPrompt(event.target.value)}
                />
              </label>
              <div className="buttons">
                <button onClick={loadSnapshot} disabled={loading}>
                  새로고침
                </button>
                <button onClick={startPingCommand}>연결 점검 실행</button>
                <button
                  onClick={() => {
                    setAuth(null);
                    setPassword("");
                  }}
                >
                  로그아웃
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      <section className="grid">
        <article className="card">
          <h2>Bridge 상태</h2>
          <dl className="facts">
            <div>
              <dt>브릿지 모드</dt>
              <dd>{status?.bridge_mode ?? "-"}</dd>
            </div>
            <div>
              <dt>App Server 모드</dt>
              <dd>{status?.app_server?.mode ?? "-"}</dd>
            </div>
            <div>
              <dt>App Server 연결</dt>
              <dd>{status?.app_server?.connected ? "connected" : "disconnected"}</dd>
            </div>
            <div>
              <dt>초기화</dt>
              <dd>{status?.app_server?.initialized ? "ready" : "pending"}</dd>
            </div>
            <div>
              <dt>NATS</dt>
              <dd>{status?.nats?.connected ? "connected" : "disconnected"}</dd>
            </div>
            <div>
              <dt>계정</dt>
              <dd>{status?.app_server?.account?.email ?? "-"}</dd>
            </div>
            <div>
              <dt>플랜</dt>
              <dd>{status?.app_server?.account?.plan_type ?? "-"}</dd>
            </div>
            <div>
              <dt>최근 오류</dt>
              <dd>{status?.app_server?.last_error ?? "-"}</dd>
            </div>
            <div>
              <dt>최근 갱신</dt>
              <dd>{formatTime(status?.updated_at)}</dd>
            </div>
          </dl>
        </article>

        <article className="card">
          <h2>LicenseHub Bootstrap</h2>
          <dl className="facts">
            <div>
              <dt>조직 노드</dt>
              <dd>{bootstrap?.orgNodes?.length ?? 0}</dd>
            </div>
            <div>
              <dt>디바이스</dt>
              <dd>{bootstrap?.deviceNodes?.length ?? 0}</dd>
            </div>
            <div>
              <dt>소프트웨어</dt>
              <dd>{bootstrap?.softwarePackages?.length ?? 0}</dd>
            </div>
            <div>
              <dt>라이선스</dt>
              <dd>{bootstrap?.licenses?.length ?? 0}</dd>
            </div>
          </dl>
        </article>

        <article className="card">
          <h2>프로젝트</h2>
          <ul className="list">
            {projects.map((project) => (
              <li key={project.id}>
                <strong>{project.name}</strong>
                <span>{project.id}</span>
              </li>
            ))}
          </ul>
        </article>

        <article className="card">
          <h2>Thread 진행 상태</h2>
          <ul className="list">
            {threads.map((thread) => (
              <li key={thread.id}>
                <strong>{thread.title}</strong>
                <span>
                  {thread.status} / {thread.progress}%
                </span>
                <span>{thread.last_message || thread.id}</span>
              </li>
            ))}
          </ul>
        </article>

        <article className="card wide">
          <h2>이벤트 로그</h2>
          <ul className="events">
            {events.map((event, index) => (
              <li key={`${event.type}-${index}`}>
                <div className="event-head">
                  <strong>{event.type}</strong>
                  <span>{formatTime(event.timestamp)}</span>
                </div>
                <pre>{JSON.stringify(event.payload, null, 2)}</pre>
              </li>
            ))}
          </ul>
        </article>
      </section>
    </div>
  );
}
