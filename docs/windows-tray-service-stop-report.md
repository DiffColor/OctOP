# Windows Tray Service Stop Report

## 목적

윈도우 트레이앱의 `서비스 정지` 동작을 현재 코드 기준으로 다시 정리하고, 실제 누락된 부분을 복구한 기록입니다.

대상 코드는 다음입니다.

- `apps/windows-agent-menu/AgentTrayApplicationContext.cs`
- `docs/windows-service-runtime-atomic-update-plan.md`
- `docs/windows-bundle-update-implementation-plan.md`

## 현재 코드에서 확인한 서비스 정지 규칙

현재 트레이앱이 정리해야 하는 대상은 단순히 `run-local-agent` 하나가 아닙니다.

- `run-local-agent.mjs`
- `run-bridge.mjs`
- `services/codex-adapter/src/index.js`
- WS `codex app-server --listen`
- 종료/업데이트 전에 함께 정리해야 하는 `stdio://` 보조 세션
- 서비스 포트를 점유한 잔여 프로세스

현재 구현은 `CollectStopTargetProcessIds()`로 관리 대상 PID와 서비스 포트 점유 PID를 모으고, `FindStdioSessionProcessIds()`로 `stdio://` 세션도 중지 대상에 포함합니다.

## 문제

수동 `서비스 정지` 버튼 경로는 업데이트/재시작에서 사용하는 공통 정지 함수와 다르게 동작하고 있었습니다.

확인된 차이는 아래와 같습니다.

1. `Stop()`이 중지 시작 시점을 `Stopping`이 아니라 즉시 `Stopped`로 기록하고 있었습니다.
2. 수동 `StopAsync()`는 프로세스를 한 번 강제 종료한 뒤 포트 해제만 기다렸고, 관리 프로세스 잔존 여부를 다시 검증하지 않았습니다.
3. 반면 업데이트/재시작 경로는 `StopServiceProcessesAsync()`를 사용하고 있어서, 수동 정지만 더 약한 종료 규칙을 갖고 있었습니다.

이 차이 때문에 수동 정지에서 아래 문제가 생길 수 있었습니다.

- 종료 이벤트가 `Stopping` 상태로 인식되지 않아 일시적으로 실패 상태가 섞일 수 있음
- `stdio://` 세션이나 서비스 하위 프로세스가 남았는데도 정지가 끝난 것처럼 보일 수 있음
- 문서에 적어둔 `서비스 정지 후 종료 검증` 원칙과 실제 수동 정지 동작이 어긋남

## 적용한 수정

`apps/windows-agent-menu/AgentTrayApplicationContext.cs` 에 아래를 반영했습니다.

1. `Stop()`은 이제 정지 시작 시 `AgentRuntimeState.Stopping`으로 상태를 바꿉니다.
2. 수동 `StopAsync()`도 업데이트/재시작과 동일하게 `StopServiceProcessesAsync(includeStdioSessions: true, logWhenIdle: true)`를 사용합니다.
3. 공통 정지 함수에서 남은 관리 프로세스와 서비스 포트 리스너를 다시 확인해, 끝까지 남아 있으면 실패로 처리하도록 정리합니다.

## 이번 수정 후 보장되는 것

- 수동 `서비스 정지`와 업데이트 전 `서비스 정지`가 같은 규칙으로 동작합니다.
- 트레이 UI 상태가 `Stopping -> Stopped` 흐름으로 맞춰집니다.
- `stdio://` 보조 세션과 서비스 포트 점유 프로세스가 남아 있으면 성공으로 처리하지 않습니다.
- 정지 실패는 로그와 상태에 남습니다.

## 남아 있는 리스크

앱 `종료` 경로는 프로세스 종료 직전에 동기적으로 `StopServiceProcessesImmediatelyForExit()`를 사용합니다.

이 경로는 앱 자체가 즉시 내려가야 해서 수동 정지 경로만큼 강한 비동기 재검증을 하지는 않습니다. 이번 수정 범위는 사용자가 직접 누르는 `서비스 정지`와 그 공통 정지 규칙 복구에 한정했습니다.

종료 경로까지 같은 수준으로 끌어올리려면, 앱 종료 수명주기와 충돌하지 않는 별도 정리 설계가 추가로 필요합니다.
