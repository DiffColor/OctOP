import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const mobileBuildId = process.env.OCTOP_MOBILE_BUILD_ID ?? `${Date.now()}`;

export default defineConfig({
  plugins: [react()],
  envDir: "../../",
  define: {
    __APP_BUILD_ID__: JSON.stringify(mobileBuildId)
  },
  server: {
    host: "0.0.0.0",
    port: 4173
  }
});
