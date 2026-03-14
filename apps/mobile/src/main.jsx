import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
import { PWA_UPDATE_ACTIVATOR_KEY, PWA_UPDATE_READY_EVENT } from "./pwaEvents.js";

if ("serviceWorker" in navigator) {
  const SERVICE_WORKER_BUILD_ID = typeof __APP_BUILD_ID__ === "string" ? __APP_BUILD_ID__ : "dev";
  const SERVICE_WORKER_URL = `/sw.js?v=${encodeURIComponent(SERVICE_WORKER_BUILD_ID)}`;
  const SKIP_WAITING_MESSAGE = { type: "SKIP_WAITING" };
  const UPDATE_CHECK_MIN_INTERVAL_MS = 15_000;
  let refreshing = false;
  let controllerSeen = Boolean(navigator.serviceWorker.controller);
  let pendingActivationWorker = null;
  let lastUpdateCheckAt = 0;
  const observedRegistrations = new WeakSet();
  const observedWorkers = new WeakSet();

  const notifyUpdateReady = (worker) => {
    if (!worker || pendingActivationWorker === worker) {
      return;
    }

    pendingActivationWorker = worker;

    const activate = () => {
      try {
        if (worker.state !== "redundant") {
          worker.postMessage(SKIP_WAITING_MESSAGE);
        } else {
          window.location.reload();
        }
      } catch {
        window.location.reload();
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

  const checkForServiceWorkerUpdate = () => {
    if (shouldSkipUpdateCheck()) {
      return;
    }

    navigator.serviceWorker
      .getRegistration()
      .then((registration) => {
        if (registration) {
          syncRegistration(registration);
          return;
        }

        return navigator.serviceWorker.register(SERVICE_WORKER_URL).then((nextRegistration) => {
          syncRegistration(nextRegistration);
        });
      })
      .catch(() => {});
  };

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!controllerSeen) {
      controllerSeen = true;
      return;
    }

    if (refreshing) {
      return;
    }

    refreshing = true;
    window.location.reload();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(SERVICE_WORKER_URL)
      .then((registration) => {
        syncRegistration(registration);
      })
      .catch(() => {});
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
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
