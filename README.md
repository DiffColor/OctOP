<p align="center">
  <img src="./design/icon.png" alt="OctOP icon" width="120" />
</p>

# OctOP

원격에서 프로젝트 이슈와 Codex 실행을 운영하는 플랫폼입니다.

OctOP는 브라우저 기반 Dashboard와 모바일 PWA에서 원격으로 접속해, 각 작업 머신에 붙어 있는 Bridge를 통해 Codex 실행을 제어하고 상태를 추적하는 구조를 사용합니다. 외부 사용자는 gateway만 바라보고, `codex app-server`와 Bridge는 작업 머신 또는 사설 네트워크 안쪽에 남겨 둡니다.

## 핵심 포인트

- 원격 운영
  Dashboard와 모바일 PWA에서 로그인 후 원격으로 프로젝트, 스레드, 이슈를 운영합니다.
- 로컬 실행 분리
  실제 Codex 실행은 각 작업 머신의 Bridge가 담당하고, 웹 클라이언트는 직접 `codex app-server`에 접근하지 않습니다.
- 명시적 상태 관리
  이슈 상태와 실행 상태를 분리해 추적합니다.
- 연속성 유지
  root thread, physical thread, rollover, handoff summary를 유지하며 긴 작업 흐름을 이어갑니다.
- 원격 워크스페이스 등록
  Bridge가 허용한 루트 아래 폴더를 원격에서 탐색해 프로젝트 workspace로 등록할 수 있습니다.

## 현재 구성

- `apps/dashboard`
  React 기반 운영 대시보드입니다. 프로젝트 보드, 스레드별 이슈 보드, 실시간 상태 갱신, 프로젝트 설정, instruction 편집을 제공합니다.
- `apps/mobile`
  React 기반 모바일 PWA입니다. 텔레그램형 UI로 프로젝트, 채팅, 이슈 흐름을 모바일에서 운영합니다.
- `apps/api`
  `.NET 10` gateway입니다. 인증, bridge 선택, REST API, SSE 진입점을 제공합니다.
- `services/codex-adapter`
  Node.js 기반 Bridge입니다. `codex app-server`와 붙어서 thread, issue, approval, continuity 이벤트를 관리합니다.
- `services/projection-worker`
  `.NET 10` projection worker입니다. NATS 이벤트를 RethinkDB read model로 반영합니다.
- `packages/domain`
  공통 상태값과 NATS subject 정의를 담고 있습니다.

## 원격 운영 구조

1. 사용자는 Dashboard 또는 Mobile PWA에 로그인합니다.
2. Gateway가 사용자 기준으로 연결 가능한 Bridge를 조회합니다.
3. 클라이언트는 프로젝트, 스레드, 이슈 생성 요청을 Gateway로 보냅니다.
4. Gateway는 사용자별 NATS subject로 Bridge에 명령을 전달합니다.
5. Bridge는 로컬 workspace와 `codex app-server`를 사용해 실제 작업을 수행합니다.
6. 실행 중 발생한 상태, 메시지, rollover, continuity 이벤트는 다시 NATS로 발행됩니다.
7. Projection worker가 이를 RethinkDB에 반영하고, Dashboard/Mobile은 최신 상태를 조회합니다.

즉, 원격 UI와 실제 실행 머신이 분리되어 있고, 실행 권한은 Bridge가 쥔 채로 운영자는 웹에서 흐름을 제어합니다.

## 현재 코드 기준 기능

- 로그인 후 사용자별 Bridge 조회
- Bridge별 프로젝트 목록 조회
- 원격 workspace root 조회 및 폴더 탐색
- 원격 프로젝트 생성, 수정, 삭제
- 프로젝트별 스레드 생성, 수정, 삭제
- 스레드별 이슈 생성, 수정, 삭제, 재정렬, 실행 시작
- 스레드 timeline, continuity, logical issue board 조회
- thread rollover 수동 실행 및 자동 rollover 지원
- bridge status 조회와 ping 명령 지원
- 프로젝트별 base/developer instruction 저장
- 모바일 PWA 설치 및 업데이트 흐름 지원

## 저장소 구조

```text
.
├── apps
│   ├── api
│   ├── dashboard
│   └── mobile
├── packages
│   └── domain
├── services
│   ├── codex-adapter
│   └── projection-worker
├── scripts
└── tests
```

## 실행 환경

- Node.js / npm workspaces
- .NET 10 SDK
- NATS
- RethinkDB
- `codex app-server`

## 빠른 실행

루트에서 실행합니다.

```bash
npm install
```

개발 서버 실행:

```bash
npm run dev:dashboard
npm run dev:mobile
npm run dev:api
npm run dev:bridge
npm run dev:projector
```

런처 사용:

```bash
npm run app-server:start
npm run bridge:start
npm run local-agent:start
```

직접 실행:

```bash
./scripts/run-app-server.sh
./scripts/run-bridge.sh
./scripts/run-local-agent.sh
```

Windows:

```bat
scripts\run-app-server.cmd
scripts\run-bridge.cmd
scripts\run-local-agent.cmd
```

Bridge 또는 local agent 실행 시 인자를 넘길 수 있습니다.

```bash
npm run bridge:start -- -id <loginId> -name "My Mac"
npm run local-agent:start -- -id <loginId> -name "My Mac"
```

## 환경 변수

기본 예제는 [`./.env.example`](./.env.example)에 있습니다.

중요 항목:

- `OCTOP_NATS_URL`
  Gateway, Bridge, Projection worker가 공통으로 사용하는 NATS 주소입니다.
- `OCTOP_LICENSEHUB_API_BASE_URL`
  로그인 검증에 사용하는 LicenseHub API 주소입니다.
- `OCTOP_GATEWAY_HOST`
- `OCTOP_GATEWAY_PORT`
- `OCTOP_DASHBOARD_ORIGIN`
  허용할 Dashboard/Mobile 웹 origin 목록입니다.
- `OCTOP_BRIDGE_HOST`
- `OCTOP_BRIDGE_PORT`
- `OCTOP_BRIDGE_TOKEN`
- `OCTOP_BRIDGE_MODE`
- `OCTOP_APP_SERVER_MODE`
- `OCTOP_APP_SERVER_WS_URL`
- `OCTOP_APP_SERVER_COMMAND`
- `OCTOP_CODEX_MODEL`
- `OCTOP_CODEX_REASONING_EFFORT`
- `OCTOP_CODEX_APPROVAL_POLICY`
- `OCTOP_CODEX_SANDBOX`
- `OCTOP_THREAD_CONTEXT_ROLLOVER_ENABLED`
- `OCTOP_THREAD_CONTEXT_ROLLOVER_THRESHOLD_PERCENT`
- `OCTOP_RUNNING_ISSUE_WATCHDOG_INTERVAL_MS`
- `OCTOP_RUNNING_ISSUE_STALE_MS`
- `OCTOP_RETHINKDB_HOST`
- `OCTOP_RETHINKDB_PORT`
- `OCTOP_RETHINKDB_DB`
- `OCTOP_RETHINKDB_USER`
- `OCTOP_RETHINKDB_PASSWORD`
- `VITE_API_BASE_URL`
  Dashboard/Mobile이 붙을 gateway 주소입니다.

## Bridge 동작 방식

- `.env.local` 이후 `.env` 순서로 환경 변수를 읽습니다.
- Bridge ID는 기본적으로 호스트명을 사용하며, 상태 파일은 `~/.octop` 아래에 저장합니다.
- 프로젝트 목록은 `~/.octop/<bridge-id>-projects.json`에 저장됩니다.
- 스레드 상태는 `~/.octop/<bridge-id>-threads.json`에 저장됩니다.
- 허용 workspace root는 현재 작업 디렉터리와 `OCTOP_WORKSPACE_ROOTS`를 기준으로 계산됩니다.
- 필요하면 Bridge가 `codex app-server`를 자식 프로세스로 함께 실행합니다.
- Codex thread 시작 시 기본 모델은 `OCTOP_CODEX_MODEL`으로 제어하며, 기본값은 `gpt-5.4`입니다.
- reasoning effort는 `OCTOP_CODEX_REASONING_EFFORT`로 제어하며, `none`, `low`, `medium`, `high`, `xhigh`를 사용할 수 있습니다.
- approval policy와 sandbox 정책은 Bridge 환경 변수로 제어됩니다.

## 배포 전제

- Dashboard와 Mobile은 공개 웹 호스트에 올릴 수 있습니다.
- Gateway는 공개 진입점 역할을 합니다.
- Bridge와 `codex app-server`는 작업 머신 또는 사설 네트워크에 둡니다.
- Projection worker는 NATS와 RethinkDB에 접근 가능한 위치에서 실행합니다.

권장 경계는 아래와 같습니다.

- 외부 공개
  Dashboard, Mobile, Gateway
- 내부 또는 작업 머신
  Bridge, `codex app-server`
- 백엔드 인프라
  NATS, RethinkDB

실제 배포 주소, origin, 내부 인프라 엔드포인트는 저장소 문서에 적지 않고 환경 변수로만 주입하는 것을 권장합니다.

## 테스트

현재 통합 테스트는 Bridge와 app-server 경계 중심입니다.

```bash
npm run test:integration:bridge-rollover
```

검증 범위:

- root thread 생성
- issue 생성과 실행
- threshold 기반 자동 rollover
- handoff summary와 timeline 연속성
- root thread delete cascade
- closed/deleted 상태의 late event drop

## 문서

- [이슈 보드 아키텍처](./docs/issue-board-architecture.md)
- [thread 중심 dashboard 재설계](./docs/thread-centric-dashboard-redesign.md)
- [thread chat 재설계](./docs/thread-chat-redesign.md)
- [rollover 구현 체크리스트](./docs/root-thread-rollover-implementation-checklist.md)
