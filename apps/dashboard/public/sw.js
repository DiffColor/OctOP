const BUILD_ID = new URL(self.location.href).searchParams.get("v") ?? "dev";
const CACHE_NAME = `octop-dashboard-${BUILD_ID}`;
const APP_SHELL = ["/", "/favicon.ico", "/icon-192.png", "/icon-512.png"];
const PUSH_MESSAGE_TYPE = "octop.push.received";
const ASSET_MISMATCH_RECOVERY_FLAG = "__octopAssetMismatchRecovery";
let assetMismatchRecoveryPromise = null;

const buildLaunchUrl = (payload) => {
  const explicitUrl = [payload?.launchUrl, payload?.url]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find(Boolean);

  if (explicitUrl) {
    return explicitUrl;
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

  return `${url.pathname}${url.search}${url.hash}`;
};

const getContentType = (response) => response?.headers?.get("content-type")?.toLowerCase() ?? "";
const isHtmlResponse = (response) => getContentType(response).includes("text/html");

const isAssetRequest = (request, requestUrl) => {
  if (!request || !requestUrl) {
    return false;
  }

  if (
    request.destination === "script" ||
    request.destination === "style" ||
    request.destination === "worker" ||
    request.destination === "document"
  ) {
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

const buildAssetMismatchRecoveryResponse = (requestUrl, destination = "") => {
  const normalizedDestination = String(destination ?? "").trim().toLowerCase();
  const pathname = String(requestUrl?.pathname ?? "").toLowerCase();

  if (
    normalizedDestination === "script" ||
    normalizedDestination === "worker" ||
    pathname.endsWith(".js") ||
    pathname.endsWith(".mjs")
  ) {
    return new Response("export {};", {
      status: 200,
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }

  if (normalizedDestination === "style" || pathname.endsWith(".css")) {
    return new Response("/* octop asset mismatch recovery */", {
      status: 200,
      headers: {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }

  return Response.error();
};

const recoverFromAssetMismatch = async () => {
  if (assetMismatchRecoveryPromise) {
    return assetMismatchRecoveryPromise;
  }

  assetMismatchRecoveryPromise = (async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.delete("/");

    const clients = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });

    await Promise.allSettled(
      clients.map(async (client) => {
        const targetUrl = new URL(client?.url || "/", self.location.origin);

        if (targetUrl.searchParams.get(ASSET_MISMATCH_RECOVERY_FLAG) !== "1") {
          targetUrl.searchParams.set(ASSET_MISMATCH_RECOVERY_FLAG, "1");
        }

        try {
          if (typeof client.navigate === "function") {
            await client.navigate(targetUrl.toString());
            return;
          }
        } catch {
          // ignore navigate failures and continue
        }

        try {
          await client.focus?.();
        } catch {
          // ignore focus failures
        }
      })
    );
  })().finally(() => {
    assetMismatchRecoveryPromise = null;
  });

  return assetMismatchRecoveryPromise;
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
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const requestUrl = new URL(event.request.url);

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

  if (requestUrl.origin !== self.location.origin) {
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
          void recoverFromAssetMismatch();
          return buildAssetMismatchRecoveryResponse(requestUrl, event.request.destination);
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
        tag: payload.tag || `octop-dashboard-${Date.parse(sentAt) || Date.now()}`,
        renotify: true,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
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
  event.waitUntil(self.clients.openWindow(event.notification.data?.launchUrl || "/"));
});
