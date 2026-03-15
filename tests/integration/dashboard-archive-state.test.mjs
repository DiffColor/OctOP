import test from "node:test";
import assert from "node:assert/strict";

import {
  mergeIncomingIssueSnapshot,
  shouldApplyRealtimeIssueToSelectedThread
} from "../../apps/dashboard/src/realtimeIssue.js";

test("부분 이슈 업데이트는 기존 보관 상태 판단에 필요한 필드를 유지한다", () => {
  const merged = mergeIncomingIssueSnapshot(
    {
      id: "issue-1",
      last_message: "delta only"
    },
    {
      currentIssue: {
        id: "issue-1",
        thread_id: "thread-1",
        root_thread_id: "thread-1",
        project_id: "project-1",
        title: "Archived issue",
        status: "completed"
      },
      fallbackThreadId: "thread-1"
    }
  );

  assert.equal(merged?.thread_id, "thread-1");
  assert.equal(merged?.root_thread_id, "thread-1");
  assert.equal(merged?.status, "completed");
  assert.equal(merged?.title, "Archived issue");
  assert.equal(merged?.last_message, "delta only");
});

test("선택된 스레드와 다른 실시간 이슈 업데이트는 적용하지 않는다", () => {
  assert.equal(shouldApplyRealtimeIssueToSelectedThread("thread-1", "thread-1"), true);
  assert.equal(shouldApplyRealtimeIssueToSelectedThread("thread-1", "thread-2"), false);
  assert.equal(shouldApplyRealtimeIssueToSelectedThread("thread-1", ""), true);
  assert.equal(shouldApplyRealtimeIssueToSelectedThread("", "thread-1"), false);
});
