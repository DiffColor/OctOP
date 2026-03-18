const BUILD_ID = new URL(self.location.href).searchParams.get("v") ?? "dev";
const CACHE_NAME = `octop-pocket-${BUILD_ID}`;
const APP_SHELL = ["/", "/manifest.webmanifest", "/favicon.ico", "/octop-home-icon-192.png", "/octop-home-icon-512.png", "/octop-home-icon-180.png"];

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
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
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
