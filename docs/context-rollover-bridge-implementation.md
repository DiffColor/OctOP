# Context Rollover Bridge 설계안

## 목적

Codex thread의 context 한도에 가까워졌을 때, 현재 작업 흐름을 끊지 않고 새 Codex thread로 안전하게 넘기는 `context rollover`를 브릿지에 구현합니다.

핵심 목표는 아래와 같습니다.

- 사용자는 같은 OctOP thread를 계속 사용한다고 느껴야 합니다.
- 내부적으로는 새 `codex_thread_id`로 교체하여 context 압박을 줄여야 합니다.
- rollover 이후에도 `Preparation`, `To Do`, `In Progress`, `Review`, `Done` 흐름이 깨지지 않아야 합니다.
- rollover 이후에도 과거 issue 목록과 issue 메시지 이력은 모두 같은 UI thread 아래에 유지되어야 합니다.
- 모바일 웹에서는 과거 issue/message가 하나의 연속된 채팅 타임라인처럼 보여야 합니다.
- 대시보드에서는 `Review`, `Done`, 보관함이 같은 UI thread의 전체 issue 집합을 기준으로 일관되게 동작해야 합니다.
- rollover는 추측이나 fallback이 아니라, 명시적 상태 전이와 검증 가능한 메타데이터로 동작해야 합니다.

---

## 현재 구조 진단

현재 브릿지 코드는 [services/codex-adapter/src/index.js](/Users/jazzlife/Documents/Workspaces/Products/OctOP/services/codex-adapter/src/index.js) 에서 각 UI thread를 내부 `codex_thread_id`와 연결합니다.

현재 확인된 사실:

- `turn/start`는 `buildExecutionPrompt(issue.prompt)`만 입력으로 보냅니다.
- Codex의 실제 누적 context는 `codex_thread_id`가 들고 있습니다.
- 브릿지는 `issueMessagesById`에 메시지를 저장하지만, 이 저장소는 UI/복원용이며 Codex context 축소에는 사용되지 않습니다.
- context 사용량을 추적하는 메타는 현재 없습니다.
- context 한도 도달 시 새 thread로 넘기는 로직도 없습니다.

즉 현재는:

- 같은 UI thread에서 Codex context가 계속 누적되고
- 어느 시점 이후에는 응답 품질 저하, 실패, 지연이 발생할 수 있으며
- 브릿지는 이를 구조적으로 완화하지 못합니다.

---

## 설계 원칙

### 1. UI thread와 Codex thread를 분리

사용자에게 보이는 thread와 실제 Codex 실행 thread는 분리합니다.

- UI thread
  - OctOP에서 선택/표시/칸반 기준이 되는 장기 세션
- Codex thread
  - app-server에 실제 `turn/start`를 보내는 실행 세션
  - context 한도에 따라 교체될 수 있음

즉:

- UI thread id는 유지
- `codex_thread_id`는 rollover 시 교체
- `issueCardsById`, `issueMessagesById`, `threadIssueIdsById`는 유지
- 즉 rollover는 "실행 세션 교체"이지 "UI thread 초기화"가 아님

### 2. rollover는 명시적 이벤트로 남김

rollover는 조용히 일어나면 안 됩니다.

브릿지는 최소한 아래 이벤트를 발행해야 합니다.

- `thread.rollover.requested`
- `thread.rollover.started`
- `thread.rollover.completed`
- `thread.rollover.failed`

이 이벤트는 대시보드/모바일/로그에서 모두 추적 가능해야 합니다.

### 3. 원문 context를 그대로 넘기지 않고 요약으로 넘김

새 Codex thread를 만들 때 기존 메시지 전체를 그대로 다시 밀어 넣지 않습니다.

넘기는 것은 아래 3개로 제한합니다.

- 작업 요약
- 현재 남은 작업
- 현재 실행하려는 issue prompt

### 4. 과거 issue / message 이력은 절대 분리하지 않음

이 설계에서 rollover는 `codex_thread_id`만 교체합니다.

유지되어야 하는 것:

- 같은 UI thread id
- 같은 `threadIssueIdsById[threadId]`
- 같은 `issueCardsById`
- 같은 `issueMessagesById`
- 같은 보관함 상태

즉 사용자가 보는 데이터 기준으로는:

- 과거 `Done`, `Review` 이슈도 그대로 남아 있어야 하고
- 모바일에서는 이전 issue의 prompt/assistant message도 연속된 채팅처럼 유지되어야 하며
- 대시보드의 보관함도 rollover 전후로 같은 issue id를 계속 추적해야 합니다

---

## 목표 동작

### 정상 흐름

1. 브릿지가 현재 thread의 context 압박을 감지
2. active issue가 없거나 안전한 전환 시점인지 확인
3. 기존 issue/history를 요약
4. 새 `codex_thread_id` 생성
5. UI thread의 `codex_thread_id`를 새 값으로 교체
6. 새 Codex thread의 첫 turn에 rollover summary 입력
7. 다음 issue부터 새 Codex thread에서 계속 실행
8. 기존 issue 카드, 완료 기록, 보관 상태는 그대로 유지

### 실행 중 rollover

`running` 상태에서 rollover를 바로 수행하면 위험합니다.

원칙:

- `running` issue가 있을 때는 rollover 예약만 하고 즉시 실행하지 않음
- `completed`, `failed`, `awaiting_input`, `idle` 시점에만 실제 rollover 수행

즉 `running` 중에는 아래처럼 처리합니다.

- `thread.rollover.requested`
- `thread.rollover_pending = true`
- active issue 종료 후 실제 rollover 수행

---

## 브릿지 데이터 모델 추가

현재 thread 메타에 아래 필드를 추가합니다.

### `threadStateById[threadId]` 확장

- `codex_thread_id`
- `codex_thread_revision`
- `rollover_pending`
- `rollover_reason`
- `rollover_requested_at`
- `last_rollover_at`
- `context_pressure`
- `context_summary_issue_id`

주의:

- 여기에 `archived_issue_ids`를 넣지 않습니다.
- 보관 상태는 현재처럼 클라이언트/별도 저장소에서 관리하되, rollover로 인해 issue id가 바뀌지 않도록 하는 것이 핵심입니다.

### 신규 Map

- `threadContextMetaById`
  - `message_count`
  - `message_chars`
  - `assistant_chars`
  - `prompt_chars`
  - `issue_count`
  - `last_summarized_at`
  - `last_summary_issue_id`

이 값은 정확한 token 수가 아니라 1차 추정치로 사용합니다.

---

## context pressure 계산

초기 구현은 token 계산기 없이 문자 수 기반으로 갑니다.

계산 요소:

- 최근 issue prompt 총 문자 수
- 최근 assistant message 총 문자 수
- thread 내 issue 개수
- 최근 N개 issue 이후의 누적 길이

권장 초기 기준:

- `message_chars >= 120000`
- 또는 `issue_count >= 24`
- 또는 `assistant_chars >= 80000`

이 값은 운영 중 조정 가능하게 환경변수로 뺍니다.

### 환경변수

- `OCTOP_CONTEXT_ROLLOVER_ENABLED=true`
- `OCTOP_CONTEXT_ROLLOVER_CHAR_THRESHOLD=120000`
- `OCTOP_CONTEXT_ROLLOVER_ISSUE_THRESHOLD=24`
- `OCTOP_CONTEXT_ROLLOVER_ASSISTANT_CHAR_THRESHOLD=80000`

---

## 요약 생성 방식

### 요약 입력 소스

브릿지가 저장 중인 아래 데이터를 사용합니다.

- `issueCardsById`
- `issueMessagesById`
- `threadStateById`

### 요약 내용

새 Codex thread에 넘길 summary는 아래 형식을 권장합니다.

1. 프로젝트/워크스페이스 정보
2. 지금까지 완료한 작업
3. 아직 유효한 결정사항
4. 수정된 파일/핵심 경로
5. 현재 남은 작업
6. 지금 시작할 issue prompt

### 요약 저장

요약은 별도 issue로 노출하지 않고 내부 메타로 먼저 저장합니다.

권장 저장 위치:

- `threadStateById[threadId].rollover_summary`
- 필요하면 별도 `threadSummaryById`

---

## rollover 상태 전이

### 상태 머신

- `idle`
- `pending`
- `running`
- `completed`
- `failed`

### 규칙

- context 압박 감지 시:
  - active issue 없음 -> 즉시 `running`
  - active issue 있음 -> `pending`

- rollover 성공 시:
  - `codex_thread_id` 교체
  - `codex_thread_revision += 1`
  - `rollover_pending = false`

- rollover 실패 시:
  - 기존 `codex_thread_id` 유지
  - `rollover_pending = false`
  - `last_event = thread.rollover.failed`

---

## 실제 브릿지 구현 포인트

### 1. context pressure 집계

추가 위치:

- `pushIssueMessage()`
- `appendAssistantDeltaToIssue()`
- `updateIssueCard()`
- `restoreThreadCentricState()`

해야 할 일:

- issue/thread별 누적 길이 계산
- 저장 시 thread context 메타 갱신

### 2. rollover 필요 여부 판단

추가 함수:

- `computeThreadContextPressure(threadId)`
- `shouldScheduleContextRollover(threadId)`

호출 지점:

- issue 생성 후
- assistant delta 누적 후
- turn 완료 후
- thread 복원 후

### 3. rollover 예약

추가 함수:

- `scheduleThreadRollover(userId, threadId, reason)`

역할:

- `running`이면 pending 표시
- 아니면 즉시 `executeThreadRollover()`

### 4. 실제 rollover 실행

추가 함수:

- `executeThreadRollover(userId, threadId)`

절차:

1. 요약 생성
2. 새 Codex thread 생성
3. 새 `codex_thread_id` 바인딩
4. summary turn 입력
5. 상태 저장 및 이벤트 발행

### 5. queue와의 연동

기존 `processIssueQueue()`와 충돌하지 않도록 조건을 추가합니다.

- `rollover_pending`인데 active issue가 끝났으면 rollover 먼저
- rollover 완료 후 다음 issue 시작

즉:

- `processIssueQueue()` 진입
- `rollover_pending` 확인
- 있으면 `executeThreadRollover()` 우선
- 끝나면 다음 issue 실행

---

## 대시보드 / 모바일 반영

### 대시보드

보여줄 정보:

- `Context rollover pending`
- `Context rollover running`
- `Context rollover completed`

보장해야 할 조건:

- 같은 thread를 다시 클릭해도 rollover 이전 `Review`, `Done`, 보관 항목이 다시 나타났다 사라지면 안 됨
- `bridge.threadIssues.updated`는 항상 해당 UI thread의 전체 issue 목록을 기준으로 갱신되어야 함
- rollover 이후에도 archive key는 기존 `thread_id + issue_id` 기준을 그대로 사용해야 함

표시 위치:

- 선택 thread 상세
- 최근 이벤트 목록
- 필요 시 thread row badge

### 모바일

보여줄 정보:

- `요약 중`
- `새 실행 세션 준비 중`

모바일은 대화 흐름이 끊기지 않는 것이 핵심이므로, 상세 타임라인에 이벤트 한 줄만 보여줘도 충분합니다.

보장해야 할 조건:

- rollover 이후에도 과거 issue의 prompt / assistant message는 동일한 thread 상세 안에 남아 있어야 함
- 사용자는 thread가 갈라졌다고 느끼면 안 됨
- 새 Codex thread에서 이어진 응답도 같은 UI thread 대화 흐름에 append되어야 함

---

## 실패 처리

### 실패 케이스

- 새 `thread/start` 실패
- summary 생성 실패
- summary turn 입력 실패
- 새 `codex_thread_id` 바인딩 실패

### 원칙

- 실패 시 기존 `codex_thread_id` 유지
- queue는 멈추지 않고 기존 thread에서 계속 진행 가능해야 함
- 단, `rollover_failed` 상태와 마지막 에러는 남김

즉 rollover는 실패해도 작업 전체를 깨뜨리면 안 됩니다.

---

## 체크리스트

### 1. bridge 메타 추가

- [ ] `threadStateById`에 rollover 관련 필드 추가
- [ ] `threadContextMetaById` 저장소 추가
- [ ] restore/persist 경로에 새 메타 저장 반영

### 2. context pressure 계산

- [ ] `pushIssueMessage()`에서 prompt 길이 반영
- [ ] `appendAssistantDeltaToIssue()`에서 assistant 길이 반영
- [ ] `updateIssueCard()`에서 thread 메타 재계산
- [ ] `computeThreadContextPressure(threadId)` 구현

### 3. rollover 트리거

- [ ] 환경변수 추가
- [ ] `shouldScheduleContextRollover(threadId)` 구현
- [ ] turn 완료 후 rollover 여부 검사
- [ ] restore 직후 오래된 thread도 검사

### 4. summary 생성

- [ ] thread 요약 생성 함수 구현
- [ ] 요약 payload 저장
- [ ] summary 생성 실패 처리

### 5. rollover 실행

- [ ] `executeThreadRollover(userId, threadId)` 구현
- [ ] 새 `codex_thread_id` 생성
- [ ] `codexThreadToThreadId` 재바인딩
- [ ] `codex_thread_revision` 증가
- [ ] summary turn 입력
- [ ] 기존 `threadIssueIdsById`, `issueCardsById`, `issueMessagesById`를 절대 초기화하지 않음

### 6. queue 연동

- [ ] `processIssueQueue()`에서 rollover pending 우선 처리
- [ ] active issue 종료 직후 rollover 실행
- [ ] rollover 후 다음 queued issue 재개

### 7. 이벤트 발행

- [ ] `thread.rollover.requested`
- [ ] `thread.rollover.started`
- [ ] `thread.rollover.completed`
- [ ] `thread.rollover.failed`
- [ ] `bridge.projectThreads.updated`에 rollover 메타 반영
- [ ] `bridge.threadIssues.updated`는 rollover 전후 동일한 UI thread issue 목록을 유지

### 8. dashboard 반영

- [ ] rollover 상태 텍스트 추가
- [ ] 최근 이벤트에 rollover 이벤트 반영
- [ ] 선택 thread 상세에 context pressure/요약 상태 표시
- [ ] 보관함이 rollover 이후에도 같은 issue id 기준으로 유지되는지 검증
- [ ] thread 재선택 시 archived review/done 이슈가 다시 보였다 사라지지 않는지 검증

### 9. mobile 반영

- [ ] rollover 상태 문구 추가
- [ ] 상세 뷰 타임라인에 rollover 이벤트 반영
- [ ] rollover 이후에도 기존 issue message가 같은 thread 상세에 누적되는지 검증
- [ ] thread 상세 재조회 시 오래된 응답이 새 session 상태를 덮지 않는지 검증

### 10. 검증

- [ ] 긴 thread에서 rollover pending 진입 확인
- [ ] active issue 종료 후 rollover 실행 확인
- [ ] 새 `codex_thread_id`로 재바인딩 확인
- [ ] 이후 issue가 새 Codex thread에서 정상 실행되는지 확인
- [ ] 실패 시 기존 thread로 계속 실행 가능한지 확인

---

## 구현 순서 제안

1. bridge 메타 / persist / restore 정리
2. context pressure 계산 추가
3. rollover pending / execute 함수 구현
4. queue 연동
5. 이벤트 발행
6. dashboard 반영
7. mobile 반영
8. 실제 긴 thread로 검증

---

## 완료 판정 기준

아래 조건을 만족하면 완료로 봅니다.

- 동일 UI thread에서 오래 작업해도 context overflow로 바로 깨지지 않음
- 일정 압박 이상이면 자동으로 rollover pending 또는 running이 됨
- 새 Codex thread로 자연스럽게 이어지고, 사용자 입장에서는 같은 thread를 계속 쓰는 것처럼 보임
- rollover 실패 시에도 기존 작업 흐름이 멈추지 않음
- rollover 전후로 과거 issue 목록, 보관함, 모바일 채팅 타임라인이 끊기지 않음
