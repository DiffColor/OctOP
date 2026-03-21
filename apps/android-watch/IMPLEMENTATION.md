# Android Watch 앱 구현 계획

## 목표

Wear OS 앱이 OctOP gateway에 워치 푸시 토큰을 등록하고, 푸시 알림을 수신하면 워치에서 바로 확인할 수 있어야 합니다.

## 현재 코드 기준 판단

- 기존 서버 푸시는 웹 푸시(VAPID) 전용입니다.
- 네이티브 워치 앱을 위해서는 OctOP gateway 내부에 `fcm` 하위 전송 경로가 추가되어야 합니다.
- 워치 앱은 작은 화면 특성상 핵심 상태와 최근 푸시 기록만 보여주는 것이 적합합니다.

## 구현 범위

1. `apps/api` 에 `fcm` 구독 저장 및 전송 지원 추가
2. Wear OS Compose 앱 추가
3. 워치 앱에서 gateway URL, login id, bridge id 설정 저장
4. 워치 푸시 토큰 발급 및 OctOP 서버 등록
5. 수신 알림 표시와 최근 알림 목록 보존
6. 클릭 시 OctOP deep link 정보 유지

## 체크리스트

- [x] 현재 저장소 구조와 기존 푸시 서버 코드를 직접 읽고 확장 지점을 확인
- [x] Wear OS 앱 폴더와 문서 생성
- [x] OctOP 서버 기준 Wear OS 네이티브 구독 등록 API 반영
- [x] FCM 전송 서비스 구현
- [x] Wear OS 앱 UI/상태 저장 구현
- [x] 워치 푸시 토큰 등록 로직 구현
- [x] 수신 알림 표시 및 최근 알림 기록 구현
- [x] 가능한 범위의 빌드 또는 정적 검증 수행
- [x] 검증 결과를 반영해 수정
- [ ] Android SDK/Gradle 환경에서 실제 APK 빌드 확인
- [ ] 실기기 또는 에뮬레이터에서 FCM 실제 수신 검증

## 환경 변수

- `OCTOP_PUSH_FCM_PROJECT_ID`
- `OCTOP_PUSH_FCM_SERVICE_ACCOUNT_JSON`
- `OCTOP_PUSH_FCM_SERVICE_ACCOUNT_FILE`
- `OCTOP_FIREBASE_PROJECT_ID`
- `OCTOP_FIREBASE_APPLICATION_ID`
- `OCTOP_FIREBASE_API_KEY`
- `OCTOP_FIREBASE_GCM_SENDER_ID`

## 검증 메모

- `xmllint` 로 `AndroidManifest.xml`, `activity_main.xml`, `strings.xml`, `themes.xml` 문법을 확인했습니다.
- 현재 환경에는 `gradle`, `kotlinc`, `sdkmanager` 가 없어 실제 Android 빌드는 수행하지 못했습니다.
