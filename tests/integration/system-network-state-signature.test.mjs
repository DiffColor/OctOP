import test from "node:test";
import assert from "node:assert/strict";

import { buildSystemNetworkStateSignature } from "../../services/codex-adapter/src/systemNetwork.js";

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
