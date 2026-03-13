# Thread Chat Redesign

## 목적

모바일 앱을 `project -> thread -> issue` 구조로 정렬합니다.

- 프로젝트 화면은 thread 목록만 보여줍니다.
- thread 화면은 실제 대화창처럼 동작합니다.
- 같은 thread 안에서 새 프롬프트를 보내면 새 issue가 생성되고 같은 thread 큐에서 순차 실행됩니다.
- thread 제목은 수정 가능해야 하고, thread 자체는 삭제 가능해야 합니다.
- 상단 chip은 thread 내부 대화 모아보기 필터로 동작해야 합니다.

---

## 현재 실제 API

현재 코드 기준 실제 구현 API는 아래와 같습니다.

### 프로젝트 / thread

- `GET /api/projects/{projectId}/threads`
- `POST /api/projects/{projectId}/threads`
- `PATCH /api/threads/{threadId}`
- `DELETE /api/threads/{threadId}`

### thread / issue

- `GET /api/threads/{threadId}/issues`
- `POST /api/threads/{threadId}/issues`
- `POST /api/threads/{threadId}/issues/start`
- `POST /api/threads/{threadId}/issues/reorder`

### issue detail

- `GET /api/issues/{issueId}`
- `DELETE /api/issues/{issueId}`

### 공통

- `GET /api/projects`
- `GET /api/bridge/status`
- `GET /api/events`

기준 파일:

- [/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/api/Program.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/api/Program.cs)
- [/Users/jazzlife/Documents/Workspaces/Products/OctOP/services/codex-adapter/src/index.js](/Users/jazzlife/Documents/Workspaces/Products/OctOP/services/codex-adapter/src/index.js)
- [/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/mobile/src/App.jsx](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/mobile/src/App.jsx)

---

## 현재 구조 해석

현재 서버의 실제 모델은 다음입니다.

- project 안에 여러 thread가 있습니다.
- thread는 채팅창 컨테이너입니다.
- 사용자가 thread 안에서 프롬프트를 보내면 새 issue가 생성됩니다.
- issue는 해당 thread의 실행 큐에 들어가고 순차 실행됩니다.
- thread 상세의 대화 타임라인은 `thread 안의 issue들 + 각 issue 메시지들`을 합쳐서 렌더링해야 합니다.

즉 현재 목표 UX를 만족시키기 위해 새 API를 억지로 만드는 것이 아니라, 이미 있는 `thread + issue` API를 정확히 써야 합니다.

---

## UX 매핑

### 프로젝트 화면

- 데이터 소스: `GET /api/projects/{projectId}/threads`
- 헤더 우측 끝: 검색 버튼
- 본문: thread 리스트
- 하단: `새 채팅창`

여기서는 직접 채팅을 입력하지 않습니다.

### 새 채팅창

새 채팅창은 아래 순서로 만듭니다.

1. `POST /api/projects/{projectId}/threads`
2. `POST /api/threads/{threadId}/issues`
3. `POST /api/threads/{threadId}/issues/start`

즉 thread를 먼저 만들고, 첫 프롬프트는 그 thread 안의 첫 issue로 시작합니다.

### 기존 thread 이어쓰기

기존 thread 안에서 프롬프트를 보내면 아래 순서로 처리합니다.

1. `POST /api/threads/{threadId}/issues`
2. `POST /api/threads/{threadId}/issues/start`

즉 같은 thread 안에 새 issue를 추가해서 이어갑니다.

### thread 제목 변경 / 삭제

- 제목 변경: `PATCH /api/threads/{threadId}` with `{ "name": "..." }`
- 삭제: `DELETE /api/threads/{threadId}`

### thread 상세 렌더링

thread 상세는 아래를 합쳐서 만듭니다.

1. `GET /api/threads/{threadId}/issues`
2. 각 issue에 대해 `GET /api/issues/{issueId}`

즉 thread 메시지 전용 단일 API가 아니라, issue detail들을 합쳐서 채팅 타임라인을 구성합니다.

---

## 이벤트 동기화

실시간 갱신은 아래 이벤트를 기준으로 맞춥니다.

- `bridge.projectThreads.updated`
- `bridge.threadIssues.updated`
- `thread.created`
- `thread.updated`
- `thread.deleted`
- `issue.created`

모바일은 프로젝트 화면에서 `bridge.projectThreads.updated`를 반영하고, 현재 열려 있는 thread에서는 `bridge.threadIssues.updated`가 오면 issue 목록과 메시지를 다시 불러옵니다.

---

## 구현 체크리스트

### API 사용 정렬

- [x] 프로젝트 화면 목록 데이터가 `GET /api/projects/{projectId}/threads`를 사용한다
- [x] 새 채팅창 생성이 `POST /api/projects/{projectId}/threads -> POST /api/threads/{threadId}/issues -> POST /api/threads/{threadId}/issues/start` 조합을 사용한다
- [x] 기존 thread 이어쓰기가 `POST /api/threads/{threadId}/issues -> POST /api/threads/{threadId}/issues/start` 조합을 사용한다
- [x] thread 제목 변경이 `PATCH /api/threads/{threadId}`를 사용한다
- [x] thread 삭제가 `DELETE /api/threads/{threadId}`를 사용한다
- [x] thread 상세 대화가 `GET /api/threads/{threadId}/issues + GET /api/issues/{issueId}` 조합을 사용한다

### 모바일 UX

- [x] 프로젝트 화면 하단 입력 제거
- [x] 검색 버튼을 헤더 우측 끝으로 이동
- [x] thread 상세 입력창만 유지
- [x] 프로젝트 화면에서 `새 채팅창` 버튼으로 빈 thread 화면에 진입 가능
- [x] 상세 입력 후 같은 thread 안에 issue가 누적되는 구조로 전환
- [x] 스와이프 편집으로 thread 제목 변경 가능
- [x] 스와이프 삭제로 thread 삭제 가능
- [x] chip이 thread 내부 필터로 동작
- [x] thread 상세에서 채팅 / 타임라인 모드를 유지

### 동기화 / 보완

- [x] `bridge.projectThreads.updated` 이벤트를 프로젝트 목록에 반영
- [x] `bridge.threadIssues.updated` 이벤트를 현재 열린 thread 상세에 반영
- [x] bridge subject 소스와 gateway 사용 이름 정합성 확인
- [x] adapter 내부 중복 helper 선언 제거

### 검증

- [x] `npm run build:mobile` 통과
- [x] `dotnet build apps/api/OctOP.Gateway.csproj` 통과
- [x] `node --check services/codex-adapter/src/index.js` 통과
- [ ] 프로젝트 선택 후 thread 목록이 실제 bridge 데이터로 정상 조회되는지 수동 확인
- [ ] 새 채팅창 생성 후 첫 issue가 자동 queued/running 되는지 수동 확인
- [ ] 기존 thread에서 후속 프롬프트 전송 시 같은 thread 안에 새 issue로 누적되는지 수동 확인
- [ ] 제목 변경 후 목록/상세가 함께 갱신되는지 수동 확인
- [ ] 삭제 후 목록에서 즉시 제거되는지 수동 확인
- [ ] 새로고침 후 thread / issue / 메시지 상태가 유지되는지 수동 확인

---

## 결론

현재 목표를 만족시키는 올바른 해석은 `thread가 채팅창이고, issue가 thread 안에서 순차 실행되는 작업 단위`라는 점입니다.

따라서 모바일 구현의 핵심은:

1. 프로젝트 화면은 thread 목록만 보여준다.
2. 채팅 입력은 thread 안에서만 한다.
3. 입력할 때마다 같은 thread 안에 새 issue를 만들고 바로 실행한다.
4. thread 상세는 issue 목록과 issue detail 메시지를 합쳐 채팅 타임라인처럼 보여준다.
