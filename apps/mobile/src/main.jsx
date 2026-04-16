import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
import bootstrapMobilePwaUpdateFlow from "./pwaBootstrap.js";

document.documentElement.dataset.octopSurface = "mobile";

(() => {
  const assetMismatchRecoveryHandledKey = "__octopAssetMismatchRecoveryHandledAt";
  const forcedBuildReloadQueryKey = "__octopPwaBuild";

  try {
    const url = new URL(window.location.href);
    let shouldReplaceHistory = false;

    if (url.searchParams.get("__octopAssetMismatchRecovery") === "1") {
      window.sessionStorage?.setItem?.(assetMismatchRecoveryHandledKey, String(Date.now()));
      url.searchParams.delete("__octopAssetMismatchRecovery");
      shouldReplaceHistory = true;
    }

    if (url.searchParams.has(forcedBuildReloadQueryKey)) {
      url.searchParams.delete(forcedBuildReloadQueryKey);
      shouldReplaceHistory = true;
    }

    if (!shouldReplaceHistory) {
      return;
    }

    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // ignore malformed location values
  }
})();

bootstrapMobilePwaUpdateFlow();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
