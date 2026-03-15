# Integration Tests

이 디렉터리는 OctOP 브리지와 app-server 경계를 자동 검증하는 통합 테스트를 둡니다.

- [root-thread-rollover.bridge.integration.test.mjs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/tests/integration/root-thread-rollover.bridge.integration.test.mjs)

현재 테스트는 다음을 검증합니다.

- root thread 생성
- issue 생성과 실행
- threshold 기반 자동 rollover
- handoff summary와 timeline 연속성
- root thread delete cascade
- closed/deleted state에 대한 late event drop
