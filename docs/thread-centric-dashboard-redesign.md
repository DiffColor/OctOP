# Thread-Centric Kanban Redesign

## 목적

OctOP를 `프로젝트 > thread > 이슈 카드` 구조로 재설계합니다.

목표는 다음과 같습니다.

- 좌측 패널은 `Codex IDE`처럼 프로젝트와 thread를 계층적으로 보여줍니다.
- 우측 메인 영역은 "선택된 thread의 작업 보드"만 보여줍니다.
- 이슈 카드는 독립 thread를 만들지 않고, 현재 선택된 thread 안에서 이어지는 작업 단위로 동작합니다.
- 프로젝트와 thread는 아이콘으로 시각적으로 분리합니다.
- thread는 우클릭 컨텍스트 메뉴로 `rename`, `delete`를 지원합니다.

---

## 현재 구조 진단

현재 코드 기준 핵심 문제는 아래와 같습니다.

- 좌측 패널은 사실상 `프로젝트 목록`만 관리하고 있고, thread는 1급 엔터티가 아닙니다.
- 이슈 생성 시 [services/codex-adapter/src/index.js](/Users/jazzlife/Documents/Workspaces/Products/OctOP/services/codex-adapter/src/index.js)에서 `thread/start`를 호출해 새 thread를 생성합니다.
- 즉 현재는 실질적으로 `1 이슈 = 1 thread` 구조입니다.
- 우측 칸반은 `selectedProjectId` 기준으로 필터링된 카드만 보여주며, "선택된 thread의 보드"가 아닙니다.
- thread rename/delete는 프로젝트처럼 표면화된 UI가 없습니다.
- 프로젝트와 thread를 구분하는 시각적 정보 구조가 부족합니다.

이 구조에서는 다음 문제가 발생합니다.

- 같은 작업 문맥을 이어가고 싶어도 계속 새 thread가 생깁니다.
- 보드는 프로젝트 기준인데, 실제 Codex 대화 단위는 thread라서 UI와 실행 컨텍스트가 어긋납니다.
- 사용자는 "프로젝트 안에서 여러 작업 대화 흐름"을 관리할 수 없습니다.

---

## 목표 모델

### 핵심 엔터티

- `Project`
  - 로컬 workspace와 대응하는 작업 공간
  - 여러 개의 thread를 가질 수 있음

- `Thread`
  - 하나의 장기 작업 대화 세션
  - Codex app-server의 thread와 1:1로 매핑
  - 프로젝트 하위에 소속됨

- `Issue Card`
  - thread 안에서 수행할 작업 단위
  - `Preparation`, `To Do`, `In Progress`, `Review`, `Done` 상태를 가짐
  - prompt와 결과 요약, queue position을 가짐

### 관계

- `1 Project : N Threads`
- `1 Thread : N Issue Cards`
- `1 Thread : N Turns`

즉 이 구조에서는:

- 새 작업 흐름 시작: `새 thread 생성`
- 같은 흐름 이어가기: `기존 thread 선택 후 새 이슈 카드 등록`
- Codex 실행: `선택된 thread에 turn 추가`

---

## 정보 구조

### 좌측 패널

좌측 패널은 다음 2단 구조입니다.

1. 프로젝트 목록
2. 선택된 프로젝트 하위의 thread 목록

표현 방식:

- 프로젝트 행
  - 폴더 아이콘
  - 프로젝트 이름
  - thread 수 또는 요약 배지
- thread 행
  - 메시지/터미널/번개 계열 아이콘
  - thread 이름
  - 마지막 갱신 시각 또는 마지막 카드 수

중요:

- 프로젝트 하위에 이슈 카드를 직접 노출하지 않습니다.
- 좌측 패널은 `프로젝트와 thread 탐색`만 담당합니다.

### 우측 메인 보드

우측 보드는 "현재 선택된 thread의 칸반보드"입니다.

표시 규칙:

- 프로젝트를 선택하면 해당 프로젝트의 기본 thread 또는 마지막 선택 thread를 자동 선택
- thread를 클릭하면 우측 보드가 즉시 해당 thread의 카드로 갱신
- 보드 헤더에는 현재 `프로젝트명 / thread명` 표시

---

## UX 설계

### 1. 프로젝트 / thread 계층

좌측 패널 구조:

- 프로젝트
  - thread A
  - thread B
  - thread C

프로젝트와 thread 구분 방법:

- 프로젝트 아이콘: `folder`
- thread 아이콘: `message-square` 또는 `terminal-square`

현재 선택 상태:

- 프로젝트 선택: 배경 강조
- thread 선택: 더 강한 강조

### 2. thread 선택 동작

- thread 클릭 시 우측 칸반의 데이터 소스를 해당 thread로 변경
- 선택된 thread가 없으면 보드는 empty state
- 선택된 thread가 바뀌어도 프로젝트는 유지

### 3. thread 우클릭 메뉴

데스크톱 웹 기준 thread 항목 우클릭 시 컨텍스트 메뉴를 엽니다.

메뉴 항목:

- `Rename`
- `Delete`

동작 규칙:

- `Rename`
  - 인라인 입력 또는 작은 팝오버 입력
  - 저장 시 즉시 반영
- `Delete`
  - 확인 다이얼로그
  - 실행 중인 thread가 있으면 삭제 차단

### 4. 이슈 등록 규칙

중요한 변경점:

- 칸반에 등록하는 이슈는 `새 thread를 만들지 않음`
- 현재 선택된 thread에 속한 카드로만 생성

즉:

- 프로젝트만 선택되고 thread가 선택되지 않으면 이슈 등록 비활성화
- 새 이슈 등록 시 payload에는 `thread_id`가 반드시 포함
- 실행 시 `turn/start`는 선택된 thread에 추가

### 5. 칸반 컬럼

컬럼은 아래를 유지합니다.

- `Preparation`
- `To Do`
- `In Progress`
- `Review`
- `Done`

표시 규칙:

- `Review`는 카드가 있을 때만 표시
- `Done` 카드는 매우 슬림하게 유지
- 완료 카드는 더블클릭 시 대화/작업 상세 모달 표시

---

## 백엔드 모델 변경

### 신규 또는 재정의 엔터티

#### `project_threads`

- `id`
- `project_id`
- `name`
- `description`
- `bridge_id`
- `login_id`
- `codex_thread_id`
- `created_at`
- `updated_at`

권장:

- 초기에는 `id == codex_thread_id`로 단순화 가능

#### `thread_issue_cards`

- `id`
- `project_id`
- `thread_id`
- `title`
- `prompt`
- `status`
- `queue_position`
- `progress`
- `last_message`
- `created_at`
- `updated_at`

### 기존 모델 변경

- 기존의 `threadStateById`는 thread 메타 저장소로 유지
- 이슈 카드 상태는 별도 저장소로 분리하는 것이 맞음
- 현재 `threadStateById`에 카드 상태를 함께 넣고 있는 방식은 장기적으로 분리 필요

---

## API 설계

### 프로젝트 하위 thread 조회

#### `GET /api/projects/{projectId}/threads`

응답:

```json
{
  "threads": [
    {
      "id": "thread_1",
      "project_id": "proj_1",
      "name": "Deploy cleanup",
      "updated_at": "2026-03-13T10:00:00.000Z"
    }
  ]
}
```

### thread 생성

#### `POST /api/projects/{projectId}/threads`

용도:

- 새 작업 흐름을 위한 빈 thread 생성
- 필요하면 첫 prompt 포함 가능

### thread 이름 변경

#### `PATCH /api/threads/{threadId}`

입력:

```json
{
  "name": "New thread name"
}
```

### thread 삭제

#### `DELETE /api/threads/{threadId}`

규칙:

- 실행 중이면 삭제 차단
- 삭제 시 하위 카드도 같이 제거

### thread 기준 카드 조회

#### `GET /api/threads/{threadId}/issues`

용도:

- 우측 칸반보드 데이터 소스

### thread 기준 카드 생성

#### `POST /api/threads/{threadId}/issues`

입력:

```json
{
  "title": "Optional title",
  "prompt": "Continue the selected thread with this task"
}
```

규칙:

- title이 비어 있으면 prompt 앞부분으로 자동 생성
- 새 Codex thread 생성 금지

### thread 기준 카드 실행

#### `POST /api/threads/{threadId}/issues/start`

용도:

- 선택된 카드들을 `Preparation -> To Do` 이동
- queue 정렬 후 순차 실행
- 실제 실행은 선택된 thread에 `turn/start` 추가

---

## 브리지 / 어댑터 설계

현재 [services/codex-adapter/src/index.js](/Users/jazzlife/Documents/Workspaces/Products/OctOP/services/codex-adapter/src/index.js)는 `createQueuedIssue()`에서 무조건 `thread/start`를 호출합니다.

이 부분을 다음처럼 분리해야 합니다.

### 1. `createProjectThread(userId, payload)`

역할:

- 프로젝트 하위 새 thread 생성
- app-server `thread/start` 호출
- thread 메타 저장

### 2. `createIssueCard(userId, payload)`

입력:

- `thread_id`
- `project_id`
- `title`
- `prompt`

역할:

- 기존 선택 thread 하위에 카드 생성
- 아직 `turn/start`는 하지 않음
- 상태는 `staged`

### 3. `startIssueCards(userId, payload)`

역할:

- 카드들을 `queued`로 이동
- 선택된 thread에 대해 `turn/start`를 순차적으로 추가

중요:

- 여기서 `thread/start`를 다시 호출하면 안 됩니다.
- 이미 존재하는 `threadId`로만 실행해야 합니다.

### 4. `renameThread(userId, payload)`

역할:

- thread 이름 변경
- `bridge.projectThreads.updated` 발행

### 5. `deleteThread(userId, payload)`

역할:

- thread 삭제
- 하위 카드 삭제
- 실행 중 thread 차단

---

## RethinkDB / Projection 설계

중앙 projection에는 최소 아래가 필요합니다.

- `projects`
- `project_threads`
- `thread_issue_cards`
- `event_log`

조회 기준:

- 좌측 프로젝트 선택: `projects`
- 좌측 thread 리스트: `project_threads by project_id`
- 우측 칸반: `thread_issue_cards by thread_id`

중요:

- 새로고침 시 stale project-wide thread 목록으로 보드를 그리면 안 됩니다.
- 우측 칸반은 반드시 `selectedThreadId`를 기준으로 읽어야 합니다.

---

## 프론트엔드 설계

### 좌측 패널

#### 프로젝트 섹션

- 프로젝트 행 좌측: 폴더 아이콘
- 더블클릭: 이름 변경
- 삭제 버튼 유지 가능

#### thread 섹션

- 선택된 프로젝트 바로 아래에 thread 리스트 표시
- thread 행 좌측: thread 아이콘
- 우클릭: 컨텍스트 메뉴

### 우측 보드

- 헤더:
  - `Project / Thread`
  - 새 이슈 버튼
- 본문:
  - 선택된 thread의 칸반 카드만 표시

### 컨텍스트 메뉴

구현 방식:

- custom context menu
- 메뉴 상태:
  - `open`
  - `x`, `y`
  - `threadId`

닫힘 조건:

- 바깥 클릭
- Esc
- 항목 선택 후

### 이슈 등록 모달

변경 사항:

- 프로젝트 선택 제거
- 현재 선택 thread 표시만 유지
- submit 시 `thread_id` 포함

---

## 구현 단계

### 1단계. 데이터 모델 분리

- `project_threads` 정의
- `thread_issue_cards` 정의
- 기존 `1 이슈 = 1 thread` 경로 제거 준비

### 2단계. bridge API 추가

- thread list by project
- thread create
- thread rename
- thread delete
- issue card create under thread
- issue card list by thread

### 3단계. gateway API 추가

- `GET /api/projects/{projectId}/threads`
- `POST /api/projects/{projectId}/threads`
- `PATCH /api/threads/{threadId}`
- `DELETE /api/threads/{threadId}`
- `GET /api/threads/{threadId}/issues`
- `POST /api/threads/{threadId}/issues`

### 4단계. 좌측 패널 개편

- 프로젝트 아래 thread 렌더링
- 아이콘 분리
- 선택 상태 분리

### 5단계. 우측 보드 기준 변경

- `selectedProjectId` 중심에서 `selectedThreadId` 중심으로 변경
- thread 선택 시 칸반 갱신

### 6단계. 컨텍스트 메뉴

- 우클릭 `rename/delete`
- rename 입력
- delete confirm

### 7단계. 이슈 등록 경로 변경

- 현재 선택 thread에 카드 추가
- 기존 thread에 이어서 실행

---

## 구현 체크리스트

### 데이터 모델

- [x] `project_threads` 테이블 정의
- [x] `thread_issue_cards` 테이블 정의
- [x] project-thread-card 관계가 명확히 저장되는지 확인

### bridge / adapter

- [x] 프로젝트별 thread 조회 함수 추가
- [x] thread 생성 함수 추가
- [x] thread 이름 변경 함수 추가
- [x] thread 삭제 함수 추가
- [x] 기존 thread에 카드 추가 함수 구현
- [x] 카드 실행 시 기존 `threadId`에 `turn/start`가 들어가는지 확인
- [x] `thread.start`가 이슈 생성 시 다시 호출되지 않도록 차단
- [x] 로컬 bridge HTTP `ping` 경로도 thread 중심 경로로 정렬

### gateway

- [x] 프로젝트 하위 thread 조회 API 추가
- [x] thread create API 추가
- [x] thread rename API 추가
- [x] thread delete API 추가
- [x] thread 하위 issue list API 추가
- [x] thread 하위 issue create API 추가

### projection / DB

- [x] `project_threads` projection 반영
- [x] `thread_issue_cards` projection 반영
- [x] `selectedThreadId` 기준 조회 API 준비
- [x] 새로고침 후 thread/card 상태 복원 확인
- [x] 새 이벤트명 `bridge.projectThreads.updated`, `bridge.threadIssues.updated` 기준으로 projection 정렬

### desktop dashboard

- [x] 좌측 프로젝트 아이콘 추가
- [x] 좌측 thread 아이콘 추가
- [x] 선택된 프로젝트 아래에 thread 목록 렌더링
- [x] thread 클릭 시 우측 칸반이 해당 thread로 바뀌는지 확인
- [x] 프로젝트와 thread의 시각적 계층이 명확한지 확인
- [x] thread 우클릭 메뉴 구현
- [x] `Rename` 동작 구현
- [x] `Delete` 동작 구현
- [x] 새 이슈 등록 시 현재 thread에 추가되는지 확인
- [x] 프로젝트만 선택되고 thread가 없을 때 이슈 등록 차단 또는 안내 처리

### 실행 로직

- [x] Preparation -> To Do -> Running 순차 실행이 thread 기준으로 동작하는지 확인
- [x] 같은 thread에 여러 카드가 누적 실행되는지 확인
- [x] 새 이슈 등록 후 새 thread가 생기지 않는지 확인
- [x] thread 삭제 시 실행 중 작업 차단 규칙 확인

### UX 검증

- [x] 프로젝트 선택
- [x] thread 생성
- [x] thread 선택
- [x] 해당 thread 칸반 렌더링 확인
- [x] 이슈 등록
- [x] 같은 thread에 이어서 실행
- [x] thread rename
- [x] thread delete
- [x] 새로고침 후 프로젝트/thread/card 복원

### 추가 보완 기록

- [x] 전체 thread 스냅샷 수신 시 대시보드 thread 목록이 중복되지 않도록 보정
- [x] thread 목록/issue 목록의 라이브 이벤트와 초기 로드 기준을 동일한 thread 중심 모델로 정렬

---

## 수용 기준

다음이 모두 만족되면 완료입니다.

- 프로젝트 하단에 해당 프로젝트의 thread 목록이 보인다.
- thread를 클릭하면 우측 칸반보드가 해당 thread 기준으로 갱신된다.
- thread 우클릭 시 `rename`, `delete` 메뉴가 뜬다.
- 새 이슈는 새 thread를 만들지 않고 현재 선택된 thread에 추가된다.
- 좌측 아이콘만 봐도 프로젝트와 thread를 구분할 수 있다.
- 새로고침 후에도 선택한 프로젝트 / thread / 카드 상태가 일관되게 복원된다.

---

## 구현 메모

- 이 구조는 현재의 `프로젝트 중심 카드 보드`에서 `thread 중심 작업 보드`로 기준을 바꾸는 작업입니다.
- 가장 먼저 바꿔야 하는 것은 UI가 아니라 데이터 모델과 bridge 실행 경로입니다.
- 프론트만 먼저 바꾸면 결국 `1 이슈 = 1 thread` 구조를 가리는 수준에서 끝나므로, 반드시 backend와 bridge를 같이 바꿔야 합니다.
