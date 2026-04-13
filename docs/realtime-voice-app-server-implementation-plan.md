# Realtime 음성대화 + app-server 연동 구현 계획

## 목적

이 문서는 현재 OctOP 코드 기준으로 모바일에서 ChatGPT 고급 음성대화에 가까운 경험을 제공하면서, 실제 작업 실행은 기존 `bridge + codex app-server` 경로를 그대로 재사용하기 위한 구현 계획을 정리합니다.

목표는 다음과 같습니다.

- 모바일에서 실시간 음성 입력/응답이 가능한 대화 세션을 연다.
- 음성 세션 중 작업성 발화는 기존 `app-server` 실행 경로로 연결한다.
- 현재 존재하는 프로젝트, 쓰레드, 이슈, 승인, 상태 이벤트 구조를 최대한 그대로 활용한다.
- 구현 시작 전에 손댈 파일, 새로 만들 파일, 단계별 체크리스트를 명확히 고정한다.

---

## 현재 코드 기준 구조 파악

## 1. Gateway 구조

현재 Gateway는 ASP.NET Minimal API 단일 엔트리 구조입니다.

- 엔트리 파일: [apps/api/Program.cs](../apps/api/Program.cs)
- NATS 요청 클라이언트: [apps/api/BridgeNatsClient.cs](../apps/api/BridgeNatsClient.cs)
- 브리지 subject 계약: [packages/server-shared/BridgeSubjects.cs](../packages/server-shared/BridgeSubjects.cs)

확인한 사실:

- 대부분의 REST 엔드포인트가 `Program.cs` 한 파일에 집중되어 있습니다.
- 브리지 호출은 `BridgeNatsClient.RequestAsync()`를 통해 NATS request/reply로 수행합니다.
- 실시간 UI 동기화는 `GET /api/events` SSE 엔드포인트가 담당합니다.
- 현재 Gateway 프로젝트에는 OpenAI SDK 의존성이 없습니다.
  - 기준 파일: [apps/api/OctOP.Gateway.csproj](../apps/api/OctOP.Gateway.csproj)
- 따라서 음성 기능 1차 구현은 OpenAI .NET SDK보다 `HttpClient` 기반 구현이 현재 코드 스타일과 더 잘 맞습니다.

현재 중요한 엔드포인트:

- `GET /api/events`
- `GET /api/bridge/status`
- `GET /api/projects`
- `GET /api/projects/{projectId}/threads`
- `GET /api/threads/{threadId}/issues`
- `POST /api/threads/{threadId}/issues/start`
- `POST /api/issues/{issueId}/interrupt`
- `POST /api/threads/{threadId}/unlock`
- `POST /api/threads/{threadId}/stop`

---

## 2. Bridge / app-server 구조

현재 실제 작업 실행은 브리지 내부에서 `codex app-server`로 연결됩니다.

- 브리지 메인: [services/codex-adapter/src/index.js](../services/codex-adapter/src/index.js)
- app-server 런처: [scripts/run-app-server.mjs](../scripts/run-app-server.mjs)
- app-server 상태 문서: [docs/app-server-bridge-communication-current-state.md](./app-server-bridge-communication-current-state.md)

확인한 사실:

- 브리지는 기본적으로 `codex app-server --listen ...`를 실행하고 WebSocket JSON-RPC로 붙습니다.
- `AppServerClient.ensureReady()`에서 app-server 프로세스 기동, WebSocket 연결, `initialize`, `account/read`를 수행합니다.
- 이슈 실행은 브리지의 `startThreadIssues()`가 담당하며 staged issue를 queued로 바꾼 뒤 실제 실행 큐를 돌립니다.
- 브리지는 작업 상태 변화를 `publishEvent()`로 NATS 이벤트에 발행합니다.
- Gateway의 `/api/events` SSE는 이 NATS 이벤트를 다시 브라우저로 전달합니다.

즉 현재 제품의 진짜 실행 엔진은 이미 존재합니다.

- 음성 기능이 새로 만들어야 하는 것은 “음성 세션 오케스트레이션”
- 새로 만들 필요가 없는 것은 “작업 실행 엔진”

---

## 3. Mobile 현재 구조

모바일 앱은 현재 하나의 큰 React 컴포넌트에 많은 기능이 모여 있습니다.

- 메인 파일: [apps/mobile/src/App.jsx](../apps/mobile/src/App.jsx)

확인한 사실:

- REST 호출은 `apiRequest()`로 직접 Gateway에 붙습니다.
- 실시간 상태 동기화는 `EventSource`로 `/api/events`를 구독합니다.
- 이미 브라우저 기반 음성 기능이 일부 들어 있습니다.
  - 음성 입력: `SpeechRecognition` / `webkitSpeechRecognition`
  - 음성 출력: `speechSynthesis`
- 현재 음성 기능은 브라우저 로컬 기능일 뿐이며, OpenAI Realtime이나 서버 오케스트레이션과는 연결되어 있지 않습니다.

현재 모바일 음성 관련 코드 위치:

- 음성 재생 보조 함수: `supportsSpeechSynthesisPlayback`, `pickPreferredSpeechSynthesisVoice`
- 음성 입력 composer 로직: `SpeechRecognition`, `toggleVoiceCapture`, `startVoiceCapture`, `stopVoiceCapture`
- 음성 응답 재생: `playAssistantVoiceResponse`, `handleToggleVoiceMode`

중요한 판단:

- 기존 음성 입력/출력 코드는 “버릴 코드”가 아니라, 1차 전환 시 참고할 UI 상태 모델입니다.
- 다만 ChatGPT 같은 고급 음성대화 수준을 목표로 한다면 현재 브라우저 `SpeechRecognition` / `speechSynthesis` 경로는 중심 경로가 될 수 없습니다.

---

## 4. Dashboard 현재 구조

대시보드 역시 현재 큰 단일 React 컴포넌트 구조입니다.

- 메인 파일: [apps/dashboard/src/App.jsx](../apps/dashboard/src/App.jsx)
- 실시간 이슈 헬퍼: [apps/dashboard/src/realtimeIssue.js](../apps/dashboard/src/realtimeIssue.js)

확인한 사실:

- 대시보드는 `/api/events` SSE를 이미 사용하고 있습니다.
- 현재 음성 기능은 모바일에만 존재하고 대시보드에는 실질적인 음성 제어 UI가 없습니다.

권장 범위 판단:

- 1차 구현은 모바일 우선
- 대시보드는 2차로 미루는 것이 현재 코드 구조상 가장 안전합니다.

---

## 5. Shared contract 구조

공통 subject 정의가 JS와 C# 양쪽에 중복 관리됩니다.

- JS: [packages/domain/src/index.js](../packages/domain/src/index.js)
- C#: [packages/server-shared/BridgeSubjects.cs](../packages/server-shared/BridgeSubjects.cs)

중요한 사실:

- 브리지 subject를 추가하거나 이름을 바꾸면 두 파일을 반드시 같이 수정해야 합니다.
- 이번 음성 기능 1차 구현에서는 가능하면 새로운 NATS subject를 추가하지 않는 것이 좋습니다.

이유:

- 이미 `thread issue start`, `interrupt`, `unlock`, `stop`, `thread issues get`, `status get` 경로가 충분히 존재합니다.
- 음성 기능은 우선 “기존 명령을 음성에서 호출하는 얇은 계층”으로 시작하는 것이 맞습니다.

---

## 현재 코드 기준 결론

현재 코드에서 가장 현실적이고 안정적인 1차 구현 전략은 다음입니다.

### 선택 전략

- 음성 세션은 모바일 클라이언트가 OpenAI Realtime에 직접 연결한다.
- 세션 생성과 보안 토큰 발급은 Gateway가 담당한다.
- 음성 중 발생한 작업성 명령은 Gateway의 새 음성 API를 통해 브리지로 전달한다.
- 실제 실행은 기존 `bridge + app-server`가 그대로 담당한다.
- UI 동기화는 기존 `/api/events` SSE를 그대로 사용한다.

### 이 전략을 택한 이유

1. 현재 모바일은 이미 클라이언트 중심 구조이며 `EventSource`, `fetch`, 로컬 음성 상태를 직접 들고 있습니다.
2. 현재 Gateway는 WebSocket 서버나 별도 장기 세션 관리 계층 없이 Minimal API 중심입니다.
3. 브리지는 이미 작업 실행과 상태 이벤트 발행을 안정적으로 담당하고 있습니다.
4. 따라서 1차는 “음성 세션 추가”에 집중하고, 기존 워크플로를 뒤흔들지 않는 것이 가장 합리적입니다.

---

## 1차 구현 범위

## 포함 범위

- 모바일 실시간 음성 세션 시작/종료
- Gateway의 Realtime 세션 발급 API
- Gateway의 음성 tool invocation API
- 음성 명령을 기존 브리지 작업으로 연결
- 기존 `/api/events` 기반 UI 동기화 재사용
- 기존 모바일 브라우저 음성 기능을 Realtime 중심으로 전환

## 제외 범위

- Dashboard 음성 UI
- 서버 측 sideband Realtime 세션 완전 제어
- 음성 세션 녹취 저장
- 음성 대화 전체를 새 도메인으로 영구 저장
- 새로운 브리지 메시지 버스 체계 전면 개편

---

## 제안 아키텍처

## 1. 데이터 흐름

1. 모바일이 `POST /api/voice/sessions` 호출
2. Gateway가 사용자/브리지/프로젝트/쓰레드 문맥을 확인
3. Gateway가 OpenAI Realtime 세션 생성용 임시 토큰 정보를 반환
4. 모바일이 OpenAI Realtime에 연결
5. 사용자가 말함
6. 모델이 일반 대화는 바로 응답
7. 작업성 발화는 tool call로 전환
8. 모바일이 `POST /api/voice/tool-invocations` 호출
9. Gateway가 기존 `BridgeNatsClient` + `BridgeSubjects`로 브리지 명령 수행
10. 브리지가 `app-server`에서 실제 작업 실행
11. 브리지가 기존 이벤트를 발행
12. 모바일은 `/api/events` SSE로 상태를 계속 반영

---

## 2. 1차 구현에서 새로 만들 계층

### Gateway 안의 `Voice` 계층

새 폴더를 추가합니다.

- `apps/api/Voice/VoiceSessionModels.cs`
- `apps/api/Voice/VoiceSessionService.cs`
- `apps/api/Voice/VoiceToolInvocationService.cs`
- `apps/api/Voice/VoicePromptBuilder.cs`

역할:

- Realtime 세션 생성 요청 payload 구성
- 음성 세션 시작 시 현재 프로젝트/쓰레드 문맥 요약 생성
- 허용된 음성 tool 목록 정의
- tool 호출을 기존 브리지 명령으로 매핑

### Mobile 안의 `voice` 계층

지금 `App.jsx`에 더 넣지 말고 별도 폴더를 추가합니다.

- `apps/mobile/src/voice/useRealtimeVoiceSession.js`
- `apps/mobile/src/voice/realtimeVoiceProtocol.js`
- `apps/mobile/src/voice/VoiceSessionSheet.jsx`
- `apps/mobile/src/voice/voiceState.js`

역할:

- WebRTC 연결과 데이터 채널 이벤트 관리
- 음성 세션 상태 머신 관리
- tool call 이벤트 수신 후 Gateway 호출
- 기존 모바일 UI와 연결

---

## 3. 기존 경로 재사용 원칙

1차 구현에서는 새로운 브리지 NATS subject를 만들지 않습니다.

우선 재사용할 기존 경로:

- 상태 조회: `StatusGet`
- 프로젝트/쓰레드 조회: `ProjectsGet`, `ProjectThreadsGet`
- 이슈 조회: `ThreadIssuesGet`, `ThreadIssueDetailGet`
- 이슈 시작: `ThreadIssuesStart`
- 이슈 중단: `ThreadIssueInterrupt`
- 쓰레드 중단: `ProjectThreadStop`
- 쓰레드 잠금 해제: `ProjectThreadUnlock`

이 원칙을 지키면:

- 브리지 변경 범위가 최소화되고
- Gateway와 모바일만 먼저 구현할 수 있으며
- 기존 테스트/이벤트 체계를 거의 그대로 유지할 수 있습니다.

---

## 작업 목표

## 1차 완료 기준

- 모바일에서 음성 버튼으로 Realtime 세션을 시작할 수 있다.
- 사용자가 음성으로 일반 질문을 하면 즉시 음성 응답이 나온다.
- 사용자가 “이 쓰레드 시작해”, “지금 실행 멈춰”, “현재 상태 알려줘” 같은 명령을 말하면 Gateway를 통해 기존 브리지 명령이 호출된다.
- 실행 결과와 상태 변화는 기존 `/api/events`로 UI에 반영된다.
- 기존 텍스트 채팅/이슈 흐름은 깨지지 않는다.

---

## 매우 구체적인 구현 체크리스트

## A. 사전 정리

- [ ] 새 설계 문서를 기준 문서로 고정한다.
- [ ] 1차 범위를 모바일 전용으로 확정한다.
- [ ] 브리지 subject 추가 없이 진행한다는 원칙을 확정한다.
- [ ] 음성 세션의 권한 범위를 “현재 선택된 bridge / project / thread”로 제한한다.

---

## B. 환경변수 정리

수정 파일:

- [ ] `.env.example`

추가할 항목:

- [ ] `OPENAI_API_KEY`
- [ ] `OCTOP_OPENAI_REALTIME_MODEL`
- [ ] `OCTOP_OPENAI_REALTIME_VOICE`
- [ ] `OCTOP_OPENAI_REALTIME_API_BASE_URL`
- [ ] `OCTOP_OPENAI_TTS_MODEL`
- [ ] `OCTOP_OPENAI_TTS_VOICE`
- [ ] `OCTOP_OPENAI_TTS_API_BASE_URL`
- [ ] `OCTOP_VOICE_SESSION_ENABLED`
- [ ] `OCTOP_VOICE_SESSION_TTL_SECONDS`
- [ ] `OCTOP_VOICE_MAX_TOOL_CALL_SECONDS`
- [ ] `VITE_VOICE_SESSION_ENABLED`

세부 체크:

- [ ] 기본 모델명을 환경변수로 분리한다.
- [ ] 운영/개발 환경에서 음성 기능을 쉽게 끌 수 있게 feature flag를 둔다.
- [ ] 모바일은 `import.meta.env`로 feature flag를 읽게 한다.

---

## C. Gateway 음성 세션 API 추가

수정 파일:

- [ ] `apps/api/Program.cs`
- [ ] `apps/api/OctOP.Gateway.csproj`

신규 파일:

- [ ] `apps/api/Voice/VoiceSessionModels.cs`
- [ ] `apps/api/Voice/VoiceSessionService.cs`
- [ ] `apps/api/Voice/VoicePromptBuilder.cs`

구현 항목:

- [ ] `VoiceSessionStartRequest` 모델 정의
- [ ] `VoiceSessionStartResponse` 모델 정의
- [ ] 현재 선택 상태를 담을 `VoiceContextSnapshot` 모델 정의
- [ ] OpenAI Realtime 세션 생성 HTTP 호출 서비스 구현
- [ ] 세션 생성 실패 시 Gateway 에러 포맷 유지

추가 엔드포인트:

- [ ] `POST /api/voice/sessions`

요청 필드 초안:

```json
{
  "login_id": "user-1",
  "bridge_id": "bridge-1",
  "project_id": "project-1",
  "thread_id": "thread-1",
  "language": "ko-KR"
}
```

응답 필드 초안:

```json
{
  "session": {
    "client_secret": "...",
    "expires_at": "...",
    "model": "...",
    "voice": "..."
  },
  "context": {
    "bridge_id": "bridge-1",
    "project_id": "project-1",
    "thread_id": "thread-1"
  },
  "tools": [
    { "name": "get_current_context" },
    { "name": "start_selected_thread_issues" },
    { "name": "interrupt_issue" },
    { "name": "stop_selected_thread" },
    { "name": "unlock_selected_thread" }
  ]
}
```

세부 체크:

- [ ] 사용자 식별은 기존 `ResolveIdentityKey()` 규칙을 그대로 따른다.
- [ ] `bridge_id`는 기존 `ResolveBridgeIdAsync()` 경로를 재사용한다.
- [ ] 현재 선택된 프로젝트/쓰레드가 없을 때의 응답 정책을 명확히 한다.
- [ ] 세션 시작 응답에 UI 표시용 문맥 요약을 함께 담는다.
- [ ] OpenAI 세션 생성용 payload는 서비스 클래스로 분리해 `Program.cs` 비대화를 막는다.

---

## D. Gateway 음성 tool invocation API 추가

신규 파일:

- [ ] `apps/api/Voice/VoiceToolInvocationService.cs`

수정 파일:

- [ ] `apps/api/Program.cs`

추가 엔드포인트:

- [ ] `POST /api/voice/tool-invocations`

요청 필드 초안:

```json
{
  "bridge_id": "bridge-1",
  "project_id": "project-1",
  "thread_id": "thread-1",
  "tool_name": "start_selected_thread_issues",
  "arguments": {
    "issue_ids": ["issue-1", "issue-2"]
  }
}
```

tool 매핑 원칙:

- [ ] Gateway는 음성용 고수준 tool 이름만 받는다.
- [ ] Gateway 내부에서만 기존 subject/브리지 명령으로 번역한다.
- [ ] 모바일은 subject 이름이나 브리지 내부 세부 구현을 알지 못하게 한다.

권장 1차 tool 목록:

- [ ] `get_current_context`
- [ ] `get_selected_thread_issues`
- [ ] `start_selected_thread_issues`
- [ ] `interrupt_issue`
- [ ] `stop_selected_thread`
- [ ] `unlock_selected_thread`
- [ ] `ping_bridge`

tool별 기존 경로 매핑:

- [ ] `get_current_context` → `StatusGet` + 필요 시 `ProjectsGet` / `ProjectThreadsGet`
- [ ] `get_selected_thread_issues` → `ThreadIssuesGet`
- [ ] `start_selected_thread_issues` → `ThreadIssuesStart`
- [ ] `interrupt_issue` → `ThreadIssueInterrupt`
- [ ] `stop_selected_thread` → `ProjectThreadStop`
- [ ] `unlock_selected_thread` → `ProjectThreadUnlock`
- [ ] `ping_bridge` → `PingStart`

세부 체크:

- [ ] `thread_id` 없는 tool 호출은 명시적으로 막는다.
- [ ] 음성 도구는 현재 선택된 브리지 범위를 벗어나지 못하게 한다.
- [ ] tool 응답 포맷은 모델이 읽기 쉬운 짧은 JSON으로 고정한다.
- [ ] 브리지 에러 메시지는 Gateway 표준 에러 포맷으로 감싼다.
- [ ] 시간이 오래 걸리는 명령은 즉시 accepted 응답 후 UI는 기존 `/api/events`를 기다리게 한다.

---

## E. Shared contract 정리

수정 후보:

- [ ] `packages/domain/src/index.js`
- [ ] `packages/server-shared/BridgeSubjects.cs`

1차 원칙:

- [ ] 새 NATS subject를 추가하지 않는다.
- [ ] 기존 subject로 모두 처리 가능한지 먼저 확정한다.

추가 검토 항목:

- [ ] 음성 UI 전용 상수나 상태 enum이 필요하면 `packages/domain`에 추가한다.
- [ ] JS / C# subject 정의 불일치가 생기지 않도록 검토한다.

---

## F. Mobile Realtime 음성 세션 구현

신규 파일:

- [ ] `apps/mobile/src/voice/useRealtimeVoiceSession.js`
- [ ] `apps/mobile/src/voice/realtimeVoiceProtocol.js`
- [ ] `apps/mobile/src/voice/VoiceSessionSheet.jsx`
- [ ] `apps/mobile/src/voice/voiceState.js`

수정 파일:

- [ ] `apps/mobile/src/App.jsx`
- [ ] `apps/mobile/src/styles.css`

현재 코드 기준 핵심 원칙:

- [ ] `App.jsx`에 직접 WebRTC 상세 로직을 더 넣지 않는다.
- [ ] 기존 브라우저 `SpeechRecognition` / `speechSynthesis` 코드는 즉시 삭제하지 말고 기능 플래그 뒤로 숨긴다.
- [ ] Realtime 음성 세션이 켜지면 기존 로컬 음성 입력/재생 경로는 비활성화한다.

UI 체크리스트:

- [ ] 현재 선택된 쓰레드에서만 음성 세션 시작 버튼을 노출한다.
- [ ] 음성 세션 상태를 `idle`, `connecting`, `listening`, `thinking`, `speaking`, `tool_running`, `error`로 분리한다.
- [ ] 마이크 권한 요청 실패 UI를 분리한다.
- [ ] 연결 중 취소 버튼을 제공한다.
- [ ] 세션 중 현재 선택된 thread 제목 또는 project 이름을 표시한다.
- [ ] 도구 실행 중에는 “작업 실행 중” 표시를 준다.
- [ ] 기존 SSE로 상태가 들어오면 음성 패널과 본문 UI가 함께 갱신되게 한다.

연결 체크리스트:

- [ ] `POST /api/voice/sessions` 호출
- [ ] 응답의 임시 토큰/세션 정보를 사용해 Realtime 연결
- [ ] 마이크 `MediaStream` 확보
- [ ] 데이터 채널 생성
- [ ] 세션 초기 instructions / tool 목록 적용
- [ ] 세션 종료 시 트랙 정리, peer connection 정리, 데이터 채널 정리

이벤트 처리 체크리스트:

- [ ] 연결 성공 이벤트 처리
- [ ] 모델 오디오 응답 시작/종료 이벤트 처리
- [ ] tool call 이벤트 파싱
- [ ] tool 결과를 Gateway에 요청
- [ ] tool 응답을 Realtime 세션으로 다시 전달
- [ ] 에러 이벤트를 사용자 메시지로 변환
- [ ] 세션 종료 시 로컬 상태 초기화

상태 동기화 체크리스트:

- [ ] `selectedBridgeId`, `selectedProjectId`, `selectedThreadId` 변경 시 음성 세션 유지 정책 결정
- [ ] 선택 대상이 바뀌면 기존 세션을 종료할지, 새 세션으로 갈아탈지 명확히 구현
- [ ] 이미 실행 중인 issue가 있으면 그 사실을 음성 패널에서도 보이게 한다
- [ ] 기존 `/api/events`의 `bridge.threadIssues.updated`, `bridge.projectThreads.updated`를 그대로 활용한다

---

## G. 기존 모바일 음성 코드 전환

현재 참조 코드:

- 음성 입력 composer 로직: [apps/mobile/src/App.jsx](../apps/mobile/src/App.jsx)
- 음성 응답 재생 로직: [apps/mobile/src/App.jsx](../apps/mobile/src/App.jsx)

전환 원칙:

- [ ] 기존 `SpeechRecognition` 기반 입력은 Realtime 음성 세션이 꺼져 있을 때만 사용 가능하게 둘지 결정한다.
- [ ] 기존 `speechSynthesis` 기반 출력은 Realtime 세션 사용 시 비활성화한다.
- [ ] 버튼 레이블과 상태 문구를 Realtime 세션 중심으로 바꾼다.

권장 1차 결정:

- [ ] Realtime 음성 기능이 활성화되면 composer의 길게 눌러 녹음 UX는 비활성화한다.
- [ ] 대신 별도의 “실시간 음성” 버튼 또는 시트를 연다.
- [ ] 현재 텍스트 composer는 그대로 유지한다.

이유:

- 현재 composer는 “텍스트 작성 + 길게 눌러 브라우저 STT”에 최적화되어 있습니다.
- Realtime 음성은 별도 세션 상태와 오디오 출력 제어가 필요하므로 UI 분리가 더 안전합니다.

---

## H. Dashboard 대응 계획

1차 구현에서는 대시보드에 음성 기능을 넣지 않습니다.

다만 다음 준비는 문서화합니다.

- [ ] `apps/dashboard/src/App.jsx`에도 추후 같은 `voice` 폴더 구조를 적용할 수 있게 설계 이름을 맞춘다.
- [ ] Gateway API는 모바일 전용으로 하드코딩하지 않는다.
- [ ] 응답 payload는 dashboard에서도 그대로 쓸 수 있게 일반화한다.

---

## I. 로그 / 진단 / 장애 대응

수정 후보:

- [ ] `apps/api/Program.cs`
- [ ] `apps/mobile/src/App.jsx`
- [ ] 필요 시 `services/codex-adapter/src/index.js`

체크리스트:

- [ ] `POST /api/voice/sessions` 성공/실패 로그를 남긴다.
- [ ] `POST /api/voice/tool-invocations` tool 이름, bridge, thread 기준 로그를 남긴다.
- [ ] 브리지 호출 실패 시 subject와 timeout 정보를 그대로 로그에 남긴다.
- [ ] 모바일에서는 연결 실패, 마이크 권한 실패, tool 호출 실패를 각각 다른 메시지로 표시한다.
- [ ] 음성 세션 종료 이유를 추적 가능하게 남긴다.

---

## J. 테스트 / 검증 체크리스트

## API 레벨

- [ ] 음성 세션 생성 API가 브리지 미선택 상태에서 적절히 실패하는지 확인
- [ ] 음성 세션 생성 API가 잘못된 로그인 정보에서 실패하는지 확인
- [ ] tool invocation API가 `thread_id` 없이 `start_selected_thread_issues`를 호출하면 실패하는지 확인
- [ ] tool invocation API가 기존 subject 호출을 정상적으로 수행하는지 확인

## 모바일 레벨

- [ ] 음성 세션 시작 시 마이크 권한 요청이 정상 표시되는지 확인
- [ ] 연결 직후 일반 질의에 음성 응답이 나오는지 확인
- [ ] `start_selected_thread_issues` 호출 후 기존 채팅 화면 이슈 상태가 `queued/running`으로 갱신되는지 확인
- [ ] `interrupt_issue` 호출 후 상태가 적절히 바뀌는지 확인
- [ ] 세션 종료 후 마이크/오디오 리소스가 정리되는지 확인

## 회귀 확인

- [ ] 기존 텍스트 issue 생성이 그대로 동작하는지 확인
- [ ] 기존 `/api/events` SSE 연결이 깨지지 않는지 확인
- [ ] 기존 브리지 상태 폴링이 깨지지 않는지 확인
- [ ] 기존 브라우저 음성 버튼이 feature flag에 따라 적절히 보이거나 숨겨지는지 확인

---

## 구현 순서

## 1단계. Gateway 기반 준비

- [ ] `.env.example`에 음성 환경변수 추가
- [ ] `apps/api/Voice/` 폴더 생성
- [ ] `VoiceSessionService` 구현
- [ ] `VoiceToolInvocationService` 구현
- [ ] `Program.cs`에 음성 엔드포인트 추가

## 2단계. Mobile 음성 세션 뼈대

- [ ] `apps/mobile/src/voice/` 폴더 생성
- [ ] `useRealtimeVoiceSession.js` 구현
- [ ] `VoiceSessionSheet.jsx` 구현
- [ ] `App.jsx`에 진입 버튼 연결

## 3단계. Bridge 명령 연결

- [ ] `get_current_context`
- [ ] `get_selected_thread_issues`
- [ ] `start_selected_thread_issues`
- [ ] `interrupt_issue`
- [ ] `stop_selected_thread`
- [ ] `unlock_selected_thread`

## 4단계. UI 안정화

- [ ] 상태 문구 정리
- [ ] 연결 오류 UX 정리
- [ ] 세션 종료 UX 정리
- [ ] 기존 voice mode와 충돌 제거

## 5단계. 검증

- [ ] 수동 시나리오 실행
- [ ] 회귀 확인
- [ ] 문서 업데이트

---

## 구현 중 주의사항

- [ ] `apps/api/Program.cs`가 이미 크므로, 음성 관련 로직은 반드시 서비스 클래스로 분리한다.
- [ ] `apps/mobile/src/App.jsx`도 이미 매우 크므로, WebRTC/음성 상태 로직을 직접 추가하지 않는다.
- [ ] 브리지 subject가 필요해 보이더라도 1차에서는 기존 subject 재사용을 우선한다.
- [ ] 새로운 음성 전용 서버를 브리지 옆에 추가하지 않는다.
- [ ] 기존 `/api/events`를 버리지 않는다.
- [ ] “음성 응답”과 “실제 작업 실행”은 같은 개념으로 다루지 않는다.

---

## 2차 확장 후보

1차 구현이 안정화된 뒤 고려할 항목:

- 서버 sideband 제어 세션 추가
- Dashboard 음성 기능 추가
- 음성 세션 transcript 저장
- 승인 대기 상태를 음성으로 읽고 음성 승인 처리
- 음성 전용 event type 추가

---

## Definition of Done

- [ ] 모바일에서 실시간 음성 세션을 시작하고 종료할 수 있다.
- [ ] 세션 중 일반 질문에 음성 응답이 온다.
- [ ] 세션 중 작업성 발화가 기존 브리지 명령을 실제로 호출한다.
- [ ] 브리지에서 발생한 상태 변화가 기존 `/api/events`를 통해 모바일 UI에 반영된다.
- [ ] 기존 텍스트 채팅과 이슈 실행 흐름이 유지된다.
- [ ] 새 코드가 `Program.cs`, `App.jsx`에 과도하게 덧붙지 않고 분리된 파일 구조를 가진다.

---

## 이번 구현에서 실제로 수정될 가능성이 큰 파일 목록

### 필수 수정

- `apps/api/Program.cs`
- `apps/api/OctOP.Gateway.csproj`
- `.env.example`
- `apps/mobile/src/App.jsx`
- `apps/mobile/src/styles.css`

### 필수 신규 파일

- `apps/api/Voice/VoiceSessionModels.cs`
- `apps/api/Voice/VoiceSessionService.cs`
- `apps/api/Voice/VoiceToolInvocationService.cs`
- `apps/api/Voice/VoicePromptBuilder.cs`
- `apps/mobile/src/voice/useRealtimeVoiceSession.js`
- `apps/mobile/src/voice/realtimeVoiceProtocol.js`
- `apps/mobile/src/voice/VoiceSessionSheet.jsx`
- `apps/mobile/src/voice/voiceState.js`

### 조건부 수정

- `packages/domain/src/index.js`
- `packages/server-shared/BridgeSubjects.cs`
- `services/codex-adapter/src/index.js`
