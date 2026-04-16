import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const mobilePackage = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const mobileAppVersion = String(process.env.OCTOP_MOBILE_APP_VERSION ?? mobilePackage.version ?? "").trim() || "0.0.0";

function readGitShortSha() {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: new URL("../../", import.meta.url),
      stdio: ["ignore", "pipe", "ignore"]
    })
      .toString("utf8")
      .trim();
  } catch {
    return "";
  }
}

function createDefaultBuildId() {
  const builtAt = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const gitShortSha = readGitShortSha();
  return gitShortSha ? `${builtAt}-${gitShortSha}` : builtAt;
}

const mobileBuildId = String(process.env.OCTOP_MOBILE_BUILD_ID ?? createDefaultBuildId()).trim() || createDefaultBuildId();

function mobileBuildMetadataPlugin(buildId) {
  const source = JSON.stringify(
    {
      buildId,
      version: mobileAppVersion,
      builtAt: new Date().toISOString()
    },
    null,
    2
  );

  return {
    name: "octop-mobile-build-metadata",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith("/version.json")) {
          next();
          return;
        }

        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(source);
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), mobileBuildMetadataPlugin(mobileBuildId)],
  envDir: "../../",
  define: {
    __APP_BUILD_ID__: JSON.stringify(mobileBuildId),
    __APP_VERSION__: JSON.stringify(mobileAppVersion)
  },
  server: {
    host: "0.0.0.0",
    port: 4173
  }
});
