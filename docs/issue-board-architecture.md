# OctOP 이슈 보드 아키텍처

## 1. 목표

OctOP는 프로젝트별 이슈 보드를 중심으로 작업을 운영하는 시스템입니다.

이 시스템은 아래를 만족해야 합니다.
- 이슈를 프로젝트 단위로 등록할 수 있어야 합니다.
- 이슈 상태를 명시적으로 변경하고 이력을 남겨야 합니다.
- 이슈별로 Codex 작업을 등록할 수 있어야 합니다.
- 작업 진행 상황, 승인 요청, 실패, 완료를 실시간으로 추적할 수 있어야 합니다.
- Codex 실행 상태와 이슈 보드 상태를 분리해서 관리해야 합니다.

## 2. 설계 원칙

- 보드의 기준은 `이슈 상태`입니다.
- Codex는 이슈를 처리하는 실행 엔진입니다.
- 한 이슈는 여러 실행을 가질 수 있습니다.
- 실행 실패는 곧바로 이슈 종료를 의미하지 않습니다.
- 승인 요청은 실행 레벨에서 관리하고, 이슈 상태 전이는 별도 정책으로 판단합니다.
- 외부 클라이언트는 `codex app-server`에 직접 접근하지 않습니다.
- 모든 외부 요청은 REST API 서버를 통과합니다.
- 실제 서버 주소, 토큰, 내부망 엔드포인트는 저장소에 고정하지 않고 배포 환경 변수로만 주입합니다.

## 3. 시스템 구성

### 3.1 구성 요소

- `apps/dashboard`
  - React 기반 운영 대시보드
  - 프로젝트 보드, 이슈 상세, 실행 타임라인, 승인 큐 제공
- `apps/api`
  - `.NET 10` 기반 REST API와 SSE 제공
  - 인증, 권한, 상태 전이 검증, 명령 수집 담당
- `services/codex-adapter`
  - Node.js 기반 로컬 브리지
  - `codex app-server`와 JSON-RPC 통신
  - thread, turn, approval 이벤트를 내부 이벤트로 변환
- `services/projection-worker`
  - `.NET 10` Worker Service
  - NATS 이벤트를 구독
  - RethinkDB의 read model과 activity feed 갱신
- `NATS + JetStream`
  - 명령 전달
  - 이벤트 fan-out
  - 재처리 및 내구성 제공
- `RethinkDB`
  - 프로젝트, 이슈, 실행, 승인, 활동 로그 저장
  - 실시간 보드 조회용 read model 제공

### 3.2 데이터 흐름

1. 사용자가 대시보드에서 이슈를 등록합니다.
2. API가 이슈를 저장하고 `issue.event.created`를 발행합니다.
3. 사용자가 이슈에서 실행을 등록합니다.
4. API가 `execution.command.dispatch`를 발행합니다.
5. `codex-adapter`가 명령을 소비하고 `codex app-server`에 `thread/start`, `turn/start`를 요청합니다.
6. Codex에서 발생한 이벤트를 `codex.event.*`로 변환합니다.
7. `projection-worker`가 이벤트를 RethinkDB에 반영합니다.
8. Dashboard는 SSE 또는 RethinkDB 기반 갱신으로 보드와 상세 화면을 최신 상태로 유지합니다.

### 3.3 배포 경계

- `apps/dashboard`
  - 공개망 또는 사내 접근 가능한 웹 호스트에 배포
- `apps/api`
  - 공개 API 또는 VPN 뒤의 gateway로 배포
- `services/codex-adapter`
  - `codex app-server`와 같은 사설 네트워크 또는 같은 머신에서만 실행
  - macOS, Windows 로컬 환경에서 동작하는 Node 에이전트로 유지
- `codex app-server`
  - 외부 비공개
- `NATS`
  - 내부망 전용

즉, 원격 사용자는 Dashboard와 gateway만 접근하고, bridge와 app-server는 숨겨진 내부 서비스로 유지합니다.

## 4. 도메인 모델

### 4.1 Project

- `id`
- `key`
- `name`
- `description`
- `workflow_id`
- `created_at`
- `updated_at`

### 4.2 Issue

- `id`
- `project_id`
- `number`
- `title`
- `description`
- `priority`
- `assignee_id`
- `reporter_id`
- `workflow_status`
- `codex_policy_id`
- `current_execution_id`
- `created_at`
- `updated_at`

### 4.3 IssueExecution

- `id`
- `issue_id`
- `project_id`
- `thread_id`
- `turn_id`
- `execution_status`
- `requested_by`
- `workspace_path`
- `approval_policy`
- `prompt`
- `started_at`
- `ended_at`
- `last_error`

### 4.4 ApprovalRequest

- `id`
- `issue_id`
- `execution_id`
- `thread_id`
- `turn_id`
- `approval_type`
- `title`
- `payload`
- `status`
- `requested_at`
- `resolved_at`
- `resolved_by`

### 4.5 IssueEvent

- `id`
- `issue_id`
- `project_id`
- `type`
- `actor`
- `payload`
- `created_at`

## 5. 상태 설계

### 5.1 이슈 워크플로 상태

- `backlog`
- `ready`
- `in_progress`
- `blocked`
- `in_review`
- `done`
- `archived`

### 5.2 실행 상태

- `queued`
- `dispatching`
- `running`
- `awaiting_approval`
- `paused`
- `failed`
- `cancelled`
- `completed`

### 5.3 상태 전이 규칙

허용 전이:
- `backlog -> ready`
- `ready -> in_progress`
- `in_progress -> blocked`
- `in_progress -> in_review`
- `blocked -> ready`
- `in_review -> in_progress`
- `in_review -> done`
- `done -> archived`

자동 전이 기본 정책:
- 실행 생성 시 이슈가 `ready`면 `in_progress`로 이동
- 승인 대기 시 이슈 상태는 유지
- 실행 완료 시 이슈를 `in_review`로 이동
- 실행 실패 시 이슈를 `blocked`로 이동

프로젝트별로 자동 전이 정책은 다르게 둘 수 있어야 합니다.

## 6. NATS subject 설계

### 6.1 명령

- `project.command.create`
- `issue.command.create`
- `issue.command.update`
- `issue.command.transition`
- `execution.command.dispatch`
- `execution.command.cancel`
- `approval.command.resolve`

### 6.2 도메인 이벤트

- `project.event.created`
- `issue.event.created`
- `issue.event.updated`
- `issue.event.transitioned`
- `execution.event.queued`
- `execution.event.running`
- `execution.event.awaiting_approval`
- `execution.event.completed`
- `execution.event.failed`
- `approval.event.requested`
- `approval.event.resolved`

### 6.3 Codex 이벤트

- `codex.event.thread.started`
- `codex.event.thread.updated`
- `codex.event.turn.started`
- `codex.event.turn.plan_updated`
- `codex.event.turn.diff_updated`
- `codex.event.turn.completed`
- `codex.event.item.started`
- `codex.event.item.updated`
- `codex.event.item.completed`
- `codex.event.approval.requested`

## 7. RethinkDB 테이블 설계

### 7.1 테이블

- `projects`
- `workflows`
- `issues`
- `issue_executions`
- `approval_requests`
- `issue_events`
- `issue_board_views`

### 7.2 인덱스

- `issues.project_id`
- `issues.project_status`
- `issues.project_updated`
- `issue_executions.issue_id`
- `issue_executions.project_status`
- `approval_requests.project_status`
- `issue_events.issue_id`

복합 인덱스 권장 키:
- `issues: [project_id, workflow_status, updated_at]`
- `issue_executions: [project_id, execution_status, started_at]`
- `approval_requests: [project_id, status, requested_at]`

## 8. REST API 설계

### 8.1 프로젝트

- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:projectId`

### 8.2 이슈

- `GET /api/projects/:projectId/issues`
- `POST /api/projects/:projectId/issues`
- `GET /api/issues/:issueId`
- `PATCH /api/issues/:issueId`
- `POST /api/issues/:issueId/transitions`

### 8.3 실행

- `POST /api/issues/:issueId/executions`
- `GET /api/issues/:issueId/executions`
- `GET /api/executions/:executionId`
- `POST /api/executions/:executionId/cancel`

### 8.4 승인

- `GET /api/approvals`
- `POST /api/approvals/:approvalId/resolve`

### 8.5 스트림

- `GET /api/projects/:projectId/stream`
- `GET /api/issues/:issueId/stream`

## 9. React Dashboard 설계

### 9.1 프로젝트 보드

- 상태별 컬럼 기반 칸반 보드
- 컬럼별 이슈 개수와 최근 변경 시간 표시
- 필터: 담당자, 우선순위, 상태, 승인 대기 여부

### 9.2 이슈 상세

- 기본 정보
- 상태 전이 버튼
- 실행 목록
- 최신 실행 상태 배지
- Codex thread/turn 타임라인
- diff 요약
- 활동 로그

### 9.3 승인 큐

- 프로젝트별 승인 요청 목록
- 승인 유형별 필터
- 승인/거절 액션
- 관련 이슈와 실행으로 이동

### 9.4 운영 설정

- 프로젝트 워크플로 상태 정의
- 자동 전이 정책
- Codex 기본 실행 정책

## 10. 보안 및 운영 규칙

- `codex app-server`는 내부 네트워크 또는 same-host에서만 접근합니다.
- 외부 사용자는 REST API만 호출합니다.
- 프로젝트별 workspace path를 명시적으로 저장합니다.
- 실행 생성 시 정책에 따라 sandbox, approval, 허용 명령 범위를 결정합니다.
- 모든 상태 전이와 승인 처리에는 감사 로그를 남깁니다.
- 실제 배포에서는 `.env.example`을 템플릿으로만 쓰고, 실값은 원격 서버의 비밀 저장소 또는 배포 환경 변수로 관리합니다.
- bridge 토큰과 내부 NATS 주소는 Dashboard에 전달하지 않습니다.

## 11. 구현 체크리스트

### Phase 1. 저장소와 공통 기반

- [x] 루트 워크스페이스 구성
- [ ] 공통 TypeScript 설정 추가
- [ ] 환경 변수 정책 정리
- [x] 공통 도메인 타입 패키지 분리

### Phase 2. API 서버

- [x] 프로젝트 CRUD API 추가
- [x] 이슈 CRUD API 추가
- [x] 상태 전이 검증기 구현
- [x] 실행 등록 API 추가
- [ ] 승인 처리 API 추가
- [ ] SSE 스트림 엔드포인트 추가

### Phase 3. Codex 연동

- [x] 로컬 브릿지 서버 기본 구조 구현
- [ ] `codex app-server` 세션 관리기 구현
- [ ] `thread/start`, `turn/start` 호출 래퍼 구현
- [x] mock Codex 이벤트 수신기 구현
- [ ] approval 요청/응답 브리지 구현
- [x] execution 상태 동기화 mock 흐름 구현

### Phase 4. 이벤트와 프로젝션

- [x] NATS 연결 모듈 구현
- [ ] JetStream stream/consumer 정책 정의
- [ ] projector 구현
- [ ] issue activity feed 생성기 구현
- [ ] board read model 최적화

### Phase 5. Dashboard

- [x] 프로젝트 목록 화면
- [ ] 프로젝트 칸반 보드 화면
- [ ] 이슈 상세 화면
- [x] 실행 타임라인 화면
- [ ] 승인 큐 화면
- [x] 실시간 상태 반영 연결

### Phase 6. 운영 준비

- [ ] 인증/권한 정책 반영
- [ ] 감사 로그 정리
- [ ] 장애 시 재처리 정책 구현
- [ ] 상태 전이 운영 문서 작성
- [ ] 배포 구조와 관측성 구성

## 12. 즉시 시작할 구현 단위

첫 구현 단위는 아래 순서가 적절합니다.

1. 루트 워크스페이스 초기화
2. API 서버 기본 엔트리와 라우트 틀 추가
3. Dashboard 기본 레이아웃 추가
4. 공통 도메인 타입 정의
5. 프로젝트/이슈/실행에 대한 메모리 기반 mock 흐름 연결

이 순서로 시작하면 실제 저장소 구조가 빨리 안정되고, 이후에 NATS와 RethinkDB를 연결해도 구조가 흔들리지 않습니다.

## 13. 현재 구현 상태

현재 저장소에는 아래가 반영되어 있습니다.
- 루트 workspace와 서비스 디렉터리 구조 추가
- 이슈/실행 상태 상수와 전이 규칙 추가
- gateway 서버 추가
- 로컬 브릿지 서버 추가
- React dashboard 추가
- 사용자별 NATS subject 설계와 request/reply 흐름 추가
- mock thread 진행 이벤트와 SSE 스트림 연결 추가
- 원격 배포용 `.env.example` 분리 구성 추가

아직 미구현입니다.
- RethinkDB 영속화
- 실제 `codex app-server` transport 연결
- 승인 큐
- 프로젝트 칸반 보드
- issue read model
