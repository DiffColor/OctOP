import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
import { startDashboardServiceWorker } from "./swRegistration.js";

document.documentElement.dataset.octopSurface = "dashboard";

(() => {
  const assetMismatchRecoveryHandledKey = "__octopAssetMismatchRecoveryHandledAt";

  try {
    const url = new URL(window.location.href);

    if (url.searchParams.get("__octopAssetMismatchRecovery") !== "1") {
      return;
    }

    window.sessionStorage?.setItem?.(assetMismatchRecoveryHandledKey, String(Date.now()));
    url.searchParams.delete("__octopAssetMismatchRecovery");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // ignore malformed location values
  }
})();

startDashboardServiceWorker();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
