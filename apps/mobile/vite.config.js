import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const mobileBuildId = process.env.OCTOP_MOBILE_BUILD_ID ?? `${Date.now()}`;

function mobileBuildMetadataPlugin(buildId) {
  const source = JSON.stringify({ buildId }, null, 2);

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
    __APP_BUILD_ID__: JSON.stringify(mobileBuildId)
  },
  server: {
    host: "0.0.0.0",
    port: 4173
  }
});
