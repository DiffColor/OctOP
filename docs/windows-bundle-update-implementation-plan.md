# Windows Bundle Update Implementation Plan

## 목적

Windows 트레이 앱의 번들 업데이트를 서비스 제어와 분리하고, 명시적인 `번들 업데이트` 버튼을 통해서만 안전하게 앱 실행 파일 교체가 일어나도록 정리합니다.

Windows는 macOS와 달리 `.app` 번들이 아니라 self-contained single-file `.exe`를 게시하므로, 문서에서는 사용자 용어 일관성을 위해 `번들 업데이트`라고 부르되 실제 교체 대상은 실행 파일과 앱 로컬 데이터입니다.

Windows 번들 업데이트의 핵심은 데이터 복원이 아니라, 기존 앱/서비스 프로세스와 서비스 포트가 완전히 해제된 상태에서만 실행 파일 교체를 수행하는 것입니다.

이 문서는 구현 중 빠뜨리기 쉬운 항목을 줄이기 위한 계획서이자 체크리스트입니다.

## 기능 정의

- `서비스 시작`
  - 앱을 제외한 서비스 구성요소를 모두 정상 기동합니다.
- `서비스 정지`
  - 앱을 제외한 OctOP 관련 프로세스를 모두 종료합니다.
- `종료`
  - 서비스 정지 후 앱을 종료합니다.
- `번들 업데이트`
  - Windows 앱 실행 파일을 새 버전으로 교체합니다.
  - 서비스 시작/정지와 분리된 명시적 동작입니다.

## Windows 현재 구조 요약

- 기본 설치 루트: `%LOCALAPPDATA%\\OctOP`
  - 코드: [OctopPaths.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/OctopPaths.cs#L30)
- 런타임 루트: `%LOCALAPPDATA%\\OctOP\\runtime`
  - 코드: [OctopPaths.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/OctopPaths.cs#L7)
- 앱 로컬 상태 저장소: `%LOCALAPPDATA%\\OctOP\\state`
  - 코드: [OctopPaths.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/OctopPaths.cs#L13)
- 앱 로컬 Codex 홈: `%LOCALAPPDATA%\\OctOP\\codex-home`
  - 코드: [OctopPaths.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/OctopPaths.cs#L12)
- 현재 Windows 자동 업데이트 자산:
  - `OctOP.WindowsAgentMenu-win-x64-vX.Y.Z.exe`
  - README: [README.md](/Users/jazzlife/Documents/Workspaces/Products/OctOP/README.md#L191)

## 번들 업데이트 대상과 비대상

### 번들 업데이트 대상

- 현재 실행 중인 Windows `.exe`
- 업데이트 가능 여부 조회와 메뉴 노출
- 업데이트 실패 시 롤백
- 업데이트 성공 후 백업 정리
- 인증 참조 위치 명세와 검증
- 프로세스/포트 종료 검증

### 번들 업데이트 비대상

- `codex-adapter` 실시간 Git 동기화
- 서비스 재사용 로직 재설계
- 서비스 시작/정지 의미 재정의 외의 UX 개편
- 정상 업데이트 경로에서의 앱 데이터 복원

## 핵심 요구사항

1. `번들 업데이트` 버튼은 GitHub 릴리즈 기준으로 새 Windows 실행 파일이 있을 때만 보여야 합니다.
2. 버튼은 일반 메뉴 항목보다 눈에 띄어야 하므로 색상을 적용해야 합니다.
3. 업데이트 시작 전에 앱은 서비스와 관련된 프로세스와 포트가 완전히 해제된 상태여야 합니다.
4. 업데이트 중 실패 시, 이전 실행 파일로 완전 복구되어야 합니다.
5. 업데이트 성공 후 새 실행 파일은 기존 데이터를 건드리지 않은 상태로 실행되어야 합니다.
6. 새 실행 파일이 정상 실행되면 백업 폴더와 임시 산출물은 정리되어야 합니다.

## 인증 참조 명세

### README 기준 기대 동작

README에는 Windows 앱이 인증 저장소를 앱 전용 `CODEX_HOME` 아래로 분리한다고 적혀 있습니다.

- [README.md](/Users/jazzlife/Documents/Workspaces/Products/OctOP/README.md#L139)

### 현재 코드 기준 실제 동작

현재 Windows 코드는 `CODEX_HOME` 결정 시 아래 후보를 우선순위로 확인합니다.

1. 환경변수 `CODEX_HOME`
2. `%USERPROFILE%\\.codex`
3. 앱 로컬 `paths.CodexHome`

- 코드: [RuntimeInstaller.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/RuntimeInstaller.cs#L387)

즉 현재 구현은 README 설명과 달리 전역 인증 저장소를 참조할 수 있습니다.

### 번들 업데이트에서 지켜야 할 원칙

- 번들 업데이트는 실제 인증 참조 위치를 문서와 코드에서 명시적으로 일치시켜야 합니다.
- 번들 업데이트는 인증 저장소를 임의 복사/이동/덮어쓰기하면 안 됩니다.
- 인증 저장소가 앱 로컬인지 전역인지 정책을 먼저 확정한 뒤, 백업/복원 대상에서 일관되게 처리해야 합니다.

### 현재 문서의 기본 원칙

이 문서는 다음 원칙으로 작성합니다.

- 인증 저장소는 번들 업데이트 대상이 아니라 참조 정책 대상입니다.
- 업데이트 문서에서는 인증 참조 위치를 먼저 확정해야 하며, 확정 전까지는 백업/복원 대상을 로컬 데이터와 분리해 다룹니다.

## 현재 코드 기준 문제 요약

- Windows 자동 업데이트가 `재시작` 경로와 섞여 있습니다.
- 현재 업데이트는 `.exe` 교체 중심이고, 데이터 전체 롤백 보장이 약합니다.
- 데이터 백업/복원이 부분 복사 중심입니다.
- 성공/실패 판정 후 정리 타이밍이 명확히 분리되어 있지 않습니다.
- 업데이트 버튼이 별도 메뉴 개념으로 존재하지 않습니다.
- 인증 저장소 정책이 README와 코드 사이에서 일치하지 않습니다.

## 목표 상태

### 메뉴/상태

- 최신 번들이 없으면 `번들 업데이트` 버튼을 숨깁니다.
- 최신 번들이 있으면 `번들 업데이트` 버튼을 표시합니다.
- 버튼 라벨에는 새 버전 정보가 포함될 수 있습니다.
- 버튼은 색상으로 강조합니다.

### 업데이트 실행

- 사용자가 `번들 업데이트`를 누릅니다.
- 앱은 서비스 정지 절차를 수행합니다.
- 외부 업데이트 프로세스가 앱 종료를 기다립니다.
- 앱/서비스 관련 프로세스와 서비스 포트 해제를 확인합니다.
- 기존 실행 파일을 백업 위치로 이동합니다.
- GitHub에서 받은 새 실행 파일을 설치합니다.
- 새 실행 파일을 실행합니다.

### 실패 복구

- 설치 실패 시 기존 실행 파일을 복원합니다.
- 복구 후 이전 앱을 자동 실행합니다.

### 성공 후 정리

- 새 실행 파일 실행 후 백업 폴더가 남아 있으면 삭제합니다.
- 임시 업데이트 다운로드 폴더도 삭제합니다.
- 앱 로컬 데이터는 정상 경로에서 복원하지 않습니다.

## 제안 구현 구조

### 1. 업데이트 상태 조회 계층

Windows 트레이 컨텍스트 또는 업데이트 전용 상태 객체에 다음 상태를 둡니다.

- 최신 번들 존재 여부
- 최신 버전 태그
- 현재 버전 태그
- 업데이트 확인 진행 중 상태
- 마지막 업데이트 확인 에러

현재 관련 코드:

- [GitHubTagUpdateClient.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/GitHubTagUpdateClient.cs)
- [WindowsAutoUpdater.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/WindowsAutoUpdater.cs)

### 2. 메뉴 계층

`AgentTrayApplicationContext.cs`에서:

- `재시작` 메뉴와 번들 업데이트를 분리합니다.
- `번들 업데이트` 메뉴를 새로 추가합니다.
- 새 버전이 있을 때만 렌더링합니다.
- 색상 강조 또는 대체 시각 강조를 적용합니다.

현재 재시작 메뉴:

- [AgentTrayApplicationContext.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/windows-agent-menu/AgentTrayApplicationContext.cs#L87)

### 3. 업데이트 실행 계층

`WindowsAutoUpdater.cs`에서:

- 최신 릴리즈 조회
- 실행 파일 다운로드
- 외부 PowerShell 스크립트 생성
- 교체 스크립트 실행

여기에 다음 책임을 추가합니다.

- 서비스 정지 완료 검증
- 앱 종료 완료 검증
- 포트 해제 확인
- 전체 백업/전체 복원
- 롤백 스크립트 분기
- 성공 후 백업 정리 검증

### 4. 데이터 보호 계층

`AgentTrayApplicationContext.cs`에서:

- 현재 `PreserveAppDataForUpdate` / `RestorePreservedAppDataIfNeeded`를 Windows 번들 업데이트 기준에 맞게 재정리합니다.

원칙:

- 정상 번들 업데이트 경로에서는 앱 로컬 데이터를 복원하지 않습니다.
- 앱 로컬 데이터는 실행 파일 위치와 분리되어 있으므로, 정상 업데이트 경로에서는 그대로 유지되어야 합니다.
- 데이터 백업/복원은 일반 절차가 아니라 예외적 손상 복구 정책으로만 다룹니다.

## 데이터 취급 원칙

정상 Windows 번들 업데이트에서는 아래 원칙을 따릅니다.

- 앱 로컬 데이터는 `%LOCALAPPDATA%\\OctOP` 아래에 그대로 둡니다.
- 새 실행 파일 설치를 위해 데이터를 다른 위치로 옮길 필요가 없습니다.
- 정상 성공 경로에서는 데이터 복원 단계가 없습니다.
- 데이터 복구는 예외 상황에서만 별도 재해복구 절차로 수행합니다.

정상 업데이트 경로에서 건드리지 않아야 할 데이터:

- `config.json`
- `bridge-id.txt`
- `pending-login.json`
- `pending-service-start`
- `codex-home`
- `state`
- `%USERPROFILE%\\.codex`
- 외부 `CODEX_HOME`

추가 판단 필요:

- `runtime`을 실행 파일과 함께 번들 자산으로 볼지
- `tools/node`, `tools/npm-global`을 유지 자산으로 볼지 별도 재생성 대상으로 볼지

## 백업 폴더 구조 제안

예시:

```text
%LOCALAPPDATA%\OctOP.update-backup\
  app\
    OctOP.WindowsAgentMenu.exe
  meta\
    target-version.txt
    started-at.txt
    status.json
```

## 업데이트 스크립트 요구사항

외부 PowerShell 스크립트는 앱 종료 후에도 계속 실행될 수 있어야 합니다.

필수 단계:

1. 기존 앱 PID 종료 대기
2. 서비스 관련 프로세스 잔존 여부 확인
3. 서비스 포트 해제 여부 확인
4. 기존 백업 폴더 정리 또는 충돌 방지
5. 현재 실행 파일 백업
6. 새 실행 파일 설치
7. 실패 시 실행 파일 롤백
8. 성공 시 새 앱 실행

## 포트/프로세스 확인 원칙

업데이트 직전 정리 대상:

- `run-local-agent.mjs`
- `run-bridge.mjs`
- `services\\codex-adapter\\src\\index.js`
- `codex app-server --listen ws://...`
- 필요 시 `codex app-server --listen stdio://`

포트 확인 대상:

- 브릿지 포트
- 서비스용 WS app-server 포트

주의:

- 업데이트 스크립트는 “앱 종료 전 정리”와 “앱 종료 후 잔여 확인”을 둘 다 가져야 합니다.
- 프로세스/포트 종료 확인 전에는 실행 파일 교체를 시작하면 안 됩니다.
- 단순 강제 종료보다, 정리 실패를 감지하고 업데이트를 중단하는 쪽이 우선입니다.

## 실패 시 롤백 원칙

아래 중 하나라도 실패하면 롤백합니다.

- 새 실행 파일 설치 실패
- 새 앱 실행 실패
- 새 앱 첫 실행 확인 실패

롤백 절차:

1. 새로 설치한 실행 파일 제거
2. 백업 실행 파일 원위치 복원
3. 이전 앱 실행
4. 롤백 실패 시 사용자에게 명확한 진단 로그 남김

## 성공 판정 원칙

다음이 만족되면 성공으로 봅니다.

- 새 실행 파일이 설치 위치에서 실행됨
- 새 앱이 시작됨
- 기존 로컬 데이터가 손대지 않은 상태로 유지됨
- 복구 대상 백업 폴더가 더 이상 필요하지 않음

성공 후 정리:

- 백업 폴더 삭제
- staging 백업 폴더 삭제
- 임시 다운로드 폴더 삭제
- 이전 실행 파일 `.previous-update` 삭제

## 자동 업데이트와의 관계

구현 시 정리 필요:

- 앱 시작 시 자동으로 실행 파일 교체가 일어나는 경로는 제거하거나 비활성화
- `번들 업데이트` 버튼만 명시적 진입점으로 유지
- 자동 업데이트 설정은 별도 정책으로 남길지 여부 결정

권장:

- 우선 수동 `번들 업데이트`만 유지
- 자동 업데이트는 후속 작업으로 분리

## 체크리스트

### A. 상태/메뉴

- [ ] 최신 Windows 번들 조회 상태 모델 추가
- [ ] 현재 버전과 최신 버전 비교 로직 정리
- [ ] 새 버전이 있을 때만 `번들 업데이트` 메뉴 노출
- [ ] 메뉴 텍스트 색상 또는 대체 시각 강조 적용
- [ ] 업데이트 확인 중/실패 상태를 메뉴 또는 로그에 반영
- [ ] 인증 참조 위치를 UI/로그/문서에서 혼동 없이 표현

### B. 진입점 분리

- [ ] `재시작` 경로에서 실행 파일 교체 책임 제거
- [ ] 앱 시작 시 자동 번들 교체 경로 제거 또는 비활성화
- [ ] `번들 업데이트` 전용 액션 추가

### C. 사전 종료 검증

- [ ] 서비스 정지 호출
- [ ] 앱 본체 PID 종료 확인
- [ ] `run-local-agent` 종료 확인
- [ ] 브릿지 종료 확인
- [ ] WS app-server 종료 또는 해제 확인
- [ ] 필요 시 `stdio://` 세션 종료 확인
- [ ] 서비스 포트 해제 확인
- [ ] 프로세스/포트 해제 실패 시 업데이트 중단

### D. 백업

- [ ] 기존 실행 파일 전체 백업
- [ ] 실행 파일 백업 구조 정리
- [ ] 백업 메타 정보 저장
- [ ] 인증 정책과 무관한 전역 인증 저장소가 백업/복원 대상에서 제외되는지 검증

### E. 설치

- [ ] 최신 실행 파일 다운로드
- [ ] 새 실행 파일 유효성 확인
- [ ] 설치 위치에 새 실행 파일 배치

### F. 데이터 복원

- [ ] 정상 번들 업데이트 경로에서 데이터 복원이 수행되지 않는지 검증
- [ ] 새 실행 파일이 기존 설정/상태를 그대로 읽는지 보장
- [ ] 데이터 무변경 원칙이 지켜지는지 검증
- [ ] 전역 인증 저장소를 건드리지 않는지 검증

### G. 롤백

- [ ] 설치 실패 시 실행 파일 롤백
- [ ] 롤백 후 이전 앱 자동 실행
- [ ] 롤백 실패 로그 명확화

### H. 성공 후 정리

- [ ] 새 앱 첫 실행 후 백업 폴더 삭제
- [ ] staging 백업 폴더 삭제
- [ ] 임시 다운로드 폴더 삭제
- [ ] `.previous-update` 삭제

### I. 검증

- [ ] 최신 버전 없음: 메뉴 미노출 확인
- [ ] 최신 버전 있음: 메뉴 노출/강조 확인
- [ ] 정상 업데이트 전 프로세스/포트 해제 확인
- [ ] 정상 업데이트 후 데이터 무변경 유지 확인
- [ ] 업데이트 실패 후 이전 상태 복구 확인
- [ ] 백업 폴더 잔존 시 다음 실행에서 정리 또는 복구 동작 확인
- [ ] 서비스 중 실행, 서비스 정지 상태 실행, 앱 재실행 후 복구 각각 검증
- [ ] 업데이트 전후 실제 인증 파일 참조 위치가 변하지 않는지 확인

## 구현 전 확인할 세부 쟁점

- GitHub 릴리즈를 계속 사용할지, 별도 Git 기반 번들 배포를 쓸지
- 앱 로컬 데이터 중 “복사”와 “이동” 중 어느 쪽이 더 안전한지
- 새 앱 첫 실행 성공을 어떤 신호로 판정할지
- `stdio://` 세션을 번들 업데이트 종료 대상에 항상 포함할지
- `runtime` 전체를 데이터로 볼지, 재생성 대상으로 볼지
- 인증 저장소 정책을 README 기준 앱 로컬로 고정할지, 현재 코드 기준 다중 후보를 유지할지

## 권장 구현 순서

1. 업데이트 상태 조회/메뉴 노출
2. 번들 업데이트 전용 메뉴 추가
3. 프로세스/포트 종료 검증 구조 정리
4. 업데이트 스크립트의 실행 파일 백업/롤백 구조 정리
5. 기존 자동 업데이트/재시작과 실행 파일 교체 분리
6. 인증 저장소 정책 명시화
7. 성공/실패 후 정리 및 복구 검증
