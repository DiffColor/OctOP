import test from "node:test";
import assert from "node:assert/strict";

import { appendLiveAssistantDelta, findLatestLiveAssistantMessageIndex } from "../../apps/mobile/src/liveAssistantMessage.js";

test("findLatestLiveAssistantMessageIndex는 숨겨진 시스템 메시지 뒤에서도 같은 이슈의 최신 응답 버블을 찾는다", () => {
  const messages = [
    { id: "prompt-1", role: "user", kind: "prompt", content: "프롬프트", issue_id: "issue-1" },
    { id: "assistant-1", role: "assistant", kind: "message", content: "[목표]\n- 최초 목표", issue_id: "issue-1" },
    { id: "tool-1", role: "system", kind: "tool_call", content: "도구 호출", issue_id: "issue-1" }
  ];

  assert.equal(findLatestLiveAssistantMessageIndex(messages, "issue-1"), 1);
});

test("appendLiveAssistantDelta는 같은 이슈 응답을 새 버블로 분리하지 않고 기존 버블에 이어 붙인다", () => {
  const messages = [
    { id: "prompt-1", role: "user", kind: "prompt", content: "프롬프트", issue_id: "issue-1" },
    {
      id: "assistant-1",
      role: "assistant",
      kind: "message",
      content: "[목표]\n- 최초 목표\n\n[계획]\n- 영향 범위: 앱",
      issue_id: "issue-1",
      issue_title: "이슈",
      issue_status: "running"
    },
    { id: "tool-1", role: "system", kind: "tool_call", content: "도구 호출", issue_id: "issue-1" }
  ];

  const nextMessages = appendLiveAssistantDelta(messages, {
    delta: "\n[목표]\n- 최초 목표\n\n[계획]\n- 영향 범위: 앱\n\n[진행 내역]\n- 코드 확인",
    issueId: "issue-1",
    issueTitle: "이슈",
    issueStatus: "running",
    timestamp: "2026-04-17T00:00:00.000Z"
  });

  assert.equal(nextMessages.length, 3);
  assert.equal(nextMessages[1].content.includes("[목표]"), true);
  assert.equal(nextMessages[1].content.split("\n").filter((line) => line.trim() === "[목표]").length, 1);
  assert.equal(nextMessages[1].content.split("\n").filter((line) => line.trim() === "[계획]").length, 1);
  assert.equal(nextMessages[1].content.includes("- 코드 확인"), true);
  assert.equal(nextMessages.at(-1)?.kind, "tool_call");
});

test("appendLiveAssistantDelta는 누적 재전송되는 일반 문장 chunk를 한 번만 유지한다", () => {
  const chunks = [
    "테스트",
    "테스트 한",
    "테스트 한 거",
    "테스트 한 거 맞아",
    "테스트 한 거 맞아 아직도",
    "테스트 한 거 맞아 아직도 중복되는데"
  ];

  let messages = [
    { id: "prompt-1", role: "user", kind: "prompt", content: "프롬프트", issue_id: "issue-1" }
  ];

  for (const chunk of chunks) {
    messages = appendLiveAssistantDelta(messages, {
      delta: chunk,
      issueId: "issue-1",
      issueTitle: "이슈",
      issueStatus: "running",
      timestamp: "2026-04-17T00:00:00.000Z"
    });
  }

  const assistantMessage = messages.find((message) => message.role === "assistant");

  assert.equal(assistantMessage?.content, "테스트 한 거 맞아 아직도 중복되는데");
});

test("appendLiveAssistantDelta는 바로 전 문장이 다시 포함된 다음 chunk가 오면 이전 표시를 교체해 중복 줄을 남기지 않는다", () => {
  const messages = [
    { id: "prompt-1", role: "user", kind: "prompt", content: "프롬프트", issue_id: "issue-1" },
    { id: "assistant-1", role: "assistant", kind: "message", content: "첫 문장", issue_id: "issue-1" }
  ];

  const nextMessages = appendLiveAssistantDelta(messages, {
    delta: "\n첫 문장\n다음 문장",
    issueId: "issue-1",
    issueTitle: "이슈",
    issueStatus: "running",
    timestamp: "2026-04-17T00:00:00.000Z"
  });

  assert.equal(nextMessages[1]?.content, "첫 문장\n다음 문장");
});
