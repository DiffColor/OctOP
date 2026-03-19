const SERVICE_WORKER_BUILD_ID = typeof __APP_BUILD_ID__ === "string" ? __APP_BUILD_ID__ : "dev";
const VERSION_METADATA_URL = "/version.json";
const UPDATE_CHECK_MIN_INTERVAL_MS = 3_000;
const UPDATE_CHECK_POLL_INTERVAL_MS = 30_000;
const UPDATE_ACTIVATION_RELOAD_TIMEOUT_MS = 2_500;

function getServiceWorkerUrl(buildId = SERVICE_WORKER_BUILD_ID) {
  return `/sw.js?v=${encodeURIComponent(buildId)}`;
}

function getBuildIdFromScriptUrl(scriptUrl) {
  if (!scriptUrl) {
    return null;
  }

  try {
    return new URL(scriptUrl, window.location.href).searchParams.get("v");
  } catch {
    return null;
  }
}

async function readLatestBuildId() {
  const response = await fetch(`${VERSION_METADATA_URL}?t=${Date.now()}`, {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`version metadata request failed (${response.status})`);
  }

  const payload = await response.json();
  const buildId = String(payload?.buildId ?? "").trim();
  return buildId || null;
}

export function startDashboardServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  let refreshing = false;
  let controllerSeen = Boolean(navigator.serviceWorker.controller);
  let activationReloadTimer = null;
  let lastUpdateCheckAt = 0;

  const clearActivationReloadTimer = () => {
    if (activationReloadTimer) {
      window.clearTimeout(activationReloadTimer);
      activationReloadTimer = null;
    }
  };

  const forceReload = () => {
    if (refreshing) {
      return;
    }

    refreshing = true;
    clearActivationReloadTimer();
    window.location.reload();
  };

  const syncRegistration = (registration) => {
    if (!registration) {
      return;
    }

    lastUpdateCheckAt = Date.now();
    registration.update().catch(() => {});

    const watchWorker = (worker) => {
      if (!worker) {
        return;
      }

      const handleStateChange = () => {
        if (worker.state === "installed") {
          worker.removeEventListener("statechange", handleStateChange);
          activationReloadTimer = window.setTimeout(() => {
            forceReload();
          }, UPDATE_ACTIVATION_RELOAD_TIMEOUT_MS);
          worker.postMessage({ type: "SKIP_WAITING" });
        }
      };

      if (worker.state === "installed") {
        activationReloadTimer = window.setTimeout(() => {
          forceReload();
        }, UPDATE_ACTIVATION_RELOAD_TIMEOUT_MS);
        worker.postMessage({ type: "SKIP_WAITING" });
        return;
      }

      worker.addEventListener("statechange", handleStateChange);
    };

    if (registration.waiting) {
      watchWorker(registration.waiting);
    }

    registration.addEventListener("updatefound", () => {
      if (registration.installing) {
        watchWorker(registration.installing);
      }
    });
  };

  const shouldSkipUpdateCheck = () => Date.now() - lastUpdateCheckAt < UPDATE_CHECK_MIN_INTERVAL_MS;

  const checkForServiceWorkerUpdate = () => {
    if (shouldSkipUpdateCheck()) {
      return;
    }

    lastUpdateCheckAt = Date.now();

    Promise.all([navigator.serviceWorker.getRegistration(), readLatestBuildId().catch(() => null)])
      .then(([registration, latestBuildId]) => {
        const targetBuildId = latestBuildId ?? SERVICE_WORKER_BUILD_ID;
        const registrationBuildId = getBuildIdFromScriptUrl(
          registration?.waiting?.scriptURL ??
            registration?.installing?.scriptURL ??
            registration?.active?.scriptURL ??
            ""
        );

        if (!registration || registrationBuildId !== targetBuildId) {
          return navigator.serviceWorker.register(getServiceWorkerUrl(targetBuildId)).then((nextRegistration) => {
            syncRegistration(nextRegistration);
          });
        }

        syncRegistration(registration);
        return undefined;
      })
      .catch(() => {});
  };

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    clearActivationReloadTimer();

    if (!controllerSeen) {
      controllerSeen = true;
      return;
    }

    forceReload();
  });

  window.addEventListener("load", checkForServiceWorkerUpdate);
  window.addEventListener("pageshow", checkForServiceWorkerUpdate);
  window.addEventListener("focus", checkForServiceWorkerUpdate);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      checkForServiceWorkerUpdate();
    }
  });

  navigator.serviceWorker.ready
    .then((registration) => {
      syncRegistration(registration);
    })
    .catch(() => {});

  window.setInterval(() => {
    if (document.visibilityState === "visible") {
      checkForServiceWorkerUpdate();
    }
  }, UPDATE_CHECK_POLL_INTERVAL_MS);
}
