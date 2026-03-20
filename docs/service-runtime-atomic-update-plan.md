# Service Runtime Atomic Update Plan

## 목적

이 문서는 `앱 번들 업데이트`와 분리된 `서비스 런타임의 원자적 업데이트`의 현재 구현 명세서입니다.

Windows 전용 계획은 별도 문서 [windows-service-runtime-atomic-update-plan.md](/Users/jazzlife/Documents/Workspaces/Products/OctOP/docs/windows-service-runtime-atomic-update-plan.md) 로 분리합니다.

여기서 말하는 서비스 런타임은 앱이 아닌, 앱이 기동/정지하는 OctOP 서비스 구성요소 전체를 뜻합니다.

- `run-local-agent`
- `run-bridge`
- `codex-adapter`
- WS `codex app-server`
- 서비스 구동에 필요한 런타임 워크스페이스, 스크립트, 의존성

이 문서의 목표는 다음 2가지를 분리하는 것입니다.

- `codex-adapter` 변경: 서비스 시작 경로에서 반영
- 앱 코드 변경: `앱 업데이트` 버튼으로 반영

즉, 서비스 런타임 업데이트와 앱 번들 업데이트는 별개입니다.

추가 원칙:

- `stdio://` 세션은 서비스가 아니다
- 하지만 `서비스 정지`, `종료`, `앱 업데이트` 전에 반드시 정리해야 하는 보조 세션이다
- 로그인 데이터는 전역 저장소를 사용한다
- 로그인 외 상태/쓰레드/설정/런타임 데이터는 로컬 저장소를 사용한다

## 현재 확정 구현

이 섹션은 2026-03-20 현재 실제 코드와 검증 결과를 기준으로 작성합니다.

### 1. 저장소 경계

- 로그인 데이터:
  - 전역 `CODEX_HOME`
  - 기본 경로 `~/.codex`
  - 코드: [AgentBootstrapSupport.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/AgentBootstrapSupport.swift#L760)
- 로컬 데이터:
  - 앱 루트 `~/Library/Application Support/OctOPAgentMenu`
  - 상태 저장소 `~/Library/Application Support/OctOPAgentMenu/state`
  - 런타임 루트 `~/Library/Application Support/OctOPAgentMenu/runtime`
  - 코드: [AgentBootstrapSupport.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/AgentBootstrapSupport.swift#L708), [AgentBootstrapSupport.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/AgentBootstrapSupport.swift#L771)
- 금지 사항:
  - 로그인 데이터를 로컬 `codex-home`로 복사하지 않는다.
  - 인증 데이터와 쓰레드/상태 데이터를 같은 저장소로 합치지 않는다.

### 2. 앱/서비스 버전 표기

- 앱 메뉴의 앱 버전 표기는 강제로 `v1.2.4`를 사용한다.
  - 코드 상수: [AgentBootstrapSupport.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/AgentBootstrapSupport.swift#L386)
- 런타임 ID는 활성 런타임의 `build-info.json.sourceRevision` 앞 12자리다.
  - 코드: [AgentBootstrapSupport.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/AgentBootstrapSupport.swift#L975)
- 메뉴 표기 형식:
  - 업데이트 없음: `런타임 ID <current12>`
  - 업데이트 있음: `런타임 ID <current12> · 업데이트 <remote12>`
  - 업데이트 표시는 파란색 단일 라인이다.
  - 코드: [OctOPAgentMenuApp.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/OctOPAgentMenuApp.swift#L916)

### 3. 런타임 저장 구조

- 런타임 루트:
  - `~/Library/Application Support/OctOPAgentMenu/runtime`
- 릴리즈 디렉터리:
  - `~/Library/Application Support/OctOPAgentMenu/runtime/releases/<runtime-id>`
- 활성 포인터:
  - `~/Library/Application Support/OctOPAgentMenu/runtime/current-release.txt`
- 이전 포인터:
  - `~/Library/Application Support/OctOPAgentMenu/runtime/previous-release.txt`
- 코드: [AgentBootstrapSupport.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/AgentBootstrapSupport.swift#L712), [AgentBootstrapSupport.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/AgentBootstrapSupport.swift#L748)

### 4. 런타임 ID 생성 규칙

- 형식:
  - `runtime-<sourceRevision12>-<configurationHash12>`
- source revision이 없으면 source hash 앞 12자리를 대신 쓴다.
- 구현 위치:
  - [AgentBootstrapSupport.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/AgentBootstrapSupport.swift#L1430)

### 5. 새 런타임 후보 생성 규칙

- 서비스 시작 직전 `prepareRuntimeReleaseForServiceStart()`가 새 후보를 준비한다.
  - 코드: [AgentBootstrapSupport.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/AgentBootstrapSupport.swift#L1284)
- 준비 순서:
  1. base environment 준비
  2. bootstrap 리소스를 staging 소스로 복사
  3. 최신 `codex-adapter`를 staging 소스에 덮어씀
  4. source hash / configuration hash 계산
  5. staging release 생성
  6. `.env.local`, `version.txt`, `build-info.json` 작성
  7. 의존성 설치
  8. 검증
  9. `runtime/releases/<id>`로 원자적으로 이동
- 코드: [AgentBootstrapSupport.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/AgentBootstrapSupport.swift#L1423)

### 6. 최신 `codex-adapter` 반영 규칙

- 우선순위 1:
  - `OCTOP_AGENT_MENU_CODEX_ADAPTER_SOURCE_PATH`가 있으면 그 경로를 사용한다.
  - 이 경로가 Git 저장소 안이면 해당 저장소의 `HEAD`를 source revision으로 쓴다.
- 우선순위 2:
  - override가 없으면 런타임 캐시 저장소 `runtime/source-cache/octop-repo`를 사용한다.
  - 저장소가 있으면 `git fetch --depth 1 origin <branch>` 후 `git reset --hard FETCH_HEAD`
  - 저장소가 없으면 `git clone --depth 1 --branch <branch> <repo>`
- 기본 remote:
  - `https://github.com/DiffColor/OctOP.git`
- 기본 branch:
  - `main`
- 코드: [AgentBootstrapSupport.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/AgentBootstrapSupport.swift#L724), [AgentBootstrapSupport.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/AgentBootstrapSupport.swift#L1536)

### 7. 원자적 전환 규칙

- 서비스 시작은 항상 다음 순서로 동작한다.
  1. 새 런타임 후보 준비
  2. 기존 서비스/보조 세션 탐지
  3. 기존 서비스/보조 세션 종료
  4. 종료 검증
  5. `current-release.txt`를 새 릴리즈로 전환
  6. 새 런타임으로 서비스 기동
  7. 헬스체크
  8. 성공 시 stale release 정리
- 코드: [OctOPAgentMenuApp.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/OctOPAgentMenuApp.swift#L55)

### 8. 롤백 규칙

- 새 런타임 기동 후 헬스체크 실패 시:
  1. 새 서비스 종료
  2. `current-release.txt`를 이전 릴리즈로 복구
  3. 이전 런타임으로 다시 기동
- 코드: [OctOPAgentMenuApp.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/OctOPAgentMenuApp.swift#L103), [AgentBootstrapSupport.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/AgentBootstrapSupport.swift#L1315)

### 9. 서비스 정지/종료 규칙

- `서비스 정지`는 앱을 제외한 관리 프로세스를 전부 종료한다.
- 종료 대상:
  - `run-local-agent`
  - `run-bridge`
  - `codex-adapter`
  - WS `codex app-server`
  - `stdio://` 보조 세션
- `종료`는 `서비스 정지` 후 앱 종료다.
- 코드: [OctOPAgentMenuApp.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/OctOPAgentMenuApp.swift#L132), [OctOPAgentMenuApp.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/OctOPAgentMenuApp.swift#L170)

### 10. 서비스 실행 판정 규칙

- `stdio://`만 떠 있을 때는 서비스 실행 중으로 판정하지 않는다.
- 서비스 프로세스 탐지는 `run-local-agent` 우선으로 판정한다.
- 코드: [OctOPAgentMenuApp.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/OctOPAgentMenuApp.swift#L178)

### 11. 런타임 업데이트 감지 규칙

- 앱 실행 중 주기적으로 원격 런타임 리비전을 조회한다.
- 기본 주기:
  - 60초
  - 환경변수 `OCTOP_AGENT_MENU_RUNTIME_UPDATE_CHECK_INTERVAL_SECONDS`로 5초 이상 값만 override 가능
- 운영 경로에서는 현재 활성 런타임의 `codex-adapter` 소스 내용 해시와 원격 캐시 저장소의 `codex-adapter` 소스 내용 해시를 비교한다.
- 내용 해시 계산 시 아래 항목은 제외한다.
  - `node_modules`
  - `package-lock.json`
- 테스트 override(`runtimeUpdateRevisionResolver`)가 설정된 경우에만 문자열 revision 비교를 사용한다.
- 원격 조회 방식:
  - `runtime/source-cache/octop-repo`를 최신화한 뒤 `services/codex-adapter` 디렉터리 내용을 해시한다.
- 코드: [AgentBootstrapSupport.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/AgentBootstrapSupport.swift#L865), [AgentBootstrapSupport.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/AgentBootstrapSupport.swift#L1028), [AgentBootstrapSupport.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/AgentBootstrapSupport.swift#L1606)

### 12. 푸시 알림 정책

- 런타임 업데이트 감지 시 모바일 푸시 알림은 보내지 않는다.
- 이유:
  - 맥 앱이 여러 대일 때 중복 발송이 발생할 수 있다.
- 현재 구현은 메뉴 표시만 한다.

### 13. 브릿지 헬스체크 probe host 규칙

- 브릿지 bind 주소와 헬스체크 접속 주소를 분리한다.
- `bridgeHost`가 아래 값이면 헬스체크는 `127.0.0.1`로 접속한다.
  - `0.0.0.0`
  - `::`
  - `[::]`
  - 빈 문자열
- 이유:
  - `0.0.0.0`과 `::`는 서버 bind 주소이지 클라이언트 접속 주소가 아니므로, 그대로 `/health`를 호출하면 정상 기동한 새 런타임도 실패로 오판해서 롤백할 수 있다.
- 구현 위치:
  - [OctOPAgentMenuApp.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/OctOPAgentMenuApp.swift)

### 14. 실제 원격 검증 커밋

- 검증용 no-op 커밋 1:
  - `5954f87e48556d064d5c183157d976158424d967`
- 검증용 no-op 커밋 2:
  - `85797a3474c114207889f3c769b2a9f3e3f0c9e4`
- 두 커밋 모두 `services/codex-adapter/src/index.js`에 로직 영향 없는 주석만 추가했다.
- 목적:
  - 원격 `main` HEAD 변경
  - 런타임 업데이트 감지
  - 새 릴리즈 생성 및 전환 검증

## 기능 정의

### 서비스 시작

- 앱 제외 서비스 전체 새로 기동
- 필요 시 `codex-adapter` 최신화
- 서비스 재사용 없음

### 서비스 정지

- 앱 제외 OctOP 관련 프로세스 전부 종료
- 살아 있는 `stdio://` 보조 세션도 함께 종료

### 앱 업데이트

- 앱 번들 교체 전용
- 서비스 상태와 개념 분리

### 종료

- 서비스 정지 후 앱 종료

## 핵심 원칙

1. 서비스 시작은 항상 새 기동입니다.
2. 기존 서비스 런타임 재사용은 하지 않습니다.
3. `codex-adapter` 변경은 서비스 시작 시 반영합니다.
4. 앱 번들 업데이트는 서비스 런타임 업데이트와 분리합니다.
5. 런타임 파일은 제자리 덮어쓰지 않습니다.
6. 새 런타임은 별도 경로에서 완성한 뒤, 서비스 정지 후 한 번에 전환합니다.
7. 실패하면 즉시 이전 런타임으로 롤백합니다.
8. `stdio://` 보조 세션은 서비스 실행 판정에 포함하지 않습니다.
9. `stdio://` 보조 세션은 종료/업데이트 전에 항상 정리합니다.

## 구현 전 문제 기록

초기 계획 시점에는 고정된 런타임 경로를 직접 수정하는 구조가 문제였습니다. 현재 구현은 이 부분을 정리해 `릴리즈 디렉터리 + 포인터 파일` 구조로 전환했습니다.

### macOS

- 런타임 루트: `~/Library/Application Support/OctOPAgentMenu/runtime`
- 코드: [AgentBootstrapSupport.swift](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/Sources/AgentBootstrapSupport.swift#L712)
- 실제 활성 런타임은 `runtime/releases/<id>` 아래에 저장됩니다.
- 활성 포인터는 `runtime/current-release.txt` 입니다.
- 이전 포인터는 `runtime/previous-release.txt` 입니다.
- 로그인 데이터는 전역 `~/.codex` 를 직접 참조합니다.
- 로그인 외 상태/쓰레드/설정/런타임 데이터는 `~/Library/Application Support/OctOPAgentMenu` 아래 로컬 저장소를 사용합니다.

## 저장 구조

서비스 런타임은 항상 `버전별 디렉터리 + 현재 포인터` 구조로 관리합니다.

예시:

### macOS

```text
~/Library/Application Support/OctOPAgentMenu/runtime/
  releases/
    runtime-<source-hash>-<config-hash>/
    runtime-<source-hash>-<config-hash>/
  current-release.txt
  previous-release.txt
```

`current-release.txt` 가 실제 서비스가 읽는 활성 런타임 포인터입니다.

## 원자적 업데이트 핵심

원자적 업데이트는 다음 뜻입니다.

- 새 런타임을 별도 경로에서 완성한다
- 서비스를 완전히 내린다
- 활성 포인터만 한 번에 바꾼다
- 실패하면 포인터를 이전 값으로 되돌린다

즉, 핵심은 `제자리 수정`이 아니라 `완성본 전환`입니다.

## 서비스 런타임 원자적 업데이트 절차

### 1. 새 런타임 준비

서비스 시작 전에 새 런타임 후보를 별도 경로에 준비합니다.

준비 대상:

- `scripts/run-local-agent`
- `scripts/run-bridge`
- `services/codex-adapter`
- 필요한 `packages`
- 의존성 설치 결과물
- 런타임 환경 파일
- 런타임 버전 메타데이터

중요:

- 현재 활성 런타임은 이 단계에서 건드리지 않습니다.
- 준비 실패 시 현재 서비스에는 영향이 없어야 합니다.

### 2. 새 런타임 검증

검증 예시:

- 엔트리 파일 존재
- `codex-adapter` 소스 존재
- 의존성 설치 완료
- 실행에 필요한 환경 파일 존재
- 런타임 버전 메타데이터 생성 완료

이 단계에서 실패하면 새 후보 디렉터리만 폐기하고 종료합니다.

### 3. 서비스 정지

서비스 시작 전에는 항상 기존 서비스를 먼저 정지합니다.

정지 대상:

- `run-local-agent`
- `run-bridge`
- `codex-adapter`
- WS `codex app-server`
- `stdio://` 보조 세션

원칙:

- 앱은 남아 있음
- 서비스 관련 프로세스만 전부 종료
- 서비스 재사용 없음

### 4. 종료 검증

아래가 만족돼야 전환 가능합니다.

- 서비스 프로세스가 더 이상 존재하지 않음
- 브릿지 포트 해제
- WS app-server 포트 해제
- 기존 런타임을 사용하는 잔여 프로세스 없음
- 살아 있는 `stdio://` 보조 세션 없음

확인이 실패하면 전환을 중단하고 새 런타임 후보를 폐기합니다.

### 5. 활성 포인터 전환

정지와 검증이 끝나면 활성 런타임 포인터를 새 런타임으로 바꿉니다.

macOS 후보:

- `runtime/current-release.txt`
- `runtime/previous-release.txt`

중요:

- 서비스는 항상 활성 포인터만 읽어야 합니다.
- `runtime/releases/<id>` 를 직접 하드코딩해서 읽으면 안 됩니다.

### 6. 서비스 시작

포인터 전환 후 서비스 전체를 새로 기동합니다.

원칙:

- 기존 프로세스 재사용 없음
- 활성 포인터가 가리키는 새 런타임만 사용
- 필요 시 이 시점에 `codex-adapter` 최신화 내용을 이미 포함한 런타임으로 시작

### 7. 헬스체크

새 런타임 시작 후 최소한 다음을 확인합니다.

- `run-local-agent` 기동 성공
- 브릿지 기동 성공
- WS `app-server` 연결 성공
- 서비스 포트 바인딩 성공
- 기본 상태 점검 API 또는 진단 상태 정상

### 8. 실패 시 롤백

헬스체크가 실패하면:

1. 새 서비스 정지
2. 활성 포인터를 이전 런타임으로 복구
3. 이전 런타임으로 서비스 다시 시작
4. 실패 원인 로그 남김

이게 서비스 런타임 원자적 업데이트의 핵심입니다.

## `codex-adapter` 최신화 위치

`codex-adapter` 변경은 앱 업데이트가 아니라 서비스 시작 경로에서 반영해야 합니다.

즉:

- 서비스 시작 전 새 런타임 후보를 만들 때
- `codex-adapter` 최신 내용을 가져와 포함하고
- 그 완료본을 활성 런타임으로 전환해야 합니다.

이렇게 해야 서비스 시작이 곧 최신 `codex-adapter` 반영이 됩니다.

## 앱 업데이트와의 관계

앱 업데이트는 계속 따로 존재해야 합니다.

이유:

- 앱 자체는 네이티브 바이너리
- Swift/C# 코드 변경
- 번들 리소스 변경
- LaunchAgent/트레이 설정 변경
- 설치 방식 변경

이건 서비스 런타임 업데이트로 해결할 수 없습니다.

정리:

- `codex-adapter` 및 서비스 스크립트 변경: 서비스 시작 경로
- 앱 코드 변경: `앱 업데이트` 버튼 경로

## 실제 저장 구조

### 공통 구조

```text
<app-root>/
  runtime/
    releases/
      <runtime-id>/
        scripts/
        services/
        packages/
        node_modules/
        .env.local
        version.txt
        build-info.json
        healthcheck.json
    current-release.txt
    previous-release.txt
```

### 런타임 ID 예시

- `runtime-85797a3474c1-9f7db077ca42`
- `runtime-5954f87e4855-9f7db077ca42`

## 메타데이터 구조

새 런타임 후보마다 아래 파일을 실제로 둡니다.

- `version.txt`
- `build-info.json`
- `healthcheck.json`

`build-info.json`에는 최소 아래 값이 들어갑니다.

- `runtimeID`
- `sourceHash`
- `configurationHash`
- `sourceRevision`
- `appVersion`
- `createdAt`

## 실패 모드

원자적 업데이트가 막아야 하는 실패:

- 절반만 복사된 `codex-adapter`
- 일부 스크립트만 최신, 일부는 구버전
- 의존성 설치 도중 실패한 `node_modules`
- 서비스가 살아 있는 상태에서 런타임 파일 덮어쓰기
- 새 런타임 기동 실패 후 서비스 전체 다운 상태 유지

## 로그 원칙

로그는 최소 아래 이벤트를 남겨야 합니다.

- 새 런타임 후보 생성 시작
- 새 런타임 후보 생성 완료
- 검증 성공/실패
- 서비스 정지 시작/완료
- 포트 해제 성공/실패
- 활성 포인터 전환 시작/완료
- 새 서비스 기동 성공/실패
- 롤백 시작/완료

## 체크리스트

### A. 개념 분리

- [x] 서비스 런타임 업데이트와 앱 번들 업데이트를 문서와 코드에서 분리
- [x] `재시작`에 앱 업데이트 책임이 섞이지 않도록 분리
- [x] `서비스 시작`, `서비스 정지`, `앱 업데이트`, `종료` 의미를 고정

### B. 런타임 저장 구조

- [x] `runtime/releases/<id>` 구조 구현
- [x] 활성 포인터 `current-release.txt` 구현
- [x] 이전 포인터 `previous-release.txt` 구현
- [x] 서비스가 항상 포인터 기준으로 런타임을 읽도록 구현

### C. 새 런타임 준비

- [x] 새 런타임을 `.staging-<uuid>` 경로에 생성
- [x] `codex-adapter` 최신화 경로 포함
- [x] 스크립트/패키지/의존성 설치 포함
- [x] `.env.local` 생성
- [x] `version.txt`, `build-info.json` 생성

### D. 준비 검증

- [x] 필수 파일 존재 검증
- [x] 의존성 설치 완료 검증
- [x] 실행 엔트리 검증
- [x] 실패 시 현재 런타임 무영향 보장

### E. 서비스 정지

- [x] 앱 제외 서비스 프로세스 전체 종료
- [x] `run-local-agent` 종료 확인
- [x] 브릿지 종료 확인
- [x] WS `app-server` 종료 확인
- [x] `stdio://` 보조 세션 종료 기준 정리
- [x] `서비스 정지`, `종료`, `앱 업데이트` 전에 `stdio://` 세션을 항상 정리하도록 규칙화

### F. 종료/포트 검증

- [x] 서비스 프로세스 잔존 여부 확인
- [x] 브릿지 포트 해제 확인
- [x] WS app-server 포트 해제 확인
- [x] 기존 런타임 경로를 잡고 있는 잔여 프로세스 없음 확인
- [x] `stdio://` 보조 세션 잔존 여부 확인
- [x] 실패 시 전환 중단

### G. 포인터 전환

- [x] 활성 포인터를 새 런타임으로 한 번에 전환
- [x] 전환 전 이전 포인터 백업
- [x] 전환 실패 시 이전 포인터 유지

### H. 새 서비스 기동

- [x] 포인터 기준 새 런타임으로만 시작
- [x] 서비스 재사용 없음
- [x] 구 런타임 경로 참조 제거

### I. 헬스체크

- [x] `run-local-agent` 기동 확인
- [x] 브릿지 기동 확인
- [x] WS 연결 확인
- [x] 서비스 포트 바인딩 확인
- [x] 기본 진단/상태 확인

### J. 롤백

- [x] 새 서비스 실패 시 새 런타임 정지
- [x] 활성 포인터 이전 값 복구
- [x] 이전 런타임으로 서비스 재기동
- [x] 롤백 성공/실패 로그 명확화

### K. 청소

- [x] 오래된 런타임 릴리즈 정리 구현
- [x] 현재 릴리즈 보존
- [x] 이전 릴리즈 보존
- [x] 최근 릴리즈 최대 3개 추가 보존
- [x] 실패한 `.staging-*` 후보 정리

### L. 검증

- [x] 정상 업데이트 후 새 런타임 기동 확인
- [x] 준비 실패 시 기존 서비스 무영향 확인
- [x] 서비스 정지 실패 시 포인터 전환이 일어나지 않는지 확인
- [x] 새 런타임 기동 실패 시 이전 런타임으로 복구되는지 확인
- [x] `codex-adapter` 변경이 서비스 시작 경로에서 반영되는지 확인
- [x] 앱 업데이트 없이 서비스 런타임만 교체 가능한지 확인
- [x] `stdio://` 세션이 서비스 실행 판정에 섞이지 않는지 확인
- [x] `서비스 정지`, `종료`, `앱 업데이트` 후 `stdio://` 좀비/고아 프로세스가 남지 않는지 확인
- [x] 원격 `main` HEAD와 활성 runtime `sourceRevision` 차이 감지 확인
- [x] 메뉴에 단일 파란색 업데이트 라인 표기 확인
- [x] 모바일 푸시 알림이 제거된 상태 확인
- [x] `bridgeHost=0.0.0.0` 환경에서도 헬스체크는 loopback으로 probe 하도록 수정

## 검증 기록

### 2026-03-20 현재 확정

- `apps/macos-agent-menu` 에서 `swift build` 통과
- `apps/api/OctOP.Gateway.csproj` 에서 `dotnet build` 통과
- `apps/macos-agent-menu` 에서 `xcrun xctest /Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/macos-agent-menu/.build/arm64-apple-macosx/debug/OctOPAgentMenuPackageTests.xctest` 통과
- 현재 전체 테스트 결과 기준:
  - `16 tests, 1 skipped, 0 failures`
- release 앱 재빌드:
  - `node scripts/release-agent-menu.mjs --platform macos --version 1.2.4`
- 재실행 확인:
  - `/Users/jazzlife/Documents/Workspaces/Products/OctOP/dist/releases/v1.2.4/OctOPAgentMenu-macos-arm64-v1.2.4.app`
- 실연결 런타임 업데이트 검증:
  - `OCTOP_RUN_REAL_RUNTIME_UPDATE_TEST=1 swift test --filter testRealRuntimeUpdateFetchesLatestRemoteCodexAdapterAndSwitchesRelease`
- 원격 최신 no-op 검증 커밋:
  - `85797a3474c114207889f3c769b2a9f3e3f0c9e4`
- `bridgeHost=0.0.0.0` 회귀 방지 테스트 추가:
  - `testBridgeProbeHostNormalizationUsesLoopbackForWildcardBindHosts`

## 문서 업데이트 규칙

- 이 문서에는 계획이 아니라 현재 확정 구현만 기록합니다.
- 새 동작이 코드와 검증으로 확정되기 전에는 체크하지 않습니다.
- 체크리스트를 변경할 때는 반드시 해당 검증 명령이나 확인 방법을 함께 남깁니다.
- 메뉴 문구, 경로, 버전 표기, 리비전 감지 방식처럼 사용자가 직접 보게 되는 동작은 문자열까지 정확히 기록합니다.

## 구현 순서 기록

1. 서비스/앱 업데이트 개념 분리
2. `runtime/releases` + `current-release.txt` 구조 도입
3. 새 런타임 후보 생성 로직 추가
4. 서비스 정지/포트 해제 검증 강화
5. 포인터 전환 로직 추가
6. 새 서비스 기동 후 헬스체크 추가
7. 롤백 경로 추가
8. 오래된 런타임 정리 정책 추가
9. 원격 `codex-adapter` 리비전 감지와 메뉴 표시 추가
10. `bridgeHost=0.0.0.0` probe 실패 롤백 버그 수정
