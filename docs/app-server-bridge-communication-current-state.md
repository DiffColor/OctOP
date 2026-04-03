# app-server와 bridge 통신/복구 현재 코드 상태

작성 기준 시점: 2026-04-03

## 범위

이 문서는 현재 코드 기준으로 `bridge`가 `app-server`와 어떻게 통신하고, 연결 이상 시 어떤 복구를 수행하는지 정리한 문서입니다.

주요 확인 대상 파일:

- `services/codex-adapter/src/index.js`
- `scripts/run-local-agent.mjs`
- `scripts/local-agent-health.mjs`
- `scripts/run-bridge.mjs`
- `scripts/run-app-server.mjs`
- `tests/integration/local-agent-health.test.mjs`

참고:

- `apps/windows-agent-menu/CodexAppServerSession.cs`에도 별도의 app-server 클라이언트가 있지만, 이는 `bridge` 경유가 아닌 메뉴 앱의 직접 `stdio` 연결 경로이므로 이 문서의 주 범위에서는 제외했습니다.

## 1. 현재 통신 구조

현재 `bridge`와 `app-server`의 주 통신 경로는 `WebSocket + JSON-RPC`입니다.

- `bridge`는 `APP_SERVER_WS_URL` 환경변수로 app-server WebSocket 주소를 사용합니다.
- 기본값은 `ws://127.0.0.1:4600`입니다.
- `bridge` 내부 `AppServerClient`가 WebSocket을 열고 JSON-RPC 요청/응답 및 notification을 처리합니다.
- `bridge`는 필요 시 `APP_SERVER_COMMAND`로 app-server 프로세스를 직접 실행할 수 있습니다.
- `scripts/run-local-agent.mjs`를 사용하면, 상위 런처가 `app-server`와 `bridge`를 별도 프로세스로 띄우고 외부에서 상태를 감시합니다.

정리하면 현재 구조는 아래 두 층으로 나뉩니다.

1. `bridge` 내부 복구
   `services/codex-adapter/src/index.js`의 `AppServerClient`
2. 상위 프로세스 복구
   `scripts/run-local-agent.mjs`

## 2. bridge 내부 app-server 연결 방식

`AppServerClient.ensureReady()`가 연결 진입점입니다.

연결 순서:

1. 필요 시 `startProcess()`로 app-server 실행
2. `connectSocket()`으로 WebSocket 연결 시도
3. JSON-RPC `initialize` 요청
4. `initialized` notification 전송
5. `account/read` 요청으로 계정 상태 확인
6. 성공 시 `connected=true`, `initialized=true` 상태로 전환

실제 요청은 `requestInternal()`에서 아래 형식으로 전송됩니다.

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "<method>",
  "params": { }
}
```

수신 데이터 처리 방식:

- `id`가 있으면 pending request와 매칭해서 resolve/reject
- `method`가 있으면 notification으로 처리
- socket activity/message 시각을 별도로 기록

즉 현재 bridge는 app-server를 단순 소켓으로 다루는 것이 아니라, 요청-응답 타임아웃과 notification 처리 상태를 모두 추적하는 상태성 클라이언트입니다.

## 3. bridge가 관리하는 연결 상태

`collectBridgeStatus()`에서 app-server 상태를 외부에 노출합니다.

노출되는 핵심 상태:

- `connected`
- `initialized`
- `last_error`
- `last_started_at`
- `last_socket_activity_at`
- `last_socket_message_at`
- `heartbeat_probe_sent_at`
- `last_silent_state_check_at`
- `last_silent_state_check_error`
- `request_timeout_without_message_count`
- `heartbeat_timeout_count`

이 상태는 `GET /health` 응답의 `status.app_server`로 반환됩니다.

따라서 현재 상위 런처나 외부 진단은 bridge가 들고 있는 app-server 상태를 `/health`로 읽는 구조입니다.

## 4. bridge 내부 복구 로직

### 4-1. WebSocket open 실패 시

`connectSocket()`은 `APP_SERVER_STARTUP_TIMEOUT_MS` 동안 `openWebSocket()`을 반복 시도합니다.

- 기본 startup timeout: `15000ms`
- open 실패 간 재시도 간격: `300ms`
- timeout 내 성공 못 하면 `app-server 연결에 실패했습니다` 예외 발생
- `ensureReady()`는 실패 시 `scheduleReconnect()`를 예약

### 4-2. socket close 시

`openWebSocket()`에서 `close` 이벤트를 받으면:

- `resetSocketState()`로 연결 상태 초기화
- pending request 전부 실패 처리
- `lastError` 갱신
- bridge status publish 시도
- `scheduleReconnect()`로 재연결 예약

즉 close는 즉시 재연결 대상입니다.

### 4-3. socket error 시

`error` 이벤트에서는:

- `connected=false`
- `lastError` 갱신
- bridge status publish 시도

다만 `error` 이벤트만으로는 바로 `resetSocketState()`를 호출하지 않습니다.
실제 reconnect는 이후 close 또는 별도 강제 reconnect 경로에 의존합니다.

이 부분은 현재 코드에서 눈여겨볼 지점입니다. 에러가 발생해도 socket 객체와 pending request 정리가 close 시점까지 지연될 수 있습니다.

### 4-4. 요청 타임아웃 시

`requestInternal()`은 요청별 타임아웃을 둡니다.

- 기본 요청 타임아웃: `20000ms`
- 타임아웃 시 pending request reject
- `lastSocketActivityAt` / `lastSocketMessageAt` 기준으로 상황을 나눔

분기:

1. 요청 이후 socket activity 자체가 없으면
   즉시 `forceReconnect()`
2. activity는 있었지만 message가 없으면
   `checkLastKnownState()` 수행
3. 같은 상황이 누적되면
   `APP_SERVER_REQUEST_TIMEOUT_FORCE_RECONNECT_MISSES` 이상에서 `forceReconnect()`

기본 강제 재연결 임계치:

- `APP_SERVER_REQUEST_TIMEOUT_FORCE_RECONNECT_MISSES = 2`

즉 현재 코드는 "요청 timeout"을 곧바로 장애로 단정하지 않고,
"소켓 활동이 완전히 없었는지"와 "메시지만 멈춘 상태인지"를 구분합니다.

### 4-5. heartbeat 기반 감시

`startHeartbeat()`가 WebSocket heartbeat를 관리합니다.

기본값:

- heartbeat interval: `20000ms`
- heartbeat timeout: `10000ms`
- active 상태 강제 reconnect 임계치: `2`

동작:

- 마지막 socket activity 이후 일정 시간 이상 조용하면 `ws.ping()`
- pong/ping/message 수신 시 activity 갱신
- probe 후 timeout을 넘기면 `heartbeatTimeoutCount` 증가
- timeout 시 `checkLastKnownState()` 수행
- bridge가 idle이 아닌데 timeout 누적이 임계치 이상이면 `forceReconnect()`

즉 heartbeat는 단순 keepalive가 아니라,
"실행 중(active)일 때는 더 공격적으로 reconnect"하는 정책을 가집니다.

### 4-6. silent state check

`checkLastKnownState()`는 app-server 소켓이 살아 있는 것처럼 보여도 상태가 묵묵부답일 때 수행됩니다.

- 조건: `connected`, `initialized`, `socket OPEN`, `readyPromise 없음`
- 최소 간격: `APP_SERVER_SILENT_STATE_CHECK_INTERVAL_MS` 기본 `60000ms`
- 내부적으로 `recoverSilentBridgeState()` 호출
- 실패하면 `lastSilentStateCheckError`와 `lastError` 갱신
- 이후 bridge status publish

즉 현재 복구는 "소켓 재연결"만이 아니라,
"소켓은 열려 있지만 내부 상태가 꼬인 경우"를 별도로 탐지하려는 구조입니다.

### 4-7. force reconnect

`forceReconnect()`는 명시적인 강제 재연결 경로입니다.

수행 내용:

- 진단 로그 기록
- `lastError` 갱신
- running issue backfill 요청
- `resetSocketState()`로 pending request 정리
- bridge status publish
- `scheduleReconnect()` 예약
- 마지막으로 `ws.terminate()` 또는 `ws.close()`

즉 강제 reconnect는 상태 정리 후 소켓 종료 순서로 처리됩니다.

### 4-8. reconnect scheduler

`scheduleReconnect()` 특징:

- `reconnectTimer`가 이미 있으면 중복 예약 안 함
- `readyPromise` 진행 중이면 중복 예약 안 함
- 이미 `connected && initialized && OPEN`이면 예약 안 함
- 지연은 선형 증가

기본값:

- 초기 재연결 지연: `1000ms`
- 최대 지연: `5000ms`
- 계산식: `APP_SERVER_RECONNECT_DELAY_MS * attempt`

즉 현재 bridge 내부 reconnect는 exponential backoff가 아니라 capped linear backoff입니다.

## 5. run-local-agent의 외부 프로세스 복구

`scripts/run-local-agent.mjs`는 bridge 바깥에서 app-server와 bridge를 따로 띄우고 감시합니다.

구조:

- app-server는 직접 spawn
- bridge는 `scripts/run-bridge.mjs`로 spawn
- bridge에는 `OCTOP_APP_SERVER_AUTOSTART=false`를 주입

즉 이 모드에서는 app-server 프로세스 생명주기를 bridge가 아니라 `run-local-agent`가 가져갑니다.

### 5-1. app-server 비정상 종료 복구

`appServerProcess.on("exit")`에서:

- controlled restart가 아니면 비정상 종료로 간주
- stable window 이상 생존했으면 restart count 리셋
- restart count 증가
- 최대 시도 초과 시 app-server와 bridge를 모두 종료하고 초기화
- 1분 후 전체 서비스를 다시 시작
- 이후에도 같은 상황이 반복되면 동일한 전체 서비스 재시작 사이클을 계속 반복
- 아니면 backoff 후 app-server 재시작

기본값:

- 초기 지연: `500ms`
- 최대 지연: `5000ms`
- 최대 시도: `12`
- stable window: `15000ms`

여기서는 exponential backoff를 사용합니다.

### 5-2. bridge /health 기반 app-server 상태 감시

`run-local-agent`는 bridge의 `/health`를 읽어 app-server 상태를 간접 감시합니다.

기본값:

- health poll interval: `5000ms`
- health timeout: `1500ms`
- startup grace: `max(15000, stable window)`
- failure threshold: `3`

판단 로직은 `scripts/local-agent-health.mjs`에 있습니다.

판정 규칙:

1. `connected && initialized`이고 에러가 없으면 정상
2. `connected=false` 또는 `initialized=false`면 비정상이지만 즉시 프로세스 재시작하지 않음
3. `connected=true && initialized=true`인데 `last_error` 또는 `last_silent_state_check_error`가 있으면 recoverable failure로 간주
4. recoverable failure가 연속 threshold 이상 누적되면 controlled restart 수행
5. 인증 오류는 재시작 대상에서 제외

즉 외부 런처는 "bridge가 아직 내부 reconnect 중인 상태"와
"정말 app-server 프로세스를 다시 띄워야 하는 상태"를 구분하려고 합니다.

## 6. 현재 코드에서 확인되는 복구 계층 정리

현재 복구는 아래 2단계입니다.

1. bridge 내부 WebSocket 재연결
   close, request timeout, heartbeat timeout, force reconnect
2. 외부 local-agent 프로세스 재시작
   bridge health를 보고 app-server 프로세스 자체 restart

즉 현재 구조는 "소켓 재연결"과 "프로세스 재시작"이 분리되어 있습니다.

## 7. 현재 코드 기준으로 보이는 특징과 주의점

### 7-1. bridge `/health`가 단순 조회가 아님

`bridgeStatus()`는 기본적으로 `ensureReady=true`입니다.
따라서 `/health` 호출이 bridge 내부 app-server 연결 시도를 유발할 수 있습니다.

즉 health endpoint가 순수 read-only 상태 조회라기보다,
"필요하면 연결을 다시 세우는 진입점" 역할도 같이 수행합니다.

### 7-2. socket `error`와 `close`의 처리 강도가 다름

`error`에서는 `connected=false`와 상태 publish는 하지만 즉시 `resetSocketState()`를 하지 않습니다.
반면 `close`는 pending request 정리와 reconnect 예약까지 수행합니다.

즉 `error`만 발생하고 `close`가 늦는 경우를 코드상 별도로 의식해야 합니다.

### 7-3. local-agent는 연결 끊김만으로 app-server를 바로 죽이지 않음

테스트와 실제 로직 모두 `connected=false, initialized=false`만으로는 restart하지 않습니다.
이는 bridge 내부 reconnect가 먼저 동작할 시간을 주기 위한 정책입니다.

### 7-4. local-agent 재시작 대상은 recoverable failure에 한정됨

현재 코드는 아래 같은 상태를 재시작 후보로 봅니다.

- `connected=true`
- `initialized=true`
- 그런데 `last_error` 또는 `last_silent_state_check_error`가 남아 있음

즉 "연결은 살아 있는데 내부 상태가 나쁜 경우"에 프로세스 restart까지 올립니다.

## 8. 관련 테스트가 보장하는 현재 규칙

현재 테스트에서 직접 확인되는 규칙:

- bridge health에서 app-server disconnected만으로는 local-agent가 즉시 재시작하지 않음
- silent state error 누적이 threshold 도달 시 controlled restart
- 인증 오류는 재시작 제외

즉 테스트 기준으로도 현재 의도는 "bridge 내부 reconnect 우선, 외부 프로세스 restart는 마지막 수단"입니다.

## 9. 한 줄 요약

현재 코드는 `bridge 내부 WebSocket 복구 -> local-agent의 app-server 프로세스 재시작` 순으로 복구를 구성하고 있으며, bridge는 내부 연결 self-healing을 먼저 수행하고, 외부 런처는 그 상태가 회복되지 않을 때만 프로세스 재시작을 수행합니다.
