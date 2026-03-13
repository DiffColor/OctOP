# Thread Chat Redesign

## 목적

프로젝트 화면을 `thread 목록`, thread 화면을 `대화 중심 작업 공간`으로 재정의합니다.

이 문서는 현재 코드에 실제 구현된 API를 기준으로 작성합니다. 즉, 이미 있는 API는 그대로 쓰고, 정말 필요한 부분만 최소 신규 API로 추가하는 방향을 기준으로 합니다.

핵심 목표는 다음과 같습니다.

- 프로젝트는 여러 개의 채팅창(thread)을 가진다.
- 새 작업을 시작할 때만 새 thread를 만든다.
- 같은 작업을 이어갈 때는 기존 thread 안에서 계속 대화한다.
- 채팅 입력은 thread 상세 화면 안에서만 한다.
- thread 제목은 편집 가능해야 한다.
- thread는 삭제 가능해야 한다.
- 상단 chip은 thread 내부 메시지/턴 필터로 동작해야 한다.

---

## 현재 구현된 API

현재 코드 기준으로 이미 구현되어 있는 API는 아래와 같습니다.

### 조회

- `GET /api/threads`
  - `project_id` 쿼리 지원
  - 프로젝트 기준 thread 목록 조회

- `GET /api/threads/{threadId}`
  - 선택된 thread의 메타 정보와 messages 조회

- `GET /api/bridge/status`
  - bridge 상태 조회

- `GET /api/events`
  - thread/status/messages 갱신용 SSE

### 생성 / 실행

- `POST /api/issues`
  - 현재는 새 thread 생성 + 첫 prompt 저장

- `POST /api/threads/start`
  - staged thread를 queued/running으로 이동

- `POST /api/threads/reorder`
  - queued thread 순서 재정렬

### 삭제

- `DELETE /api/threads/{threadId}`
  - 삭제 가능한 상태의 thread 삭제

기준 파일:

- [/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/api/Program.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/api/Program.cs)
- [/Users/jazzlife/Documents/Workspaces/Products/OctOP/services/codex-adapter/src/index.js](/Users/jazzlife/Documents/Workspaces/Products/OctOP/services/codex-adapter/src/index.js)
- [/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/mobile/src/App.jsx](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/mobile/src/App.jsx)

---

## 현재 구조 진단

현재 구조에서 중요한 점은 아래와 같습니다.

- `POST /api/issues`는 새 thread를 만듭니다.
- 따라서 지금은 사실상 `1 이슈 = 1 thread`입니다.
- 모바일 thread 상세 입력창도 이어쓰기처럼 보이지만, 실제로는 `POST /api/issues`를 타면 새 thread를 만들게 됩니다.
- 즉 UI와 실행 구조가 어긋나 있습니다.

현재 구조를 짧게 정리하면:

- 프로젝트 화면: thread 목록과 작업 생성 UI가 섞여 있음
- thread 상세 화면: 대화처럼 보이지만 실제 후속 입력은 기존 thread를 잇지 못함
- 삭제는 가능하지만 제목 변경 API는 없음

---

## 목표 UX

### 1. 프로젝트 화면

프로젝트 화면은 `thread 목록`입니다.

- 데이터 소스: `GET /api/threads?project_id={projectId}`
- 헤더 우측 끝: 검색 버튼
- 본문: thread 리스트
- 하단: `새 채팅창` 생성 버튼

이 화면에서는 채팅 입력을 하지 않습니다.

### 2. thread 상세 화면

thread 상세는 실제 대화 공간입니다.

- 데이터 소스: `GET /api/threads/{threadId}`
- 실시간 갱신: `GET /api/events`
- 하단 입력창에서 프롬프트를 보냅니다
- 목표 동작은 `기존 thread 이어쓰기`입니다

### 3. thread 편집

thread 리스트 아이템은 스와이프 편집을 지원합니다.

- `제목 변경`
- `삭제`

### 4. 상단 chip

chip은 프로젝트 전체 상태 필터가 아니라, 현재 thread 내부의 모아보기 필터입니다.

권장 초기 세트:

- `all`
- `prompts`
- `responses`
- `runs`

---

## 현재 API를 그대로 쓰는 방식

### 프로젝트별 thread 목록

기존에 별도 `GET /api/projects/{projectId}/threads`를 만드는 대신 현재는 아래를 그대로 씁니다.

#### 사용 API

`GET /api/threads?project_id={projectId}`

#### 프론트 규칙

- 프로젝트 선택 시 이 API 호출
- 응답의 `threads`를 그대로 목록 렌더링에 사용
- `selectedThreadId`는 현재 프로젝트 목록 안에서 유지

### thread 상세 조회

#### 사용 API

`GET /api/threads/{threadId}`

#### 프론트 규칙

- thread 선택 시 상세 조회
- 응답의 `thread`, `messages`를 채팅/타임라인 렌더링의 단일 소스로 사용

### 새 채팅창 생성

현재 구현에는 `POST /api/threads`가 없습니다.

따라서 새 채팅창 생성은 당분간 아래 조합을 씁니다.

#### 사용 API

1. `POST /api/issues`
2. `POST /api/threads/start`

#### 의미 재정의

이 조합을 UI에서 다음 의미로 사용합니다.

- `새 채팅창 생성`
- 선택적으로 첫 prompt를 함께 시작

즉 버튼/레이블은 `새 이슈`가 아니라 `새 채팅창` 또는 `새 thread`가 더 맞습니다.

### thread 삭제

#### 사용 API

`DELETE /api/threads/{threadId}`

#### 현재 제약

삭제 가능 상태:

- `staged`
- `queued`
- `idle`
- `awaiting_input`
- `failed`

실행 중 thread는 현재 구조상 삭제 차단입니다.

### queue 순서 변경

#### 사용 API

`POST /api/threads/reorder`

#### 의미

이 API는 thread 목록 정렬이 아니라 `실행 대기 queue 정렬`입니다.

따라서 이것을 리스트 정렬용으로 재사용하면 안 되고, queued thread 순서 조정에만 써야 합니다.

---

## 최소 신규 API

이 문서의 UX를 만족시키려면 아래 두 API는 최소 추가가 필요합니다.

### 1. 기존 thread 이어쓰기

#### 필요 API

`POST /api/threads/{threadId}/messages`

#### 필요한 이유

현재 상세 입력창은 기존 thread에 쓰는 것처럼 보이지만, 실제로는 새 thread 생성 경로를 타게 됩니다.

목표는 아래여야 합니다.

- 기존 `thread_id`에 user message 추가
- 같은 thread에 새 turn 실행
- 화면은 같은 thread 상세에 그대로 머묾

#### 최소 요청 예시

```json
{
  "prompt": "이전 작업 이어서 테스트 실패 원인까지 수정해"
}
```

### 2. thread 제목 변경

#### 필요 API

`PATCH /api/threads/{threadId}`

#### 최소 요청 예시

```json
{
  "title": "모바일 채팅 입력 구조 정리"
}
```

---

## 브리지 / 어댑터 정렬

현재 어댑터에는 이미 아래 함수가 있습니다.

- `createQueuedIssue(userId, payload)`
- `startQueuedThreads(userId, payload)`
- `reorderQueuedThreads(userId, payload)`
- `deleteThread(userId, payload)`
- `getThreadDetail(userId, threadId)`

이 의미를 아래처럼 고정해야 합니다.

### `createQueuedIssue(userId, payload)`

- 새 thread 생성 전용
- 내부적으로 `thread/start`를 호출

### `appendPromptToThread(userId, payload)`

신규 추가 필요.

- 기존 `thread_id`에 user prompt 누적
- 새 thread 생성 금지
- 같은 thread에서 turn 실행

중요:

- 여기서 다시 `thread/start`를 호출하면 안 됩니다.
- 새 thread 생성과 기존 thread 이어쓰기는 함수 레벨에서 분리돼야 합니다.

### `renameThread(userId, payload)`

신규 추가 필요.

- title 변경
- `bridge.threads.updated` 발행

---

## 모바일 화면 설계

### 프로젝트 화면

- 헤더
  - 좌측: 프로젝트 정보
  - 우측 끝: 검색 버튼
- 본문
  - thread 리스트
- 하단
  - `새 채팅창` 버튼

### thread 상세 화면

- 헤더
  - 뒤로
  - thread 제목
  - 상태
- chip 필터
  - `all`
  - `prompts`
  - `responses`
  - `runs`
- 본문
  - 채팅 / 타임라인
- 하단
  - 현재 thread에 이어쓰기 입력창

### 스와이프 액션

thread 리스트 아이템에서:

- 스와이프 -> `편집`
- 스와이프 -> `삭제`

편집은 작은 다이얼로그 또는 시트로 처리합니다.

---

## 구현 순서

### 1단계. 현재 API로 가능한 화면부터 정리

- 프로젝트 화면을 thread 목록 중심으로 전환
- 헤더 검색 버튼 위치 조정
- 새 채팅창 생성 동선을 `POST /api/issues -> POST /api/threads/start`로 명확화
- thread 상세를 `GET /api/threads/{threadId}` 기반으로 정리

### 2단계. 신규 API 최소 추가

- `PATCH /api/threads/{threadId}`
- `POST /api/threads/{threadId}/messages`

### 3단계. 상세 입력창 교체

- 현재 `create issue` 흐름 제거
- 기존 thread 이어쓰기 API로 교체

### 4단계. 스와이프 편집/삭제 완성

- 제목 변경
- 삭제

---

## 체크리스트

### 현재 API 사용 전환

- [ ] 프로젝트 화면 목록 데이터가 `GET /api/threads?project_id=...`를 사용한다
- [ ] thread 상세가 `GET /api/threads/{threadId}`를 사용한다
- [ ] 새 채팅창 생성이 `POST /api/issues -> POST /api/threads/start` 조합을 사용한다
- [ ] 삭제가 `DELETE /api/threads/{threadId}`를 사용한다
- [ ] queue 정렬 UI가 있을 경우 `POST /api/threads/reorder`만 사용한다

### 신규 API

- [ ] `PATCH /api/threads/{threadId}` 추가
- [ ] `POST /api/threads/{threadId}/messages` 추가
- [ ] gateway endpoint 추가
- [ ] bridge subject 추가
- [ ] adapter handler 추가

### 모바일 UX

- [ ] 프로젝트 화면 하단 입력 제거
- [ ] 검색 버튼을 헤더 우측 끝으로 이동
- [ ] thread 상세 입력창만 유지
- [ ] 상세 입력 후 새 thread가 생기지 않는다
- [ ] 스와이프 편집으로 제목 변경 가능
- [ ] 스와이프 편집으로 삭제 가능
- [ ] chip이 thread 내부 필터로 동작

### 검증

- [ ] 프로젝트 선택 후 thread 목록이 정상 조회된다
- [ ] 새 채팅창 생성 시 새 thread가 생긴다
- [ ] 기존 thread에서 후속 prompt 전송 시 같은 thread에 누적된다
- [ ] 제목 변경 후 목록/상세가 함께 갱신된다
- [ ] 삭제 후 목록에서 즉시 제거된다
- [ ] 새로고침 후 thread/messages/title이 유지된다

---

## 결론

이 문서의 핵심은 "지금 있는 API부터 정확히 쓰고, 정말 부족한 부분만 최소 신규 API로 메운다"입니다.

즉 우선순위는 아래와 같습니다.

1. `GET /api/threads`, `GET /api/threads/{threadId}`, `POST /api/issues`, `POST /api/threads/start`, `DELETE /api/threads/{threadId}`를 중심으로 화면 구조를 바로잡는다.
2. 그 다음 `thread rename`, `thread 이어쓰기` 두 API만 추가한다.
3. UI를 `project > thread > conversation` 구조로 완전히 정렬한다.
