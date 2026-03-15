# OctOP 자동화 테스트 가능 항목 분류

## 1. 목적

이 문서는 현재 OctOP 기능 중 어떤 항목을 Playwright 기반 UI 자동화로 닫을 수 있는지, 어떤 항목은 별도 백엔드 하네스 또는 수동 검증이 필요한지를 구분합니다.

이 문서의 기준은 다음과 같습니다.

- UI 소비 계약은 Playwright로 자동화
- 브리지 내부 정합성은 API/프로세스 제어 테스트로 검증
- 장애 복구와 재시작 시나리오는 별도 통합 하네스로 검증

---

## 2. 자동화 가능 항목 분류

### 2.1 Playwright로 직접 자동화 가능한 항목

#### 대시보드 UI 계약

- [x] root thread만 사용자 thread 목록에 노출되는지
- [x] merged issue board가 정상 렌더링되는지
- [x] prep 정렬 규칙이 유지되는지
- [x] running / done 컬럼에 서로 다른 continuity source의 issue가 함께 보이는지
- [ ] archive UI와 delete 후 scope 정리 같은 프론트엔드 상태 관리

#### 모바일 UI 계약

- [x] root thread가 채팅창 하나로 보이는지
- [x] issue fan-out으로 합성된 메시지 흐름이 정상인지
- [x] handoff summary가 system message 톤으로 렌더링되는지
- [ ] refresh 이후 timeline 유지
- [ ] context usage, refresh, project 전환 같은 보조 흐름 회귀

#### API 소비 계약

- [x] `/api/threads/{threadId}/issues` 응답이 UI에서 깨지지 않는지
- [x] `/api/issues/{issueId}` fan-out 결과가 모바일 채팅에 반영되는지
- [x] `continuity.read_split`가 UI 소비에 문제를 일으키지 않는지
- [ ] `/api/threads/{threadId}/timeline` 단일 조회 경로를 실제 UI가 소비하는지

### 2.2 Playwright만으로는 부족한 항목

#### 브리지 내부 정합성

- [ ] `closed_at` / `deleted_at` 기반 late event drop 검증
- [ ] tombstone miss 후 authoritative state 재검사 검증
- [ ] active physical thread 라우팅 정합성
- [ ] atomic write의 `temp -> rename` 보장
- [ ] lazy migration의 영속 상태 검증

#### 재시작/장애 시나리오

- [ ] bridge 재시작 직후 복구
- [ ] projection worker down / lag
- [ ] app-server down
- [ ] binding invalidated 후 재바인딩

이 항목들은 아래 보조 수단이 같이 필요합니다.

- 프로세스 제어 하네스
- 직접 API 호출
- 상태 파일/저장소 검증
- 통합 테스트 스크립트

---

## 3. 현재 작성된 자동화 테스트

### 3.1 공통 전제

- 모든 issue 프롬프트는 `현재 워크스페이스 경로`를 사용합니다.
- 테스트 서버는 고정 포트가 아니라 동적 포트로 뜹니다.
- PWA 서비스워커는 테스트 중 차단합니다.
  이유: UI contract 검증과 무관한 업데이트 다이얼로그가 흐름을 오염시키지 않게 하기 위함입니다.

### 3.2 대시보드 continuity 스펙

파일:

- [dashboard-thread-continuity.spec.js](/Users/jazzlife/Documents/Workspaces/Products/OctOP/playwright/tests/dashboard-thread-continuity.spec.js)

보조 코드:

- [static-app-server.js](/Users/jazzlife/Documents/Workspaces/Products/OctOP/playwright/helpers/static-app-server.js)

검증 범위:

- root thread 기반 보드 렌더링
- prep 정렬 유지
- active bridge issue + closed projection issue 동시 표시
- root thread 하나 안에서 continuity source가 달라도 같은 board에 보이는지

### 3.3 모바일 handoff 스펙

파일:

- [mobile-thread-handoff.spec.js](/Users/jazzlife/Documents/Workspaces/Products/OctOP/playwright/tests/mobile-thread-handoff.spec.js)

검증 범위:

- root thread 단일 표시
- 작은 프롬프트 응답 흐름 표시
- handoff summary의 system bubble 렌더링
- 이전 physical thread 이력이 현재 root thread 채팅 흐름 안에 보이는지

### 3.4 브리지 통합 스펙

파일:

- [root-thread-rollover.bridge.integration.test.mjs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/tests/integration/root-thread-rollover.bridge.integration.test.mjs)

보조 문서:

- [README.md](/Users/jazzlife/Documents/Workspaces/Products/OctOP/tests/integration/README.md)

검증 범위:

- 격리된 브리지 프로세스 기동
- fake app-server websocket 연결
- root thread 생성
- issue 2개 생성 후 1개 실행
- `thread/tokenUsage/updated`로 threshold 진입
- 자동 rollover로 target physical thread 생성
- handoff summary가 timeline에 적재되는지 확인
- root thread delete cascade
- closed physical thread late event drop
- deleted root thread late event drop
- bridge 저장 파일에 deleted/physical/handoff 상태가 남는지 확인

---

## 4. 실행 결과

실행 일시:

- 2026-03-15

실행 명령:

```bash
npx playwright test /Users/jazzlife/Documents/Workspaces/Products/OctOP/playwright/tests/mobile-thread-handoff.spec.js --reporter=line
npx playwright test /Users/jazzlife/Documents/Workspaces/Products/OctOP/playwright/tests/dashboard-thread-continuity.spec.js /Users/jazzlife/Documents/Workspaces/Products/OctOP/playwright/tests/mobile-thread-handoff.spec.js --reporter=line
npm run test:integration:bridge-rollover
```

결과:

- [x] 모바일 handoff 스펙 통과
- [x] 대시보드 + 모바일 연속 실행 통과
- [x] 동적 포트 기반 반복 실행 통과
- [x] 서비스워커 업데이트 다이얼로그 간섭 제거 확인
- [x] 브리지 통합 검증 통과

---

## 5. 다음 자동화 우선순위

1. dashboard thread delete 후 archive scope 정리
2. mobile refresh 후 timeline 유지
3. `/api/threads/{threadId}/timeline` consumer 계약 검증 강화
4. bridge/projection/app-server 프로세스 제어형 장애 E2E 추가
