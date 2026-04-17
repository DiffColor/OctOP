import test from "node:test";
import assert from "node:assert/strict";

import { appendLiveAssistantDelta } from "../../apps/dashboard/src/liveAssistantMessage.js";
import { mergeThreadMessages } from "../../apps/dashboard/src/threadMessageConsolidation.js";

test("dashboard mergeThreadMessages는 더 긴 assistant 응답을 늦게 온 짧은 snapshot으로 줄이지 않는다", () => {
  const merged = mergeThreadMessages(
    [
      {
        id: "prompt-1",
        role: "user",
        kind: "prompt",
        content: "응답을 하나의 버블로 유지해줘",
        issue_id: "issue-1",
        timestamp: "2026-04-17T10:00:00.000Z"
      },
      {
        id: "assistant-live",
        role: "assistant",
        kind: "message",
        content: "[목표]\n- 원인 확인\n\n[계획]\n- 누적 유지\n\n[진행 내역]\n- 실시간 delta 반영",
        issue_id: "issue-1",
        timestamp: "2026-04-17T10:00:05.000Z"
      }
    ],
    [
      {
        id: "prompt-final",
        role: "user",
        kind: "prompt",
        content: "응답을 하나의 버블로 유지해줘",
        issue_id: "issue-1",
        timestamp: "2026-04-17T10:00:01.000Z",
        optimistic: false
      },
      {
        id: "assistant-stale",
        role: "assistant",
        kind: "message",
        content: "[목표]\n- 원인 확인",
        issue_id: "issue-1",
        timestamp: "2026-04-17T10:00:06.000Z"
      }
    ]
  );

  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.id, "prompt-final");
  assert.equal(merged[1]?.content.includes("[진행 내역]"), true);
  assert.equal(merged[1]?.content.includes("실시간 delta 반영"), true);
});

test("dashboard appendLiveAssistantDelta는 숨겨진 tool 메시지 뒤에서도 같은 assistant 버블에 이어 붙인다", () => {
  const nextMessages = appendLiveAssistantDelta(
    [
      {
        id: "prompt-1",
        role: "user",
        kind: "prompt",
        content: "중복 없이 끝까지 응답해줘",
        issue_id: "issue-1",
        timestamp: "2026-04-17T10:00:00.000Z"
      },
      {
        id: "assistant-1",
        role: "assistant",
        kind: "message",
        content: "[목표]\n- 현재 코드 확인",
        issue_id: "issue-1",
        timestamp: "2026-04-17T10:00:02.000Z"
      },
      {
        id: "tool-1",
        role: "system",
        kind: "tool_result",
        content: "테스트 통과",
        issue_id: "issue-1",
        timestamp: "2026-04-17T10:00:03.000Z"
      }
    ],
    {
      issueId: "issue-1",
      delta: "\n\n[진행 내역]\n- 실시간 delta 반영",
      timestamp: "2026-04-17T10:00:04.000Z",
      issueTitle: "Issue One",
      issueStatus: "running"
    }
  );

  assert.equal(nextMessages.length, 3);
  assert.equal(nextMessages[1]?.id, "assistant-1");
  assert.equal(nextMessages[1]?.content.includes("[진행 내역]"), true);
  assert.equal(nextMessages[1]?.content.includes("실시간 delta 반영"), true);
  assert.equal(nextMessages[2]?.kind, "tool_result");
});
