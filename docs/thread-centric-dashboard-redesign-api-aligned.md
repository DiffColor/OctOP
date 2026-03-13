# Thread-Centric Dashboard Redesign API-Aligned

## 목적

[thread-centric-dashboard-redesign.md](/Users/jazzlife/Documents/Workspaces/Products/OctOP/docs/thread-centric-dashboard-redesign.md)는 참고 문서로 유지하고, 이 문서는 현재 코드에 실제 구현된 API를 기준으로 재정렬한 실행 설계안입니다.

핵심 원칙은 다음과 같습니다.

- 이미 구현된 API를 최대한 그대로 사용합니다.
- 꼭 필요한 경우에만 신규 API를 추가합니다.
- 프로젝트 화면은 `thread 목록`, thread 화면은 `대화/작업 실행 공간`으로 분리합니다.
- 현재의 `1 이슈 = 1 thread 생성` 구조와, 목표인 `기존 thread 이어가기` 구조를 분리해서 설계합니다.

---

## 현재 구현된 API 기준

현재 코드 기준으로 이미 사용 가능한 API는 아래와 같습니다.

### 조회

- `GET /api/threads`
  - `project_id` 쿼리 지원
  - 프로젝트 기준 thread 목록 조회

- `GET /api/threads/{threadId}`
  - thread 메타 + messages 조회

- `GET /api/bridge/status`
  - bridge 상태 조회

- `GET /api/events`
  - SSE 이벤트 스트림

### 생성/실행

- `POST /api/issues`
  - 현재는 새 thread 생성 + 첫 prompt 저장

- `POST /api/threads/start`
  - `thread_ids` 배열을 받아 staged thread를 queued/running으로 이동

- `POST /api/threads/reorder`
  - queued thread 순서 재정렬

### 삭제

- `DELETE /api/threads/{threadId}`
  - 준비/대기 계열 상태의 thread 삭제

현재 기준 파일:

- [/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/api/Program.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/api/Program.cs)
- [/Users/jazzlife/Documents/Workspaces/Products/OctOP/services/codex-adapter/src/index.js](/Users/jazzlife/Documents/Workspaces/Products/OctOP/services/codex-adapter/src/index.js)

---

## 현재 동작 해석

현재 시스템에서 `POST /api/issues`는 사실상 아래 의미입니다.

1. app-server에 `thread/start` 요청
2. 새 Codex thread 생성
3. 첫 user prompt 저장
4. thread 상태를 `staged`로 기록
5. 이후 `POST /api/threads/start`로 실행 큐에 올림

즉 현재는 아래 구조입니다.

- `새 이슈 등록 = 새 thread 생성`
- `기존 thread 이어쓰기 = 아직 없음`

이 점이 현재 UI와 어긋나는 핵심입니다.

---

## 목표 UX를 현재 API에 맞춰 재구성

### 프로젝트 화면

프로젝트 화면은 칸반보다 `thread 목록` 중심으로 봐야 합니다.

- 데이터 소스: `GET /api/threads?project_id={projectId}`
- 실시간 갱신: `GET /api/events`
- 검색 대상:
  - thread 제목
  - 마지막 메시지
  - 상태

이 화면에서는 하단 채팅 입력을 두지 않습니다.

### thread 상세 화면

thread 상세는 대화 공간입니다.

- 데이터 소스: `GET /api/threads/{threadId}`
- 실시간 갱신: `GET /api/events`
- 하단 입력창은 여기만 존재

현재 API만으로 가능한 동작:

- 새 thread를 하나 더 만드는 방식의 후속 작업

목표 동작:

- 기존 thread에 새 prompt를 이어붙여 같은 문맥으로 turn 실행

즉 상세 화면 입력창은 최종적으로 신규 API가 필요합니다.

---

## 현재 API를 그대로 사용하는 영역

### 1. 프로젝트별 thread 목록

기존 제안서의 `GET /api/projects/{projectId}/threads`는 현재 구현에 없습니다.

대신 아래를 사용합니다.

#### 사용 API

`GET /api/threads?project_id={projectId}`

#### 프론트 동작

- 프로젝트 선택 시 위 API 호출
- 응답 `threads`를 그대로 좌측 또는 메인 thread 목록에 사용
- `selectedThreadId`는 이 목록 안에서만 유지

### 2. thread 상세 조회

#### 사용 API

`GET /api/threads/{threadId}`

#### 프론트 동작

- thread 선택 시 상세 조회
- `thread`
- `messages`
를 함께 받아 채팅 뷰와 타임라인 뷰를 렌더링

### 3. 새 thread 생성

기존 제안서의 `POST /api/projects/{projectId}/threads`는 현재 구현에 없습니다.

현재는 아래 조합을 사용해야 합니다.

#### 사용 API

1. `POST /api/issues`
2. `POST /api/threads/start`

#### 의미 재정의

이 조합을 당분간 아래 의미로 사용합니다.

- `새 채팅창 생성`
- 선택적으로 첫 프롬프트를 함께 보냄

즉 UI 레이블은 `새 이슈`보다 `새 채팅창` 또는 `새 thread`가 맞습니다.

### 4. thread 삭제

#### 사용 API

`DELETE /api/threads/{threadId}`

#### 제약

현재 어댑터 구현상 아래 상태만 삭제 가능합니다.

- `staged`
- `queued`
- `idle`
- `awaiting_input`
- `failed`

실행 중 thread 삭제는 현재 차단됩니다.

### 5. queue 재정렬

#### 사용 API

`POST /api/threads/reorder`

#### 의미

프로젝트 내 thread 순서가 아니라, 실행 대기 queue 순서입니다.

따라서 이 API는 목록 정렬 UI용이 아니라 `To Do / queued` 관리용으로만 써야 합니다.

---

## 신규 API가 꼭 필요한 영역

현재 목표 UX를 만족시키려면 아래 두 API는 사실상 필수입니다.

### 1. thread 이어쓰기

#### 필요한 API

`POST /api/threads/{threadId}/messages`

#### 이유

현재 상세 입력창은 기존 thread에 쓰는 것처럼 보이지만, 실제로는 `POST /api/issues`를 통해 새 thread를 만듭니다.

목표는 아래여야 합니다.

- 기존 `thread_id`에 user message 추가
- 같은 thread에서 새 turn 실행
- `selectedThreadId` 유지

#### 최소 요구 payload

```json
{
  "prompt": "이전 작업 이어서 진행"
}
```

### 2. thread 제목 변경

#### 필요한 API

`PATCH /api/threads/{threadId}`

#### 이유

사용자 요구사항에 `스와이프 편집으로 제목 변경`이 포함되어 있으나 현재 구현 API에는 rename 경로가 없습니다.

#### 최소 요구 payload

```json
{
  "title": "새 제목"
}
```

---

## 어댑터 설계 정렬

현재 어댑터의 핵심 함수는 다음 의미를 가집니다.

### 이미 존재

- `createQueuedIssue(userId, payload)`
  - 새 thread 생성 전용

- `startQueuedThreads(userId, payload)`
  - staged thread 실행 큐 진입

- `reorderQueuedThreads(userId, payload)`
  - 실행 큐 순서 재정렬

- `deleteThread(userId, payload)`
  - 삭제 가능 상태의 thread 삭제

- `getThreadDetail(userId, threadId)`
  - thread/messages 상세 조회

### 추가 필요

- `appendPromptToThread(userId, payload)`
  - 기존 thread에 user message 추가
  - 해당 thread를 queued 또는 running 흐름으로 연결

- `renameThread(userId, payload)`
  - thread title 변경

중요한 설계 원칙:

- `appendPromptToThread()`는 절대 `thread/start`를 다시 호출하면 안 됩니다.
- 새 thread 생성은 `createQueuedIssue()`
- 기존 thread 이어쓰기는 `appendPromptToThread()`

이 둘은 명확히 분리돼야 합니다.

---

## 프론트엔드 설계 정렬

### 프로젝트 화면

#### 데이터

- 프로젝트 선택
- `GET /api/threads?project_id=...`

#### 기능

- thread 목록 렌더링
- 헤더 우측 검색 버튼
- thread 스와이프 액션
  - 제목 변경
  - 삭제
- `새 채팅창` 버튼
  - 내부적으로 `POST /api/issues` 사용

### thread 상세 화면

#### 데이터

- `GET /api/threads/{threadId}`
- SSE 이벤트 수신

#### 기능

- 채팅 보기
- 대화 타임라인 보기
- 상단 chip 필터
  - `all`
  - `prompts`
  - `responses`
  - `runs`
- 하단 입력창

#### 현재 단계

- 타임라인 렌더링은 프론트에서 `messages`를 그룹핑해도 됨
- 그러나 입력창 submit은 신규 API로 바꿔야 함

---

## 권장 구현 순서

### 1단계. 참고 문서와 구현 기준 분리

- 참고 문서: [thread-centric-dashboard-redesign.md](/Users/jazzlife/Documents/Workspaces/Products/OctOP/docs/thread-centric-dashboard-redesign.md)
- 실행 문서: 이 문서

### 2단계. 현재 API로 가능한 부분 먼저 반영

- 프로젝트별 thread 목록
- thread 상세
- 새 채팅창 생성
- 삭제
- 검색 버튼 위치 변경

### 3단계. 신규 API 최소 추가

- `PATCH /api/threads/{threadId}`
- `POST /api/threads/{threadId}/messages`

### 4단계. 상세 입력창을 진짜 이어쓰기 구조로 전환

- 현재 `handleCreateIssue()` 경로 제거
- 기존 thread 기반 append 경로로 교체

### 5단계. 스와이프 편집/삭제 완성

- rename
- delete

---

## 체크리스트

### 현재 API 사용 전환

- [ ] 프로젝트 화면 목록 데이터가 `GET /api/threads?project_id=...`를 사용한다
- [ ] thread 상세 데이터가 `GET /api/threads/{threadId}`를 사용한다
- [ ] 새 채팅창 생성이 `POST /api/issues -> POST /api/threads/start` 조합을 사용한다
- [ ] 삭제가 `DELETE /api/threads/{threadId}`를 사용한다
- [ ] queue 재정렬 UI가 있을 경우 `POST /api/threads/reorder`만 사용한다

### 신규 API 추가

- [ ] `PATCH /api/threads/{threadId}` 추가
- [ ] `POST /api/threads/{threadId}/messages` 추가
- [ ] 브리지 subject 정의 추가
- [ ] gateway endpoint 추가
- [ ] adapter handler 추가

### 어댑터

- [ ] `createQueuedIssue()`를 새 thread 생성 전용으로 고정
- [ ] `appendPromptToThread()` 구현
- [ ] 기존 thread 이어쓰기에서 `thread/start`가 다시 호출되지 않는지 확인
- [ ] 이어쓰기 후 `messages`에 user prompt가 누적되는지 확인
- [ ] 이어쓰기 후 `bridge.threads.updated` 이벤트가 발행되는지 확인

### 모바일 UX

- [ ] 프로젝트 화면 하단 입력창 제거
- [ ] thread 상세 입력창만 유지
- [ ] 검색 버튼을 헤더 우측 끝으로 이동
- [ ] 스와이프 편집으로 제목 변경 가능
- [ ] 스와이프 편집으로 삭제 가능
- [ ] 상단 chip이 thread 내부 필터로 동작
- [ ] 타임라인 보기와 채팅 보기 모두 같은 thread 데이터를 본다

### 검증

- [ ] 프로젝트 진입 후 thread 목록이 정상 조회된다
- [ ] 새 채팅창 생성 시 새 thread가 생긴다
- [ ] thread 상세에서 이어쓰기 시 새 thread가 생기지 않는다
- [ ] 제목 변경 후 목록/상세가 동시에 갱신된다
- [ ] 삭제 후 목록에서 즉시 제거된다
- [ ] 새로고침 후 thread/messages/title이 유지된다

---

## 결론

현재 시스템은 이미 `thread 조회`, `thread 상세`, `새 thread 생성`, `실행`, `삭제`, `queue 재정렬`까지는 갖추고 있습니다. 따라서 문서를 실제 구현에 맞추려면, 기존 제안처럼 `/api/projects/{projectId}/threads`나 `/api/threads/{threadId}/issues`를 먼저 만드는 방향보다 아래가 더 맞습니다.

1. 기존 `GET /api/threads`, `GET /api/threads/{threadId}`, `POST /api/issues`, `POST /api/threads/start`, `DELETE /api/threads/{threadId}`를 먼저 사용한다.
2. 부족한 부분은 `thread rename`, `thread 이어쓰기` 두 API만 최소 추가한다.
3. 모바일과 대시보드 UI를 `project > thread > conversation` 구조로 정렬한다.

이 방향이 현재 코드와 가장 충돌이 적고, 실제 제품 전환 속도도 가장 빠릅니다.
