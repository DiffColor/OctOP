import test from "node:test";
import assert from "node:assert/strict";

import { normalizeAssistantMessageContent } from "../../apps/mobile/src/assistantMessageNormalization.js";
import { mergeAssistantDeltaContent } from "../../apps/mobile/src/assistantDelta.js";
import { consolidateThreadMessages } from "../../apps/mobile/src/threadMessageConsolidation.js";

test("뒤에 다시 오는 최종 보고 섹션 제목을 유지한다", () => {
  const content = [
    "[목표]",
    "- 목표",
    "",
    "[최종 보고]",
    "- 첫 보고",
    "",
    "[최종 보고]",
    "- 두 번째 보고"
  ].join("\n");

  assert.equal(
    normalizeAssistantMessageContent(content),
    content
  );
});

test("최종 보고 continuation 병합 시 뒤쪽 섹션을 제거하지 않는다", () => {
  const previousContent = [
    "[목표]",
    "- 목표",
    "",
    "[진행 내역]",
    "- 진행",
    "",
    "[최종 보고]",
    "- 첫 보고"
  ].join("\n");
  const delta = [
    "[최종 보고]",
    "- 두 번째 보고"
  ].join("\n");

  assert.equal(
    mergeAssistantDeltaContent(previousContent, delta),
    [
      "[목표]",
      "- 목표",
      "",
      "[진행 내역]",
      "- 진행",
      "",
      "[최종 보고]",
      "- 첫 보고",
      "",
      "[최종 보고]",
      "- 두 번째 보고"
    ].join("\n")
  );
});

test("중복된 목표/계획 섹션 본문은 함께 제거되고 진행 내역만 남는다", () => {
  const content = [
    "[목표]",
    "- 최초 목표",
    "",
    "[계획]",
    "- 최초 계획",
    "",
    "[목표]",
    "- 중복 목표",
    "",
    "[계획]",
    "- 중복 계획",
    "",
    "[진행 내역]",
    "- 실제 진행"
  ].join("\n");

  assert.equal(
    normalizeAssistantMessageContent(content),
    [
      "[목표]",
      "- 최초 목표",
      "",
      "[계획]",
      "- 최초 계획",
      "",
      "[진행 내역]",
      "- 실제 진행"
    ].join("\n")
  );
});

test("도구 응답 이후의 assistant 최종 보고도 같은 이슈 안에서는 하나의 메시지로 합쳐진다", () => {
  const issueId = "issue-1";
  const messages = [
    {
      id: "prompt-1",
      role: "user",
      kind: "prompt",
      content: "질문",
      issue_id: issueId,
      timestamp: "2026-04-17T00:00:00.000Z"
    },
    {
      id: "assistant-1",
      role: "assistant",
      kind: "message",
      content: "[계획]\n- 1차 계획",
      issue_id: issueId,
      timestamp: "2026-04-17T00:00:01.000Z"
    },
    {
      id: "mcp-result-1",
      role: "system",
      kind: "mcp_result",
      content: "도구 응답",
      issue_id: issueId,
      timestamp: "2026-04-17T00:00:02.000Z"
    },
    {
      id: "assistant-2",
      role: "assistant",
      kind: "message",
      content: "[최종 보고]\n- 후속 보고",
      issue_id: issueId,
      timestamp: "2026-04-17T00:00:03.000Z"
    }
  ];

  assert.deepEqual(
    consolidateThreadMessages(messages).map((message) => ({
      id: message.id,
      role: message.role,
      kind: message.kind,
      content: message.content
    })),
    [
      {
        id: "prompt-1",
        role: "user",
        kind: "prompt",
        content: "질문"
      },
      {
        id: "assistant-1",
        role: "assistant",
        kind: "message",
        content: "[계획]\n- 1차 계획\n\n[최종 보고]\n- 후속 보고"
      },
      {
        id: "mcp-result-1",
        role: "system",
        kind: "mcp_result",
        content: "도구 응답"
      }
    ]
  );
});
