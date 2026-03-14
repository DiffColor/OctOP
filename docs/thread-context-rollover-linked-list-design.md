# Root Thread + Physical Thread Rollover + Projection Merge 설계

## 1. 목적

이 문서는 현재 OctOP 코드 기준으로 다음 요구사항을 실제 서비스 가능한 수준으로 구체화합니다.

1. 사용자가 보는 쓰레드는 최초 생성된 하나의 `root thread`여야 합니다.
2. 컨텍스트 사용량이 높아지면 내부적으로는 새로운 `physical thread`를 생성해 이어서 작업해야 합니다.
3. 과거 physical thread의 issue/message는 읽기 전용 projection으로 합성되어, 사용자는 현재 root thread 안에 모든 이력이 있는 것처럼 봐야 합니다.
4. 사용자가 root thread를 삭제하면 연관된 모든 physical thread, issue, message, summary, projection row가 함께 삭제되어야 합니다.

이 문서는 linked list 구조를 전제로 하지 않습니다. 실제 작업 대상은 언제나 가장 마지막 physical thread이며, 과거 thread들은 읽기 전용 이력으로만 다룹니다.

---

## 2. 현재 코드 기준 사실

### 2.1 실행 상태의 실질 소스 오브 트루스

현재 실행 상태는 [`services/codex-adapter/src/index.js`](../services/codex-adapter/src/index.js)에 있습니다.

현재 핵심 상태 맵:

- `threadStateById`
- `issueCardsById`
- `issueMessagesById`
- `threadIssueIdsById`
- `activeIssueByThreadId`
- `codexThreadToThreadId`

현재 `thread` 엔티티에는 이미 다음 값이 있습니다.

- `codex_thread_id`
- `token_usage`
- `context_window_tokens`
- `context_used_tokens`
- `context_usage_percent`

즉, rollover 트리거를 위한 컨텍스트 사용량 데이터는 이미 브리지에서 확보하고 있습니다.

### 2.2 모바일은 이미 합성 조회 구조다

[`apps/mobile/src/App.jsx`](../apps/mobile/src/App.jsx)의 `loadThreadMessages`는 실제로 다음 순서로 메시지를 만듭니다.

1. `/api/threads/{threadId}/issues`
2. 각 issue마다 `/api/issues/{issueId}`
3. 각 issue의 `messages`를 시간순으로 합쳐 채팅 타임라인을 구성

즉 모바일은 현재도 "thread 자체 메시지"가 아니라 "thread 아래 issue message 합성 뷰"를 보고 있습니다. 따라서 physical thread가 여러 개가 되어도 합성 조회만 바꾸면 UI를 거의 유지할 수 있습니다.

### 2.3 대시보드는 root thread별 칸반이다

[`apps/dashboard/src/App.jsx`](../apps/dashboard/src/App.jsx)는 다음 구조를 전제로 합니다.

- 프로젝트 아래 thread 목록 조회
- 선택된 thread에 대해 `/api/threads/{threadId}/issues`
- issue 상태를 칸반 컬럼으로 표시

따라서 사용자에게 노출되는 thread 정체성은 `root thread` 하나로 유지하고, issue 조회만 "과거 physical thread까지 합성"되도록 바꾸는 것이 맞습니다.

### 2.4 Projection worker는 읽기 모델에 적합하다

[`services/projection-worker/ProjectionWorkerService.cs`](../services/projection-worker/ProjectionWorkerService.cs)는 이미 다음 읽기 모델을 유지합니다.

- `thread_projection`
- `project_threads`
- `thread_issue_cards`

이 구조는 "쓰기 모델은 브리지, 읽기 모델은 projection" 분리에 잘 맞습니다. 이번 기능도 그 원칙을 유지하는 것이 안정적입니다.

---

## 3. 결론

linked list는 도입하지 않습니다.

대신 다음 구조를 사용합니다.

- 사용자가 보는 엔티티: `root thread`
- 실제 Codex 실행 엔티티: `physical thread`
- 실제 작업 대상: 항상 `root thread` 아래 가장 마지막 `physical thread`
- 읽기 연속성: projection이 모든 physical thread의 issue/message를 root thread 기준으로 합성
- 삭제 기준: `root_thread_id`

이 구조는 linked list보다 단순하고, 삭제/복구/투영/운영 면에서 더 안정적입니다.

---

## 4. 핵심 도메인 모델

## 4.1 Root thread

사용자가 인식하는 단일 thread입니다.

권장 필드:

```json
{
  "id": "thread-root-1",
  "project_id": "project-1",
  "name": "Main",
  "description": "",
  "bridge_id": "bridge-1",
  "login_id": "user-1",
  "active_physical_thread_id": "pth-3",
  "latest_physical_sequence": 3,
  "rollover_count": 2,
  "status": "running",
  "progress": 72,
  "last_event": "item.agentMessage.delta",
  "last_message": "현재 tail thread 기준 마지막 출력",
  "codex_thread_id": "codex-tail-thread-id",
  "context_usage_percent": 88,
  "context_used_tokens": 176000,
  "context_window_tokens": 200000,
  "continuity_mode": "projection_merge",
  "continuity_status": "healthy",
  "created_at": "2026-03-14T00:00:00.000Z",
  "updated_at": "2026-03-14T00:10:00.000Z",
  "deleted_at": null
}
```

핵심 규칙:

- 사용자가 보는 thread ID는 항상 `root thread.id`
- 현재 실행용 `codex_thread_id`는 항상 active physical thread의 값을 mirror
- root thread는 삭제의 집계 단위

## 4.2 Physical thread

실제 Codex 실행 단위입니다.

권장 필드:

```json
{
  "id": "pth-3",
  "root_thread_id": "thread-root-1",
  "project_id": "project-1",
  "bridge_id": "bridge-1",
  "login_id": "user-1",
  "sequence": 3,
  "codex_thread_id": "codex-tail-thread-id",
  "status": "active",
  "opened_reason": "context_rollover",
  "opened_from_physical_thread_id": "pth-2",
  "rollover_trigger_percent": 88,
  "handoff_summary_id": "sum-3",
  "context_usage_percent": 12,
  "context_used_tokens": 24000,
  "context_window_tokens": 200000,
  "created_at": "2026-03-14T00:09:00.000Z",
  "updated_at": "2026-03-14T00:10:00.000Z",
  "closed_at": null,
  "deleted_at": null
}
```

핵심 규칙:

- `sequence`는 `root_thread_id` 안에서 단조 증가
- 작업 대상은 항상 `MAX(sequence)`
- 과거 physical thread는 읽기 전용
- linked list 포인터는 두지 않음

## 4.3 Issue

issue는 여전히 root thread 소속으로 보이되, 실제 실행 출처는 physical thread로 추적합니다.

권장 필드:

```json
{
  "id": "issue-1",
  "root_thread_id": "thread-root-1",
  "created_physical_thread_id": "pth-2",
  "executed_physical_thread_id": "pth-3",
  "project_id": "project-1",
  "title": "로그인 화면 수정",
  "prompt": "모바일 로그인 UI를 정리해줘",
  "status": "completed",
  "progress": 100,
  "last_event": "turn.completed",
  "last_message": "수정 완료",
  "queue_position": null,
  "prep_position": null,
  "created_at": "2026-03-14T00:04:00.000Z",
  "updated_at": "2026-03-14T00:08:00.000Z",
  "deleted_at": null
}
```

핵심 규칙:

- 대시보드와 모바일은 `root_thread_id` 기준으로 issue를 본다.
- 생성 provenance는 `created_physical_thread_id`로 추적한다.
- 실제 실행 provenance는 `executed_physical_thread_id`로 추적한다.
- `executed_physical_thread_id`는 실행 전까지 null일 수 있다.

## 4.4 Issue message

권장 필드:

```json
{
  "id": "msg-1",
  "issue_id": "issue-1",
  "root_thread_id": "thread-root-1",
  "physical_thread_id": "pth-3",
  "role": "assistant",
  "kind": "message",
  "message_class": "assistant",
  "content": "변경 내용을 적용했습니다.",
  "timestamp": "2026-03-14T00:07:00.000Z",
  "deleted_at": null
}
```

## 4.5 Handoff summary

summary는 issue가 아니라 별도 엔티티로 둡니다.

이유:

- 사용자 작업 카드와 의미가 다름
- 칸반에 노출되면 UX 오염
- 모바일 채팅에서는 system message로 합성하는 것이 더 자연스러움

권장 필드:

```json
{
  "id": "sum-3",
  "root_thread_id": "thread-root-1",
  "target_physical_thread_id": "pth-3",
  "source_physical_thread_id": "pth-2",
  "format_version": 1,
  "summary_type": "handoff",
  "content_markdown": "[이전 컨텍스트 요약]\\n- 목표: ...",
  "content_json": {
    "goal": "현재 작업 목표",
    "completed_work": ["반영 완료 1", "반영 완료 2"],
    "open_tasks": ["남은 작업 1"],
    "risks": ["주의점 1"],
    "latest_user_intent": "다음에 이어야 할 요구",
    "relevant_files": ["/workspace/apps/mobile/src/App.jsx"]
  },
  "created_at": "2026-03-14T00:09:00.000Z",
  "deleted_at": null
}
```

---

## 5. 쓰기 모델과 읽기 모델 분리

## 5.1 쓰기 모델의 권위자

쓰기 모델 authoritative state는 계속 브리지입니다.

대상:

- [`services/codex-adapter/src/index.js`](../services/codex-adapter/src/index.js)
- `~/.octop/<bridge-id>-threads.json`

이유:

- 실제 app-server notification은 브리지가 받음
- 현재 active issue, active Codex thread, token usage를 브리지가 가장 정확히 알고 있음
- rollover 수행 주체도 브리지여야 race condition이 줄어듦

## 5.2 읽기 모델의 역할

읽기 모델은 브리지와 projection을 혼합합니다.

대상:

- 현재 active physical thread의 live 상태
- 과거 physical thread의 issue/message/history
- 운영자 디버깅용 continuity view

원칙:

- 현재 active physical thread의 실시간 상태는 반드시 브리지에서 읽는다.
- projection은 현재 root thread 전체의 최종 권위자가 아니라, 과거 physical thread 이력을 붙이는 읽기 전용 캐시다.
- projection은 이미 닫힌 physical thread와 과거 issue/message/summary만 담당한다.
- 현재 active physical thread의 running status, live delta, token usage는 projection에서 읽지 않는다.
- projection이 실행 라우팅 결정을 해서는 안 됨
- 삭제/복구 기준은 항상 쓰기 모델의 `root_thread_id`
- rollover 직후 막 닫힌 physical thread는 projection 반영 전까지 브리지 로컬 상태에서도 함께 읽을 수 있어야 한다.

권장 조회 전략:

1. 현재 active physical thread 상태
   브리지 메모리에서 직접 조회
2. 과거 physical thread 이력
   projection에서 조회
3. API 응답
   브리지 또는 API 계층에서 두 결과를 병합해 반환

### production-ready grace window

projection은 비동기 반영이므로, rollover 직후 source physical thread의 마지막 이력이 잠깐 비어 보이지 않게 해야 합니다.

권장 규칙:

- `recently_closed_physical_thread_grace_window_ms = 60000`
- 닫힌 지 60초 이내의 physical thread는 projection만 보지 않고 브리지 로컬 상태도 함께 읽는다.
- projection이 해당 physical thread까지 반영된 것이 확인되면 grace window 이전에도 브리지 로컬 fallback을 제거할 수 있다.

즉, 읽기 경로는 아래처럼 3단계가 됩니다.

1. active physical thread
   브리지 live
2. recently closed physical threads
   브리지 local fallback + projection
3. older closed physical threads
   projection only

---

## 6. 저장 구조 상세

## 6.1 브리지 로컬 저장

현재 `persistThreadsForUser`가 저장하는 구조에 아래를 추가합니다.

권장 구조:

```json
{
  "project_thread_ids": ["thread-root-1"],
  "project_threads": {
    "thread-root-1": {}
  },
  "physical_thread_ids": ["pth-1", "pth-2", "pth-3"],
  "physical_threads": {
    "pth-1": {},
    "pth-2": {},
    "pth-3": {}
  },
  "root_thread_physical_thread_ids": {
    "thread-root-1": ["pth-1", "pth-2", "pth-3"]
  },
  "handoff_summary_ids": ["sum-2", "sum-3"],
  "handoff_summaries": {
    "sum-2": {},
    "sum-3": {}
  },
  "issue_ids": ["issue-1", "issue-2"],
  "issues": {},
  "issue_messages": {},
  "updated_at": "..."
}
```

신규 메모리 맵:

- `physicalThreadStateById`
- `rootThreadPhysicalThreadIdsById`
- `handoffSummariesById`
- `rolloverLocksByRootThreadId`
- `rolloverCooldownByRootThreadId`
- `recentlyClosedPhysicalThreadIdsByRootThreadId`

추가 영속 필드:

- `root_thread.deleted_at`
- `physical_thread.closed_at`
- `physical_thread.deleted_at`

중요:

- late event 차단은 메모리 tombstone만으로 끝내면 안 된다.
- 브리지 재시작 이후에도 동일하게 차단되도록 `deleted_at`, `closed_at`를 authoritative 저장소에 남겨야 한다.

## 6.2 RethinkDB projection 테이블

현재 테이블:

- `thread_projection`
- `project_threads`
- `thread_issue_cards`

추가 권장 테이블:

- `root_threads`
- `physical_threads`
- `handoff_summaries`
- `logical_thread_timeline`
- `logical_thread_issue_board`

`thread_projection`과 `project_threads`는 당장 유지하되, 점진적으로 `root_threads` 기반으로 정리할 수 있습니다.

범위 조정:

- projection durable delivery(JetStream 등)는 현재 필수 범위가 아니다.
- 현재 단계에서는 projection을 "과거 이력 캐시"로만 사용하므로, 유실 시 브리지 authoritative state와 grace window fallback으로 운영 가능해야 한다.
- durable projection 전달은 향후 운영 고도화 항목으로 둔다.

## 6.3 권장 인덱스

실서비스 기준 최소 인덱스:

### `root_threads`

- `project_id`
- `bridge_id`
- `login_id`
- `updated_at`
- `deleted_at`

### `physical_threads`

- `root_thread_id`
- compound concept: `root_thread_id + sequence`
- `codex_thread_id`
- `deleted_at`

### `thread_issue_cards`

- `root_thread_id`
- `created_physical_thread_id`
- `executed_physical_thread_id`
- `status`
- `updated_at`
- `deleted_at`

### `handoff_summaries`

- `root_thread_id`
- `target_physical_thread_id`
- `deleted_at`

### `logical_thread_timeline`

- `root_thread_id`
- `sort_key`
- `deleted_at`

---

## 7. 핵심 불변식

운영 안정성을 위해 아래 불변식을 코드로 강제합니다.

1. `root_thread.active_physical_thread_id`는 반드시 해당 root thread 소속이어야 한다.
2. `root_thread.latest_physical_sequence`는 active physical thread의 `sequence`와 같아야 한다.
3. active physical thread는 root thread당 정확히 1개여야 한다.
4. 새 physical thread의 `sequence`는 기존 최대값 + 1이어야 한다.
5. issue는 반드시 `root_thread_id`를 가져야 한다.
6. issue의 `created_physical_thread_id`, `executed_physical_thread_id`는 반드시 같은 `root_thread_id` 소속이어야 한다.
7. handoff summary는 반드시 target physical thread와 1:1 또는 1:0 관계여야 한다.
8. 삭제된 root thread 아래 활성 physical thread가 남아 있으면 안 된다.
9. 닫히거나 삭제된 physical thread의 이벤트는 상태 반영 전에 차단되어야 한다.

---

## 8. 생성, 실행, rollover, 조회, 삭제 라이프사이클

## 8.1 root thread 생성

현재 `createProjectThread`와 `ensureDefaultProjectThread`가 root thread 생성 역할을 합니다.

새 규칙:

1. root thread 생성
2. physical thread `sequence = 1` 생성
3. `active_physical_thread_id = sequence 1`
4. root thread의 `codex_thread_id`는 아직 `null`
5. 실제 첫 실행 시점에 physical thread에 Codex binding 생성

## 8.2 issue 생성

새 issue는 항상 root thread 소속으로 생성합니다.

생성 시점:

- `root_thread_id = 선택한 사용자 thread`
- `created_physical_thread_id = 현재 active physical thread`
- `executed_physical_thread_id = null`

의미:

- 사용자는 root thread에 issue를 추가한다고 느낀다.
- 내부적으로는 "이 issue가 어느 rollover 세대에서 생성되었는지"가 남는다.

## 8.3 issue 실행

실행 라우팅 규칙:

1. root thread 조회
2. `active_physical_thread_id` 조회
3. 해당 physical thread의 `codex_thread_id`를 resolve
4. 없으면 `thread/start`
5. `turn/start`는 항상 active physical thread에 보냄
6. 실행 시작 시 `executed_physical_thread_id`를 현재 active physical thread로 기록

핵심:

- 절대 과거 physical thread로 새 작업을 보내지 않음
- 사용자 입력은 언제나 tail로 간다

## 8.4 rollover

트리거 조건:

- `context_usage_percent >= 85`
- 현재 active issue 존재
- 현재 root thread에 rollover lock 없음
- 마지막 rollover 이후 cooldown 경과

실행 순서:

1. root thread lock 획득
2. threshold 재검증
3. source active physical thread 스냅샷 확보
4. deterministic handoff summary 생성
5. new physical thread `sequence = latest + 1` 생성
6. 새 physical thread에 새 Codex thread 생성
7. handoff summary를 새 physical thread 시작 컨텍스트로 주입
8. root thread의 `active_physical_thread_id`, `latest_physical_sequence`, `codex_thread_id` 갱신
9. source physical thread를 `closed` 상태로 전환
10. 이벤트 발행 및 projection 반영
11. lock 해제

### 왜 source thread를 계속 쓰지 않는가

안정성 때문입니다.

- 이미 컨텍스트 사용량이 높음
- 같은 thread에서 요약/후속 턴을 더 태우면 실패 확률이 커짐
- 새 physical thread를 만든 뒤 handoff summary만 넣는 편이 예측 가능함

## 8.5 조회

### 대시보드

`/api/threads/{rootThreadId}/issues`는 root thread 기준 merged issue board를 내려주되, 데이터 소스는 다음처럼 분리합니다.

1. 현재 active physical thread에 속한 live issue 상태
   브리지 메모리에서 직접 조회
2. 이미 닫힌 physical thread에 속한 과거 issue
   projection에서 조회
3. 응답 직전 병합

정렬 원칙:

1. 칸반 상태 정렬
2. 큐/프렙 순서 유지
3. 동률이면 `physical_thread.sequence ASC`
4. 최종적으로 `updated_at DESC` 또는 기존 정책 적용

### 모바일

root thread merged timeline을 내려주되, 데이터 소스는 다음처럼 분리합니다.

1. 현재 active physical thread의 live message
   브리지 메모리에서 직접 조회
2. 이미 닫힌 physical thread의 과거 message와 handoff summary
   projection에서 조회
3. 응답 직전 병합

정렬 원칙:

1. `physical_thread.sequence ASC`
2. `issue.created_at ASC`
3. `message.timestamp ASC`

segment 경계마다 handoff summary를 synthetic system message로 삽입합니다.

## 8.6 root thread 삭제

삭제는 root thread 단위 집계 삭제입니다.

사용자가 root thread 삭제 시 삭제 대상:

- root thread
- root thread 소속 physical threads
- root thread 소속 issues
- issue messages
- handoff summaries
- logical_thread_timeline projection rows
- logical_thread_issue_board projection rows
- 기존 `thread_projection`, `project_threads`, `thread_issue_cards` 관련 rows

삭제 순서:

1. root thread lock 획득
2. active physical thread가 실행 중이면 종료 시도
3. root thread 소속 active issue 정리
4. physical thread 전부 soft delete 또는 hard delete
5. issue/messages/summary 일괄 삭제
6. root thread 삭제
7. projection 정리 이벤트 발행
8. lock 해제

현재 [`services/codex-adapter/src/index.js`](../services/codex-adapter/src/index.js)의 `deleteProjectThread`는 root thread 하나만 지우는 수준이므로, cascade 삭제로 확장해야 합니다.

---

## 9. projection 설계

## 9.1 root thread issue board projection

목적:

- 대시보드 칸반 조회 최적화

row 예시:

```json
{
  "id": "issue-1",
  "root_thread_id": "thread-root-1",
  "created_physical_thread_id": "pth-2",
  "executed_physical_thread_id": "pth-3",
  "project_id": "project-1",
  "title": "로그인 화면 수정",
  "status": "completed",
  "progress": 100,
  "last_message": "수정 완료",
  "queue_position": null,
  "prep_position": null,
  "physical_sequence": 2,
  "updated_at": "...",
  "deleted_at": null
}
```

이 projection은 root thread 단위 issue 목록을 즉시 반환할 수 있어야 합니다.

## 9.2 root thread timeline projection

목적:

- 모바일 채팅 조회 최적화

row 예시:

```json
{
  "id": "timeline-thread-root-1-000123",
  "root_thread_id": "thread-root-1",
  "physical_thread_id": "pth-3",
  "physical_sequence": 3,
  "issue_id": null,
  "entry_type": "handoff_summary",
  "role": "assistant",
  "content": "[이전 컨텍스트 요약] ...",
  "sort_key": "000003:2026-03-14T00:09:00.000Z:000001",
  "timestamp": "2026-03-14T00:09:00.000Z",
  "deleted_at": null
}
```

`entry_type` 예시:

- `prompt`
- `assistant_message`
- `handoff_summary`
- `system_event`

이 projection이 있으면 모바일이 issue detail을 여러 번 왕복 조회하지 않고도 root thread 전체 채팅을 바로 읽을 수 있습니다.

## 9.3 projection 생성 원칙

1. projection은 event-driven upsert
2. 모든 row는 `root_thread_id`로 귀속
3. soft delete 가능 구조 유지
4. out-of-order event에 대비해 `projected_at` 비교 필요

현재 projection worker의 `ShouldReplaceProjection` 패턴을 그대로 확장하면 됩니다.

---

## 10. API 설계

## 10.1 유지 API

### `GET /api/projects/{projectId}/threads`

의미:

- project 내 root thread 목록 조회

반환:

- root thread만 반환
- physical thread는 직접 노출하지 않음

### `GET /api/threads/{threadId}/issues`

변경 의미:

- `threadId`는 root thread id
- root thread 기준 merged issue board 반환
- 현재 active physical thread의 issue는 브리지 live state에서 읽고, 닫힌 physical thread의 issue는 projection에서 읽는다.

추가 권장 응답:

```json
{
  "root_thread": {},
  "issues": [],
  "continuity": {
    "active_physical_thread_id": "pth-3",
    "latest_physical_sequence": 3,
    "rollover_count": 2
  }
}
```

### `GET /api/issues/{issueId}`

issue detail은 유지하되 message provenance를 포함합니다.

추가 필드:

- `root_thread_id`
- `physical_thread_id`
- `physical_sequence`
- `message_class`

## 10.2 신규 API

### `GET /api/threads/{threadId}/timeline`

목적:

- 모바일 merged chat 전용

읽기 규칙:

- active physical thread의 live message는 브리지 메모리 우선
- closed physical thread의 과거 message와 summary는 projection 우선

응답:

```json
{
  "root_thread": {},
  "entries": [],
  "continuity": {}
}
```

### `GET /api/threads/{threadId}/continuity`

목적:

- 운영/디버깅

응답:

- root thread
- physical threads
- active physical thread
- handoff summaries

### `POST /api/threads/{threadId}/rollover`

목적:

- 운영자 수동 rollover
- QA 테스트

요청 예시:

```json
{
  "reason": "manual"
}
```

### `DELETE /api/threads/{threadId}`

변경 의미:

- root thread cascade delete

반환 권장:

```json
{
  "accepted": true,
  "thread_id": "thread-root-1",
  "deleted_physical_thread_count": 3,
  "deleted_issue_count": 12,
  "deleted_message_count": 84,
  "deleted_summary_count": 2
}
```

---

## 11. 브리지 구현 상세

## 11.1 신규 메모리 구조

[`services/codex-adapter/src/index.js`](../services/codex-adapter/src/index.js)에 아래를 추가합니다.

```js
const physicalThreadStateById = new Map();
const rootThreadPhysicalThreadIdsById = new Map();
const handoffSummariesById = new Map();
const rolloverLocksByRootThreadId = new Map();
const rolloverCooldownByRootThreadId = new Map();
const codexThreadToPhysicalThreadId = new Map();
const closedPhysicalThreadTombstonesById = new Map();
const deletedRootThreadTombstonesById = new Map();
```

## 11.2 `threadStateById`의 의미 재정의

현재 `threadStateById`는 사실상 사용자 thread를 담고 있으므로 이를 root thread 상태로 유지합니다.

즉:

- 기존 `threadStateById`는 유지
- 단 의미를 "사용자에게 보이는 root thread"로 확정
- 실제 Codex binding과 usage는 active physical thread의 mirror로 취급

이 방식이면 대시보드/모바일 회귀 위험이 가장 낮습니다.

## 11.3 physical thread helper

필요 함수:

- `createPhysicalThreadId()`
- `listPhysicalThreads(rootThreadId)`
- `getActivePhysicalThread(rootThreadId)`
- `createPhysicalThread(rootThreadId, reason, sourcePhysicalThread = null)`
- `bindCodexThreadToPhysicalThread(physicalThreadId, codexThreadId)`
- `closePhysicalThread(physicalThreadId, status)`

## 11.4 root thread helper

필요 함수:

- `ensureRootThread(rootThreadId)`
- `syncRootThreadFromActivePhysicalThread(rootThreadId)`
- `updateRootThreadContinuityState(rootThreadId, patch)`

## 11.5 issue 생성 경로 변경

대상 함수:

- `createThreadIssue`

변경:

- `thread_id`는 root thread id로 계속 수용
- issue 저장 시 `root_thread_id = threadId`
- `created_physical_thread_id = getActivePhysicalThread(threadId).id`
- `executed_physical_thread_id = null`

호환성:

- 기존 프론트는 그대로 `thread_id`를 보내면 됨

## 11.6 실행 경로 변경

대상 함수:

- `ensureCodexThreadForProjectThread`
- `startIssueTurn`
- `invalidateCodexThreadBinding`

변경 방향:

- `ensureCodexThreadForProjectThread`는 deprecated 성격으로 두고 내부에서 `ensureCodexThreadForActivePhysicalThread(rootThreadId)` 호출
- `startIssueTurn`은 issue의 `physical_thread_id`가 아니라 "현재 active physical thread"로 실행
- 이유: 사용자가 같은 root thread에서 이어서 작업하면 항상 tail에서 실행되어야 하기 때문

주의:

- 대기열 issue가 오래전에 만들어졌더라도 실행 시점에는 항상 최신 physical thread에서 돌아야 합니다.
- 따라서 필드는 초기에 분리해서 고정합니다.

필수 필드:

- `created_physical_thread_id`
- `executed_physical_thread_id`

규칙:

- issue 생성 시 `created_physical_thread_id`만 채움
- issue 실행 시작 시 `executed_physical_thread_id`를 active physical thread로 확정
- 이후 assistant delta/message는 반드시 `executed_physical_thread_id` 기준으로 기록

## 11.6.1 이벤트 귀속과 late event 차단

rollover 후 늦은 이벤트는 구조상 거의 없어야 하지만, 운영 안정성을 위해 브리지에서 차단합니다.

필수 규칙:

1. app-server notification 수신 시 `codex_thread_id -> physical_thread_id`를 먼저 resolve
2. notification 처리의 primary key는 항상 `physical_thread_id`다.
3. `physical_thread_id`가 `closedPhysicalThreadTombstonesById`에 있으면 즉시 drop
4. 해당 physical thread의 `closed_at` 또는 `deleted_at`가 authoritative 저장소에 있으면 즉시 drop
5. `root_thread_id`가 `deletedRootThreadTombstonesById`에 있으면 즉시 drop
6. 해당 root thread의 `deleted_at`가 authoritative 저장소에 있으면 즉시 drop
7. 델타/상태 이벤트는 현재 root thread 전체가 아니라, 해당 `physical_thread_id`에 귀속된 실행 issue에만 반영

최소 수정 방향:

- 기존 `codexThreadToThreadId`는 유지
- `codexThreadToPhysicalThreadId`를 추가해 이벤트 귀속을 physical thread까지 내린다
- `activeIssueByThreadId` 단일 매핑만으로는 부족하므로 `activeIssueByPhysicalThreadId`를 추가한다
- `resolveLocalThreadId`보다 앞단에서 `resolvePhysicalThreadIdByCodexThreadId`를 수행한다

구현 규약:

- root thread는 집계/조회/삭제 단위다.
- notification 귀속과 상태 반영 단위는 physical thread다.
- root thread 상태는 physical thread 반영 결과를 집계해서 갱신한다.

권장 신규 맵:

```js
const activeIssueByPhysicalThreadId = new Map();
```

## 11.7 rollover orchestrator

필요 함수:

- `maybeTriggerContextRollover(userId, rootThreadId)`
- `performContextRollover(userId, rootThreadId, reason = "threshold")`
- `buildDeterministicHandoffSummary(rootThreadId, sourcePhysicalThreadId)`
- `buildHandoffPrompt(summary)`

권장 pseudo flow:

```js
async function performContextRollover(userId, rootThreadId, reason = "threshold") {
  const release = acquireRootThreadLock(rootThreadId);
  try {
    const rootThread = threadStateById.get(rootThreadId);
    const sourcePhysicalThread = getActivePhysicalThread(rootThreadId);
    validateRolloverPreconditions(rootThread, sourcePhysicalThread);

    const summary = buildDeterministicHandoffSummary(rootThreadId, sourcePhysicalThread.id);
    const targetPhysicalThread = createPhysicalThread(rootThreadId, "context_rollover", sourcePhysicalThread);
    const codexThreadId = await startCodexThreadForPhysicalThread(userId, rootThreadId, targetPhysicalThread.id, summary);

    bindCodexThreadToPhysicalThread(targetPhysicalThread.id, codexThreadId);
    closePhysicalThread(sourcePhysicalThread.id, "rolled_over");
    markPhysicalThreadClosedForEventDrop(sourcePhysicalThread.id);
    activatePhysicalThread(rootThreadId, targetPhysicalThread.id);
    persistRootThreadState(rootThreadId);
    publishRolloverEvents(userId, rootThreadId, sourcePhysicalThread.id, targetPhysicalThread.id);
  } finally {
    release();
  }
}
```

## 11.8 수동 삭제

기존 `deleteProjectThread`는 root thread cascade delete로 대체합니다.

필요 세부 함수:

- `deleteRootThreadCascade(userId, rootThreadId)`
- `stopActivePhysicalThreadBestEffort(rootThreadId)`
- `deleteRootThreadIssues(rootThreadId)`
- `deleteRootThreadMessages(rootThreadId)`
- `deleteRootThreadSummaries(rootThreadId)`
- `deleteRootThreadProjectionArtifacts(rootThreadId)`

삭제 정책:

- 1차 구현은 hard delete 가능
- 운영 로그/감사를 위해서는 soft delete + 주기적 purge가 더 안전

실서비스 권장:

- 브리지 로컬 저장에서는 hard delete
- projection/RethinkDB에서는 `deleted_at` soft delete 후 background purge
- 브리지는 삭제 직후 `deletedRootThreadTombstonesById`에 tombstone을 남겨 late event를 drop
- 단, 최종 차단 근거는 메모리 tombstone이 아니라 authoritative `deleted_at`여야 한다

---

## 12. Projection worker 구현 상세

## 12.1 추가 이벤트

브리지에서 아래 이벤트를 발행합니다.

- `rootThread.created`
- `rootThread.updated`
- `physicalThread.created`
- `physicalThread.updated`
- `physicalThread.closed`
- `rootThread.rollover.started`
- `rootThread.rollover.completed`
- `rootThread.rollover.failed`
- `rootThread.deleted`
- `handoffSummary.created`
- `logicalThread.timeline.updated`

현재 event naming 스타일과 맞추려면 `bridge.*` 네임스페이스를 써도 됩니다. 중요한 것은 projection worker가 root/physical/summaries를 별도로 식별할 수 있어야 한다는 점입니다.

## 12.2 projection worker 역할

[`services/projection-worker/ProjectionWorkerService.cs`](../services/projection-worker/ProjectionWorkerService.cs)는 다음 일을 해야 합니다.

1. root thread projection 유지
2. physical thread projection 유지
3. merged issue board projection 유지
4. merged timeline projection 유지
5. delete event 수신 시 cascade soft delete
6. 현재 active physical thread의 live 상태를 대신하지 않음

## 12.3 out-of-order event 보호

현재 worker의 `ShouldReplaceProjection` 패턴을 그대로 확장합니다.

모든 projection row에는 다음 필드를 둡니다.

- `projected_at`
- `last_event_type`
- `deleted_at`

규칙:

- 더 오래된 이벤트가 나중에 도착하면 projection을 덮어쓰지 않음
- 삭제 이벤트 이후 늦게 온 update는 무시
- closed physical thread에 대한 update는 projection에 반영하지 않음

## 12.4 projection 일관성 점검

worker는 주기적으로 다음 invariant 검사를 할 수 있어야 합니다.

1. root thread active physical thread가 projection에도 존재하는지
2. logical thread issue board에 dangling issue가 없는지
3. timeline에 삭제된 message가 남아있지 않은지

이는 2차 구현으로 빼도 되지만 운영성을 생각하면 매우 유용합니다.

---

## 13. 모바일 구현 상세

## 13.1 1차 방식

최소 변경으로 가려면 모바일은 기존 `thread -> issues -> issue detail messages` 구조를 유지하고, API만 root thread merged 결과를 주도록 바꾸면 됩니다.

가장 현실적인 방법:

- `GET /api/threads/{threadId}/issues`가 이미 merged issue board 반환
- `GET /api/issues/{issueId}`는 provenance 포함
- 모바일은 여전히 issue detail들을 모아 합성

장점:

- 프론트 수정량 적음

단점:

- API 왕복 수가 많음
- 현재 active physical thread의 live message는 projection이 아니라 브리지 응답을 써야 함

## 13.2 2차 방식

`GET /api/threads/{threadId}/timeline` 도입 후 모바일은 timeline 하나만 읽습니다.

장점:

- 훨씬 빠름
- 합성 로직 단순
- handoff summary/system event 표현 용이

실서비스 기준으로는 2차 방식이 권장됩니다.

---

## 14. 대시보드 구현 상세

대시보드는 root thread 하나에 대한 merged issue board만 보면 됩니다.

필수 변경:

- 없음에 가깝게 유지

권장 변경:

- thread 카드에 `rollover_count`
- `continuity_status`
- `active sequence`

하지만 1차 릴리스에서는 UI 무변경이 더 안전합니다.

---

## 15. 장애 대응과 안정성

## 15.1 rollover lock

동일 root thread에 대해 rollover 중복 실행을 막아야 합니다.

권장 구조:

```json
{
  "thread-root-1": {
    "started_at": "...",
    "reason": "threshold",
    "source_physical_thread_id": "pth-2"
  }
}
```

규칙:

- lock이 있으면 새 rollover 거절
- 일정 시간 이상 오래된 lock은 stale로 판단 후 복구

## 15.2 late event 차단

late event는 구조상 거의 없어야 하지만, 다음 최소 차단 장치를 반드시 둡니다.

1. physical thread가 rollover로 닫히는 순간 tombstone 기록
2. root thread가 삭제되는 순간 tombstone 기록
3. app-server notification 수신 시 tombstone 우선 검사
4. tombstone miss가 나더라도 authoritative `closed_at` / `deleted_at`로 2차 차단
5. tombstone 대상 이벤트는 로그만 남기고 상태 반영하지 않음

권장 보존 시간:

- `closedPhysicalThreadTombstonesById`: 10분
- `deletedRootThreadTombstonesById`: 30분

production-ready 규칙:

- 메모리 tombstone은 빠른 차단용 캐시다.
- 최종 차단 기준은 브리지 저장소에 기록된 `closed_at`, `deleted_at`다.
- 따라서 브리지 재시작 후에도 late event 차단 보장이 유지된다.

## 15.3 cooldown

threshold 이벤트가 여러 번 와도 반복 rollover를 막습니다.

예:

- `OCTOP_THREAD_CONTEXT_ROLLOVER_COOLDOWN_MS=30000`

## 15.4 idempotency

idempotency key:

- `root_thread_id + source_physical_thread_id + latest_physical_sequence`

동일 key의 rollover는 한 번만 성공해야 합니다.

## 15.5 새 physical thread 생성 실패

대응:

1. root thread active 포인터는 유지
2. source physical thread 계속 active
3. `continuity_status = degraded`
4. 경고 이벤트 발행
5. 수동 rollover 가능 상태 유지

## 15.6 app-server 일시 장애

rollover는 "새 Codex thread 생성 성공" 이전에는 root thread active 포인터를 바꾸지 않습니다.

즉 부분 성공이 남더라도 작업 대상이 잘못 바뀌는 일은 없어야 합니다.

## 15.7 delete 도중 실패

삭제도 root thread lock 하에서 수행합니다.

실패 시:

- 브리지 메모리와 로컬 JSON은 마지막 성공 시점까지만 반영
- projection에는 `rootThread.delete.failed` 이벤트 발행
- 재시도 가능

권장:

- root thread 삭제는 soft delete marker 먼저 기록
- 이후 purge 단계에서 실제 하드 삭제

범위 조정:

- 별도 rollover transaction journal은 현재 필수 범위가 아니다.
- 현재 단계에서는 `active_physical_thread_id`, `latest_physical_sequence`, `closed_at`, `deleted_at`를 기준으로 재시작 시 invariant 복구를 수행한다.
- transaction journal은 향후 운영 고도화 항목으로 둔다.

---

## 16. 마이그레이션

현재 데이터는 root/physical 분리가 없습니다.

마이그레이션 전략:

1. 기존 사용자 thread를 전부 root thread로 간주
2. 각 root thread마다 physical thread `sequence = 1` 자동 생성
3. 기존 `codex_thread_id`, usage 정보는 sequence 1 physical thread로 이관
4. 기존 issue는 모두 `root_thread_id = 기존 thread id`, `created_physical_thread_id = sequence 1`, `executed_physical_thread_id = sequence 1`

적용 위치:

- `restoreThreadCentricState` 안에서 lazy migration

이 방식의 장점:

- 별도 배치 마이그레이션 없음
- bridge 재시작 시 자동 보정 가능

---

## 17. 릴리스 전략

## 17.1 Phase 1

- root/physical 모델 추가
- lazy migration
- 기존 UI 유지
- rollover는 비활성
- 브리지 상태 파일 원자 저장 도입

검증:

- 기존 thread/issue 생성과 실행 regression 없음

## 17.2 Phase 2

- physical thread 실행 라우팅 활성
- root thread delete cascade 추가
- projection root/physical row 저장
- notification 처리의 primary key를 `physical_thread_id`로 전환

검증:

- 삭제 시 관련 데이터 전부 정리
- 현재 active physical thread live 상태는 projection이 아니라 브리지 응답을 계속 사용

## 17.3 Phase 3

- threshold rollover 활성
- handoff summary 저장
- active physical thread 전환

검증:

- threshold 도달 시 새 Codex thread로 안전하게 전환
- projection 반영 전에도 source physical thread의 직전 이력이 grace window 동안 보인다

## 17.4 Phase 4

- merged timeline projection/API 추가
- 모바일 timeline 조회 최적화

검증:

- 모바일에서 과거 thread 이력이 현재 thread 안에 있는 것처럼 보임
- 현재 active physical thread의 live delta는 여전히 브리지에서 읽음

## 17.5 향후 확장

- projection durable delivery
- projection rebuild/rehydrate 자동화
- rollover transaction journal

---

## 18. 테스트 계획

## 18.1 단위 테스트

필수 케이스:

1. 기존 thread 로딩 시 root/physical lazy migration
2. root thread에 새 issue 생성 시 active physical thread 귀속
3. `context_usage_percent = 84` rollover 미발생
4. `context_usage_percent = 85` rollover 정확히 1회 발생
5. 동일 source thread에 threshold 이벤트 10번 와도 1회만 rollover
6. rollover 실패 시 active thread 유지
7. root thread 삭제 시 모든 physical thread/issue/message/summary 정리
8. closed physical thread의 late event는 tombstone으로 drop
9. 브리지 재시작 후에도 `closed_at` / `deleted_at` 기준으로 late event가 차단됨

## 18.2 통합 테스트

필수 시나리오:

1. root thread 생성
2. issue 여러 개 생성/실행
3. threshold 이벤트 주입
4. physical thread 2 생성 확인
5. 이후 새 실행이 반드시 physical thread 2로 감
6. `/api/threads/{root}/issues`가 두 physical thread의 issue를 함께 반환
7. `/api/threads/{root}/timeline`이 handoff summary를 포함해 반환
8. root thread 삭제 시 projection까지 정리
9. rollover 후 source physical thread에서 온 notification은 반영되지 않음

## 18.3 장애 테스트

1. rollover 중 app-server down
2. delete 중 bridge 재시작
3. out-of-order projection event
4. stale lock 복구
5. rollover 직후 projection 지연 상태에서 grace window fallback 동작
6. 브리지 재시작 후 late event 차단 유지

---

## 19. 운영 메트릭과 로그

필수 메트릭:

- `root_thread_rollover_total`
- `root_thread_rollover_failed_total`
- `root_thread_rollover_duration_ms`
- `root_thread_delete_total`
- `root_thread_delete_failed_total`
- `physical_thread_count_per_root_thread`
- `timeline_projection_lag_ms`

필수 로그 필드:

- `root_thread_id`
- `active_physical_thread_id`
- `source_physical_thread_id`
- `target_physical_thread_id`
- `latest_physical_sequence`
- `context_usage_percent`
- `active_issue_id`
- `event_type`

---

## 20. 최종 권고

현재 OctOP 구조에서 가장 안정적인 해법은 다음입니다.

1. 사용자가 보는 thread는 최초 생성된 `root thread` 하나로 고정
2. 실제 실행은 `root thread` 아래 가장 마지막 `physical thread`
3. 브리지가 최종 권위자이며 현재 active physical thread의 live 상태는 항상 브리지에서 직접 읽음
4. rollover는 새 physical thread를 추가하는 방식으로만 수행
5. 과거 physical thread는 projection에서 읽기 전용으로 합성
6. rollover 후 닫힌 physical thread와 삭제된 root thread의 이벤트는 tombstone으로 차단
7. 삭제는 `root_thread_id` 기준 cascade delete

즉 이 기능의 본질은 linked list가 아니라 아래입니다.

- `root thread`는 사용자 정체성
- `physical thread`는 실행 세대
- `bridge live + projection history merge`는 읽기 연속성
- `cascade delete`는 운영 안정성

이 구조가 현재 코드, 현재 UI, 현재 projection worker, 현재 app-server 연동 방식에 가장 맞고 서비스 운영 리스크도 가장 낮습니다.
