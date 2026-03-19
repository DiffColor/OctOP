# OctOP Push Issue Notification Checklist

## 목표

- `Push alias` 샘플의 실제 구현 규칙을 참고한다.
- OctOP 이슈가 `completed` 또는 `failed` 로 종료될 때 모바일웹과 대시보드웹에 웹푸시 알림을 보낸다.
- 푸시 기능이 비활성 상태이거나 전송 실패해도 OctOP 본 이슈 실행 흐름에는 영향이 없어야 한다.

## 구현 계획

1. 서버(API)를 푸시 저장/발송 계층과 이벤트 감시 계층으로 분리한다.
2. 브리지 실행 코드는 건드리지 않고, API가 NATS `octop.user.*.bridge.*.events` 를 후행 구독한다.
3. 푸시 구독은 `user + bridge + app + endpoint` 단위로 저장한다.
4. 완료/실패 푸시는 `user + bridge + issue + terminal status` 단위 receipt 로 중복 발송을 막는다.
5. 모바일웹과 대시보드웹은 각 origin 에서 독립 service worker 와 구독 상태 UI를 가진다.
6. VAPID 키가 없으면 서버/클라이언트 모두 자동 비활성화하고, 기존 동작만 유지한다.

## 반복 체크리스트

### 1차 구현

- [x] Push 샘플 문서와 소스를 읽고 OctOP 구조와 차이를 정리했다.
- [x] API에 `Lib.Net.Http.WebPush` 의존성과 VAPID 서비스 추가
- [x] RethinkDB에 push subscription / receipt 테이블 추가
- [x] `/api/push/config` 추가
- [x] `/api/push/subscriptions` GET/POST/DELETE 추가
- [x] `/api/push/send` 수동 테스트용 전송 경로 추가
- [x] API BackgroundService 로 terminal event 감시 워커 추가
- [x] `turn.completed` 의 `completed/failed` 상태만 푸시 트리거로 사용
- [x] receipt 기반 중복 방지 추가

### 2차 구현

- [x] 모바일 PWA service worker 에 push 수신 / notification click 처리 추가
- [x] 모바일 PWA 캐시 설치 방식을 샘플 규칙처럼 실패 허용형으로 변경
- [x] 모바일웹에 현재 브릿지 기준 push 구독 카드 추가
- [x] 대시보드웹용 service worker 등록/버전 체크 추가
- [x] 대시보드웹 service worker 에 push 수신 / notification click 처리 추가
- [x] 대시보드웹에 현재 브릿지 기준 push 구독 카드 추가

### 3차 검증

- [x] `dotnet build apps/api/OctOP.Gateway.csproj`
- [x] `npm run build:mobile`
- [x] `npm run build:dashboard`
- [x] VAPID 환경변수가 비어 있을 때 서버가 빌드되고 푸시만 비활성화되는 구조인지 확인
- [ ] 로컬/운영 VAPID 키를 넣고 실제 브라우저에서 모바일웹 구독 확인
- [ ] 로컬/운영 VAPID 키를 넣고 실제 브라우저에서 대시보드웹 구독 확인
- [ ] 실제 이슈 완료 시 모바일웹 알림 수신 확인
- [ ] 실제 이슈 실패 시 모바일웹 알림 수신 확인
- [ ] 실제 이슈 완료 시 대시보드웹 알림 수신 확인
- [ ] 실제 이슈 실패 시 대시보드웹 알림 수신 확인
- [ ] 동일 issue terminal event 재방출 시 중복 푸시가 막히는지 확인

## 검증 메모

- 현재 워크스페이스의 `.env` 와 `.env.example` 기준으로 `OCTOP_PUSH_VAPID_*` 항목은 아직 설정되어 있지 않았다.
- 따라서 이번 턴에서는 실제 웹푸시 E2E 까지는 진행하지 않았고, 빌드/정적 검증과 비활성 안전성 검증까지 완료했다.
- 푸시 키가 없는 상태에서는:
  - API 빌드 및 기존 엔드포인트 동작에 영향이 없다.
  - Push worker 는 비활성 로그만 남기고 대기한다.
  - 모바일/대시보드 UI 는 서버 미설정 상태를 표시하고 구독을 시도하지 않는다.

## 추가 계획

1. 운영 또는 로컬 검증용 VAPID 키를 `OCTOP_PUSH_VAPID_PUBLIC_KEY`, `OCTOP_PUSH_VAPID_PRIVATE_KEY`, `OCTOP_PUSH_VAPID_SUBJECT` 에 주입한다.
2. 브라우저 2개 이상으로 모바일웹/대시보드웹을 각각 열고 브릿지별 구독을 활성화한다.
3. `/api/push/send` 로 수동 푸시를 먼저 확인한 뒤 실제 이슈 종료 이벤트를 검증한다.
4. 필요하면 Playwright 실브라우저 시나리오를 별도 추가해 자동화한다.
