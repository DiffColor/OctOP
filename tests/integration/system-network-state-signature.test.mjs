import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSystemNetworkStateSignature,
  shouldAttemptSystemNetworkRecovery
} from "../../services/codex-adapter/src/systemNetwork.js";

test("같은 인터페이스라도 주소가 바뀌면 다른 시스템 네트워크 상태로 본다", () => {
  const previous = buildSystemNetworkStateSignature({
    connected: true,
    interfaces: [
      {
        name: "en0",
        family: "IPv4",
        address: "192.168.0.12"
      }
    ],
    default_route: {
      interfaceName: "en0"
    }
  });
  const next = buildSystemNetworkStateSignature({
    connected: true,
    interfaces: [
      {
        name: "en0",
        family: "IPv4",
        address: "10.0.0.23"
      }
    ],
    default_route: {
      interfaceName: "en0"
    }
  });

  assert.notEqual(next, previous);
});

test("인터페이스 순서가 달라도 같은 주소 집합이면 동일한 시그니처를 만든다", () => {
  const first = buildSystemNetworkStateSignature({
    connected: true,
    interfaces: [
      {
        name: "en0",
        family: "IPv6",
        address: "2001:db8::2"
      },
      {
        name: "en0",
        family: "IPv4",
        address: "10.0.0.23"
      }
    ],
    default_route: {
      interfaceName: "en0"
    }
  });
  const second = buildSystemNetworkStateSignature({
    connected: true,
    interfaces: [
      {
        name: "en0",
        family: "IPv4",
        address: "10.0.0.23"
      },
      {
        name: "en0",
        family: "IPv6",
        address: "2001:db8::2"
      }
    ],
    default_route: {
      interfaceName: "en0"
    }
  });

  assert.equal(second, first);
});

test("복구 보류 상태면 네트워크 시그니처 변화가 없어도 복구를 다시 시도한다", () => {
  assert.equal(
    shouldAttemptSystemNetworkRecovery({
      previousConnected: true,
      previousStateSignature: "same-signature",
      nextStateSignature: "same-signature",
      recoveryPending: true,
      networkConnected: true
    }),
    true
  );
});

test("복구 보류가 없고 연결 상태/시그니처 변화가 없으면 복구를 다시 시도하지 않는다", () => {
  assert.equal(
    shouldAttemptSystemNetworkRecovery({
      previousConnected: true,
      previousStateSignature: "same-signature",
      nextStateSignature: "same-signature",
      recoveryPending: false,
      networkConnected: true
    }),
    false
  );
});

test("직전에는 끊겨 있었고 지금은 연결되었으면 즉시 복구를 시도한다", () => {
  assert.equal(
    shouldAttemptSystemNetworkRecovery({
      previousConnected: false,
      previousStateSignature: "disconnected-signature",
      nextStateSignature: "connected-signature",
      recoveryPending: false,
      networkConnected: true
    }),
    true
  );
});
