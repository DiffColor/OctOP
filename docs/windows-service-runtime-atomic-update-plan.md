# Windows Service Runtime Atomic Update Plan

## 목적

이 문서는 Windows용 `서비스 런타임의 원자적 업데이트` 계획서입니다.

여기서 다루는 대상은 앱 번들 업데이트가 아니라, 트레이 앱이 시작/정지하는 서비스 런타임 전체입니다.

- `run-local-agent`
- `run-bridge`
- `codex-adapter`
- WS `codex app-server`
- 서비스 구동에 필요한 런타임 워크스페이스, 스크립트, 의존성

앱 번들 업데이트는 별도 문서 [windows-bundle-update-implementation-plan.md](/Users/jazzlife/Documents/Workspaces/Products/OctOP/docs/windows-bundle-update-implementation-plan.md) 로 분리합니다.

이 문서의 역할은 macOS에서 이미 확정된 근간 로직을 Windows에도 같은 의미로 적용하되, Windows 파일 잠금과 경로 구조에 맞게 구현 방식을 바꾸는 것입니다.

## 공통 근간 로직

Windows도 아래 의미는 macOS와 동일해야 합니다.

- `서비스 시작`
  - 앱 제외 서비스 전체 새로 기동
  - 필요 시 `codex-adapter` 최신화
  - 서비스 재사용 없음
- `서비스 정지`
  - 앱 제외 OctOP 관련 프로세스 전부 종료
- `앱 업데이트`
  - 앱 번들 교체 전용
  - 서비스 런타임 업데이트와 분리
- `종료`
  - 서비스 정지 후 앱 종료

즉 Windows도 아래 불변 조건을 지켜야 합니다.

1. 서비스 시작은 항상 새 기동입니다.
2. 기존 서비스 런타임 재사용은 하지 않습니다.
3. `codex-adapter` 변경은 서비스 시작 경로에서 반영합니다.
4. 앱 번들 업데이트는 서비스 런타임 업데이트와 분리합니다.
5. 런타임 파일은 제자리 덮어쓰지 않습니다.
6. 새 런타임은 별도 경로에서 완성한 뒤, 서비스 정지 후 포인터를 한 번에 전환합니다.
7. 실패하면 즉시 이전 런타임으로 롤백합니다.
8. `stdio://` 보조 세션은 서비스 실행 판정에 포함하지 않습니다.
9. `stdio://` 보조 세션은 `서비스 정지`, `종료`, `앱 업데이트` 전에 항상 정리합니다.

## 저장소 경계

Windows도 저장소 경계는 macOS와 같은 논리를 유지해야 합니다.

- 로그인 데이터
  - 전역 `CODEX_HOME`
  - 기본 경로 `%USERPROFILE%\\.codex`
- 로그인 외 데이터
  - `%LOCALAPPDATA%\\OctOP`
  - 설정, 상태, 쓰레드/프로젝트/진단, 런타임, 캐시

금지:

- 로그인 데이터를 로컬 `codex-home`으로 복사하지 않음
- 인증 데이터와 상태/쓰레드 데이터를 같은 저장소로 합치지 않음
- 서비스 런타임 원자적 업데이트가 인증 저장소를 옮기거나 덮어쓰지 않음

## 앱/런타임 표기 규칙

Windows도 사용자에게 보이는 개념은 macOS와 맞춰야 합니다.

- 앱 버전
  - 현재 실행 중인 앱 번들 버전
- 런타임 ID
  - 활성 런타임의 `build-info.json.sourceRevision` 앞 12자리
- 업데이트 표시
  - 업데이트 없음: `런타임 ID <current12>`
  - 업데이트 있음: `런타임 ID <current12> · 업데이트 <remote12>`
  - UI 제약에 맞게 표현하되 의미와 정보량은 동일하게 유지

## 현재 Windows 코드 구조

### 경로

- 설치 루트: `%LOCALAPPDATA%\\OctOP`
  - 코드: [OctopPaths.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/OctopPaths.cs#L30)
- 런타임 루트: `%LOCALAPPDATA%\\OctOP\\runtime`
  - 코드: [OctopPaths.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/OctopPaths.cs#L7)
- 런타임 엔트리: `%LOCALAPPDATA%\\OctOP\\runtime\\scripts\\run-local-agent.mjs`
  - 코드: [OctopPaths.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/OctopPaths.cs#L22)

### 현재 구조 문제

- 고정된 `runtime` 경로를 직접 수정합니다.
- `StartAsync()`가 기존 런타임 프로세스를 재사용합니다.
- 앱 시작 시 포트 점유 프로세스를 강제 종료하는 흐름이 섞여 있습니다.
- `codex app-server --listen` 탐지가 `stdio://`와 WS를 구분하지 못합니다.
- 변경 감지, 새 후보 준비, 검증, 전환, 롤백이 한 절차로 묶여 있지 않습니다.

## 목표 상태

Windows 서비스 런타임은 macOS와 같은 의미의 `버전별 디렉터리 + 활성 포인터` 구조로 관리합니다.

```text
%LOCALAPPDATA%\OctOP\
  runtime-releases\
    <runtime-id>\
      scripts\
      services\
      packages\
      node_modules\
      .env.local
      version.txt
      build-info.json
    <runtime-id-2>\
  runtime-current.txt
  runtime-previous.txt
```

중요:

- 서비스는 항상 `runtime-current.txt`가 가리키는 런타임만 읽어야 합니다.
- 특정 `runtime\...` 경로를 코드에 직접 고정하면 안 됩니다.
- 제자리 덮어쓰기는 금지합니다.

## 런타임 ID 생성 규칙

Windows도 macOS와 같은 규칙을 사용해야 합니다.

- 형식:
  - `runtime-<sourceRevision12>-<configurationHash12>`
- source revision이 없으면 source hash 앞 12자리를 대신 사용

## 변경 감지 원칙

항상 새 런타임을 만들지 않습니다.

- 변경사항이 없으면:
  - 새 `runtime-releases/<id>`를 만들지 않음
  - 기존 활성 런타임으로 서비스만 새로 기동
- 변경사항이 있으면:
  - 새 런타임 후보 생성
  - 검증
  - 서비스 정지
  - 포인터 전환
  - 새 런타임으로 기동

운영 기준으로는 macOS와 같은 논리로 정리합니다.

- 현재 활성 런타임의 `codex-adapter` 소스 내용 해시와 원격 캐시 저장소의 `codex-adapter` 소스 내용 해시를 비교
- 내용 해시 계산 시 아래 항목은 제외
  - `node_modules`
  - `package-lock.json`
- 테스트 override가 있을 때만 문자열 revision 비교 허용

## 최신 `codex-adapter` 반영 규칙

우선순위는 macOS와 같은 의미를 유지합니다.

1. override source 경로가 있으면 그 경로를 사용
2. override가 없으면 로컬 캐시 저장소를 최신화해서 사용

Windows 구현도 결국 아래 흐름이 되어야 합니다.

- 캐시 저장소가 있으면 `fetch` 후 `reset --hard FETCH_HEAD`
- 저장소가 없으면 `clone --depth 1 --branch <branch>`
- `services/codex-adapter`만 새 후보에 반영

## 원자적 전환 규칙

Windows 서비스 시작은 항상 다음 순서로 동작해야 합니다.

1. 새 런타임 후보 준비
2. 기존 서비스/보조 세션 탐지
3. 기존 서비스/보조 세션 종료
4. 종료 검증
5. `runtime-current.txt`를 새 릴리즈로 전환
6. 새 런타임으로 서비스 기동
7. 헬스체크
8. 성공 시 stale release 정리

첫 앱 구동 시에도 예외는 없습니다.

- `AutoStartRequested == true`
- 환경이 `ReadyToRun == true`
- 현재 서비스가 실행 중이 아님

이면, 앱 초기화 직후에도 반드시 위와 동일한 `StartAsync()` 경로를 타야 합니다.

즉 Windows 구현은 아래 두 경우를 동일하게 다뤄야 합니다.

- 사용자가 메뉴에서 `서비스 시작`을 눌렀을 때
- 로그인 후 앱이 자동 시작되었고 서비스 자동 시작이 요청된 상태일 때

이 둘은 모두 같은 원자적 전환 규칙을 사용해야 하며, 앱 초기화 경로라고 해서 원자적 업데이트를 건너뛰면 안 됩니다.

## 새 런타임 후보 준비 규칙

새 후보는 항상 별도 경로에서 완성해야 합니다.

준비 대상:

- `scripts/run-local-agent.mjs`
- `scripts/run-bridge.mjs`
- `services/codex-adapter`
- 필요한 `packages`
- 의존성 설치 결과물
- `.env.local`
- `version.txt`
- `build-info.json`

중요:

- 현재 활성 런타임은 이 단계에서 건드리지 않습니다.
- 준비 실패 시 현재 서비스에는 영향이 없어야 합니다.

## 종료 및 포트 해제 검증

전환 전에 아래가 만족돼야 합니다.

- 서비스 프로세스가 더 이상 존재하지 않음
- 브릿지 포트 해제
- WS `app-server` 포트 해제
- 기존 런타임 경로를 잡고 있는 잔여 프로세스 없음
- 살아 있는 `stdio://` 보조 세션 없음

중요:

- 시작 시 광범위한 포트 강제 종료로 대체하면 안 됩니다.
- 종료 검증은 `서비스 정지` 이후의 결과를 확인하는 단계여야 합니다.

## 헬스체크 규칙

새 런타임 시작 후 최소한 다음을 확인합니다.

- `run-local-agent` 기동 성공
- 브릿지 기동 성공
- WS `app-server` 연결 성공
- 서비스 포트 바인딩 성공
- 기본 진단/상태 확인 성공

추가 원칙:

- bind 주소와 probe 주소는 분리합니다.
- wildcard bind 주소(`0.0.0.0`, `::`, `[::]`)를 그대로 헬스체크 접속 주소로 쓰면 안 됩니다.
- probe는 loopback 기준으로 정규화해야 합니다.

## 실패 시 롤백

헬스체크가 실패하면:

1. 새 서비스 정지
2. `runtime-current.txt`를 이전 런타임으로 복구
3. 이전 런타임으로 서비스 다시 시작
4. 실패 원인 로그 남김

## 구현 시 정렬 기준

Windows 구현은 운영체제 특성은 달라도, 아래 논리는 macOS와 동일해야 합니다.

- 런타임 포인터 2개
  - `runtime-current.txt`
  - `runtime-previous.txt`
- 서비스 시작 전환 순서
  1. 새 후보 준비
  2. 기존 서비스/보조 세션 종료
  3. 종료 검증
  4. 포인터 전환
  5. 새 런타임 기동
  6. 헬스체크
  7. 실패 시 롤백
- stale release 정리
  - 현재/이전/최근 릴리즈만 남기고 오래된 릴리즈 정리

## 체크리스트

### A. 개념 분리

- [x] Windows에서 서비스 런타임 업데이트와 앱 번들 업데이트를 문서와 코드에서 분리
- [x] `재시작`에 앱 업데이트 책임이 섞이지 않도록 분리
- [x] `서비스 시작`, `서비스 정지`, `앱 업데이트`, `종료` 의미를 고정
- [x] 로그인 데이터는 전역, 그 외 데이터는 로컬이라는 저장소 경계를 고정
- [x] `stdio://` 보조 세션 정책을 서비스 정책과 분리

### B. 현재 코드 정리 대상

- [x] `StartAsync()`의 런타임 재사용 로직 제거
- [x] `Stop()`을 서비스 전체 종료 기준으로 정리
- [x] 시작 시 포트 강제 종료 역할 제거 또는 축소
- [x] 서비스 판정에서 `stdio://` 보조 세션이 섞이지 않도록 정리
- [x] `stdio://` 세션 추적 및 종료 책임 위치 정의

### C. 런타임 저장 구조

- [x] `runtime-releases` 구조 설계
- [x] `runtime-current.txt` 구조 설계
- [x] `runtime-previous.txt` 구조 설계
- [x] 서비스가 항상 포인터 기준으로 런타임을 읽도록 정리

### D. 변경 감지

- [x] 어떤 입력이 바뀌면 새 런타임을 만드는지 정의
- [x] 변경이 없으면 기존 활성 런타임으로 서비스만 재기동하도록 정의
- [x] 활성 런타임 메타데이터 구조 정의
- [x] `codex-adapter` 소스 내용 해시 기반 감지로 정리
- [x] `node_modules`, `package-lock.json` 제외 규칙 반영

### E. 새 런타임 준비

- [x] 새 런타임을 별도 경로에 생성
- [x] `codex-adapter` 최신화 경로 포함
- [x] 스크립트/패키지/의존성 설치 포함
- [x] 환경 파일 생성
- [x] 버전 메타데이터 생성
- [x] `build-info.json`에 앱 버전, runtime ID, source revision 기록

### F. 준비 검증

- [x] 필수 파일 존재 검증
- [x] 의존성 설치 완료 검증
- [x] 실행 엔트리 검증
- [x] 실패 시 현재 런타임 무영향 보장

### G. 서비스 정지

- [x] 앱 제외 서비스 프로세스 전체 종료
- [x] `run-local-agent` 종료 확인
- [x] 브릿지 종료 확인
- [x] WS `app-server` 종료 확인
- [x] `stdio://` 보조 세션 종료 기준 정리

### H. 종료/포트 검증

- [x] 서비스 프로세스 잔존 여부 확인
- [x] 브릿지 포트 해제 확인
- [x] WS `app-server` 포트 해제 확인
- [x] 기존 런타임 경로를 잡고 있는 잔여 프로세스 없음 확인
- [x] `stdio://` 보조 세션 잔존 여부 확인
- [x] wildcard bind 주소를 probe 주소로 그대로 쓰지 않도록 정규화

### I. 전환/롤백

- [x] `runtime-current.txt` 전환
- [x] `runtime-previous.txt` 기록
- [x] 새 서비스 기동
- [x] 헬스체크 실패 시 이전 런타임 롤백
- [x] stale release 정리

## 현재 검증

- [x] `dotnet build apps/windows-agent-menu/OctOP.WindowsAgentMenu.csproj`
