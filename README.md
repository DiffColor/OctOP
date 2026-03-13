# OctOP

프로젝트별 이슈 등록, 처리, 추적을 위한 운영 대시보드입니다.

핵심 구성 요소:
- `apps/dashboard`: React 기반 운영 UI
- `apps/api`: `.NET 10` 기반 외부 진입용 REST/SSE API
- `services/codex-adapter`: Node.js 기반 `codex app-server` 브리지
- `services/projection-worker`: `.NET 10` 기반 NATS -> RethinkDB projection worker

문서:
- 상세 설계: `docs/issue-board-architecture.md`

초기 목표:
- 프로젝트별 이슈 보드 제공
- 이슈별 Codex 실행 등록
- 실행 상태, 승인 요청, 결과 추적
- Symphony처럼 명시적인 상태 전이 관리

1차 구현 목표:
- `services/codex-adapter`: 로컬 브릿지 서버
- `apps/api`: Dashboard gateway
- `apps/dashboard`: React 기반 상태 확인 화면
- `.env.example`: 원격 배포용 서버 정보 분리

배포 원칙:
- `codex app-server`와 브릿지는 외부에 직접 노출하지 않습니다.
- Dashboard는 gateway만 바라봅니다.
- NATS, bridge, app-server 주소와 토큰은 코드에 넣지 않고 `.env`로만 주입합니다.
- `OCTOP_DASHBOARD_ORIGIN`은 쉼표로 여러 도메인을 넣을 수 있습니다. 예: `https://octop.pages.dev,https://octop.ilycode.app`
- 저장소에는 예제 파일만 두고 실제 `.env`는 원격 서버에서 따로 관리합니다.

현재 배포 전제:
- Dashboard는 Cloudflare Pages에서 서비스합니다.
- 계정 인증은 `licensehub.ilycode.app` API를 사용합니다.
- NATS는 `ilysrv.ddns.net:4222` 외부 서버를 사용합니다.
- Projection 저장소는 `rethinkdb.ilycode.app` 외부 RethinkDB를 사용합니다.

개발 실행:
- Dashboard: `npm run dev:dashboard`
- Bridge(Node): `npm run dev:bridge`
- App Server 간편 실행: `npm run app-server:start`
- macOS/Linux 직접 실행: `./scripts/run-app-server.sh`
- Windows 직접 실행: `scripts\\run-app-server.cmd`
- Bridge 간편 실행: `npm run bridge:start`
- Bridge 파라미터 실행: `npm run bridge:start -- -id <loginId> -name "My Mac"`
- macOS/Linux 직접 실행: `./scripts/run-bridge.sh`
- Windows 직접 실행: `scripts\\run-bridge.cmd`
- App Server + Bridge 동시 실행: `npm run local-agent:start`
- App Server + Bridge 파라미터 실행: `npm run local-agent:start -- -id <loginId> -name "My Mac"`
- macOS/Linux 직접 실행: `./scripts/run-local-agent.sh`
- Windows 직접 실행: `scripts\\run-local-agent.cmd`
- Gateway(.NET 10): `npm run dev:api`
- Projection Worker(.NET 10): `npm run dev:projector`

브릿지 런처 동작:
- `.env.local` -> `.env` 순서로 환경변수를 읽습니다.
- 파일에 값이 없으면 NATS, bridge 포트, app-server listen 주소 기본값을 채웁니다.
- `bridge-id`는 로컬 머신에서 한 번 자동 생성되어 `~/.octop/bridge-id`에 저장됩니다.
- 프로젝트 목록은 bridge별로 `~/.octop/<bridge-id>-projects.json`에 저장되어 재시작 후에도 유지됩니다.
- bridge는 `process.cwd()`와 `OCTOP_WORKSPACE_ROOTS` 아래의 로컬 워크스페이스를 자동 감지해 프로젝트로 동기화합니다.
- Dashboard의 프로젝트 등록 모달은 bridge가 노출한 허용 루트만 원격으로 탐색할 수 있으며, 선택한 폴더를 프로젝트 workspace로 등록합니다.
- 실행 인자로 `-id`, `-name`을 넘기면 각각 owner loginId, 표시 이름으로 환경값보다 우선 적용됩니다.
- 브릿지 프로세스를 띄우고, 필요하면 bridge가 `codex app-server`를 자식 프로세스로 함께 실행합니다.

app-server 런처 동작:
- `.env.local` -> `.env` 순서로 환경변수를 읽습니다.
- 파일에 값이 없으면 `ws://127.0.0.1:4600`을 기본 listen 주소로 사용합니다.
- `OCTOP_APP_SERVER_COMMAND`가 있으면 그 값을 그대로 실행하고, 없으면 `codex app-server --listen <ws-url>`를 실행합니다.

합본 런처 동작:
- app-server를 먼저 띄우고, bridge는 외부 app-server에 붙는 모드로 실행합니다.
- 따라서 app-server 중복 실행 없이 두 프로세스를 한 번에 올릴 수 있습니다.
