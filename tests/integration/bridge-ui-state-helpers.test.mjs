import test from "node:test";
import assert from "node:assert/strict";

import {
  isBridgeDisconnectConfirmed,
  mergeProjectSnapshots,
  reduceBridgeDisconnectEvidence
} from "../../packages/domain/src/index.js";

test("status_disconnected 단독 증거만으로는 브리지 미연결을 확정하지 않는다", () => {
  const evidence = reduceBridgeDisconnectEvidence(null, {
    type: "status_disconnected",
    at: 1_000,
    message: "socket temporarily unavailable"
  });

  assert.equal(evidence.socketDisconnectedAt, 1_000);
  assert.equal(evidence.transportFailureAt, 0);
  assert.equal(evidence.confirmedAt, 0);
  assert.equal(isBridgeDisconnectConfirmed(evidence), false);
});

test("status_disconnected 뒤 transport_failure가 오면 브리지 미연결이 확정된다", () => {
  const statusEvidence = reduceBridgeDisconnectEvidence(null, {
    type: "status_disconnected",
    at: 1_000
  });
  const confirmedEvidence = reduceBridgeDisconnectEvidence(statusEvidence, {
    type: "transport_failure",
    at: 2_000,
    message: "api timeout"
  });

  assert.equal(confirmedEvidence.socketDisconnectedAt, 1_000);
  assert.equal(confirmedEvidence.transportFailureAt, 2_000);
  assert.equal(confirmedEvidence.confirmedAt, 2_000);
  assert.equal(isBridgeDisconnectConfirmed(confirmedEvidence), true);
});

test("mergeProjectSnapshots는 누락된 지침 필드를 현재 상태에서 보존한다", () => {
  const merged = mergeProjectSnapshots(
    [
      {
        id: "project-1",
        name: "기존 프로젝트",
        base_instructions: "항상 한국어로 답변",
        developer_instructions: "테스트 먼저 작성"
      }
    ],
    [
      {
        id: "project-1",
        name: "새 프로젝트 이름"
      }
    ]
  );

  assert.deepEqual(merged, [
    {
      id: "project-1",
      name: "새 프로젝트 이름",
      base_instructions: "항상 한국어로 답변",
      developer_instructions: "테스트 먼저 작성"
    }
  ]);
});

test("mergeProjectSnapshots는 명시적으로 전달된 빈 문자열 지침은 제거로 반영한다", () => {
  const merged = mergeProjectSnapshots(
    [
      {
        id: "project-1",
        base_instructions: "기존 일반지침",
        developer_instructions: "기존 개발지침"
      }
    ],
    [
      {
        id: "project-1",
        base_instructions: "",
        developer_instructions: ""
      }
    ]
  );

  assert.deepEqual(merged, [
    {
      id: "project-1",
      base_instructions: "",
      developer_instructions: ""
    }
  ]);
});
