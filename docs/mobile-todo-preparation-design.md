# Mobile ToDo Preparation 설계

## 목적

이 문서는 현재 OctOP 코드 기준으로 모바일웹에 `ToDo` 고정 chip과 preparation 전용 대화 흐름을 추가하기 위한 설계를 정리합니다.

목표는 다음과 같습니다.

- 등록된 프로젝트 외에 `ToDo` 고정 chip을 제공한다.
- `ToDo` 안에서는 Codex로 보내지 않는 preparation 대화를 저장하고 관리한다.
- `ToDo` 안의 대화는 채팅 목록 단위로 관리한다.
- 각 preparation 대화 메시지는 편집/삭제 가능해야 한다.
- 각 preparation 대화 메시지는 기존 thread 또는 신규 thread로 이동시켜 staged issue로 넘길 수 있어야 한다.

---

## 현재 코드 기준 사실

### 모바일 현재 구조

모바일은 현재 `project -> thread -> issue/messages` 구조입니다.

- 프로젝트 chip 렌더: [apps/mobile/src/App.jsx](../apps/mobile/src/App.jsx)
- 선택된 프로젝트 기준 thread 필터링: [apps/mobile/src/App.jsx](../apps/mobile/src/App.jsx)
- thread 상세는 `GET /api/threads/{threadId}/issues` 후 각 issue detail을 합성해 채팅처럼 렌더링: [apps/mobile/src/App.jsx](../apps/mobile/src/App.jsx)

즉 현재 모바일은:

- 프로젝트를 선택하면
- 해당 프로젝트의 thread 목록이 보이고
- thread를 열면
- 그 안의 issue/message가 채팅 타임라인으로 보이는 구조입니다.

### 현재 API 실제 범위

현재 공개 API는 project/thread/issue 중심입니다.

- `GET /api/projects`
- `GET /api/projects/{projectId}/threads`
- `POST /api/projects/{projectId}/threads`
- `PATCH /api/threads/{threadId}`
- `DELETE /api/threads/{threadId}`
- `GET /api/threads/{threadId}/issues`
- `POST /api/threads/{threadId}/issues`
- `POST /api/threads/{threadId}/issues/start`
- `PATCH /api/issues/{issueId}`
- `DELETE /api/issues/{issueId}`

기준 파일:

- [apps/api/Program.cs](../apps/api/Program.cs)
- [services/codex-adapter/src/index.js](../services/codex-adapter/src/index.js)
- [apps/mobile/src/App.jsx](../apps/mobile/src/App.jsx)

### 왜 기존 thread/issue를 그대로 재활용하면 안 되는가

현재 `issue` 생성은 반드시 `thread_id`가 필요합니다. 즉 "프로젝트가 아직 정해지지 않은 preparation"을 그대로 `issue`로 저장하려면 가짜 project 또는 가짜 thread가 필요해집니다.

이 방식은 다음 문제를 만듭니다.

- 프로젝트 개수와 선택 모델이 오염된다.
- 프로젝트 삭제/권한/동기화 경로에 예외가 생긴다.
- "ToDo는 프로젝트 밖 preparation"이라는 요구와 충돌한다.

따라서 `ToDo`는 기존 project/thread와 별도의 도메인으로 두는 것이 맞습니다.

---

## 결론

`ToDo`는 프로젝트가 아니라 `project 밖 preparation inbox`입니다.

다만 사용성은 현재 모바일 구조와 맞추기 위해 다음 2단계 모델로 설계합니다.

- `ToDo` chip
- `ToDo chat` 목록
- 각 `ToDo chat` 안의 `prep message`

즉 현재 `project -> thread -> issue/messages`와 유사하게,

- `ToDo -> todo chat -> prep messages`

구조를 만듭니다.

차이는 다음입니다.

- project thread는 Codex 실행용
- todo chat은 preparation 저장용
- prep message는 Codex에 보내지 않음
- 이동 시점에만 실제 thread의 staged issue로 변환됨

---

## 도메인 모델

## 1. Todo Scope

모바일 선택 상태를 `selectedProjectId` 단일 값이 아니라 scope로 확장합니다.

권장 구조:

```json
{
  "kind": "todo" | "project",
  "id": "todo" | "project-1"
}
```

의미:

- `kind: "project"`이면 현재 동작 유지
- `kind: "todo"`이면 프로젝트 목록 대신 todo chat 목록 표시

## 2. Todo Chat

`ToDo` 안의 채팅 목록 단위입니다.

권장 필드:

```json
{
  "id": "todo-chat-1",
  "bridge_id": "bridge-1",
  "login_id": "user-1",
  "title": "랜딩 개편 아이디어",
  "last_message": "CTA를 더 강하게 가져가자",
  "message_count": 4,
  "created_at": "2026-03-15T10:00:00.000Z",
  "updated_at": "2026-03-15T11:20:00.000Z",
  "deleted_at": null
}
```

규칙:

- `ToDo` chip 아래에 보이는 목록의 기본 단위
- rename/delete 가능
- 마지막 메시지와 업데이트 시간 표시

## 3. Todo Message

실제 preparation 아이템입니다.

권장 필드:

```json
{
  "id": "todo-msg-1",
  "todo_chat_id": "todo-chat-1",
  "bridge_id": "bridge-1",
  "login_id": "user-1",
  "content": "빠른 메모 입력과 초안 모드를 분리해보자",
  "created_at": "2026-03-15T11:00:00.000Z",
  "updated_at": "2026-03-15T11:10:00.000Z",
  "status": "open",
  "moved_to_project_id": null,
  "moved_to_thread_id": null,
  "moved_to_issue_id": null,
  "deleted_at": null
}
```

상태:

- `open`: 아직 ToDo 안에 남아 있음
- `moved`: 프로젝트 thread로 넘겨짐
- `deleted`: 삭제됨

권장 동작:

- 기본 목록에는 `open`만 표시
- `moved`는 선택적으로 히스토리 보기에서만 표시 가능

---

## UX 설계

## 1. 상단 chip

현재 project chip row 앞에 고정 `ToDo` chip을 추가합니다.

순서:

1. `ToDo`
2. 등록된 프로젝트들

스타일 규칙:

- `ToDo`도 프로젝트 chip과 같은 계열의 pill UI
- 선택 시 현재 프로젝트 chip과 같은 active style
- 검색은 현재처럼 현재 scope에만 적용

## 2. ToDo 목록 화면

`ToDo` 선택 시 본문은 project thread 목록 대신 `todo chat` 목록이 보입니다.

표시 항목:

- chat title
- last message preview
- updated time
- 필요 시 message count

하단 CTA:

- `새 ToDo 채팅`

현재 `새 채팅창` 버튼과 동일한 위치/규칙으로 두되 label만 바뀝니다.

## 3. ToDo chat 상세

현재 `ThreadDetail`과 유사한 상세 화면이 필요하지만, 실행 상태와 assistant 응답은 없습니다.

필요 요소:

- 헤더: todo chat 제목
- 본문: prep message 버블 목록
- 하단 composer: 새 prep message 저장

메시지 규칙:

- 모두 user-side bubble 성격
- Codex 전송 없음
- 저장만 수행

## 4. 메시지 액션

각 prep message는 탭 또는 롱프레스로 액션시트를 엽니다.

액션:

- 편집
- 삭제
- 프로젝트-쓰레드로 이동

편집:

- 기존 content 수정

삭제:

- soft delete

이동:

- project 선택
- 기존 thread / 신규 thread 선택
- 완료 후 staged issue 생성

## 5. 이동 플로우

### 기존 thread로 이동

1. 프로젝트 선택
2. 해당 프로젝트의 기존 thread 선택
3. 대상 thread에 staged issue 생성
4. `issues/start`는 호출하지 않음
5. prep message를 `moved` 처리

### 신규 thread로 이동

1. 프로젝트 선택
2. 신규 thread 생성 선택
3. thread title 입력
4. project 아래 새 thread 생성
5. 생성된 thread에 staged issue 생성
6. `issues/start`는 호출하지 않음
7. prep message를 `moved` 처리

이유:

- 사용자 요구는 "할일/아이디어 준비 단계"
- Codex 실행 전 단계이므로 `staged`가 맞음
- 대시보드의 Preparation column과 의미를 맞출 수 있음

---

## 서버 설계

## 1. 저장 위치

권장 저장 위치는 bridge persisted state 내부입니다.

이유:

- project/thread/issue도 bridge state에 있음
- bridge/user별 분리가 이미 존재함
- mobile/dashboard/api gateway 구조와 맞음

권장 새 상태:

- `todoChatsById`
- `todoChatIdsByUserId`
- `todoMessagesById`
- `todoMessageIdsByChatId`

## 2. API 설계

### Todo Chat

- `GET /api/todo/chats`
- `POST /api/todo/chats`
- `PATCH /api/todo/chats/{chatId}`
- `DELETE /api/todo/chats/{chatId}`

### Todo Message

- `GET /api/todo/chats/{chatId}/messages`
- `POST /api/todo/chats/{chatId}/messages`
- `PATCH /api/todo/messages/{messageId}`
- `DELETE /api/todo/messages/{messageId}`
- `POST /api/todo/messages/{messageId}/transfer`

### transfer payload

```json
{
  "project_id": "project-1",
  "thread_mode": "existing",
  "thread_id": "thread-1",
  "thread_name": null
}
```

또는

```json
{
  "project_id": "project-1",
  "thread_mode": "new",
  "thread_id": null,
  "thread_name": "랜딩 리뉴얼"
}
```

### transfer response

```json
{
  "accepted": true,
  "todo_message": { "...": "moved state" },
  "thread": { "...": "target thread" },
  "issue": { "...": "created staged issue" }
}
```

---

## 브리지 구현 규칙

## 1. transfer 처리

`todo message -> issue` 변환 시:

- 기존 thread면 `ThreadIssueCreate`
- 신규 thread면 `ProjectThreadCreate` 후 `ThreadIssueCreate`
- issue status는 `staged`
- `ThreadIssuesStart` 호출 금지

즉 transfer는 "실행"이 아니라 "Preparation으로 넘기기"입니다.

## 2. issue 생성 payload

현재 `POST /api/threads/{threadId}/issues`는 `title`, `prompt`를 받습니다.

transfer 시 권장 매핑:

- `title`: `createThreadTitleFromPrompt(content)` 또는 첫 N자 요약
- `prompt`: prep message `content`

추가 메타가 필요하면 추후 `source: "todo_transfer"` 같은 provenance를 붙일 수 있지만, 1차 구현에서는 없어도 됩니다.

## 3. 삭제 정책

- todo chat 삭제 시 연관 todo message도 soft delete
- moved message는 삭제 시 history만 지워지고 생성된 issue는 유지
- project/thread 삭제는 todo domain에 영향 없음

---

## 모바일 상태 설계

권장 새 상태:

- `selectedScope`
- `todoChats`
- `selectedTodoChatId`
- `todoChatDetails`
- `todoBusy`
- `todoEditorState`
- `todoTransferState`

현재 상태와 매핑:

- 기존 `projects`, `threads`, `threadDetails`는 그대로 유지
- `selectedProjectId` 단독 모델은 점진적으로 `selectedScope`로 감싼다

예시:

```js
const [selectedScope, setSelectedScope] = useState({ kind: "project", id: "" });
const selectedProjectId = selectedScope.kind === "project" ? selectedScope.id : "";
const isTodoScope = selectedScope.kind === "todo";
```

이 방식이면 기존 코드를 한 번에 다 갈아엎지 않고 점진적으로 옮길 수 있습니다.

---

## UI 컴포넌트 제안

새 컴포넌트:

- `TodoChatListItem`
- `TodoChatRenameDialog`
- `TodoMessageActionSheet`
- `TodoMessageEditorDialog`
- `TodoTransferSheet`
- `TodoChatDetail`

재사용 가능한 것:

- `BottomSheet`
- 일부 header/button 스타일
- composer 스타일 일부

재사용 비권장:

- 현재 `ThreadDetail` 전체

이유:

- `ThreadDetail`은 assistant/system/run timeline/status chip에 묶여 있음
- ToDo는 user-only message와 편집/이동 액션 중심이라 성격이 다름

---

## 구현 단계

## 1단계. 서버/브리지 도메인 추가

- bridge persisted state에 todo chat/message 저장 구조 추가
- CRUD helper 추가
- transfer helper 추가
- gateway API route 추가

## 2단계. 모바일 scope 모델 확장

- `selectedScope` 도입
- `ToDo` 고정 chip 추가
- todo scope일 때 목록 렌더 분기

## 3단계. ToDo chat 목록 구현

- todo chat list fetch
- 새 todo chat 생성
- rename/delete

## 4단계. ToDo chat 상세 구현

- todo message list fetch
- 새 message 저장
- message edit/delete

## 5단계. transfer flow 구현

- 프로젝트 선택
- 기존/new thread 분기
- transfer API 연결
- moved 후 리스트 반영

## 6단계. 검증

- 모바일 수동/Playwright 검증
- API 동작 검증
- staged issue가 대시보드 Preparation에 반영되는지 확인

---

## 상세 체크리스트

## A. 브리지

- [ ] persisted state에 `todoChatsById`, `todoMessagesById` 추가
- [ ] user 기준 todo chat index 추가
- [ ] chat 기준 message index 추가
- [ ] todo chat create/list/update/delete helper 추가
- [ ] todo message create/list/update/delete helper 추가
- [ ] todo message transfer helper 추가
- [ ] transfer 시 신규 thread 생성 분기 구현
- [ ] transfer 시 기존 thread 분기 구현
- [ ] transfer issue를 `staged` 상태로 생성
- [ ] transfer에서 `issues/start` 호출하지 않도록 보장
- [ ] moved/deleted 상태 persistence 반영
- [ ] state save/load 호환성 확인

## B. API Gateway

- [ ] `GET /api/todo/chats` 추가
- [ ] `POST /api/todo/chats` 추가
- [ ] `PATCH /api/todo/chats/{chatId}` 추가
- [ ] `DELETE /api/todo/chats/{chatId}` 추가
- [ ] `GET /api/todo/chats/{chatId}/messages` 추가
- [ ] `POST /api/todo/chats/{chatId}/messages` 추가
- [ ] `PATCH /api/todo/messages/{messageId}` 추가
- [ ] `DELETE /api/todo/messages/{messageId}` 추가
- [ ] `POST /api/todo/messages/{messageId}/transfer` 추가
- [ ] login_id / bridge_id 인증 규칙 기존 API와 동일하게 맞춤

## C. 모바일 상태 모델

- [ ] `selectedScope` 도입
- [ ] `ToDo` 고정 chip 추가
- [ ] project chip row와 ToDo chip 공존 구조로 변경
- [ ] todo scope 선택 시 project thread 필터와 분리
- [ ] `todoChats` 상태 추가
- [ ] `selectedTodoChatId` 상태 추가
- [ ] `todoChatDetails` 상태 추가
- [ ] todo CRUD 전용 busy state 추가

## D. 모바일 목록 화면

- [ ] todo scope에서 todo chat 목록 렌더
- [ ] project scope에서 기존 thread 목록 유지
- [ ] 검색이 현재 scope에만 적용되도록 분기
- [ ] 하단 CTA를 scope별로 `새 채팅창` / `새 ToDo 채팅`으로 분기

## E. ToDo chat 상세

- [ ] `TodoChatDetail` 컴포넌트 추가
- [ ] todo message 목록 렌더
- [ ] composer 입력 시 message 저장만 수행
- [ ] Codex 실행 경로와 완전히 분리
- [ ] 빈 상태 메시지 추가
- [ ] header/back 동선 기존 thread detail과 일관성 유지

## F. 메시지 액션

- [ ] message 탭 또는 롱프레스 액션시트 추가
- [ ] 편집 다이얼로그 추가
- [ ] 삭제 확인 추가
- [ ] 이동 액션 진입 추가

## G. 이동 플로우

- [ ] 프로젝트 선택 step 추가
- [ ] 기존 thread / 신규 thread 선택 step 추가
- [ ] 기존 thread picker 추가
- [ ] 신규 thread 이름 입력 step 추가
- [ ] transfer 성공 후 moved 상태 반영
- [ ] transfer 성공 후 대상 thread refresh
- [ ] transfer 실패 시 prep message 유지

## H. 일관성 / 운영

- [ ] ToDo는 project 삭제 영향 없이 유지
- [ ] bridge 변경 시 todo chats/messages도 bridge 기준으로 분리
- [ ] logout 시 todo 상태 초기화
- [ ] events 기반 실시간 반영 필요 여부 결정
- [ ] moved message 표시 정책 결정

## I. 검증

- [ ] `npm --prefix apps/mobile run build`
- [ ] `dotnet build apps/api/OctOP.Gateway.csproj`
- [ ] `node --check services/codex-adapter/src/index.js`
- [ ] ToDo chip 노출 수동 확인
- [ ] todo chat 생성/rename/delete 수동 확인
- [ ] todo message 생성/edit/delete 수동 확인
- [ ] 기존 thread로 transfer 수동 확인
- [ ] 신규 thread로 transfer 수동 확인
- [ ] transfer 후 대시보드 Preparation 반영 수동 확인
- [ ] 앱 재시작 후 todo data 유지 확인

---

## 보류 결정 사항

아래는 구현 전에 확정이 필요하지만, 기본값을 정하고 들어갈 수 있는 항목입니다.

### 1. moved message 표시 정책

권장 기본값:

- 기본 목록에서는 숨김
- 추후 `Moved 보기` 필터 추가 가능

### 2. todo chat 자동 제목

권장 기본값:

- 첫 message 기반 제목 자동 생성
- 사용자가 rename 가능

### 3. edit/delete 인터랙션

권장 기본값:

- 탭 시 액션시트
- 목록/상세 모두 동일 규칙

---

## 최종 요약

이 요구사항의 핵심은 `ToDo를 project/thread의 변형으로 만들지 않는 것`입니다.

안정적인 구조는 다음입니다.

- `ToDo`는 프로젝트 밖 고정 scope
- `ToDo` 안에는 `todo chat 목록`
- 각 `todo chat` 안에는 `prep message`
- prep message는 저장/편집/삭제 가능
- 필요할 때만 기존/new thread로 이동되어 staged issue가 됨

이 구조가 현재 모바일의 project/thread UX와 가장 자연스럽게 연결되고, 대시보드 Preparation 의미와도 충돌하지 않습니다.
