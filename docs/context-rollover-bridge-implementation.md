# Context Rollover Bridge 운영 설계안

## 목적

Codex thread의 문맥 한도에 가까워졌을 때 새 Codex thread로 안전하게 넘기는 `context rollover`를 구현합니다.

단, 이 문서는 rollover 기능 자체보다 아래 목표를 더 우선합니다.

- `무한대기`가 절대 발생하지 않을 것
- queue/active lock/awaiting_input이 서로 꼬이지 않을 것
- 브릿지 재시작 후에도 상태가 복구 가능할 것
- 대시보드와 모바일이 같은 source of truth를 서로 다른 UI로 안정적으로 소비할 것

즉 rollover는 `운영 안정성`을 만족하는 구조 위에서만 허용합니다.

---

## 현재 코드 기준 진단

현재 기준 파일:

- [services/codex-adapter/src/index.js](/Users/jazzlife/Documents/Workspaces/Products/OctOP/services/codex-adapter/src/index.js)
- [apps/api/Program.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/api/Program.cs)
- [services/projection-worker/ProjectionWorkerService.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/services/projection-worker/ProjectionWorkerService.cs)
- [apps/dashboard/src/App.jsx](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/dashboard/src/App.jsx)
- [apps/mobile/src/App.jsx](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/mobile/src/App.jsx)

현재 구조에서 확인된 사실:

- 하나의 UI thread는 내부적으로 하나의 `codex_thread_id`를 오래 재사용합니다.
- `issueMessagesById`는 UI/복원용 기록일 뿐, Codex context를 줄이지 않습니다.
- `startIssueTurn()`은 queue에서 issue를 꺼낸 뒤 실행합니다.
- `awaiting_input`은 active lock을 유지한 채 queue를 멈추는 상태입니다.
- watchdog는 `running` stale만 일부 보정합니다.
- legacy thread queue와 thread-centric issue queue가 같은 파일에 공존합니다.

즉 지금 구조는 문맥 한도뿐 아니라 `무한대기`, `queue 유실`, `stale binding`, `상태 꼬임` 위험도 같이 가지고 있습니다.

---

## 최우선 운영 원칙

### 1. 무한대기를 허용하지 않음

어떤 상태도 복구 경로 없이 장시간 유지되면 안 됩니다.

특히 아래는 모두 timeout / reconcile 대상입니다.

- `leased`
- `running`
- `awaiting_input`
- `rollover_pending`

### 2. queue는 원자적으로 처리

queue에서 꺼낸 작업은 아래 중 하나가 반드시 보장되어야 합니다.

- 성공적으로 `running`에 진입
- 다시 `queued`로 복귀
- `failed`로 종료

즉 조용히 사라지는 상태는 허용하지 않습니다.

### 3. bridge가 단일 source of truth

아래는 모두 bridge가 단일 기준으로 관리합니다.

- queue 상태
- active issue
- rollover 상태
- `codex_thread_id` binding
- context pressure

대시보드와 모바일은 이를 해석만 하고, 상태를 추론해서 보정하지 않습니다.

### 4. UI thread와 Codex thread는 분리

- UI thread
  - 사용자가 보는 장기 세션
- Codex thread
  - app-server에서 실제 turn이 실행되는 세션

rollover는 `codex_thread_id`만 교체합니다.

절대 초기화하면 안 되는 것:

- `threadIssueIdsById`
- `issueCardsById`
- `issueMessagesById`
- archive 기준이 되는 `issue_id`

---

## 운영 관점의 핵심 위험

### 위험 1. queue dequeue 후 실행 실패

현재 `processIssueQueue()`는 먼저 `queue.shift()`를 수행합니다.

위험:

- `ensureCodexThreadForProjectThread()` 실패
- `thread/start` 실패
- `turn/start` 이전 예외

이 경우 issue가 queue에서 이미 빠졌는데 실행도 안 되고 재삽입도 안 될 수 있습니다.

이건 `무한대기`와 별개로 `조용한 유실`입니다.

### 위험 2. awaiting_input 영구 정지

현재 `awaiting_input`은 active lock을 유지한 채 queue를 정지시킵니다.

문제:

- 입력이 오지 않으면 영구 정지 가능
- rollover도 금지해야 하므로 복구 경로가 더 중요

즉 `awaiting_input`은 상태 이름이 아니라 운영 정책이 필요한 정지 상태입니다.

### 위험 3. running stale만으로는 부족

현재 watchdog는 주로 `running` stale을 봅니다.

하지만 실제로는 아래도 멈춤 원인입니다.

- active issue는 없는데 queue가 남아 있음
- active issue는 있는데 running meta가 없음
- `rollover_pending`이 오래 지속
- `leased` 상태에서 실행 진입 실패

즉 `running watchdog`만으로는 부족하고, `queue reconciliation`이 별도 필요합니다.

### 위험 4. thread-level summary 저장 계약 부재

모바일은 채팅형 타임라인을 유지해야 하고, 대시보드는 issue 카드와 archive 일관성이 더 중요합니다.

따라서 rollover summary를 issue로 만들면 안 되고, thread-level message로 다뤄야 합니다.

하지만 이 저장소는 현재 코드에 없습니다.

즉 아래 계약이 선행되어야 합니다.

- `threadMessagesById`
- persist / restore
- gateway API
- 모바일 merge 규칙
- 대시보드 표시 규칙

### 위험 5. legacy queue 경로 공존

현재 bridge 파일에는

- thread-centric issue queue
- legacy thread queue

가 공존합니다.

이 상태로 rollover를 넣으면 상태 오염 가능성이 큽니다.

즉 rollover 전에 `공식 실행 경로`를 한 개로 줄여야 합니다.

---

## context rollover는 언제 필요한가

현재 구조상, 같은 UI thread에 issue를 계속 추가하면 내부 Codex thread의 문맥은 계속 누적됩니다.

다음 사용 패턴이면 rollover가 필요합니다.

- 하나의 thread를 장기간 유지
- 모바일에서 같은 thread를 채팅처럼 오래 사용
- 대시보드에서 한 thread에 이슈를 계속 이어 붙임
- assistant delta와 수정 이력이 많이 쌓임

따라서 현재 제품 방향에서는 rollover 필요성이 높습니다.

단, 아래 선행 조건 없이 바로 구현하면 운영 장애를 만들 가능성이 큽니다.

---

## 선행 구현 조건

### 1. queue lease 모델 도입

queue 상태를 아래처럼 분리합니다.

- `staged`
- `queued`
- `leased`
- `running`
- `awaiting_input`
- `completed`
- `failed`

의미:

- `queued`
  - 아직 실행 슬롯을 얻지 않음
- `leased`
  - 실행 시작을 시도하는 중
  - 아직 실제 `turn/start` 성공 확정 아님
- `running`
  - app-server turn이 실제 시작됨

규칙:

- `processIssueQueue()`는 `shift` 대신 `lease`로 전환
- `leased`에서 실패하면 다시 `queued` 복귀 또는 `failed`
- `leased` timeout이 지나면 reconcile 대상

### 2. awaiting_input 운영 정책 추가

반드시 있어야 하는 정책:

- `OCTOP_AWAITING_INPUT_STALE_MS`
- `OCTOP_AWAITING_INPUT_FAIL_MS`

권장 흐름:

1. `awaiting_input` 진입
2. 일정 시간 내 사용자 입력이 오면 기존 Codex thread로 continuation
3. 일정 시간 경과 시 `review_required` 또는 `failed_input_timeout`
4. active lock 해제 여부를 정책으로 명시

즉 `awaiting_input`은 단순 상태가 아니라 SLA가 있는 정지 상태로 봅니다.

### 3. queue reconciliation 추가

watchdog 외에 별도 reconcile 루틴이 필요합니다.

검사 항목:

- active issue 없음 + queue 있음 + thread idle
- active issue 있음 + running meta 없음
- leased 상태인데 일정 시간 진전 없음
- rollover_pending이 일정 시간 이상 유지
- `codex_thread_id`는 있는데 remote thread를 못 찾음

이 reconcile은 `무한대기 방지`의 핵심입니다.

### 4. thread-level message 저장 계약 추가

rollover summary와 thread-level 운영 이벤트는 `threadMessagesById`에 저장합니다.

반드시 포함할 것:

- persist
- restore
- thread 삭제 시 정리
- gateway detail API 노출
- 모바일 타임라인 merge
- 대시보드 상세 노출

중요:

- synthetic issue 생성 금지
- issue id 집합은 archive 정합성을 위해 유지

### 5. legacy queue 제거 또는 비활성화

rollover 구현 전에 아래 중 하나를 먼저 해야 합니다.

- legacy thread queue 완전 제거
- 또는 feature flag로 완전 비활성화

`공식 실행 경로`는 thread-centric issue queue 하나만 남기는 것이 맞습니다.

---

## rollover 설계

### 공통 원칙

- rollover는 `UI thread`를 유지한 채 `codex_thread_id`만 교체
- 과거 issue / issue messages / archive는 그대로 유지
- rollover summary는 thread-level system message로 추가
- summary turn 성공 전에는 binding 교체 금지

### rollover 상태

- `rollover_pending`
- `rollover_running`
- `rollover_failed`
- `rollover_completed`

### rollover 금지 조건

아래 중 하나라도 참이면 rollover 금지:

- `activeIssueByThreadId` 존재
- `awaiting_input`
- `leased`
- bridge reconnect 중
- app-server not ready

즉 단순히 thread status 문자열만 보고 판단하지 않습니다.

### rollover 허용 조건

- active issue 없음
- leased 없음
- awaiting_input 아님
- queue reconciliation 결과 정합성 확인됨
- context pressure threshold 초과

---

## context pressure 계산

pressure 계산은 전체 이력이 아니라 `마지막 summary 이후 window`만 기준으로 합니다.

사용 값:

- `window_prompt_chars`
- `window_assistant_chars`
- `window_issue_count`

환경변수:

- `OCTOP_CONTEXT_ROLLOVER_ENABLED=true`
- `OCTOP_CONTEXT_ROLLOVER_CHAR_THRESHOLD`
- `OCTOP_CONTEXT_ROLLOVER_ISSUE_THRESHOLD`
- `OCTOP_CONTEXT_ROLLOVER_ASSISTANT_CHAR_THRESHOLD`

재계산 트리거:

- issue 생성
- issue 수정
- issue 삭제
- issue 재시도
- assistant delta 누적
- turn 완료
- thread restore
- summary 생성 완료

즉 pressure는 append 시점뿐 아니라 `삭제/편집`에서도 다시 계산되어야 합니다.

---

## rollover summary 저장/노출 설계

### bridge 내부 메타

아래를 thread 메타로 저장:

- `rollover_summary`
- `last_rollover_at`
- `codex_thread_revision`
- `last_summary_issue_id`
- `summary_window_start_at`

### UI 노출용 저장

새 저장소:

- `threadMessagesById`

메시지 형식:

- `role: "system"`
- `kind: "rollover-summary"`
- `content`
- `timestamp`
- `codex_thread_revision`

이 저장소를 택하는 이유:

- 모바일은 issue message와 thread message를 합쳐 채팅 타임라인 구성 가능
- 대시보드는 thread 상태/상세에서만 노출 가능
- issue id 집합을 건드리지 않음

---

## 데이터 계약

### bridge 공통

bridge가 source of truth로 발행:

- `bridge.projectThreads.updated`
- `bridge.threadIssues.updated`
- `thread.rollover.*`

snapshot payload에 포함:

- `codex_thread_revision`
- `rollover_pending`
- `rollover_running`
- `last_rollover_at`
- `context_pressure`

### 대시보드 전용 계약

- `bridge.threadIssues.updated`는 항상 같은 UI thread의 전체 issue 집합을 반환
- issue id는 rollover 전후 절대 바뀌지 않음
- archive key는 기존 `thread_id + issue_id`를 유지
- rollover summary는 issue 카드가 아니라 thread 상태/상세 정보로만 노출

### 모바일 전용 계약

- thread detail API는 `thread messages + issue messages`를 시간순으로 합쳐 렌더할 수 있어야 함
- rollover summary는 실제 타임라인 message로 들어가야 함
- stale detail 응답이 최신 revision을 덮으면 안 됨

---

## 실패 및 복구 설계

### 부분 성공 복구 규칙

순서:

1. 새 Codex thread 생성
2. 새 thread에 summary turn 전송
3. summary turn 성공 확인
4. local state / persist / mapping commit
5. snapshot / raw event 발행

복구 원칙:

- 1 또는 2 실패
  - 기존 binding 유지
  - 새 thread 폐기
- 3 성공, 4 실패
  - binding 교체 커밋 금지
  - 다음 reconcile에서 재시도 가능 상태로 유지
- 4 성공, 5 실패
  - local state가 source of truth
  - snapshot 재발행으로 복구

### 무한대기 방지 복구 규칙

- `leased` stale
  - 다시 `queued` 또는 `failed`
- `running` stale
  - remote 상태 재조회 후 `completed/failed/awaiting_input`
- `awaiting_input` stale
  - `review_required` 또는 `failed_input_timeout`
- `rollover_pending` stale
  - reason/attempt 기록 후 pending 해제 또는 실패 처리

---

## 실제 구현 체크리스트

### 1. 실행 경로 정리

- [ ] legacy thread queue 제거 또는 비활성화
- [ ] 공식 실행 경로를 thread-centric issue queue 하나로 고정

### 2. queue lease 도입

- [ ] issue 상태에 `leased` 추가
- [ ] `processIssueQueue()`에서 `shift` 대신 lease 전환
- [ ] `leased -> running` 승격 조건 구현
- [ ] `leased` 실패 시 `queued` 복귀 또는 `failed` 처리
- [ ] `leased` timeout reconcile 구현

### 3. awaiting_input 운영 정책

- [ ] `OCTOP_AWAITING_INPUT_STALE_MS` 추가
- [ ] `OCTOP_AWAITING_INPUT_FAIL_MS` 추가
- [ ] 입력 재개 API 정의
- [ ] timeout 시 `review_required` 또는 `failed_input_timeout` 전환
- [ ] active lock 해제 정책 명시

### 4. queue reconciliation

- [ ] active issue 없음 + queue 있음 + thread idle 검사
- [ ] active issue 있음 + meta 없음 검사
- [ ] leased stale 검사
- [ ] rollover_pending stale 검사
- [ ] remote thread missing 검사

### 5. thread-level messages

- [ ] `threadMessagesById` 추가
- [ ] persist/restore 반영
- [ ] thread 삭제 시 정리
- [ ] gateway detail API에 포함
- [ ] 모바일 merge 로직 추가
- [ ] 대시보드 상세 표시 로직 추가

### 6. context pressure

- [ ] `threadContextMetaById` 저장소 추가
- [ ] issue 생성/수정/삭제/재시도 시 재계산
- [ ] delta 누적 시 재계산
- [ ] summary 이후 window 기준 계산

### 7. rollover 실행

- [ ] `scheduleThreadRollover()` 구현
- [ ] `executeThreadRollover()` 구현
- [ ] active/leased/awaiting_input에서는 rollover 금지
- [ ] 2-phase binding 적용
- [ ] partial success rollback 구현

### 8. snapshot/raw event

- [ ] snapshot에 rollover 메타 포함
- [ ] `thread.rollover.requested`
- [ ] `thread.rollover.started`
- [ ] `thread.rollover.completed`
- [ ] `thread.rollover.failed`
- [ ] snapshot이 최종 정합성을 책임지도록 유지

### 9. 대시보드

- [ ] rollover 상태를 thread 상태 정보로 표시
- [ ] archive가 rollover 전후 issue id 기준으로 유지되는지 검증
- [ ] thread 재선택 시 archived review/done 재등장 방지 검증

### 10. 모바일

- [ ] threadMessages system message를 타임라인에 합치기
- [ ] rollover 이후에도 기존 issue message와 연속성 유지
- [ ] stale detail 응답 방지

### 11. 운영 검증

- [ ] bridge 재시작 후 active/queue 복원 검증
- [ ] leased stale 복구 검증
- [ ] awaiting_input timeout 복구 검증
- [ ] rollover 실패 후 기존 thread 계속 사용 검증
- [ ] 긴 thread에서 rollover 성공 검증

---

## 완료 기준

아래를 만족해야 완료로 봅니다.

- issue가 queue에서 조용히 사라지지 않음
- `awaiting_input`, `leased`, `running`, `rollover_pending` 어느 상태도 영구 유지되지 않음
- bridge 재시작 후에도 queue와 active 상태가 복구 가능
- rollover 전후 대시보드의 issue/archive 정합성이 깨지지 않음
- rollover 전후 모바일의 채팅 타임라인이 끊기지 않음
- context 압박이 커져도 기존 UI thread를 유지한 채 Codex thread만 안전하게 교체 가능
