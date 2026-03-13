# Thread Chat Redesign

## 목적

프로젝트 안에서 `Codex IDE` 스타일의 채팅창(thread) 목록을 운영하고, 각 채팅창 안에서 대화를 이어가며 작업을 수행하는 구조로 정리한다.

핵심 목표는 다음과 같다.

- 프로젝트는 여러 개의 채팅창(thread)을 가질 수 있다.
- 채팅창은 일회성 이슈 카드가 아니라, 같은 문맥을 이어가는 대화 단위다.
- 채팅 입력은 항상 채팅창 내부에서 이뤄진다.
- 새 작업을 시작하고 싶으면 새 채팅창을 만든다.
- 같은 작업을 이어가고 싶으면 기존 채팅창에 후속 프롬프트를 추가한다.

---

## 현재 구조 진단

현재 코드 기준 문제는 아래와 같다.

- `POST /api/issues`는 새 thread를 생성한다.
- 모바일 상세 화면의 입력창도 실제로는 기존 thread에 이어쓰지 않고 새 thread를 만든다.
- 즉 UI는 "이어쓰기"처럼 보이지만 실제 동작은 `1 이슈 = 1 thread` 생성이다.
- thread 제목 수정 API가 없다.
- thread 삭제는 준비 상태 계열에서만 허용되고 있으나, 모바일 UI에는 편집/삭제 플로우가 아직 부족하다.
- 상단 chip은 상태 필터처럼 보이지만, thread 내부의 메시지/턴/상태 묶음 필터로 설계되어 있지 않다.

현재 기준점 파일:

- [/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/api/Program.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/api/Program.cs)
- [/Users/jazzlife/Documents/Workspaces/Products/OctOP/services/codex-adapter/src/index.js](/Users/jazzlife/Documents/Workspaces/Products/OctOP/services/codex-adapter/src/index.js)
- [/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/mobile/src/App.jsx](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/mobile/src/App.jsx)

---

## 목표 모델

### 엔티티 의미

- `Project`
  - 작업 공간 단위
  - 여러 개의 thread를 가진다

- `Thread`
  - 하나의 대화 세션
  - 제목, 프로젝트, 메시지 목록, 실행 상태를 가진다
  - 사용자는 새 thread를 만들거나 기존 thread에 이어서 대화한다

- `Message`
  - thread 내부 대화 항목
  - 최소 `role`, `content`, `timestamp`, `kind`를 가진다

- `Turn`
  - 사용자 프롬프트 1회에 대한 실행 단위
  - user message 1개와 그에 대응하는 assistant 응답, 상태 변경, 산출을 묶는다

### 관계

- `1 Project : N Threads`
- `1 Thread : N Messages`
- `1 Thread : N Turns`
- `1 Turn : 1 User Prompt + N Assistant Outputs`

즉 최종 구조는 `1 이슈 = 1 thread`가 아니라 아래와 같아야 한다.

- 새 작업 시작: `새 thread 생성`
- 작업 이어가기: `기존 thread에 새 turn 추가`

---

## 사용자 경험 설계

### 1. 프로젝트 화면

프로젝트 화면은 "채팅창 목록"이다.

- 리스트 항목 = thread
- 항목 정보는 최소화한다
  - 제목
  - 마지막 메시지 일부
  - 마지막 갱신 시각
  - 상태 점만 간단히 표시
- 새 채팅창 버튼으로 thread를 만든다
- 검색 버튼은 헤더 우측 끝에 배치한다

### 2. 채팅창 상세 화면

채팅창 상세는 실제 대화 공간이다.

- 하단 입력창에서 프롬프트를 입력한다
- 입력 시 기존 thread에 새 turn이 추가된다
- 화면은 새 thread로 튀지 않는다
- 채팅 흐름은 user / assistant 대화를 그대로 유지한다

### 3. 채팅창 제목 편집

thread 항목은 스와이프 편집을 지원한다.

- 좌/우 스와이프 시 액션 노출
- `제목 변경`
- `삭제`

제목 변경은 인라인 입력보다 아래 방식이 안정적이다.

- 스와이프 -> `편집`
- 작은 바텀시트 또는 중앙 다이얼로그 오픈
- 제목 입력 후 저장

### 4. 채팅창 삭제

- 스와이프 -> `삭제`
- 실행 중 thread는 삭제 제한 또는 확인 경고
- 삭제 후 리스트 즉시 갱신

### 5. 상단 chip 필터

chip은 프로젝트 전체 상태 필터가 아니라 "현재 채팅창 내부의 모아보기 필터"로 재정의한다.

권장 필터:

- `all`
  - 전체 메시지/턴
- `prompts`
  - 사용자 프롬프트만
- `responses`
  - assistant 응답만
- `runs`
  - turn 시작/완료/실패 등 실행 단위 묶음
- `files`
  - diff/plan/result 등 산출 중심 요약이 가능해지면 사용

초기 구현은 아래 4개면 충분하다.

- `all`
- `prompts`
- `responses`
- `runs`

### 6. 검색

검색은 프로젝트 화면 헤더 우측 끝 아이콘 버튼으로 둔다.

- 기본 상태에서는 숨김
- 아이콘 탭 시 검색바 확장
- thread 제목 + 마지막 메시지 + 프롬프트 일부 대상 검색

---

## API 설계

### 유지할 API

- `GET /api/threads`
- `GET /api/threads/{threadId}`
- `POST /api/threads/start`
- `DELETE /api/threads/{threadId}`

### 역할을 바꿔야 하는 API

#### `POST /api/issues`

현재:

- 새 thread 생성
- 첫 prompt 저장

향후:

- 모바일 채팅 모델 기준에서는 `새 채팅창 생성 + 첫 프롬프트 전송` 용도로만 제한
- 이름도 장기적으로는 `POST /api/threads`가 더 맞다

권장 방향:

- 기존 호환성 유지: `POST /api/issues`
- 신규 정식 API 추가: `POST /api/threads`

### 신규 API

#### `POST /api/threads`

용도:

- 새 빈 채팅창 생성
- 선택적으로 첫 프롬프트까지 같이 시작 가능

예시 요청:

```json
{
  "project_id": "proj_123",
  "title": "배포 자동화 정리",
  "prompt": "필요하면 첫 메시지"
}
```

예시 응답:

```json
{
  "accepted": true,
  "thread": {
    "id": "thread_123",
    "project_id": "proj_123",
    "title": "배포 자동화 정리",
    "status": "staged"
  }
}
```

#### `POST /api/threads/{threadId}/messages`

용도:

- 기존 thread에 새 사용자 프롬프트를 추가
- 새 turn을 시작 큐에 넣음

예시 요청:

```json
{
  "prompt": "이전 작업 이어서 테스트 실패 원인까지 수정해"
}
```

예시 응답:

```json
{
  "accepted": true,
  "thread": { "id": "thread_123", "status": "queued" },
  "message": { "role": "user", "content": "이전 작업 이어서 테스트 실패 원인까지 수정해" }
}
```

#### `PATCH /api/threads/{threadId}`

용도:

- 제목 변경

예시 요청:

```json
{
  "title": "모바일 채팅창 리디자인"
}
```

#### `GET /api/threads/{threadId}/timeline`

선택 사항이지만 권장한다.

용도:

- 메시지 원문 외에 turn 단위 그룹핑된 데이터를 서버에서 제공
- 모바일에서 무거운 그룹핑 로직을 반복하지 않아도 됨

초기 단계에서는 생략 가능하다.
초기 구현은 기존 `messages`로도 충분하다.

---

## 브리지 / 어댑터 설계

### 현재 `createQueuedIssue`의 문제

- 항상 `thread/start`를 호출해 새 thread를 만든다
- 기존 thread에 prompt를 추가하는 경로가 없다

### 신규 어댑터 함수

#### `createThread(userId, payload)`

- 새 app-server thread 생성
- project 연결
- title 저장
- prompt가 있으면 첫 user message 추가
- 상태를 `staged` 또는 `queued`로 만들기

#### `appendPromptToThread(userId, payload)`

입력:

- `thread_id`
- `prompt`

동작:

- thread 소유권 확인
- user message 저장
- thread 상태를 `queued`로 전환
- queue에 등록
- 실행 시작

중요:

- 여기서는 새 `thread/start`를 호출하면 안 된다
- 기존 `threadId`를 대상으로 `turn/start`가 실행돼야 한다

#### `renameThread(userId, payload)`

- thread title만 변경
- 이벤트 발행

### 이벤트

추가 또는 명확화할 이벤트:

- `thread.created`
- `thread.renamed`
- `thread.message.created`
- `thread.deleted`
- `thread.turn.queued`

---

## 모바일 화면 설계

### 화면 구조

#### A. 프로젝트 > thread 목록

- 헤더
  - 좌측: 뒤로 또는 프로젝트명
  - 중앙: 프로젝트명
  - 우측: 검색 버튼
- 본문
  - thread 리스트
- 하단
  - `새 채팅창` 생성 버튼

#### B. thread 상세

- 헤더
  - 뒤로
  - thread 제목
  - 상태/갱신시각
- chip 필터 바
  - `all`
  - `prompts`
  - `responses`
  - `runs`
- 메시지 타임라인
- 하단 입력창
  - 현재 thread에 이어쓰기

### 리스트 스와이프 액션

thread 리스트 아이템에 대해:

- 오른쪽 스와이프: `편집`
- 왼쪽 스와이프: `삭제`

또는 한 방향 스와이프 후 두 액션 버튼 노출:

- `제목 변경`
- `삭제`

초기 구현은 라이브러리 없이도 가능하지만, 모바일 UX 품질을 위해 간단한 스와이프 상태 관리가 필요하다.

---

## 상태 설계

모바일 앱에서 필요한 상태:

- `threads`
- `selectedThreadId`
- `threadDetailsById`
- `threadFilter`
- `threadSearchOpen`
- `threadSearchQuery`
- `threadSwipeState`
- `renameDialogState`
- `deleteConfirmState`

### 중요한 원칙

- 프로젝트 화면의 입력창은 제거
- 입력창은 thread 상세에만 존재
- 상세 입력은 `create issue`가 아니라 `append prompt to current thread`

---

## 구현 순서

### 1단계. 백엔드/브리지 정리

- `POST /api/threads` 추가
- `POST /api/threads/{threadId}/messages` 추가
- `PATCH /api/threads/{threadId}` 추가
- 어댑터에 `appendPromptToThread()` 구현
- 기존 `createQueuedIssue()`는 새 thread 생성 전용으로 정리

### 2단계. 모바일 정보 구조 변경

- 프로젝트 화면을 thread 목록 전용으로 변경
- 하단 입력창 제거
- 새 채팅창 생성 액션 추가
- 헤더 우측 검색 버튼 추가

### 3단계. thread 상세 이어쓰기 연결

- 상세 입력창 submit 시 `POST /api/threads/{threadId}/messages`
- 성공 시 같은 thread 상세 유지
- 메시지 갱신

### 4단계. 편집/삭제

- 스와이프 액션 구현
- 제목 변경 다이얼로그 구현
- 삭제 확인 후 thread 삭제

### 5단계. chip 필터 정리

- 내부 메시지 필터로 재정의
- `all/prompts/responses/runs`

---

## 체크리스트

### 백엔드

- [ ] `POST /api/threads` 추가
- [ ] `POST /api/threads/{threadId}/messages` 추가
- [ ] `PATCH /api/threads/{threadId}` 추가
- [ ] 기존 `POST /api/issues`는 호환성 유지 여부 결정
- [ ] thread 삭제 시 실행 중 상태 제한 정책 확정
- [ ] thread 제목 저장/조회가 영속화되는지 확인

### 브리지 / 어댑터

- [ ] 기존 thread에 prompt 추가 함수 구현
- [ ] 기존 thread에 대해 `turn/start` 실행되도록 연결
- [ ] 새 thread 생성과 기존 thread 이어쓰기 로직 분리
- [ ] user message / assistant message 누적 저장 확인
- [ ] `bridge.threads.updated` 이벤트가 rename/delete/append에 모두 발행되는지 확인

### 모바일 UI

- [ ] 프로젝트 화면 하단 입력창 제거
- [ ] 프로젝트 화면을 thread 목록 전용으로 정리
- [ ] 헤더 우측 검색 버튼 배치
- [ ] 새 채팅창 생성 진입점 추가
- [ ] thread 상세 입력창이 기존 thread에 이어쓰기 하도록 변경
- [ ] thread 상세에서 메시지 전송 후 새 thread가 생기지 않는지 확인
- [ ] chip을 내부 필터로 전환
- [ ] 스와이프 편집 액션 구현
- [ ] 제목 변경 다이얼로그 구현
- [ ] 삭제 액션 구현

### 데이터/상태

- [ ] `selectedThreadId`가 새 thread 생성 후 정확히 이동하는지 확인
- [ ] 기존 thread 이어쓰기 후 `selectedThreadId`가 바뀌지 않는지 확인
- [ ] thread list preview가 마지막 assistant 응답으로 갱신되는지 확인
- [ ] timeline/chat 보기 모두 기존 thread 메시지를 기준으로 동작하는지 확인

### 검증

- [ ] 새 프로젝트 생성
- [ ] 새 채팅창 생성
- [ ] 첫 프롬프트 전송
- [ ] 같은 채팅창에서 두 번째 프롬프트 전송
- [ ] 새 thread가 생기지 않고 기존 thread에 누적되는지 확인
- [ ] 제목 변경 후 리스트/상세 동기화 확인
- [ ] 삭제 후 리스트/상세 상태 정리 확인
- [ ] 앱 새로고침 후 thread/messages/title 복원 확인

---

## 수용 기준

아래가 모두 만족되면 완료로 본다.

- 프로젝트 안에서 채팅창(thread)을 여러 개 생성할 수 있다.
- 채팅창 안에서 프롬프트를 보내면 같은 thread에 계속 누적된다.
- 새 작업을 시작하고 싶을 때만 새 thread를 만든다.
- thread 제목을 스와이프 편집으로 바꿀 수 있다.
- thread를 스와이프 편집에서 삭제할 수 있다.
- 프로젝트 화면의 chip은 thread 내부 필터가 아니라면 제거하거나 역할을 재정의한다.
- 검색은 프로젝트 헤더 우측 끝에 있다.
- 채팅 입력은 프로젝트 화면이 아니라 채팅창 안에만 존재한다.

---

## 권장 구현 메모

- `POST /api/issues`를 바로 없애기보다, 내부적으로는 `POST /api/threads`로 수렴시키는 편이 안전하다.
- 모바일 상세 입력창은 절대 `create issue`를 호출하면 안 된다.
- 타임라인 뷰는 UI 기능이지 데이터 모델의 주체가 아니다. 데이터 주체는 어디까지나 `thread + messages + turns`다.
- 먼저 "같은 thread 이어쓰기"를 맞추고, 그 다음 타임라인/필터/스와이프를 올리는 순서가 가장 안전하다.
