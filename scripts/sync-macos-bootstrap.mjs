import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const workspaceRoot = process.cwd();
const bootstrapRoot = resolve(
  workspaceRoot,
  "apps",
  "macos-agent-menu",
  "Sources",
  "Resources",
  "bootstrap"
);

const runtimeFiles = [
  "scripts/shared-env.mjs",
  "scripts/app-server-runtime-state.mjs",
  "scripts/app-server-activity-beacon.mjs",
  "scripts/local-agent-health.mjs",
  "scripts/run-local-agent.mjs",
  "scripts/run-bridge.mjs",
  "services/codex-adapter/package.json",
  "services/codex-adapter/src/index.js",
  "services/codex-adapter/src/assistantMessageNormalization.js",
  "services/codex-adapter/src/domain.js",
  "services/codex-adapter/src/projectInstructionState.js"
];

for (const relativePath of runtimeFiles) {
  const sourcePath = resolve(workspaceRoot, relativePath);
  const targetPath = resolve(bootstrapRoot, relativePath);

  if (!existsSync(sourcePath)) {
    throw new Error(`macOS bootstrap sync source missing: ${sourcePath}`);
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  cpSync(sourcePath, targetPath);
  console.log(`[sync-macos-bootstrap] ${relativePath}`);
}
