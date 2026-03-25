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
  const UPDATE_ACTIVATION_RELOAD_TIMEOUT_MS = 10_000;
  const UPDATE_ACTIVATION_POLL_INTERVAL_MS = 250;
  const QUEUED_PWA_UPDATE_BUILD_ID_KEY = "__octopMobileQueuedPwaUpdateBuildId";
  const UNKNOWN_QUEUED_PWA_UPDATE_BUILD_ID = "__unknown__";
  let refreshing = false;
  let controllerSeen = Boolean(navigator.serviceWorker.controller);
  let pendingActivationWorker = null;
  let lastUpdateCheckAt = 0;
  let activationRequested = false;
  let activationReloadTimer = null;
  let queuedPwaUpdateBuildId = "";
  const observedRegistrations = new WeakSet();
  const observedWorkers = new WeakSet();

  const normalizeQueuedUpdateBuildId = (buildId) => {
    const normalizedBuildId = String(buildId ?? "").trim();
    return normalizedBuildId || "";
  };

  const readQueuedUpdateBuildId = () => {
    try {
      return normalizeQueuedUpdateBuildId(window.sessionStorage?.getItem?.(QUEUED_PWA_UPDATE_BUILD_ID_KEY));
    } catch {
      return "";
    }
  };

  const writeQueuedUpdateBuildId = (buildId = "") => {
    const normalizedBuildId = normalizeQueuedUpdateBuildId(buildId);

    try {
      if (!normalizedBuildId) {
        window.sessionStorage?.removeItem?.(QUEUED_PWA_UPDATE_BUILD_ID_KEY);
        return;
      }

      window.sessionStorage?.setItem?.(QUEUED_PWA_UPDATE_BUILD_ID_KEY, normalizedBuildId);
    } catch {
      // ignore storage failures
    }
  };

  const queueLatestPwaUpdate = (buildId = "") => {
    queuedPwaUpdateBuildId = normalizeQueuedUpdateBuildId(buildId) || UNKNOWN_QUEUED_PWA_UPDATE_BUILD_ID;
    writeQueuedUpdateBuildId(queuedPwaUpdateBuildId);
  };

  const clearQueuedPwaUpdate = () => {
    queuedPwaUpdateBuildId = "";
    writeQueuedUpdateBuildId("");
  };

  const getQueuedPwaUpdateBuildId = () => (queuedPwaUpdateBuildId === UNKNOWN_QUEUED_PWA_UPDATE_BUILD_ID ? "" : queuedPwaUpdateBuildId);

  const shouldAutoActivateQueuedUpdate = (buildId = "") => {
    if (!queuedPwaUpdateBuildId) {
      return false;
    }

    if (queuedPwaUpdateBuildId === UNKNOWN_QUEUED_PWA_UPDATE_BUILD_ID) {
      return true;
    }

    return normalizeQueuedUpdateBuildId(buildId) === queuedPwaUpdateBuildId;
  };

  queuedPwaUpdateBuildId = readQueuedUpdateBuildId();

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
    pendingActivationWorker = null;
    window[PWA_UPDATE_ACTIVATOR_KEY] = null;
    clearActivationReloadTimer();
    window.location.reload();
  };

  const hasActivatedTargetBuild = (registration, targetBuildId = "") => {
    const normalizedTargetBuildId = String(targetBuildId ?? "").trim();

    if (!normalizedTargetBuildId) {
      return false;
    }

    const activeBuildId = getBuildIdFromScriptUrl(registration?.active?.scriptURL);
    const controllerBuildId = getBuildIdFromScriptUrl(navigator.serviceWorker.controller?.scriptURL);
    const waitingBuildId = getBuildIdFromScriptUrl(registration?.waiting?.scriptURL);
    const installingBuildId = getBuildIdFromScriptUrl(registration?.installing?.scriptURL);

    if (controllerBuildId === normalizedTargetBuildId) {
      return true;
    }

    return (
      activeBuildId === normalizedTargetBuildId &&
      waitingBuildId !== normalizedTargetBuildId &&
      installingBuildId !== normalizedTargetBuildId
    );
  };

  const waitForNewControllerScript = (targetBuildId = "") => {
    clearActivationReloadTimer();

    const normalizedTargetBuildId = String(targetBuildId ?? "").trim();
    if (!normalizedTargetBuildId) {
      activationReloadTimer = window.setTimeout(() => {
        void clearServiceWorker().finally(() => {
          forceReload();
        });
      }, UPDATE_ACTIVATION_RELOAD_TIMEOUT_MS);
      return;
    }

    const startedAt = Date.now();
    let resolved = false;

    const check = async () => {
      if (resolved) {
        return;
      }

      try {
        const registration = await navigator.serviceWorker.getRegistration();

        if (hasActivatedTargetBuild(registration, normalizedTargetBuildId)) {
          resolved = true;
          forceReload();
          return;
        }
      } catch {
        // ignore and continue polling
      }

      if (Date.now() - startedAt >= UPDATE_ACTIVATION_RELOAD_TIMEOUT_MS) {
        resolved = true;
        void clearServiceWorker().finally(() => {
          forceReload();
        });
        return;
      }

      activationReloadTimer = window.setTimeout(check, UPDATE_ACTIVATION_POLL_INTERVAL_MS);
    };

    activationReloadTimer = window.setTimeout(check, UPDATE_ACTIVATION_POLL_INTERVAL_MS);
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

  const requestServiceWorkerActivation = async (targetWorker = null) => {
    const registration = await navigator.serviceWorker.getRegistration();
    const waitingWorker = registration?.waiting;
    const activationWorker = targetWorker && targetWorker.state !== "redundant" ? targetWorker : waitingWorker;

    try {
      await registration?.update?.();
    } catch {
      // no-op
    }

    if (activationWorker && activationWorker.state !== "redundant") {
      activationWorker.postMessage(SKIP_WAITING_MESSAGE);
      return;
    }

    if (waitingWorker && waitingWorker.state !== "redundant") {
      waitingWorker.postMessage(SKIP_WAITING_MESSAGE);
    } else {
      throw new Error("no activatable worker");
    }
  };

  const clearServiceWorker = async () => {
    const registration = await navigator.serviceWorker.getRegistration();

    if (registration) {
      await registration.unregister().catch(() => {});
    }
  };

  const notifyUpdateReady = (worker) => {
    if (!worker || pendingActivationWorker === worker || refreshing) {
      return;
    }

    const targetBuildId = getBuildIdFromScriptUrl(worker?.scriptURL);

    if (activationRequested) {
      queueLatestPwaUpdate(targetBuildId);
      return;
    }

    pendingActivationWorker = worker;

    const activate = () => {
      if (activationRequested || refreshing) {
        return;
      }

      activationRequested = true;
      pendingActivationWorker = worker;
      window[PWA_UPDATE_ACTIVATOR_KEY] = null;

      if (shouldAutoActivateQueuedUpdate(targetBuildId)) {
        clearQueuedPwaUpdate();
      }

      waitForNewControllerScript(targetBuildId ?? SERVICE_WORKER_BUILD_ID);

      try {
        void requestServiceWorkerActivation(worker).catch(() => {
          void clearServiceWorker().finally(() => {
            forceReload();
          });
        });
      } catch {
        void clearServiceWorker().finally(() => {
          forceReload();
        });
      }
    };

    if (queuedPwaUpdateBuildId) {
      if (shouldAutoActivateQueuedUpdate(targetBuildId)) {
        activate();
        return;
      }

      checkForServiceWorkerUpdate();
      return;
    }

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

    if (activationRequested || refreshing) {
      return;
    }

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
    if (shouldSkipUpdateCheck() || activationRequested || refreshing) {
      return;
    }

    lastUpdateCheckAt = Date.now();

    Promise.all([navigator.serviceWorker.getRegistration(), readLatestBuildId().catch(() => null)])
      .then(([registration, latestBuildId]) => {
        const queuedBuildId = getQueuedPwaUpdateBuildId();
        const targetBuildId = latestBuildId ?? queuedBuildId ?? SERVICE_WORKER_BUILD_ID;
        const registrationBuildId = getRegistrationBuildId(registration);

        if (queuedBuildId && hasActivatedTargetBuild(registration, queuedBuildId)) {
          clearQueuedPwaUpdate();
        }

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
    pendingActivationWorker = null;
    window[PWA_UPDATE_ACTIVATOR_KEY] = null;

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
