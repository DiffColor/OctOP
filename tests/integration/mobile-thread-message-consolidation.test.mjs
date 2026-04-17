import test from "node:test";
import assert from "node:assert/strict";

import { consolidateThreadMessages } from "../../apps/mobile/src/threadMessageConsolidation.js";

test("consolidateThreadMessages는 같은 이슈의 중복 prompt를 하나만 유지한다", () => {
  const messages = consolidateThreadMessages([
    {
      id: "prompt-optimistic",
      role: "user",
      kind: "prompt",
      content: "중복 프롬프트",
      issue_id: "issue-1",
      timestamp: "2026-04-17T10:00:00.000Z",
      optimistic: true
    },
    {
      id: "prompt-final",
      role: "user",
      kind: "prompt",
      content: "중복 프롬프트",
      issue_id: "issue-1",
      timestamp: "2026-04-17T10:00:02.000Z",
      optimistic: false
    }
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.id, "prompt-final");
  assert.equal(messages[0]?.optimistic, false);
});

test("consolidateThreadMessages는 같은 이슈의 누적 assistant snapshot을 하나의 응답으로 합친다", () => {
  const messages = consolidateThreadMessages([
    {
      id: "prompt-1",
      role: "user",
      kind: "prompt",
      content: "모바일 버그 수정",
      issue_id: "issue-1",
      timestamp: "2026-04-17T10:00:00.000Z"
    },
    {
      id: "assistant-1",
      role: "assistant",
      kind: "message",
      content: "[목표]\n- 원인 확인",
      issue_id: "issue-1",
      timestamp: "2026-04-17T10:00:01.000Z"
    },
    {
      id: "assistant-2",
      role: "assistant",
      kind: "message",
      content: "[목표]\n- 원인 확인\n\n[계획]\n- 수정 적용",
      issue_id: "issue-1",
      timestamp: "2026-04-17T10:00:03.000Z"
    }
  ]);

  assert.equal(messages.length, 2);
  assert.equal(messages[1]?.id, "assistant-1");
  assert.equal(messages[1]?.content.includes("[목표]"), true);
  assert.equal(messages[1]?.content.includes("[계획]"), true);
  assert.equal(messages[1]?.timestamp, "2026-04-17T10:00:03.000Z");
});

test("consolidateThreadMessages는 더 짧은 stale assistant snapshot으로 긴 응답을 덮어쓰지 않는다", () => {
  const messages = consolidateThreadMessages([
    {
      id: "assistant-long",
      role: "assistant",
      kind: "message",
      content: "[목표]\n- 원인 확인\n\n[진행 내역]\n- 코드 읽음",
      issue_id: "issue-1",
      timestamp: "2026-04-17T10:00:05.000Z"
    },
    {
      id: "assistant-short",
      role: "assistant",
      kind: "message",
      content: "[목표]\n- 원인 확인",
      issue_id: "issue-1",
      timestamp: "2026-04-17T10:00:06.000Z"
    }
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.content.includes("[진행 내역]"), true);
});

test("consolidateThreadMessages는 숨겨진 도구 응답 사이에 끊긴 assistant snapshot도 하나의 응답으로 합친다", () => {
  const issueId = "issue-1";
  const messages = consolidateThreadMessages([
    {
      id: "prompt-1",
      role: "user",
      kind: "prompt",
      content: "모바일 버그 수정",
      issue_id: issueId,
      timestamp: "2026-04-17T10:00:00.000Z"
    },
    {
      id: "assistant-1",
      role: "assistant",
      kind: "message",
      content: "[목표]\n- 원인 확인",
      issue_id: issueId,
      timestamp: "2026-04-17T10:00:01.000Z"
    },
    {
      id: "tool-result-1",
      role: "system",
      kind: "tool_result",
      content: "도구 응답",
      issue_id: issueId,
      timestamp: "2026-04-17T10:00:02.000Z"
    },
    {
      id: "assistant-2",
      role: "assistant",
      kind: "message",
      content: "[목표]\n- 원인 확인\n\n[계획]\n- 수정 적용\n\n[진행 내역]\n- 실제 수정",
      issue_id: issueId,
      timestamp: "2026-04-17T10:00:03.000Z"
    }
  ]);

  assert.equal(messages.length, 3);
  assert.equal(messages[1]?.content.includes("[계획]"), true);
  assert.equal(messages[1]?.content.includes("[진행 내역]"), true);
  assert.equal(messages[2]?.kind, "tool_result");
});
