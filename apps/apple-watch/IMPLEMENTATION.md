# Apple Watch 앱 구현 계획

## 목표

watchOS 앱이 OctOP gateway에 워치 푸시 토큰을 등록하고, 푸시 알림을 수신하면 워치에서 바로 확인할 수 있어야 합니다.

## 현재 코드 기준 판단

- 기존 서버 푸시는 웹 푸시(VAPID)만 처리합니다.
- watchOS 앱을 위해서는 OctOP gateway 내부에 `apns` 하위 전송 경로가 추가되어야 합니다.
- 워치 앱은 SwiftUI 기반으로 상태 설정, 마지막 등록 상태, 최근 알림 기록을 보여주는 구성이 적절합니다.

## 구현 범위

1. `apps/api` 에 `apns` 구독 저장 및 전송 지원 추가
2. watchOS SwiftUI 앱 소스 추가
3. gateway URL, login id, bridge id, APNs topic 설정 저장
4. APNs 원격 알림 권한 요청 및 워치 푸시 토큰 등록
5. 수신 알림 표시와 최근 알림 목록 보존
6. 딥링크 파라미터 유지

## 체크리스트

- [x] 현재 저장소 구조와 기존 푸시 서버 코드를 직접 읽고 확장 지점을 확인
- [x] Apple Watch 앱 폴더와 문서 생성
- [x] OctOP 서버 기준 watchOS 네이티브 구독 등록 API 반영
- [x] APNs 전송 서비스 구현
- [x] watchOS 앱 상태 저장/UI 구현
- [x] 워치 푸시 토큰 등록 로직 구현
- [x] 수신 알림 표시 및 최근 알림 기록 구현
- [x] 가능한 범위의 빌드 또는 정적 검증 수행
- [x] 검증 결과를 반영해 수정
- [ ] 실제 Xcode 앱 번들/서명 구성으로 watchOS 실행 확인
- [ ] 실기기 또는 시뮬레이터에서 APNs 실제 수신 검증

## 환경 변수

- `OCTOP_PUSH_APNS_KEY_ID`
- `OCTOP_PUSH_APNS_TEAM_ID`
- `OCTOP_PUSH_APNS_PRIVATE_KEY`
- `OCTOP_PUSH_APNS_PRIVATE_KEY_FILE`
- `OCTOP_PUSH_APNS_DEFAULT_TOPIC`
- `OCTOP_PUSH_APNS_USE_SANDBOX`

## 검증 메모

- `swift package dump-package --package-path apps/apple-watch` 로 패키지 매니페스트를 검증했습니다.
- `xcrun --sdk watchsimulator swiftc -target arm64-apple-watchos10.0-simulator ...` 로 소스 컴파일을 확인했고, 1차 오류 수정 후 통과했습니다.
