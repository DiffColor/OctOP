import { useEffect, useMemo, useRef, useState } from "react";

const APP_ID = "mobile-web";
const PUSH_MESSAGE_TYPE = "octop.push.received";
const MAX_LOG_ENTRIES = 5;

function supportsPush() {
  return (
    typeof window !== "undefined" &&
    typeof Notification !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

function createInitialState() {
  return {
    configured: false,
    loading: false,
    bridgeRegistered: false,
    browserSubscriptionReady: false,
    permission: typeof Notification === "undefined" ? "default" : Notification.permission,
    subscriptionCount: 0,
    received: [],
    error: ""
  };
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replaceAll("-", "+").replaceAll("_", "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((character) => character.charCodeAt(0)));
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function readExistingSubscription(registration, attempts = 1, delayMs = 0) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const subscription = await registration.pushManager.getSubscription().catch(() => null);

    if (subscription) {
      return subscription;
    }

    if (attempt < attempts - 1 && delayMs > 0) {
      await delay(delayMs);
    }
  }

  return null;
}

function formatPermission(permission) {
  switch (permission) {
    case "granted":
      return "허용됨";
    case "denied":
      return "차단됨";
    default:
      return "대기 중";
  }
}

function formatRelativeTimestamp(value) {
  const timestamp = Date.parse(value ?? "");

  if (!Number.isFinite(timestamp)) {
    return "";
  }

  const diffMs = Math.max(0, Date.now() - timestamp);
  const diffMinutes = Math.floor(diffMs / 60000);

  if (diffMinutes <= 0) {
    return "방금 전";
  }

  if (diffMinutes < 60) {
    return `${diffMinutes}분 전`;
  }

  const diffHours = Math.floor(diffMinutes / 60);

  if (diffHours < 24) {
    return `${diffHours}시간 전`;
  }

  return new Date(timestamp).toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export default function PushNotificationCard({ apiRequest, session, selectedBridgeId }) {
  const [state, setState] = useState(createInitialState);
  const endpointRef = useRef("");

  const configPath = useMemo(() => {
    if (!session?.loginId || !selectedBridgeId) {
      return "";
    }

    return `/api/push/config?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}&app_id=${encodeURIComponent(APP_ID)}`;
  }, [selectedBridgeId, session?.loginId]);

  const subscriptionsPath = useMemo(() => {
    if (!session?.loginId || !selectedBridgeId) {
      return "";
    }

    return `/api/push/subscriptions?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}&app_id=${encodeURIComponent(APP_ID)}`;
  }, [selectedBridgeId, session?.loginId]);

  useEffect(() => {
    if (!supportsPush()) {
      setState((current) => ({
        ...current,
        configured: false,
        loading: false,
        bridgeRegistered: false,
        browserSubscriptionReady: false,
        permission: typeof Notification === "undefined" ? "default" : Notification.permission,
        subscriptionCount: 0,
        error: "이 브라우저는 웹 푸시를 지원하지 않습니다."
      }));
      return undefined;
    }

    if (!configPath || !subscriptionsPath) {
      setState((current) => ({
        ...current,
        loading: false,
        bridgeRegistered: false,
        browserSubscriptionReady: false,
        subscriptionCount: 0,
        error: ""
      }));
      endpointRef.current = "";
      return undefined;
    }

    let cancelled = false;

    async function syncState() {
      setState((current) => ({
        ...current,
        loading: true,
        permission: Notification.permission,
        error: ""
      }));

      try {
        const config = await apiRequest(configPath);

        if (cancelled) {
          return;
        }

        if (!config?.enabled) {
          endpointRef.current = "";
          setState((current) => ({
            ...current,
            configured: false,
            loading: false,
            bridgeRegistered: false,
            browserSubscriptionReady: false,
            permission: Notification.permission,
            subscriptionCount: 0,
            error: "서버에 VAPID 키가 없어 푸시가 비활성화되어 있습니다."
          }));
          return;
        }

        const registration = await navigator.serviceWorker.ready;
        const [summary, subscription] = await Promise.all([
          apiRequest(subscriptionsPath),
          readExistingSubscription(registration, Notification.permission === "granted" ? 5 : 1, 250)
        ]);

        if (cancelled) {
          return;
        }

        endpointRef.current = subscription?.endpoint ?? "";
        const endpoints = Array.isArray(summary?.endpoints) ? summary.endpoints : [];
        const currentEndpointRegistered = Boolean(endpointRef.current) && endpoints.includes(endpointRef.current);

        setState((current) => ({
          ...current,
          configured: true,
          loading: false,
          bridgeRegistered: currentEndpointRegistered,
          browserSubscriptionReady: Boolean(subscription),
          permission: Notification.permission,
          subscriptionCount: Number(summary?.count ?? endpoints.length ?? 0),
          error: ""
        }));
      } catch (error) {
        if (cancelled) {
          return;
        }

        setState((current) => ({
          ...current,
          configured: false,
          loading: false,
          permission: Notification.permission,
          error: error instanceof Error ? error.message : String(error)
        }));
      }
    }

    void syncState();

    return () => {
      cancelled = true;
    };
  }, [apiRequest, configPath, subscriptionsPath]);

  useEffect(() => {
    if (!supportsPush()) {
      return undefined;
    }

    const handleMessage = (event) => {
      if (event.data?.type !== PUSH_MESSAGE_TYPE || !event.data.payload) {
        return;
      }

      setState((current) => ({
        ...current,
        received: [event.data.payload, ...current.received].slice(0, MAX_LOG_ENTRIES)
      }));
    };

    navigator.serviceWorker.addEventListener("message", handleMessage);

    return () => {
      navigator.serviceWorker.removeEventListener("message", handleMessage);
    };
  }, []);

  const enablePushForBridge = async () => {
    if (!supportsPush() || !configPath || !subscriptionsPath || state.loading) {
      return;
    }

    setState((current) => ({
      ...current,
      loading: true,
      error: ""
    }));

    try {
      const config = await apiRequest(configPath);

      if (!config?.enabled || !config.publicVapidKey) {
        throw new Error("서버에 VAPID 공개키가 없어 푸시를 켤 수 없습니다.");
      }

      const registration = await navigator.serviceWorker.ready;
      let permission = Notification.permission;

      if (permission === "default") {
        permission = await Notification.requestPermission();
      }

      if (permission !== "granted") {
        throw new Error("브라우저 알림 권한이 허용되지 않았습니다.");
      }

      let subscription = await readExistingSubscription(registration, 5, 250);

      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(config.publicVapidKey)
        });
      }

      const payload = subscription.toJSON();

      if (!payload.endpoint || !payload.keys?.p256dh || !payload.keys?.auth) {
        throw new Error("브라우저 푸시 구독 객체를 읽지 못했습니다.");
      }

      await apiRequest(subscriptionsPath, {
        method: "POST",
        body: JSON.stringify({
          endpoint: payload.endpoint,
          expirationTime: payload.expirationTime ?? null,
          keys: {
            p256dh: payload.keys.p256dh,
            auth: payload.keys.auth
          }
        })
      });

      const summary = await apiRequest(subscriptionsPath);
      endpointRef.current = payload.endpoint;

      setState((current) => ({
        ...current,
        configured: true,
        loading: false,
        bridgeRegistered: true,
        browserSubscriptionReady: true,
        permission,
        subscriptionCount: Number(summary?.count ?? 1),
        error: ""
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        permission: typeof Notification === "undefined" ? current.permission : Notification.permission,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  };

  const disablePushForBridge = async () => {
    if (!supportsPush() || !subscriptionsPath || state.loading) {
      return;
    }

    const endpoint = endpointRef.current;

    if (!endpoint) {
      setState((current) => ({
        ...current,
        bridgeRegistered: false,
        loading: false
      }));
      return;
    }

    setState((current) => ({
      ...current,
      loading: true,
      error: ""
    }));

    try {
      await apiRequest(subscriptionsPath, {
        method: "DELETE",
        body: JSON.stringify({ endpoint })
      });

      const summary = await apiRequest(subscriptionsPath);
      setState((current) => ({
        ...current,
        loading: false,
        bridgeRegistered: false,
        subscriptionCount: Number(summary?.count ?? 0),
        error: ""
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  };

  return (
    <section className="mt-3 rounded-3xl border border-white/10 bg-white/[0.04] px-4 py-3 shadow-telegram-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Push Alerts</p>
          <h3 className="mt-1 text-sm font-semibold text-white">현재 브릿지 종료 알림</h3>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
            state.bridgeRegistered ? "bg-emerald-400/15 text-emerald-200" : "bg-white/5 text-slate-300"
          }`}
        >
          {state.bridgeRegistered ? "켜짐" : "꺼짐"}
        </span>
      </div>

      <div className="mt-3 grid gap-2 text-[12px] text-slate-400">
        <div className="flex items-center justify-between gap-3">
          <span>서버 구성</span>
          <span className={state.configured ? "text-emerald-300" : "text-slate-500"}>
            {state.configured ? "준비됨" : "미설정"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span>브라우저 권한</span>
          <span className={state.permission === "granted" ? "text-emerald-300" : "text-slate-300"}>
            {formatPermission(state.permission)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span>브라우저 구독</span>
          <span className={state.browserSubscriptionReady ? "text-emerald-300" : "text-slate-500"}>
            {state.browserSubscriptionReady ? "준비됨" : "없음"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span>현재 브릿지 등록 수</span>
          <span className="text-slate-200">{state.subscriptionCount}</span>
        </div>
      </div>

      {state.error ? <p className="mt-3 text-[12px] leading-5 text-rose-300">{state.error}</p> : null}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => void enablePushForBridge()}
          disabled={!selectedBridgeId || state.loading || !supportsPush()}
          className="flex-1 rounded-2xl bg-telegram-500 px-3 py-2 text-[12px] font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {state.loading ? "처리 중..." : "현재 브릿지 켜기"}
        </button>
        <button
          type="button"
          onClick={() => void disablePushForBridge()}
          disabled={!selectedBridgeId || state.loading || !state.bridgeRegistered}
          className="rounded-2xl border border-white/10 px-3 py-2 text-[12px] font-medium text-slate-200 transition hover:border-white/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          끄기
        </button>
      </div>

      {state.received.length > 0 ? (
        <div className="mt-3 border-t border-white/10 pt-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Recent</p>
          <ul className="mt-2 space-y-2">
            {state.received.map((entry) => (
              <li key={`${entry.issueId ?? entry.tag ?? entry.sentAt}-${entry.sentAt}`} className="rounded-2xl bg-slate-950/70 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-[12px] font-medium text-white">{entry.title ?? "OctOP 알림"}</p>
                  <span className="shrink-0 text-[11px] text-slate-500">{formatRelativeTimestamp(entry.sentAt)}</span>
                </div>
                <p className="mt-1 text-[11px] leading-5 text-slate-400">{entry.body}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
