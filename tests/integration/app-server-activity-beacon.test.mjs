import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

import { readAppServerRuntimeSnapshot } from "../../scripts/app-server-runtime-state.mjs";

test("activity beacon 래퍼가 긴 셸 명령 동안 비컨을 남기고 종료 후 정리한다", async () => {
  const tempRoot = mkdtempSync(resolve(os.tmpdir(), "octop-activity-beacon-"));
  const env = {
    ...process.env,
    OCTOP_STATE_HOME: tempRoot,
    OCTOP_BRIDGE_ID: "test-bridge",
    OCTOP_APP_SERVER_ACTIVITY_BEACON_PULSE_INTERVAL_MS: "50",
    OCTOP_APP_SERVER_ACTIVITY_BEACON_STALE_MS: "5000"
  };
  const beaconScriptPath = resolve("scripts", "app-server-activity-beacon.mjs");
  const child = spawn(
    process.execPath,
    [
      beaconScriptPath,
      "run",
      "--label",
      "integration-test",
      "--",
      process.execPath,
      "-e",
      "setTimeout(function(){process.exit(0)}, 2000)"
    ],
    {
      cwd: process.cwd(),
      env,
      stdio: "ignore"
    }
  );

  let activeSnapshot = null;
  const startedAt = Date.now();

  while (Date.now() - startedAt < 1500) {
    activeSnapshot = readAppServerRuntimeSnapshot({
      env,
      workspaceRoot: process.cwd()
    });

    if (activeSnapshot.activityBeacon.active) {
      break;
    }

    await new Promise((resolveTimer) => setTimeout(resolveTimer, 25));
  }

  assert.equal(activeSnapshot.activityBeacon.active, true);
  assert.equal(activeSnapshot.activityBeacon.activeCount, 1);
  assert.equal(activeSnapshot.activityBeacon.lastLabel, "integration-test");

  const exitCode = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code) => resolveExit(code));
  });

  assert.equal(exitCode, 0);

  await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));

  const completedSnapshot = readAppServerRuntimeSnapshot({
    env,
    workspaceRoot: process.cwd()
  });

  assert.equal(completedSnapshot.activityBeacon.active, false);
});
