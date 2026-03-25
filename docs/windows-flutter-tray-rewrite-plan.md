# Windows Flutter Tray App Rewrite Plan

## 목적

이 문서는 현재 `apps/windows-agent-menu`를 대체할 Windows용 `Flutter` 트레이 앱 재작성 계획서입니다.

이번 재작성의 핵심 목표는 2가지입니다.

1. `WPF + WinForms` 제약에서 벗어나 UI/상태 표현을 안정적으로 재구성한다.
2. Windows 구현의 기준을 더 이상 기존 Windows 코드가 아니라 `apps/macos-agent-menu`의 동작 로직으로 맞춘다.

즉, 새 Windows 앱은 **UI는 Flutter로 재작성**하고, **서비스/런타임/로그인/업데이트 의미는 macOS 앱과 동일하게 유지**해야 합니다.

---

## 현재 코드 기준 사실

### 1. macOS 앱은 이미 기준이 되는 완성 로직을 갖고 있다

실제 기준 소스는 아래입니다.

- `apps/macos-agent-menu/Sources/OctOPAgentMenuApp.swift`
- `apps/macos-agent-menu/Sources/AgentBootstrapSupport.swift`
- `apps/macos-agent-menu/Sources/AgentUpdateSupport.swift`

이 macOS 구현에는 아래가 이미 들어 있습니다.

- 단일 인스턴스 제어
- 메뉴바 상태/로그/설정 창
- 서비스 시작/정지/종료
- 런타임 후보 준비, 활성 포인터 전환, 롤백
- `run-local-agent` / `run-bridge` / `codex-adapter` / WS `codex app-server` 헬스체크
- `stdio://` 보조 세션 정리
- Codex 로그인, 브라우저 선택, pending login 복구
- 런타임 업데이트 감지
- 앱 업데이트 다운로드/적용/복구

### 2. 현재 Windows 앱도 같은 책임을 갖고 있으나 구현이 UI와 강하게 결합돼 있다

실제 Windows 구현은 아래입니다.

- `apps/windows-agent-menu/AgentTrayApplicationContext.cs`
- `apps/windows-agent-menu/RuntimeInstaller.cs`
- `apps/windows-agent-menu/RuntimeConfiguration.cs`
- `apps/windows-agent-menu/OctopPaths.cs`
- `apps/windows-agent-menu/WindowsAutoUpdater.cs`
- `apps/windows-agent-menu/WindowsStartupManager.cs`

현재 Windows 앱은 다음 책임을 한 클래스/한 프로세스에 과도하게 몰아두고 있습니다.

- 트레이 UI
- 설정/로그 창
- 서비스 프로세스 시작/정지/재시작
- 런타임 릴리즈 준비/전환/롤백
- 포트 해제 검증
- Codex 로그인
- 자동 시작
- 앱 업데이트

이 구조는 UI 기술 제약뿐 아니라 프로세스 관리 안정성도 같이 떨어뜨립니다.

### 3. 기존 문서도 이미 macOS 의미를 Windows에 맞추라고 정리하고 있다

아래 문서는 이번 재작성에서도 그대로 기준으로 사용해야 합니다.

- `docs/service-runtime-atomic-update-plan.md`
- `docs/windows-service-runtime-atomic-update-plan.md`
- `docs/bundle-update-implementation-plan.md`
- `docs/windows-bundle-update-implementation-plan.md`
- `docs/windows-tray-service-stop-report.md`

즉, 이번 작업은 새로 의미를 만드는 것이 아니라, **이미 확정된 macOS 의미를 Flutter Windows 앱으로 옮기는 작업**입니다.

---

## 재작성 원칙

### 1. macOS 구현을 source of truth로 사용한다

동작 의미가 충돌하면 아래 우선순위를 따른다.

1. `apps/macos-agent-menu` 실제 코드
2. `docs/service-runtime-atomic-update-plan.md`
3. `docs/bundle-update-implementation-plan.md`
4. Windows 문서/구현

### 2. 기존 Windows UI 구조는 버린다

다음은 유지 대상이 아닙니다.

- `WPF Window` 중심 UI 구조
- `WinForms NotifyIcon + ContextMenuStrip` 중심 상태 관리
- UI 클래스 안에 들어간 프로세스 관리/업데이트 로직
- 종료/재시작/업데이트 로직이 UI 이벤트 흐름에 묶인 구조

### 3. 데이터 경계는 그대로 유지한다

새 Flutter 앱도 아래 경계를 유지해야 합니다.

- 로그인 데이터: 전역 `CODEX_HOME`
- 로컬 상태/설정/런타임/캐시: `%LOCALAPPDATA%\OctOP`

금지 사항:

- 전역 인증 데이터를 로컬 저장소로 복사
- 앱 업데이트 중 전역 인증 파일 이동/삭제
- 서비스 런타임과 인증 저장소의 경계 혼합

### 4. 서비스 의미를 바꾸지 않는다

새 Windows Flutter 앱에서도 아래 의미는 그대로 유지해야 합니다.

- `서비스 시작`
  - 항상 새 기동
  - 필요 시 새 런타임 후보 준비 후 포인터 전환
- `서비스 정지`
  - `run-local-agent`, `run-bridge`, `codex-adapter`, WS `codex app-server`, `stdio://` 보조 세션까지 정리
- `종료`
  - 서비스 정지 후 앱 종료
- `앱 업데이트`
  - 앱 실행 파일 교체 전용
  - 서비스 런타임 업데이트와 분리

---

## 새 앱의 목표 상태

### 사용자 관점

- 트레이 아이콘/메뉴는 Flutter 기반 UI 상태와 자연스럽게 연결된다.
- 설정 창/로그 창은 Windows에서도 macOS와 같은 정보량과 흐름을 제공한다.
- 서비스 상태, 런타임 ID, 앱 업데이트, 오류 메시지, 로그가 즉시 반영된다.
- UI 프레임워크 제약 때문에 기능/상태가 축소되지 않는다.

### 운영 관점

- 서비스 프로세스 제어는 UI와 분리된 명시적 런타임 계층에서 수행한다.
- 런타임 릴리즈 준비/검증/전환/롤백이 macOS와 같은 의미로 동작한다.
- Windows 전용 동작(트레이, 자동 시작, 실행 파일 교체, 프로세스/포트 검사)은 전담 어댑터로 격리한다.
- 장기적으로 macOS/Windows가 같은 도메인 규칙을 공유할 수 있는 구조를 만든다.

---

## 권장 아키텍처

## 선택안

`Flutter UI + Dart 애플리케이션 계층 + Windows 전용 네이티브 헬퍼` 구조를 권장합니다.

이 선택이 가장 합리적인 이유는 다음과 같습니다.

- UI 문제는 Flutter가 해결한다.
- 그러나 Windows 트레이, 자동 시작, 단일 인스턴스 활성화, 프로세스/포트 탐지, 실행 파일 교체는 여전히 Windows 고유 책임이다.
- 이 책임을 Dart 순수 구현으로만 밀어붙이면 다시 운영 안정성이 흔들릴 수 있다.
- 따라서 **UI는 Flutter**, **운영체제 특화 기능은 작은 전용 helper/plugin** 으로 분리하는 것이 가장 안전하다.

## 목표 디렉터리 제안

```text
apps/
  windows-agent-menu-flutter/
    lib/
      src/
        app/
        domain/
        application/
        infrastructure/
        features/
          tray/
          setup/
          logs/
          runtime/
          updates/
          diagnostics/
        platform/
          windows/
    windows/
      runner/
      tray_plugin/
      update_helper/
    test/
    integration_test/
```

## 레이어 정의

### 1. Flutter Presentation Layer

책임:

- 트레이 메뉴 상태 표현
- 설정 화면
- 로그 화면
- 업데이트 진행 표시
- 오류/진단 노출

비책임:

- 프로세스 직접 제어
- 포트 점유 검사 로직 구현
- Git/Node/Codex 설치 절차 구현
- 실행 파일 교체 절차 구현

### 2. Dart Application Layer

책임:

- macOS 의미를 Windows Flutter 앱의 use case로 옮김
- 상태 머신 관리
- 비동기 작업 순서 보장
- UI 이벤트를 도메인 명령으로 변환

핵심 서비스 후보:

- `BootstrapCoordinator`
- `RuntimeReleaseManager`
- `RuntimeSupervisor`
- `RuntimeHealthValidator`
- `CodexLoginCoordinator`
- `RuntimeUpdateCoordinator`
- `AppUpdateCoordinator`
- `DiagnosticsCoordinator`
- `AutostartCoordinator`

### 3. Dart Domain Layer

책임:

- 상태/엔티티/불변 조건 정의
- 플랫폼 독립 규칙 유지

핵심 모델 후보:

- `AgentRuntimeState`
- `RuntimeConfiguration`
- `RuntimeStatus`
- `RuntimeReleaseBuildInfo`
- `RuntimeUpdateDescriptor`
- `AppUpdateDescriptor`
- `DiagnosticItem`
- `ServiceLaunchCheck`
- `PendingLoginState`
- `PendingAppUpdateState`

### 4. Windows Infrastructure Layer

책임:

- 파일 시스템 접근
- 프로세스 시작/종료/대기
- 포트 점유 검사
- Git/Node/npm/Codex 실행
- HTTP healthcheck
- GitHub tags / 자산 확인
- `%LOCALAPPDATA%\OctOP` 경로 관리

### 5. Native Windows Adapter Layer

책임:

- 시스템 트레이 아이콘 등록/갱신
- 단일 인스턴스 보장 및 기존 인스턴스 활성화
- 로그인 시 자동 시작 등록/해제
- 앱 종료 후 실행 파일 교체 helper 실행
- 필요 시 프로세스 tree kill / 포트 조회 / detached updater 수행

권장 방향:

- 트레이/단일 인스턴스/앱 활성화는 `windows/runner` 또는 전용 plugin에서 직접 소유
- 실행 파일 교체는 `update_helper` 같은 별도 helper executable이 담당
- Flutter 메인 앱은 업데이트 helper를 실행한 뒤 정상 종료만 수행

---

## macOS 로직 → Flutter Windows 매핑

| macOS 기준 | 의미 | Flutter Windows 대상 |
| --- | --- | --- |
| `OctOPAgentMenuApp.swift` 의 `AgentMenuModel.start()` | 서비스 시작 전체 orchestration | `RuntimeSupervisor.start()` |
| `OctOPAgentMenuApp.swift` 의 `stop()` / `handleApplicationWillTerminate()` | 서비스 정지/종료 | `RuntimeSupervisor.stop()` / `shutdownForExit()` |
| `OctOPAgentMenuApp.swift` 의 `validateServiceLaunch()` | 기동 검증/헬스체크 | `RuntimeHealthValidator.validateLaunch()` |
| `OctOPAgentMenuApp.swift` 의 `refreshRuntimeStateFromSystem()` | 외부 실행중 서비스 탐지 | `RuntimeSupervisor.refreshState()` |
| `AgentBootstrapSupport.swift` 의 `ensureReadyForLaunch()` | 실행 준비 자동 보장 | `BootstrapCoordinator.ensureReadyForLaunch()` |
| `AgentBootstrapSupport.swift` 의 `prepareRuntimeCandidate()` | 새 런타임 후보 생성 | `RuntimeReleaseManager.prepareCandidate()` |
| `AgentBootstrapSupport.swift` 의 `activateRuntimeRelease()` / `rollbackRuntimeRelease()` | 포인터 전환/롤백 | `RuntimeReleaseManager.activate()` / `rollback()` |
| `AgentBootstrapSupport.swift` 의 `refreshAvailableRuntimeUpdate()` | 런타임 업데이트 감지 | `RuntimeUpdateCoordinator.refresh()` |
| `AgentBootstrapSupport.swift` 의 `loginWithBrowserSelection()` / pending login recovery | Codex 로그인 흐름 | `CodexLoginCoordinator` |
| `AgentUpdateSupport.swift` 의 `refreshAvailableAppUpdate()` / `applyAvailableAppUpdate()` | 앱 업데이트 확인/적용 | `AppUpdateCoordinator` |
| `AgentBootstrapSupport.swift` 의 `installLaunchAgent()` | 자동 시작 | `WindowsAutostartAdapter` |
| `AgentLogWindow` / `AgentSetupWindow` / `AgentMenuContent` | 로그창/설정창/메뉴 UI | Flutter `TrayMenu`, `SetupPage`, `LogPage` |

---

## 구현 범위

## 반드시 포함할 범위

### 1. 트레이/윈도우 UX

- 트레이 아이콘 상태 변경
  - 실행 중/시작 중: 컬러
  - 중지/중지 중/실패: 그레이
- 트레이 메뉴 항목
  - 앱 버전
  - 런타임 ID / 업데이트 표시
  - 서비스 상태
  - 환경 설정 필요 표시
  - 서비스 시작/정지
  - 앱 업데이트
  - 환경 설정
  - 종료
- 로그 창
- 설정 창
- 단일 인스턴스 보장

### 2. 설정/진단

- macOS/현재 Windows와 같은 설정 필드 유지
  - owner login id
  - device name
  - workspace roots
  - nats url
  - bridge host / port / token
  - app server mode / ws url
  - codex model / reasoning / approval / sandbox
  - watchdog / stale ms
  - auto start at login
- 진단 항목 표시
  - 런타임 워크스페이스
  - 관리형 node
  - 관리형 codex
  - bootstrap 리소스
  - 자동 시작 구성 상태

### 3. 런타임 준비/원자적 전환

- `%LOCALAPPDATA%\OctOP` 유지
- `runtime-releases/<runtime-id>` 구조 유지
- `runtime-current.txt`, `runtime-previous.txt` 유지
- 새 후보 staging 생성
- `.env.local`, `version.txt`, `build-info.json` 작성
- `codex-adapter` 최신화 반영
- 의존성 설치
- 기동 성공 전까지 기존 활성 런타임 불변 유지
- 실패 시 이전 런타임 롤백

### 4. 서비스 프로세스 관리

정리 대상:

- `run-local-agent.mjs`
- `run-bridge.mjs`
- `services/codex-adapter/src/index.js`
- WS `codex app-server --listen`
- `stdio://` 보조 세션
- 서비스 포트를 점유한 잔여 프로세스

필수 동작:

- 시작 전 기존 프로세스/포트 정리
- 종료 후 실제 해제 검증
- 기동 후 헬스체크 검증
- 앱 종료 직전 정리
- 업데이트 전 정리

### 5. Codex 로그인 흐름

- 브라우저 선택
- ChatGPT 로그인 시작
- pending login 저장
- 로그인 완료 대기
- account status 반영
- 재실행 시 pending login 복구/정리

### 6. 런타임 업데이트 감지

- 원격 `codex-adapter` 기준 업데이트 감지
- 현재 런타임과 원격 캐시 비교
- 메뉴에 `런타임 ID <current12> · 업데이트 <remote12>` 표시
- 백그라운드 주기 체크

### 7. 앱 업데이트

- GitHub tags / 자산 존재 확인
- 새 버전이 있을 때만 버튼 노출
- 서비스 정지 후 외부 helper가 `.exe` 교체
- launch 확인 신호 대기
- 실패 시 이전 실행 파일 롤백
- 성공 후 임시 산출물 정리

## 명시적 제외 범위

- macOS 앱 자체의 Flutter 전환
- `run-local-agent.mjs` / `run-bridge.mjs` / `codex-adapter` 기능 재작성
- OctOP 백엔드 프로토콜 변경
- 로그인 저장소 정책 변경

---

## 핵심 설계 결정

## 1. 현재 Windows 코드를 직접 포팅하지 않는다

기존 `apps/windows-agent-menu`는 참고 자료로만 사용합니다.

새 Flutter 구현은 **macOS 의미를 기준으로 새로 구성**합니다.

즉 아래 순서로 작업합니다.

1. macOS 로직을 use case 단위로 분해
2. Windows 전용 차이만 adapter로 분리
3. Flutter 앱에서 새 상태/화면/오케스트레이션 구축
4. 기존 Windows 코드와 동작 parity 확인

## 2. 트레이는 네이티브 shell, 화면은 Flutter

권장 방식:

- 트레이 아이콘/메뉴는 Windows native adapter가 관리
- 메뉴 액션은 Flutter/Dart use case 호출
- 설정/로그/진단 화면은 Flutter window로 제공

이렇게 해야 트레이 API 안정성과 Flutter UI 생산성을 동시에 확보할 수 있습니다.

## 3. 프로세스 관리는 전용 모듈로 고립

다음 책임은 UI 코드 안으로 들어가면 안 됩니다.

- 서비스 프로세스 탐지
- 포트 점유 검사
- tree kill
- 대기/재시도
- launch validation
- rollback

이 책임은 `RuntimeSupervisor` / `ProcessInspector` / `PortInspector` / `RuntimeHealthValidator` 계층으로 분리해야 합니다.

## 4. 앱 업데이트는 반드시 외부 helper가 적용

Windows에서는 실행 중인 `.exe`를 자기 자신이 덮어쓸 수 없습니다.

따라서 새 Flutter 앱도 아래 구조를 사용해야 합니다.

1. Flutter 앱이 업데이트 준비 완료
2. 외부 `update_helper` 실행
3. 앱이 정상 종료
4. helper가 종료 대기 / 파일 교체 / 롤백 / 재실행 담당

기존 앱 프로세스가 직접 파일 교체를 시도하면 다시 불안정해집니다.

---

## 단계별 구현 계획

## Phase 0. 기준 고정

목표:

- macOS 기준 로직과 Windows 재작성 범위를 고정한다.

산출물:

- 이 문서 확정
- 소스 기준표 확정
- parity acceptance list 확정

## Phase 1. Flutter Windows 앱 골격 생성

목표:

- 새 앱 뼈대를 만들고 기존 Windows 앱과 공존 가능하게 준비한다.

작업:

- `apps/windows-agent-menu-flutter` 생성
- Flutter Windows desktop 초기화
- 앱 아이콘/브랜딩 이식
- 멀티윈도우/트레이 shell 기본 연결
- 단일 인스턴스 처리

완료 기준:

- 트레이에서 앱 표시 가능
- 설정 창/로그 창 빈 화면까지 열림
- 기존 Windows 앱과 별도 경로에서 실행 가능

## Phase 2. 도메인/상태 머신 이식

목표:

- macOS 의미를 Dart 상태/유스케이스로 옮긴다.

작업:

- `AgentRuntimeState` 정의
- 앱 상태 스토어 정의
- 로그 버퍼링 정책 정의
- 서비스 시작/정지/실패 상태 전이 정의
- 앱/런타임 업데이트 상태 정의

완료 기준:

- UI 없이도 상태 전이 테스트 가능

## Phase 3. 런타임/bootstrap 계층 구현

목표:

- macOS의 `AgentBootstrapStore` 책임을 Windows Flutter에서 재구성한다.

작업:

- `%LOCALAPPDATA%\OctOP` 경로 관리
- 설정 load/save
- bridge id 생성/지속화
- 관리형 node/codex 준비
- runtime release staging
- `build-info.json` / `.env.local` / `version.txt` 생성
- runtime pointer 전환/롤백
- stale release 정리

완료 기준:

- 새 후보 생성과 활성 포인터 전환이 독립 테스트 가능
- 현재 활성 런타임을 건드리지 않고 새 후보 생성 가능

## Phase 4. 서비스 supervisor 구현

목표:

- macOS의 start/stop/launch validation 의미를 Windows에서 동일하게 구현한다.

작업:

- 서비스 시작 orchestration
- 기존 관리 프로세스 탐지
- tree kill 및 재검증
- 브릿지/WS 포트 해제 대기
- `run-local-agent` 시작
- stdout/stderr 로그 스트리밍
- 기동 검증
- 실패 시 롤백
- 앱 종료 경로 정리

완료 기준:

- 시작/정지/재시작/종료가 모두 동일한 상태 머신으로 동작
- `stdio://` 세션 처리 포함

## Phase 5. 로그인/자동 시작/진단 구현

목표:

- setup UX와 운영 기능을 macOS 수준으로 맞춘다.

작업:

- 브라우저 선택 로그인
- pending login 저장/복구
- Codex 로그인 상태 조회
- 자동 시작 등록/해제
- 진단 항목 계산
- 환경 설정 저장 직후 진단 갱신

완료 기준:

- 설정창만으로 실행 준비 상태까지 만들 수 있음

## Phase 6. 앱/런타임 업데이트 구현

목표:

- macOS와 같은 의미로 업데이트를 분리한다.

작업:

- 런타임 업데이트 감지 주기 작업
- 앱 업데이트 availability 확인
- 외부 `update_helper` 구현
- launch marker / pending update state 구현
- 롤백/정리 절차 구현

완료 기준:

- 새 버전 감지, 교체, 실패 복구, 성공 후 정리 가능

## Phase 7. UI polish 및 기존 앱 대체 준비

목표:

- 실제 운영 전환 가능한 UX와 설치 산출물을 만든다.

작업:

- 메뉴/상태/버튼/오류 문구 정리
- 설정/로그 화면 polish
- 아이콘/색상/윈도우 동작 정리
- 배포 산출물 및 설치 경로 정리
- 기존 앱 대체 전략 수립

완료 기준:

- Flutter 버전이 기존 Windows 앱을 기능적으로 대체 가능

---

## 구현 체크리스트

## A. 프로젝트 골격

- [ ] `apps/windows-agent-menu-flutter` 생성
- [ ] Flutter Windows desktop 초기화
- [ ] 앱 이름/아이콘/버전 표기 연결
- [ ] 기본 실행 진입점 구성
- [ ] 개발/릴리즈 빌드 스크립트 정리
- [ ] 기존 `apps/windows-agent-menu` 와 병행 실행 가능한 임시 앱 ID/이름 정리

## B. Windows shell / tray

- [ ] 단일 인스턴스 락 구현
- [ ] 기존 인스턴스 활성화 구현
- [ ] 트레이 아이콘 생성
- [ ] 트레이 메뉴 구성
- [ ] 상태별 아이콘 전환 구현
- [ ] 설정 창 열기/포커스 구현
- [ ] 로그 창 열기/포커스 구현
- [ ] 종료 액션 연결
- [ ] 앱을 일반 메인 창 없이 accessory 스타일로 운영하도록 정리

## C. 상태 관리 / 도메인 모델

- [ ] `AgentRuntimeState` 정의
- [ ] `RuntimeConfiguration` 정의
- [ ] `RuntimeStatus` 정의
- [ ] `RuntimeUpdateDescriptor` 정의
- [ ] `AppUpdateDescriptor` 정의
- [ ] `DiagnosticItem` 정의
- [ ] `PendingLoginState` 정의
- [ ] `PendingAppUpdateState` 정의
- [ ] 로그 라인 버퍼 정책(max lines) 정의
- [ ] 상태 전이 표 작성 및 테스트 추가

## D. 경로 / 저장소 계층

- [ ] `%LOCALAPPDATA%\OctOP` 경로 관리 구현
- [ ] `runtime-releases` / `runtime-current.txt` / `runtime-previous.txt` 경로 구현
- [ ] `config.json`, `state`, `pending-login`, `pending-service-start` 경로 구현
- [ ] bridge id 파일 읽기/쓰기 구현
- [ ] 전역 `CODEX_HOME` 우선 선택 규칙 구현
- [ ] 인증 저장소와 로컬 상태 저장소 분리 보장

## E. 설정 / 진단

- [ ] 설정 load/save 구현
- [ ] workspace roots 파싱 구현
- [ ] extra env 파싱 구현
- [ ] 진단 항목 계산 구현
- [ ] 관리형 node 존재 여부 진단 구현
- [ ] 관리형 codex 존재 여부 진단 구현
- [ ] bootstrap 리소스 진단 구현
- [ ] 자동 시작 구성 진단 구현
- [ ] 설정 저장 직후 진단 새로고침 구현

## F. bootstrap / runtime release

- [ ] bootstrap 리소스 소스 경로 결정 구현
- [ ] 최신 `codex-adapter` source 준비 구현
- [ ] runtime source hash 계산 구현
- [ ] configuration hash 계산 구현
- [ ] runtime ID 생성 구현
- [ ] staging release 생성 구현
- [ ] `.env.local` 생성 구현
- [ ] `version.txt` 생성 구현
- [ ] `build-info.json` 생성 구현
- [ ] `npm install --omit=dev` 실행 구현
- [ ] 필수 파일 검증 구현
- [ ] prepared runtime 재사용 판정 구현
- [ ] active pointer 전환 구현
- [ ] previous pointer 기록 구현
- [ ] rollback 구현
- [ ] stale release cleanup 구현

## G. Node / Codex 준비

- [ ] 관리형 node 탐지 구현
- [ ] 시스템 node import 구현 또는 설치 fallback 구현
- [ ] 관리형 codex 탐지 구현
- [ ] 시스템 codex import 구현 또는 설치 fallback 구현
- [ ] 실행 PATH 구성 구현
- [ ] runtime process environment 구성 구현
- [ ] launch environment 구성 구현

## H. 서비스 supervisor

- [ ] 관리 프로세스 탐지 구현
- [ ] 서비스 프로세스와 `stdio://` 세션 구분 구현
- [ ] 포트 점유 프로세스 탐지 구현
- [ ] process tree kill 구현
- [ ] 종료 grace period + 강제 종료 구현
- [ ] 브릿지 포트 해제 대기 구현
- [ ] WS app-server 포트 해제 대기 구현
- [ ] 시작 전 기존 프로세스 정리 구현
- [ ] `run-local-agent.mjs` 실행 구현
- [ ] stdout/stderr 로그 스트리밍 구현
- [ ] 외부 서비스 감지 후 상태 반영 구현
- [ ] 종료 이벤트 처리 구현
- [ ] PID 마커 기록/정리 구현

## I. 기동 검증 / 헬스체크

- [ ] `run-local-agent` 기동 확인 구현
- [ ] `run-bridge` 기동 확인 구현
- [ ] `codex-adapter` 기동 확인 구현
- [ ] WS `codex app-server` 기동 확인 구현
- [ ] 활성 runtime 경로 기준 기동 확인 구현
- [ ] 브릿지 포트 바인딩 확인 구현
- [ ] WS 포트 바인딩 확인 구현
- [ ] `/health` 호출 구현
- [ ] `bridgeHost=0.0.0.0/::/[::]/빈값 -> 127.0.0.1 probe` 규칙 구현
- [ ] launch validation 실패 시 rollback 구현
- [ ] healthcheck.json 기록 구현

## J. 런타임 업데이트 감지

- [ ] 원격 저장소 캐시 clone/fetch/reset 구현
- [ ] `services/codex-adapter` content hash 비교 구현
- [ ] override source path 규칙 구현
- [ ] 주기적 업데이트 체크 작업 구현
- [ ] 메뉴 런타임 업데이트 표시 구현
- [ ] update available 로그 기록 구현

## K. Codex 로그인

- [ ] 브라우저 선택 UI 구현
- [ ] Codex app-server session 래퍼 구현
- [ ] 로그인 시작 구현
- [ ] pending login 저장 구현
- [ ] 브라우저 열기 구현
- [ ] 로그인 완료 대기 구현
- [ ] account status 조회 구현
- [ ] relogin 구현
- [ ] logout 구현
- [ ] 재실행 시 pending login recovery 구현
- [ ] 로그인 상태 문구 반영 구현

## L. 자동 시작

- [ ] Windows 자동 시작 adapter 구현
- [ ] Registry Run key 방식 구현
- [ ] Startup shortcut fallback 구현
- [ ] enable/disable idempotent 처리 구현
- [ ] 설정값과 실제 구성 상태 비교 구현

## M. 앱 업데이트

- [ ] GitHub tags 조회 구현
- [ ] 최신 버전 semver 비교 구현
- [ ] 자산 존재 여부 확인 구현
- [ ] 업데이트 버튼 노출 조건 구현
- [ ] 업데이트 다운로드 구현
- [ ] 임시 staging 폴더 구조 구현
- [ ] pending app update state 기록 구현
- [ ] launch marker 기록 구현
- [ ] 외부 `update_helper` 설계/구현
- [ ] 앱 종료 대기 구현
- [ ] 서비스/포트 재검증 구현
- [ ] 기존 `.exe` 백업 구현
- [ ] 새 `.exe` 설치 구현
- [ ] 실패 시 롤백 구현
- [ ] 성공 시 새 앱 재실행 구현
- [ ] 성공 후 임시 파일 정리 구현

## N. Flutter UI

- [ ] 트레이 메뉴 상태 뷰 구현
- [ ] 앱 버전/런타임 ID 라인 구현
- [ ] 서비스 시작/정지 버튼 구현
- [ ] 앱 업데이트 버튼 구현
- [ ] 환경 설정 버튼 구현
- [ ] 종료 버튼 구현
- [ ] last error 노출 구현
- [ ] 로그 뷰어 구현
- [ ] 로그 지우기 구현
- [ ] 설정 폼 구현
- [ ] 설치/로그인/진단 상태 UI 구현
- [ ] 업데이트 진행 상태 UI 구현

## O. 테스트

- [ ] 도메인 상태 전이 단위 테스트
- [ ] runtime ID 생성 테스트
- [ ] configuration hash 테스트
- [ ] prepared runtime 재사용 테스트
- [ ] pointer 전환/rollback 테스트
- [ ] 프로세스 탐지/정지 테스트
- [ ] 포트 해제 대기 테스트
- [ ] launch validation 테스트
- [ ] pending login 저장/복구 테스트
- [ ] app update availability 테스트
- [ ] update helper 롤백 테스트
- [ ] 단일 인스턴스 동작 테스트
- [ ] auto start 등록/해제 테스트
- [ ] smoke integration test 작성

## P. 전환 준비

- [ ] 기존 `apps/windows-agent-menu` 대비 기능 parity 표 작성
- [ ] macOS 기준 parity 표 작성
- [ ] 배포 산출물 이름/경로 확정
- [ ] 설치/업데이트/재실행 절차 검증
- [ ] 이전 앱 대체/폐기 계획 정리
- [ ] 운영 로그 수집 포인트 확정

---

## 수용 기준

아래가 만족되면 재작성 1차 완료로 봅니다.

1. 새 Flutter 앱이 트레이/설정/로그 UI를 안정적으로 제공한다.
2. 서비스 시작/정지/종료 의미가 macOS 앱과 동일하다.
3. 런타임 후보 준비, 포인터 전환, 롤백이 동작한다.
4. `stdio://` 보조 세션 정책이 유지된다.
5. Codex 로그인과 pending login recovery가 동작한다.
6. 런타임 업데이트 감지와 앱 업데이트가 분리돼 동작한다.
7. Windows 자동 시작, 단일 인스턴스, 외부 updater helper가 안정적으로 동작한다.
8. 기존 Windows 앱 없이도 운영 가능한 수준의 parity가 확보된다.

---

## 최종 정리

이번 작업의 본질은 `Windows UI를 Flutter로 바꾸는 것`이 아니라, 다음을 동시에 달성하는 것입니다.

- **UI는 Flutter로 재구성**하고
- **운영 의미는 macOS와 동일하게 맞추고**
- **Windows 전용 위험 구간은 전용 adapter/helper로 분리**해서
- **프로세스 관리와 업데이트 안정성을 구조적으로 회복**하는 것

따라서 구현은 반드시 `기존 Windows 코드 포팅`이 아니라 `macOS 로직 기준 재구성`으로 진행해야 합니다.
