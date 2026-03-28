import test from "node:test";
import assert from "node:assert/strict";

import {
  isLoopbackHostname,
  shouldResetAppServerForSystemNetworkRecovery
} from "../../services/codex-adapter/src/systemNetwork.js";

test("loopback/바인드 주소는 로컬 app-server 대상으로 취급한다", () => {
  assert.equal(isLoopbackHostname("localhost"), true);
  assert.equal(isLoopbackHostname("127.0.0.1"), true);
  assert.equal(isLoopbackHostname("127.0.0.42"), true);
  assert.equal(isLoopbackHostname("[::1]"), true);
  assert.equal(isLoopbackHostname("::"), true);
  assert.equal(isLoopbackHostname("0.0.0.0"), true);
});

test("로컬 app-server URL은 system network 복구 때 소켓을 강제로 닫지 않는다", () => {
  assert.equal(shouldResetAppServerForSystemNetworkRecovery("ws://127.0.0.1:4600"), false);
  assert.equal(shouldResetAppServerForSystemNetworkRecovery("ws://localhost:4600"), false);
  assert.equal(shouldResetAppServerForSystemNetworkRecovery("ws://[::1]:4600"), false);
  assert.equal(shouldResetAppServerForSystemNetworkRecovery("ws://0.0.0.0:4600"), false);
});

test("원격 app-server URL이나 잘못된 URL은 기존처럼 network 복구 대상에 포함한다", () => {
  assert.equal(shouldResetAppServerForSystemNetworkRecovery("ws://192.168.0.10:4600"), true);
  assert.equal(shouldResetAppServerForSystemNetworkRecovery("wss://octop.example.com/app-server"), true);
  assert.equal(shouldResetAppServerForSystemNetworkRecovery("not-a-url"), true);
});
