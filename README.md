# OctOP

프로젝트별 이슈 등록, 처리, 추적을 위한 운영 대시보드입니다.

핵심 구성 요소:
- `apps/dashboard`: React 기반 운영 UI
- `apps/api`: 외부 진입용 REST/SSE API
- `services/codex-adapter`: `codex app-server` 브리지
- `services/projection-worker`: NATS 이벤트를 RethinkDB read model로 반영

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
- 저장소에는 예제 파일만 두고 실제 `.env`는 원격 서버에서 따로 관리합니다.

현재 배포 전제:
- Dashboard는 Cloudflare Pages에서 서비스합니다.
- 계정 인증은 `licensehub.ilycode.app` API를 사용합니다.
- NATS는 `nats.ilycode.app` 외부 서버를 사용합니다.
- Projection 저장소는 `rethinkdb.ilycode.app` 외부 RethinkDB를 사용합니다.
