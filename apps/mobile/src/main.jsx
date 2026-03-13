import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

if ("serviceWorker" in navigator) {
  const SKIP_WAITING_MESSAGE = { type: "SKIP_WAITING" };
  let refreshing = false;
  let controllerSeen = Boolean(navigator.serviceWorker.controller);

  const requestImmediateActivation = (worker) => {
    if (!worker) {
      return;
    }

    const notifyWorker = () => {
      worker.postMessage(SKIP_WAITING_MESSAGE);
    };

    if (worker.state === "installed") {
      notifyWorker();
    } else {
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed") {
          notifyWorker();
        }
      });
    }
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
      .register("/sw.js")
      .then((registration) => {
        requestImmediateActivation(registration.waiting ?? registration.installing);

        registration.addEventListener("updatefound", () => {
          requestImmediateActivation(registration.installing);
        });
      })
      .catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
