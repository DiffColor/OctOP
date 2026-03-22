# Android Watch 현재 API 연동 설계

## 목적

이 문서는 현재 OctOP 저장소의 실제 코드 기준으로 안드로이드 워치 앱 설계를 다시 정리합니다.

이번 설계의 원칙은 다음과 같습니다.

- 현재 gateway API 계약을 그대로 사용합니다.
- Bridge, NATS, RethinkDB, `codex app-server`에 워치 앱이 직접 붙지 않습니다.
- 안드로이드 워치만 범위에 포함합니다.
- 코드 수정은 보류하고, 현재 코드 기준으로 가능한 범위와 불가능한 범위를 먼저 명확히 합니다.

---

## 현재 코드 기준 핵심 사실

### 1. 로그인은 gateway를 통해 LicenseHub로 위임됩니다

현재 로그인 진입점은 `POST /api/auth/login` 입니다.

- gateway가 LicenseHub `/api/auth/login` 으로 프록시합니다.
- 성공 시 사용자 정보를 gateway 쪽 RethinkDB `users` 테이블에 동기화합니다.
- 모바일/대시보드는 로그인 응답 전체를 세션으로 저장합니다.

기준 코드:

- [apps/api/Program.cs](../apps/api/Program.cs)
- [apps/mobile/src/App.jsx](../apps/mobile/src/App.jsx)

### 2. 이후 API 호출의 사용자 식별은 현재 `login_id` 쿼리 기반입니다

현재 gateway는 이후 API에서 `Authorization` 헤더를 읽지 않고, `login_id` 또는 `user_id` query string으로 사용자를 식별합니다.

- `ResolveIdentityKey()`는 `login_id` 우선으로 사용합니다.
- 모바일/대시보드도 이후 호출에서 `login_id`를 계속 붙입니다.

즉 현재 워치 앱도 "로그인 후 세션 저장" 자체는 유지하되, 실제 API 호출은 현재 클라이언트들과 동일하게 `login_id`를 기준으로 맞춰야 합니다.

기준 코드:

- [apps/api/Program.cs](../apps/api/Program.cs)
- [apps/mobile/src/App.jsx](../apps/mobile/src/App.jsx)
- [apps/dashboard/src/App.jsx](../apps/dashboard/src/App.jsx)

### 3. 모든 주요 데이터 접근은 `bridge_id` 선택을 전제로 합니다

현재 구조에서 워치 앱이 바로 프로젝트/스레드/이슈로 들어가면 안 됩니다.

실제 흐름은 다음입니다.

1. 로그인
2. `GET /api/bridges?login_id=...`
3. 선택 가능한 bridge 목록 확인
4. 선택된 `bridge_id`로 이후 모든 API 호출

gateway는 `bridge_id`가 없으면 사용자가 가진 bridge 목록 중 첫 bridge를 기본값으로 사용하지만, 모바일은 별도로 선택 bridge를 로컬 저장하고 다시 복원합니다.

또한 기본 bridge 선택 규칙은 현재 모바일 기준으로 다음과 같습니다.

- thread 수가 있는 bridge를 우선 선택
- 없으면 첫 번째 bridge 선택

bridge 목록 자체도 단순 raw 목록이 아니라, gateway가 host/device identity 기준으로 canonicalize 해서 정리한 결과입니다.

기준 코드:

- [apps/api/Program.cs](../apps/api/Program.cs)
- [apps/api/OctopStore.cs](../apps/api/OctopStore.cs)
- [apps/mobile/src/App.jsx](../apps/mobile/src/App.jsx)

### 4. 현재 읽기 API는 gateway가 bridge/NATS/read model을 조합한 결과입니다

워치 앱은 현재 공개 API만 사용해야 합니다.

핵심 조회 경로:

- `GET /api/bridge/status`
- `GET /api/projects`
- `GET /api/projects/{projectId}/threads`
- `GET /api/threads/{threadId}/issues`
- `GET /api/issues/{issueId}`
- `GET /api/events`

이 API들은 단순 DB 직조회가 아닙니다.

- `projects`, `threads`, `bridge/status`는 gateway가 bridge 쪽 NATS request/reply를 통해 가져옵니다.
- `threads/{threadId}/issues`는 bridge 응답 위에 projection worker가 RethinkDB에 적재한 logical issue board를 merge 합니다.

따라서 워치 앱은 "현재 상태를 보려면 gateway API를 그대로 사용"해야 하고, RethinkDB schema를 직접 소비하면 안 됩니다.

기준 코드:

- [apps/api/Program.cs](../apps/api/Program.cs)
- [apps/api/OctopStore.cs](../apps/api/OctopStore.cs)
- [services/projection-worker/ProjectionWorkerService.cs](../services/projection-worker/ProjectionWorkerService.cs)
- [README.md](../README.md)

### 5. 현재 실시간성은 SSE 기반입니다

모바일은 선택된 bridge가 있을 때 다음 SSE를 구독합니다.

- `GET /api/events?login_id=...&bridge_id=...`

이 스트림은 다음 이벤트를 제공합니다.

- `ready`
- `snapshot`
- `message`
- `heartbeat`
- `error`

모바일은 foreground 상태에서 이 SSE를 유지하면서 bridge 상태와 활성 thread 관련 화면을 갱신합니다.

즉 워치 앱의 실시간 갱신도 현재 구조 그대로라면 push가 아니라 `foreground SSE`가 기본입니다.

기준 코드:

- [apps/api/Program.cs](../apps/api/Program.cs)
- [apps/mobile/src/App.jsx](../apps/mobile/src/App.jsx)

### 6. 현재 push는 네이티브 안드로이드 푸시가 아니라 웹 푸시 전용입니다

현재 저장소의 push 계약은 명확하게 웹 푸시입니다.

- `Lib.Net.Http.WebPush` 사용
- VAPID 공개키/개인키 사용
- 구독 DTO가 `endpoint`, `p256dh`, `auth` 를 요구
- service worker 기반 브라우저 subscription 전제
- 현재 템플릿의 앱 구분도 `dashboard-web`, `mobile-web` 중심

즉 지금 상태의 API에는 다음이 없습니다.

- Android FCM registration token 계약
- 워치 전용 `app_id`
- 워치 네이티브 푸시 수신 모델
- 안드로이드 워치 알림 탭/딥링크를 위한 native provider 분기

따라서 "현재 API를 그대로 쓰는 안드로이드 워치 앱" 설계에서는 native background push를 범위에 넣으면 안 됩니다.

기준 코드:

- [apps/api/Push/WebPushNotificationService.cs](../apps/api/Push/WebPushNotificationService.cs)
- [apps/api/Push/PushSubscriptionDto.cs](../apps/api/Push/PushSubscriptionDto.cs)
- [apps/api/Push/PushSubscriptionService.cs](../apps/api/Push/PushSubscriptionService.cs)
- [apps/api/Push/PushNotificationTemplateService.cs](../apps/api/Push/PushNotificationTemplateService.cs)
- [apps/mobile/src/PushNotificationCard.jsx](../apps/mobile/src/PushNotificationCard.jsx)
- [apps/dashboard/public/sw.js](../apps/dashboard/public/sw.js)

---

## 설계 결론

현재 코드 기준 안드로이드 워치 v1은 `원격 운영용 경량 companion` 으로 설계하는 것이 맞습니다.

정리하면 다음입니다.

- 워치 앱은 현재 gateway의 로그인, bridge 선택, 조회, SSE 계약을 그대로 사용합니다.
- 워치 앱은 브라우저 PWA가 아니라 네이티브 안드로이드 워치 앱으로 설계하되, 서버 계약은 새로 만들지 않습니다.
- 배경 푸시는 이번 설계 범위에서 제외합니다.
- foreground 상태에서만 SSE로 실시간 갱신합니다.
- 워치에서 write 기능은 당장 넣지 않고, 먼저 읽기/모니터링 중심으로 설계합니다.

이 판단의 이유는 다음과 같습니다.

- 현재 API는 이미 모바일/대시보드용 read flow가 안정적으로 존재합니다.
- 반면 native watch push를 위한 서버 계약은 아직 없습니다.
- 작은 화면에서 프로젝트 생성, thread 편집, 이슈 재정렬 같은 heavy write 기능은 현재 UX와도 맞지 않습니다.
- 먼저 현재 원격 운영 흐름을 그대로 보여주는 watch monitor를 만드는 편이 리스크가 낮습니다.

---

## 안드로이드 워치 v1 범위

### 포함

- 로그인
- 세션 복원
- bridge 목록 조회 및 선택
- 선택 bridge 저장
- bridge 상태 조회
- 프로젝트 목록 조회
- 프로젝트별 thread 목록 조회
- thread별 issue 요약 조회
- foreground SSE 연결
- 수동 새로고침

### 제외

- 네이티브 푸시 수신
- 프로젝트 생성/수정/삭제
- workspace root 탐색
- ToDo chat 흐름
- issue 생성/start/reorder/move/interrupt/rollover
- 브리지 삭제

---

## 워치 정보 구조

### 1. Session

워치 앱도 현재 모바일과 같은 세션 형태를 유지합니다.

권장 저장 필드:

```json
{
  "accessToken": "gateway login response value",
  "expiresAt": "2026-03-22T00:00:00.000Z",
  "role": "viewer",
  "userId": "licensehub user id",
  "displayName": "Jane",
  "permissions": [],
  "loginId": "jane"
}
```

주의:

- 현재 후속 API는 사실상 `loginId` 쿼리만 사용합니다.
- 그래도 세션 전체를 저장해 두는 편이 이후 인증 구조 변경에 덜 취약합니다.

### 2. BridgeSelection

권장 저장 필드:

```json
{
  "selectedBridgeId": "bridge-123"
}
```

복원 규칙:

1. 저장된 `selectedBridgeId`가 현재 bridge 목록에 있으면 그대로 사용
2. 없으면 모바일과 동일하게 `thread count > 0` bridge 우선
3. 그래도 없으면 첫 bridge 사용

### 3. WatchHomeState

권장 상태:

```json
{
  "bridge": {
    "bridge_id": "bridge-123",
    "device_name": "My Mac",
    "last_seen_at": "2026-03-22T10:00:00.000Z"
  },
  "status": {
    "app_server": {
      "connected": true,
      "initialized": true,
      "last_socket_activity_at": "2026-03-22T10:00:00.000Z"
    },
    "counts": {
      "projects": 3,
      "threads": 12
    },
    "updated_at": "2026-03-22T10:00:00.000Z"
  },
  "projects": []
}
```

---

## 화면 설계

## 1. 로그인 화면

필수 입력:

- Login ID
- Password

동작:

- `POST /api/auth/login`
- 성공 시 session 저장
- 직후 `GET /api/bridges?login_id=...`

워치 UX 기준으로는 모바일의 `remember device` 체크박스를 그대로 복제하기보다, 워치 앱은 기본적으로 세션 유지로 두는 편이 합리적입니다.

## 2. Bridge 선택 화면

표시 항목:

- `device_name`
- `bridge_id`
- `last_seen_at`

규칙:

- bridge가 1개면 자동 선택 후 다음 화면 이동
- bridge가 여러 개면 목록 선택
- bridge가 없으면 빈 상태 화면 표시

빈 상태 메시지 예시:

- 연결 가능한 bridge가 없습니다.
- 먼저 작업 머신에서 OctOP bridge를 실행해 주세요.

## 3. 홈 화면

핵심 목표는 "현재 이 bridge가 살아 있는지"와 "지금 볼 수 있는 프로젝트가 무엇인지"를 빠르게 보여주는 것입니다.

표시 항목:

- bridge 이름
- 연결 상태
- 마지막 활동 시간
- 프로젝트 수
- thread 수
- 프로젝트 목록

액션:

- 새로고침
- bridge 변경

## 4. 프로젝트별 thread 목록

표시 우선순위:

1. `running`
2. `awaiting_input`
3. `queued`
4. 그 외 최신 `updated_at`

표시 항목:

- thread title
- status
- progress
- updated_at
- last_event 또는 last_message 요약

watch 특성상 현재는 project/thread 편집보다 "활성 작업 모니터링"이 중요하므로 정렬도 그 방향으로 둡니다.

## 5. thread 상세

표시 항목:

- thread 기본 정보
- issue 목록
- 활성 issue 강조
- continuity 관련 핵심 값

데이터 원천:

- `GET /api/threads/{threadId}/issues`
- 필요 시 `GET /api/issues/{issueId}`

현재 API는 `threads/{threadId}/issues` 응답에서 logical issue board merge 결과를 이미 포함하므로, 워치 앱은 이 응답을 주 데이터로 쓰는 것이 맞습니다.

---

## 네트워크 설계

## 1. 초기 진입

앱 시작 시:

1. 저장된 session 확인
2. session이 없으면 로그인 화면
3. session이 있으면 `GET /api/bridges?login_id=...`
4. 저장된 bridge 복원 또는 기본 bridge 선택
5. `GET /api/bridge/status`
6. `GET /api/projects`

## 2. 프로젝트 진입

프로젝트 선택 시:

1. `GET /api/projects/{projectId}/threads?login_id=...&bridge_id=...`
2. running/awaiting_input 우선 정렬

## 3. thread 진입

thread 선택 시:

1. `GET /api/threads/{threadId}/issues?login_id=...&bridge_id=...`
2. issue 상세가 더 필요하면 `GET /api/issues/{issueId}`

## 4. 실시간 갱신

선택 bridge가 존재하고 화면이 foreground일 때만:

- `GET /api/events?login_id=...&bridge_id=...`

처리 규칙:

- `snapshot`: bridge status 즉시 갱신
- `message`: 현재 보고 있는 project/thread와 관련 있으면 목록/상세 재조회
- `heartbeat`: 연결 유지 표시만 업데이트
- app background 전환 시 SSE 종료

---

## 현재 API 그대로일 때의 제약

### 1. native push는 불가

현재 push API는 웹 푸시 subscription 객체를 요구합니다.

필수 필드:

- `endpoint`
- `keys.p256dh`
- `keys.auth`

이 계약은 Android watch 네이티브 앱의 FCM registration token과 맞지 않습니다.

즉 현재 설계에서 워치는:

- background push 수신 불가
- foreground SSE 기반 실시간 갱신만 가능

### 2. write 기능은 watch에서 지금 바로 붙이기 부적절

현재 issue 생성 시 `source_app_id`를 body로 넘길 수는 있지만, 현재 코드에서 명시적으로 다뤄지는 앱 식별과 푸시 템플릿 분기는 `dashboard-web`, `mobile-web` 중심입니다.

즉 워치를 완전한 작성 클라이언트로 넣으려면 최소한 다음 논의가 먼저 필요합니다.

- 워치 전용 `source_app_id` 추가 여부
- 워치 생성 이슈에 대한 알림 정책
- 작은 화면에서 실행/중단/재정렬 UX

코드 수정 보류 단계에서는 이 범위를 열지 않는 편이 안전합니다.

### 3. 일부 조회 API는 bridge online 상태에 의존합니다

현재 `projects`, `threads`, `bridge/status` 등은 gateway가 bridge NATS request/reply로 가져옵니다.

즉 bridge가 죽어 있으면 워치도 데이터 조회에 바로 영향을 받습니다.

watch 설계에는 반드시 다음 상태를 넣어야 합니다.

- bridge offline
- gateway timeout
- bridge no responders

---

## 권장 구현 순서

## 1단계

- 로그인
- bridge 목록 조회/선택
- bridge 상태 조회
- 프로젝트 목록

## 2단계

- project -> thread 목록
- thread -> issue 요약
- foreground SSE 반영

## 3단계

- watch에 맞는 필터/정렬 최적화
- 마지막으로 본 bridge/project/thread 복원

---

## 보류 항목

다음은 현재 설계 문서에는 남기되, 이번 개발 범위에서는 제외합니다.

- 네이티브 푸시 수신
- 워치에서 issue 생성/실행/중단
- ToDo chat 연동
- workspace 관리

특히 네이티브 푸시를 정말 넣으려면 그때는 "워치 앱 개발"이 아니라 "gateway push 계약 확장"이 먼저입니다.

필요한 변경 범주는 최소 다음입니다.

- 워치용 `app_id` 정의
- FCM registration token 저장 모델 추가
- native push provider 추가
- 워치 알림 payload 규격 추가

지금 단계에서는 이 변경을 설계 문서의 후속 과제로만 남겨 두는 것이 맞습니다.

---

## 최종 결론

현재 OctOP 코드 기준으로 안드로이드 워치 앱은 `모바일/대시보드의 축소판` 이 아니라, `선택된 bridge의 상태와 활성 작업을 빠르게 확인하는 경량 모니터` 로 설계해야 합니다.

현재 API를 그대로 존중하면 다음이 정답입니다.

- 로그인은 gateway 그대로 사용
- 사용자 식별은 현재 클라이언트와 동일하게 `login_id` 기준
- bridge 선택을 반드시 거친다
- 조회와 실시간성은 `REST + SSE` 조합으로 간다
- native push는 이번 범위에서 제외한다
- write 기능은 보류한다

이 방향이 현재 프로젝트 소스와 가장 일치하고, 이후 실제 안드로이드 워치 구현으로 넘어갈 때도 구조적 충돌이 가장 적습니다.
