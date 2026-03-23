import test from "node:test";
import assert from "node:assert/strict";

import {
  createBridgeDisconnectEvidence,
  isBridgeDisconnectConfirmed,
  reduceBridgeDisconnectEvidence
} from "../../packages/domain/src/index.js";

test("ws 끊김만으로는 브릿지 끊김을 확정하지 않는다", () => {
  const next = reduceBridgeDisconnectEvidence(createBridgeDisconnectEvidence(), {
    type: "socket_disconnected",
    at: 1000
  });

  assert.equal(next.socketDisconnectedAt, 1000);
  assert.equal(next.transportFailureAt, 0);
  assert.equal(isBridgeDisconnectConfirmed(next), false);
});

test("ws 끊김 뒤 transport 실패가 오면 브릿지 끊김을 확정한다", () => {
  const suspected = reduceBridgeDisconnectEvidence(createBridgeDisconnectEvidence(), {
    type: "socket_disconnected",
    at: 1000
  });
  const confirmed = reduceBridgeDisconnectEvidence(suspected, {
    type: "transport_failure",
    at: 2000,
    message: "503"
  });

  assert.equal(confirmed.socketDisconnectedAt, 1000);
  assert.equal(confirmed.transportFailureAt, 2000);
  assert.equal(confirmed.confirmedAt, 2000);
  assert.equal(confirmed.lastError, "503");
  assert.equal(isBridgeDisconnectConfirmed(confirmed), true);
});

test("transport 실패가 먼저 와도 이후 ws 끊김이 오면 브릿지 끊김을 확정한다", () => {
  const failed = reduceBridgeDisconnectEvidence(createBridgeDisconnectEvidence(), {
    type: "transport_failure",
    at: 1000,
    message: "gateway timeout"
  });
  const confirmed = reduceBridgeDisconnectEvidence(failed, {
    type: "socket_disconnected",
    at: 2000
  });

  assert.equal(confirmed.transportFailureAt, 1000);
  assert.equal(confirmed.socketDisconnectedAt, 2000);
  assert.equal(confirmed.confirmedAt, 2000);
  assert.equal(confirmed.lastError, "gateway timeout");
  assert.equal(isBridgeDisconnectConfirmed(confirmed), true);
});

test("브릿지 상태가 명시적으로 disconnected 이면 즉시 끊김을 확정한다", () => {
  const confirmed = reduceBridgeDisconnectEvidence(createBridgeDisconnectEvidence(), {
    type: "status_disconnected",
    at: 1000,
    message: "app-server not connected"
  });

  assert.equal(confirmed.socketDisconnectedAt, 1000);
  assert.equal(confirmed.transportFailureAt, 1000);
  assert.equal(confirmed.confirmedAt, 1000);
  assert.equal(confirmed.lastError, "app-server not connected");
  assert.equal(isBridgeDisconnectConfirmed(confirmed), true);
});

test("성공한 bridge 요청은 누적된 끊김 증거를 해제한다", () => {
  const confirmed = reduceBridgeDisconnectEvidence(
    reduceBridgeDisconnectEvidence(createBridgeDisconnectEvidence(), {
      type: "socket_disconnected",
      at: 1000
    }),
    {
      type: "transport_failure",
      at: 2000,
      message: "503"
    }
  );
  const recovered = reduceBridgeDisconnectEvidence(confirmed, {
    type: "transport_success",
    at: 3000
  });

  assert.deepEqual(recovered, createBridgeDisconnectEvidence());
  assert.equal(isBridgeDisconnectConfirmed(recovered), false);
});
