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

추가 원칙:

- `stdio://` 세션은 서비스가 아니다
- 하지만 `서비스 정지`, `종료`, `앱 업데이트` 전에 반드시 정리해야 하는 보조 세션이다
- `stdio://` 세션을 서비스 실행 판정에 넣으면 안 된다

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

## 현재 Windows 코드 구조

### 런타임 경로

- 설치 루트: `%LOCALAPPDATA%\\OctOP`
- 코드: [OctopPaths.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/OctopPaths.cs#L30)
- 런타임 루트: `%LOCALAPPDATA%\\OctOP\\runtime`
- 코드: [OctopPaths.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/OctopPaths.cs#L7)
- 런타임 엔트리: `%LOCALAPPDATA%\\OctOP\\runtime\\scripts\\run-local-agent.mjs`
- 코드: [OctopPaths.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/OctopPaths.cs#L22)

### 런타임 설치 방식

- 현재는 `RuntimeInstaller.InstallOrUpdateAsync()`가 고정된 `RuntimeRoot`에 직접 파일을 씁니다.
- 코드: [RuntimeInstaller.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/RuntimeInstaller.cs#L130)
- `WriteRuntimeBundleAsync()`, `WriteEnvironmentFile()`, `WriteRuntimeVersion()`도 모두 현재 활성 런타임 경로를 직접 수정합니다.
- 코드: [RuntimeInstaller.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/RuntimeInstaller.cs#L146)
- 코드: [RuntimeInstaller.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/RuntimeInstaller.cs#L155)
- 코드: [RuntimeInstaller.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/RuntimeInstaller.cs#L167)

### 서비스 시작/정지 방식

- 현재 `StartAsync()`는 기존 런타임 프로세스가 있으면 재사용합니다.
- 코드: [AgentTrayApplicationContext.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/AgentTrayApplicationContext.cs#L231)
- 현재 `Stop()`은 런타임 경로에 걸리는 프로세스를 찾아 종료합니다.
- 코드: [AgentTrayApplicationContext.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/AgentTrayApplicationContext.cs#L407)
- 현재 런타임 프로세스 탐지는 `codex app-server --listen` 전반을 포함하므로 `stdio://`와 WS `app-server`를 구분하지 못합니다.
- 코드: [AgentTrayApplicationContext.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/AgentTrayApplicationContext.cs#L998)
- 현재 앱 시작 시점에 `TerminateProcessesHoldingConfiguredPorts()`로 관리 포트를 점유한 프로세스를 강제 종료합니다.
- 코드: [AgentTrayApplicationContext.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/AgentTrayApplicationContext.cs#L156)
- 현재 관리 포트는 `bridgePort`와 `appServerWsUrl` 포트를 모두 포함합니다.
- 코드: [AgentTrayApplicationContext.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/AgentTrayApplicationContext.cs#L1174)

### 현재 구조 문제

- 고정된 `runtime` 경로를 제자리 수정함
- 서비스 시작 시 기존 런타임 재사용 로직이 있음
- 시작 시 포트 점유 프로세스를 강제 종료하는 흐름이 섞여 있음
- 변경 없는 경우와 변경 있는 경우의 런타임 전환 경계가 없음
- 새 런타임 준비, 검증, 전환, 롤백이 한 절차로 묶여 있지 않음
- `stdio://` 보조 세션을 서비스와 구분하지 못해 좀비/고아 프로세스 관리가 불명확함

## 목표 상태

Windows 서비스 런타임은 `버전별 디렉터리 + 활성 포인터` 구조로 관리합니다.

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
- `runtime\...` 고정 경로를 직접 엔트리로 쓰면 안 됩니다.
- 제자리 덮어쓰기는 금지합니다.

## `<runtime-id>` 의미

`<runtime-id>`는 Git 태그를 강제하자는 뜻이 아닙니다.

목적:

- 어떤 런타임 후보가 활성화됐는지 식별
- 변경 감지 결과를 기준으로 새 런타임을 생성
- 실패 시 이전 런타임으로 롤백

예시:

- `2026-03-20T11-05-00Z`
- `runtime-1f3ab42`
- `adapter-1f3ab42-20260320T110500Z`

핵심은 `변경사항이 있을 때만` 새 런타임 후보를 만든다는 점입니다.

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

변경 감지 대상 예시:

- `codex-adapter` 최신 커밋
- 런타임 스크립트 변경
- 런타임 패키지 정의 변경
- 환경 템플릿 변경

## Windows 서비스 런타임 원자적 업데이트 절차

### 1. 변경 감지

- 현재 활성 런타임의 메타데이터 확인
- 새 `codex-adapter` 또는 런타임 입력 변경 여부 확인
- 변경이 없으면 새 런타임 생성 없이 기존 활성 런타임으로 서비스만 기동

### 2. 새 런타임 후보 준비

변경이 있을 때만 새 런타임 후보를 별도 경로에 준비합니다.

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

### 3. 새 런타임 후보 검증

검증 예시:

- 엔트리 파일 존재
- `codex-adapter` 소스 존재
- 의존성 설치 완료
- 환경 파일 생성 완료
- 런타임 메타데이터 생성 완료

실패하면 새 후보 디렉터리만 폐기하고 종료합니다.

### 4. 서비스 정지

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

### 5. 종료 및 포트 해제 검증

아래가 만족돼야 전환 가능합니다.

- 서비스 프로세스가 더 이상 존재하지 않음
- 브릿지 포트 해제
- WS `app-server` 포트 해제
- 기존 런타임 경로를 잡고 있는 잔여 프로세스 없음
- 살아 있는 `stdio://` 보조 세션 없음

확인이 실패하면 전환을 중단하고 새 런타임 후보를 폐기합니다.

### 6. 활성 포인터 전환

정지와 검증이 끝나면 `runtime-current.txt`를 새 런타임으로 바꿉니다.

중요:

- 서비스는 항상 포인터를 읽어 엔트리 경로를 결정해야 합니다.
- 특정 `runtime-releases/<id>` 경로를 코드에 고정하면 안 됩니다.
- 전환 전에는 `runtime-previous.txt` 또는 동등한 롤백 메타를 남겨야 합니다.

### 7. 서비스 시작

포인터 전환 후 서비스 전체를 새로 기동합니다.

원칙:

- 기존 프로세스 재사용 없음
- 활성 포인터가 가리키는 새 런타임만 사용
- 새 런타임 기동은 현재 앱 프로세스에서 명시적으로 시작

### 8. 헬스체크

새 런타임 시작 후 최소한 다음을 확인합니다.

- `run-local-agent` 기동 성공
- 브릿지 기동 성공
- WS `app-server` 연결 성공
- 서비스 포트 바인딩 성공
- 기본 진단/상태 확인 성공

### 9. 실패 시 롤백

헬스체크가 실패하면:

1. 새 서비스 정지
2. `runtime-current.txt`를 이전 런타임으로 복구
3. 이전 런타임으로 서비스 다시 시작
4. 실패 원인 로그 남김

## 체크리스트

### A. 개념 분리

- [ ] Windows에서 서비스 런타임 업데이트와 앱 번들 업데이트를 문서와 코드에서 분리
- [ ] `재시작`에 앱 업데이트 책임이 섞이지 않도록 분리
- [ ] `서비스 시작`, `서비스 정지`, `앱 업데이트`, `종료` 의미를 고정

### B. 현재 코드 정리 대상

- [ ] `StartAsync()`의 런타임 재사용 로직 제거 계획 정리
- [ ] `Stop()`을 서비스 전체 종료 기준으로 정리
- [ ] 시작 시 `TerminateProcessesHoldingConfiguredPorts()` 호출 제거 또는 역할 축소 계획 정리
- [ ] 서비스 판정에서 `stdio://` 보조 세션이 섞이지 않도록 기준 정리
- [ ] `stdio://` 세션 추적 및 종료 책임 위치 정의

### C. 런타임 저장 구조

- [ ] `runtime-releases` 구조 설계
- [ ] `runtime-current.txt` 구조 설계
- [ ] `runtime-previous.txt` 또는 동등한 롤백 메타 구조 설계
- [ ] 서비스가 항상 포인터 기준으로 런타임을 읽도록 설계

### D. 변경 감지

- [ ] 어떤 입력이 바뀌면 새 런타임을 만드는지 정의
- [ ] 변경이 없으면 기존 활성 런타임으로 서비스만 재기동하도록 정의
- [ ] 활성 런타임 메타데이터 구조 정의

### E. 새 런타임 준비

- [ ] 새 런타임을 별도 경로에 생성
- [ ] `codex-adapter` 최신화 경로 포함
- [ ] 스크립트/패키지/의존성 설치 포함
- [ ] 환경 파일 생성
- [ ] 버전 메타데이터 생성

### F. 준비 검증

- [ ] 필수 파일 존재 검증
- [ ] 의존성 설치 완료 검증
- [ ] 실행 엔트리 검증
- [ ] 실패 시 현재 런타임 무영향 보장

### G. 서비스 정지

- [ ] 앱 제외 서비스 프로세스 전체 종료
- [ ] `run-local-agent` 종료 확인
- [ ] 브릿지 종료 확인
- [ ] WS `app-server` 종료 확인
- [ ] `stdio://` 보조 세션 종료 기준 정리
- [ ] `서비스 정지`, `종료`, `앱 업데이트` 전에 `stdio://` 세션을 항상 정리하도록 규칙화

### H. 종료/포트 검증

- [ ] 서비스 프로세스 잔존 여부 확인
- [ ] 브릿지 포트 해제 확인
- [ ] WS `app-server` 포트 해제 확인
- [ ] 기존 런타임 경로를 잡고 있는 잔여 프로세스 없음 확인
- [ ] `stdio://` 보조 세션 잔존 여부 확인
- [ ] 실패 시 전환 중단

### I. 포인터 전환

- [ ] 활성 포인터를 새 런타임으로 한 번에 전환
- [ ] 전환 전 이전 포인터 백업
- [ ] 전환 실패 시 이전 포인터 유지

### J. 새 서비스 기동

- [ ] 포인터 기준 새 런타임으로만 시작
- [ ] 서비스 재사용 없음
- [ ] 구 런타임 직접 참조 제거

### K. 헬스체크

- [ ] `run-local-agent` 기동 확인
- [ ] 브릿지 기동 확인
- [ ] WS 연결 확인
- [ ] 서비스 포트 바인딩 확인
- [ ] 기본 진단/상태 확인

### L. 롤백

- [ ] 새 서비스 실패 시 새 런타임 정지
- [ ] 활성 포인터 이전 값 복구
- [ ] 이전 런타임으로 서비스 재기동
- [ ] 롤백 성공/실패 로그 명확화

### M. 청소

- [ ] 오래된 런타임 릴리즈 정리 정책
- [ ] 마지막 정상 런타임 최소 1개 이상 보존
- [ ] 실패한 후보 런타임 정리 정책

### N. 검증

- [ ] 변경 없는 서비스 시작 시 새 런타임 생성이 생략되는지 확인
- [ ] 변경 있는 서비스 시작 시 새 런타임 후보가 생성되는지 확인
- [ ] 준비 실패 시 기존 서비스 무영향 확인
- [ ] 서비스 정지 실패 시 포인터 전환이 일어나지 않는지 확인
- [ ] 새 런타임 기동 실패 시 이전 런타임으로 복구되는지 확인
- [ ] `codex-adapter` 변경이 서비스 시작 경로에서 반영되는지 확인
- [ ] 앱 업데이트 없이 서비스 런타임만 교체 가능한지 확인
- [ ] `stdio://` 세션이 서비스 실행 판정에 섞이지 않는지 확인
- [ ] `서비스 정지`, `종료`, `앱 업데이트` 후 `stdio://` 좀비/고아 프로세스가 남지 않는지 확인

## 권장 구현 순서

1. 서비스/앱 업데이트 개념 분리
2. Windows용 `runtime-releases` + `runtime-current.txt` 구조 도입
3. 변경 감지 메타데이터 구조 추가
4. 새 런타임 후보 생성 로직 추가
5. 서비스 정지/포트 해제 검증 강화
6. 포인터 전환 로직 추가
7. 새 서비스 기동 후 헬스체크 추가
8. 롤백 경로 추가
9. 오래된 런타임 정리 정책 추가
