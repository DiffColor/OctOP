const BUILD_ID = new URL(self.location.href).searchParams.get("v") ?? "dev";
const CACHE_NAME = `octop-pocket-${BUILD_ID}`;
const APP_SHELL = ["/", "/manifest.webmanifest", "/favicon.ico", "/octop-home-icon-192.png", "/octop-home-icon-512.png", "/octop-home-icon-180.png"];
const PUSH_MESSAGE_TYPE = "octop.push.received";
const CLIENT_CONTEXT_MESSAGE_TYPE = "octop.client.context";
const CLIENT_MODE_STANDALONE = "standalone";
const CLIENT_MODE_BROWSER = "browser";
const MOBILE_APP_ID = "mobile-web";
const clientContextById = new Map();

const normalizeLaunchUrl = (value) => {
  try {
    return new URL(typeof value === "string" ? value : "/", self.location.origin).toString();
  } catch {
    return new URL("/", self.location.origin).toString();
  }
};

const normalizeClientMode = (value) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === CLIENT_MODE_STANDALONE ? CLIENT_MODE_STANDALONE : CLIENT_MODE_BROWSER;
};

const withClientModeLaunchUrl = (launchUrl, clientMode) => {
  const normalizedLaunchUrl = normalizeLaunchUrl(launchUrl);

  if (normalizeClientMode(clientMode) !== CLIENT_MODE_STANDALONE) {
    return normalizedLaunchUrl;
  }

  try {
    const url = new URL(normalizedLaunchUrl);
    url.searchParams.set("client_mode", CLIENT_MODE_STANDALONE);
    return url.toString();
  } catch {
    return normalizedLaunchUrl;
  }
};

const resolveTargetClientMode = (payload, launchUrl = "/") => {
  const normalizedTargetAppId = String(payload?.targetAppId ?? "").trim().toLowerCase();

  if (normalizedTargetAppId === MOBILE_APP_ID) {
    return CLIENT_MODE_STANDALONE;
  }

  if (normalizeClientMode(payload?.clientMode) === CLIENT_MODE_STANDALONE) {
    return CLIENT_MODE_STANDALONE;
  }

  return readClientModeFromLaunchUrl(launchUrl);
};

const buildLaunchUrl = (payload) => {
  const explicitUrl = [payload?.launchUrl, payload?.url]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find(Boolean);

  if (explicitUrl) {
    return withClientModeLaunchUrl(explicitUrl, resolveTargetClientMode(payload, explicitUrl));
  }

  const bridgeId = String(payload?.bridgeId ?? "").trim();
  const projectId = String(payload?.projectId ?? "").trim();
  const threadId = String(payload?.threadId ?? "").trim();
  const issueId = String(payload?.issueId ?? "").trim();

  if (!bridgeId && !projectId && !threadId && !issueId) {
    return "/";
  }

  const url = new URL("/", self.location.origin);

  if (bridgeId) {
    url.searchParams.set("bridge_id", bridgeId);
  }

  if (projectId) {
    url.searchParams.set("project_id", projectId);
  }

  if (threadId) {
    url.searchParams.set("thread_id", threadId);
  }

  if (issueId) {
    url.searchParams.set("issue_id", issueId);
  }

  const nextLaunchUrl = `${url.pathname}${url.search}${url.hash}`;
  return withClientModeLaunchUrl(nextLaunchUrl, resolveTargetClientMode(payload, nextLaunchUrl));
};

const isSameOriginClient = (client) => {
  if (!client?.url) {
    return false;
  }

  try {
    return new URL(client.url).origin === self.location.origin;
  } catch {
    return false;
  }
};

const readClientMode = (client) => normalizeClientMode(clientContextById.get(client?.id)?.mode);

const readClientModeFromUrl = (client) => {
  try {
    const url = new URL(client?.url ?? "", self.location.origin);
    return normalizeClientMode(url.searchParams.get("client_mode"));
  } catch {
    return CLIENT_MODE_BROWSER;
  }
};

const readClientModeFromLaunchUrl = (launchUrl) => {
  try {
    const url = new URL(normalizeLaunchUrl(launchUrl));
    return normalizeClientMode(url.searchParams.get("client_mode"));
  } catch {
    return CLIENT_MODE_BROWSER;
  }
};

const resolveClientModeForClient = (client) => {
  const reportedClientMode = readClientMode(client);
  return reportedClientMode === CLIENT_MODE_STANDALONE
    ? CLIENT_MODE_STANDALONE
    : readClientModeFromUrl(client);
};

const isStandaloneClient = (client) => resolveClientModeForClient(client) === CLIENT_MODE_STANDALONE;

const pruneClientContexts = (clients) => {
  const activeIds = new Set(clients.map((client) => client?.id).filter(Boolean));

  for (const clientId of clientContextById.keys()) {
    if (!activeIds.has(clientId)) {
      clientContextById.delete(clientId);
    }
  }
};

const scoreNotificationClient = (client, targetUrl) => {
  if (!client || !isSameOriginClient(client)) {
    return Number.NEGATIVE_INFINITY;
  }

  const clientMode = resolveClientModeForClient(client);
  let score = clientMode === CLIENT_MODE_STANDALONE ? 100 : 10;

  if (client.focused) {
    score += 20;
  }

  if (client.visibilityState === "visible") {
    score += 10;
  }

  if (normalizeLaunchUrl(client.url) === targetUrl) {
    score += 5;
  }

  return score;
};

const focusNotificationClient = async (client, targetUrl) => {
  if (!client) {
    return null;
  }

  try {
    if (normalizeLaunchUrl(client.url) !== targetUrl && typeof client.navigate === "function") {
      await client.navigate(targetUrl);
    }
  } catch {
    // navigate 실패 시에도 focus는 계속 시도
  }

  if (typeof client.focus === "function") {
    try {
      await client.focus();
    } catch {
      // 일부 플랫폼은 background client focus를 무시할 수 있으므로 실패를 삼킨다.
    }
  }

  return client;
};

const openWindowToTarget = async (targetUrl) => {
  if (typeof self.clients.openWindow !== "function") {
    return null;
  }

  try {
    const openedClient = await self.clients.openWindow(targetUrl);

    if (!openedClient) {
      return null;
    }

    return focusNotificationClient(openedClient, targetUrl);
  } catch {
    return null;
  }
};

const focusOrOpenNotificationTarget = async (launchUrl, payload = null) => {
  const targetUrl = normalizeLaunchUrl(launchUrl);
  const targetClientMode = resolveTargetClientMode(payload, targetUrl);
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true
  });

  pruneClientContexts(clients);

  const sameOriginClients = [...clients]
    .filter((client) => isSameOriginClient(client))
    .sort((left, right) => scoreNotificationClient(right, targetUrl) - scoreNotificationClient(left, targetUrl));
  const preferredClient = sameOriginClients[0] ?? null;
  const preferredVisibleClient =
    sameOriginClients.find((client) => client.focused || client.visibilityState === "visible") ?? null;
  const preferredStandaloneClient = sameOriginClients.find((client) => isStandaloneClient(client)) ?? null;
  const shouldPreferStandaloneLaunch =
    targetClientMode === CLIENT_MODE_STANDALONE || Boolean(preferredStandaloneClient);

  if (shouldPreferStandaloneLaunch && preferredStandaloneClient) {
    return focusNotificationClient(preferredStandaloneClient, targetUrl);
  }

  if (preferredVisibleClient) {
    return focusNotificationClient(preferredVisibleClient, targetUrl);
  }

  if (preferredClient) {
    return focusNotificationClient(preferredClient, targetUrl);
  }

  return openWindowToTarget(targetUrl);
};

const getContentType = (response) => response?.headers?.get("content-type")?.toLowerCase() ?? "";

const isHtmlResponse = (response) => getContentType(response).includes("text/html");

const isAssetRequest = (request, requestUrl) => {
  if (!request || !requestUrl) {
    return false;
  }

  if (request.destination === "script" || request.destination === "style" || request.destination === "worker") {
    return true;
  }

  return requestUrl.pathname.startsWith("/assets/");
};

const isApiRequest = (requestUrl) => requestUrl?.pathname?.startsWith("/api/");

const cacheResponse = async (request, response) => {
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response.clone());
};

const removeCachedResponse = async (request) => {
  const cache = await caches.open(CACHE_NAME);
  await cache.delete(request);
};

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.allSettled(
        APP_SHELL.map(async (url) => {
          try {
            const response = await fetch(url, { cache: "no-store" });
            if (response.ok) {
              await cache.put(url, response.clone());
            }
          } catch {
          }
        })
      );
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }

          return Promise.resolve();
        })
      )
    )
  );

  self.clients.claim();
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  if (event.data?.type === CLIENT_CONTEXT_MESSAGE_TYPE) {
    const clientId = String(event.source?.id ?? "").trim();

    if (!clientId) {
      return;
    }

    clientContextById.set(clientId, {
      mode: normalizeClientMode(event.data.clientMode),
      updatedAt: Date.now()
    });
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const requestUrl = new URL(event.request.url);
  const isSameOrigin = requestUrl.origin === self.location.origin;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const cloned = response.clone();

          caches.open(CACHE_NAME).then((cache) => {
            cache.put("/", cloned);
          });

          return response;
        })
        .catch(async () => {
          const cached = await caches.match("/");
          return cached ?? Response.error();
        })
    );

    return;
  }

  if (!isSameOrigin) {
    return;
  }

  if (isApiRequest(requestUrl) || requestUrl.pathname.startsWith("/version.json")) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }

  event.respondWith(
    caches.match(event.request).then(async (cached) => {
      const assetRequest = isAssetRequest(event.request, requestUrl);

      if (cached) {
        if (!(assetRequest && isHtmlResponse(cached))) {
          return cached;
        }

        await removeCachedResponse(event.request);
      }

      return fetch(event.request, assetRequest ? { cache: "no-store" } : undefined).then(async (response) => {
        if (!response || response.status !== 200 || response.type !== "basic") {
          return response;
        }

        if (assetRequest && isHtmlResponse(response)) {
          await removeCachedResponse(event.request);
          return response;
        }

        await cacheResponse(event.request, response);
        return response;
      });
    })
  );
});

self.addEventListener("push", (event) => {
  const payload = event.data ? event.data.json() : {};
  const title = payload.title || "OctOP";
  const sentAt = payload.sentAt || new Date().toISOString();
  const body = payload.body || "이슈 상태 알림이 도착했습니다.";
  const launchUrl = buildLaunchUrl(payload);
  const notificationData = {
    ...payload,
    launchUrl,
    sentAt
  };

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, {
        body,
        tag: payload.tag || `octop-mobile-${Date.parse(sentAt) || Date.now()}`,
        renotify: true,
        icon: "/octop-home-icon-192.png",
        badge: "/octop-home-icon-192.png",
        data: notificationData
      });

      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true
      });

      for (const client of clients) {
        client.postMessage({
          type: PUSH_MESSAGE_TYPE,
          payload: notificationData
        });
      }
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    focusOrOpenNotificationTarget(event.notification.data?.launchUrl || "/", event.notification.data ?? null)
  );
});
