import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
import { PWA_UPDATE_ACTIVATOR_KEY, PWA_UPDATE_READY_EVENT } from "./pwaEvents.js";

if ("serviceWorker" in navigator) {
  const SERVICE_WORKER_BUILD_ID = typeof __APP_BUILD_ID__ === "string" ? __APP_BUILD_ID__ : "dev";
  const VERSION_METADATA_URL = "/version.json";
  const SKIP_WAITING_MESSAGE = { type: "SKIP_WAITING" };
  const UPDATE_CHECK_MIN_INTERVAL_MS = 3_000;
  const UPDATE_CHECK_POLL_INTERVAL_MS = 5_000;
  const UPDATE_ACTIVATION_RELOAD_TIMEOUT_MS = 2_500;
  let refreshing = false;
  let controllerSeen = Boolean(navigator.serviceWorker.controller);
  let pendingActivationWorker = null;
  let lastUpdateCheckAt = 0;
  let activationRequested = false;
  let activationReloadTimer = null;
  const observedRegistrations = new WeakSet();
  const observedWorkers = new WeakSet();

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

  const getServiceWorkerUrl = (buildId = SERVICE_WORKER_BUILD_ID) => `/sw.js?v=${encodeURIComponent(buildId)}`;

  const getBuildIdFromScriptUrl = (scriptUrl) => {
    if (!scriptUrl) {
      return null;
    }

    try {
      return new URL(scriptUrl, window.location.href).searchParams.get("v");
    } catch {
      return null;
    }
  };

  const getRegistrationBuildId = (registration) =>
    getBuildIdFromScriptUrl(
      registration?.waiting?.scriptURL ??
        registration?.installing?.scriptURL ??
        registration?.active?.scriptURL ??
        ""
    );

  const notifyUpdateReady = (worker) => {
    if (!worker || pendingActivationWorker === worker) {
      return;
    }

    pendingActivationWorker = worker;

    const activate = () => {
      activationRequested = true;
      clearActivationReloadTimer();
      activationReloadTimer = window.setTimeout(() => {
        forceReload();
      }, UPDATE_ACTIVATION_RELOAD_TIMEOUT_MS);

      try {
        if (worker.state !== "redundant") {
          worker.postMessage(SKIP_WAITING_MESSAGE);
        } else {
          forceReload();
        }
      } catch {
        forceReload();
      }
    };

    window[PWA_UPDATE_ACTIVATOR_KEY] = activate;
    window.dispatchEvent(
      new CustomEvent(PWA_UPDATE_READY_EVENT, {
        detail: {
          activate
        }
      })
    );
  };

  const monitorWaitingWorker = (worker) => {
    if (!worker) {
      return;
    }

    if (worker.state === "installed") {
      notifyUpdateReady(worker);
      return;
    }

    if (observedWorkers.has(worker)) {
      return;
    }

    observedWorkers.add(worker);

    const handleStateChange = () => {
      if (worker.state === "installed") {
        worker.removeEventListener("statechange", handleStateChange);
        notifyUpdateReady(worker);
      }
    };

    worker.addEventListener("statechange", handleStateChange);
  };

  const registerUpdateListeners = (registration) => {
    if (!registration) {
      return;
    }

    if (registration.waiting) {
      monitorWaitingWorker(registration.waiting);
    } else if (registration.installing) {
      monitorWaitingWorker(registration.installing);
    }

    if (observedRegistrations.has(registration)) {
      return;
    }

    observedRegistrations.add(registration);
    registration.addEventListener("updatefound", () => {
      if (registration.installing) {
        monitorWaitingWorker(registration.installing);
      }
    });
  };

  const shouldSkipUpdateCheck = () => Date.now() - lastUpdateCheckAt < UPDATE_CHECK_MIN_INTERVAL_MS;

  const syncRegistration = (registration) => {
    if (!registration) {
      return;
    }

    registerUpdateListeners(registration);
    lastUpdateCheckAt = Date.now();
    registration.update().catch(() => {});
  };

  const readLatestBuildId = async () => {
    const response = await fetch(`${VERSION_METADATA_URL}?t=${Date.now()}`, {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`version metadata request failed (${response.status})`);
    }

    const payload = await response.json();
    const buildId = String(payload?.buildId ?? "").trim();
    return buildId || null;
  };

  const checkForServiceWorkerUpdate = () => {
    if (shouldSkipUpdateCheck()) {
      return;
    }

    lastUpdateCheckAt = Date.now();

    Promise.all([navigator.serviceWorker.getRegistration(), readLatestBuildId().catch(() => null)])
      .then(([registration, latestBuildId]) => {
        const targetBuildId = latestBuildId ?? SERVICE_WORKER_BUILD_ID;
        const registrationBuildId = getRegistrationBuildId(registration);

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

    if (!controllerSeen && !activationRequested) {
      controllerSeen = true;
      return;
    }

    controllerSeen = true;
    activationRequested = false;
    forceReload();
  });

  window.addEventListener("load", () => {
    checkForServiceWorkerUpdate();
  });

  navigator.serviceWorker.ready
    .then((registration) => {
      registerUpdateListeners(registration);
    })
    .catch(() => {});

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      checkForServiceWorkerUpdate();
    }
  });

  window.addEventListener("pageshow", () => {
    checkForServiceWorkerUpdate();
  });

  window.addEventListener("focus", () => {
    checkForServiceWorkerUpdate();
  });

  window.setInterval(() => {
    if (document.visibilityState === "visible") {
      checkForServiceWorkerUpdate();
    }
  }, UPDATE_CHECK_POLL_INTERVAL_MS);
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
