# Thread별 개발지침 적용 설계

## 목적

이 문서는 `thread별 개발지침`만 다룹니다.

범위는 명확합니다.

- 프로젝트 공통 `developer_instructions`는 유지한다.
- thread마다 별도의 `developer_instructions`를 저장할 수 있게 한다.
- 새 Codex physical thread가 시작될 때 project 개발지침과 thread 개발지침이 함께 적용되게 한다.
- `base_instructions` 확장은 이번 설계 범위에서 제외한다.

즉 이전 문서의 `thread별 프롬프트`, `thread별 일반지침`, `base/developer 동시 확장`은 모두 범위 밖입니다.

---

## 현재 코드 기준 상태

### 1. 프로젝트 단위 개발지침은 이미 존재한다

현재 저장되는 프로젝트 instruction은 아래 두 필드입니다.

- `base_instructions`
- `developer_instructions`

하지만 이번 설계에서 실제로 이어받을 대상은 `project.developer_instructions`입니다.

관련 위치:

- `services/codex-adapter/src/index.js`
  - `normalizeProject()`
  - `updateProject()`
  - `getProjectInstructionOverrides()`
- `apps/api/Program.cs`
  - `PATCH /api/projects/{projectId}`
- `apps/dashboard/src/App.jsx`
- `apps/mobile/src/App.jsx`

현재 동작은 다음과 같습니다.

1. Dashboard 또는 Mobile에서 프로젝트 개발지침을 수정한다.
2. API가 이를 bridge로 전달한다.
3. bridge가 프로젝트 상태에 `developer_instructions`를 저장한다.
4. bridge가 `thread/start` 호출 시 `developerInstructions`로 전달한다.

### 2. thread에는 개발지침 필드가 없다

현재 `normalizeProjectThread()`가 만드는 thread 객체에는 `developer_instructions`가 없습니다.

즉 thread마다 별도 개발지침을 저장할 수 없고, 모든 thread가 프로젝트 공통 개발지침만 공유합니다.

### 3. 실제 주입 시점은 `thread/start`다

현재 구조에서 개발지침은 `turn/start`가 아니라 `thread/start`에 붙습니다.

따라서 thread별 개발지침도 아래 시점에 적용하는 것이 맞습니다.

- 최초 Codex physical thread 생성 시
- rollover 이후 새 physical thread 생성 시

---

## 문제 정의

프로젝트 공통 개발지침만으로는 다음 요구를 처리하기 어렵습니다.

- 같은 프로젝트 안에서 thread마다 다른 작업 방식을 유지해야 하는 경우
- 특정 thread에만 적용되는 출력 규칙, 금지 규칙, 역할 고정
- 장기 운영 thread와 일회성 실험 thread를 분리해야 하는 경우

현재 구조에서는 이 차이를 사용자가 매 issue prompt마다 다시 써야 합니다. 이건 지속성도 없고, 실행 품질도 흔들립니다.

---

## 설계 원칙

- 이번 설계는 `developer_instructions`만 확장한다.
- `base_instructions`는 건드리지 않는다.
- thread 개발지침은 root thread 메타에 저장한다.
- 실제 app-server 전달 책임은 bridge가 가진다.
- API는 기존 엔드포인트를 확장하되 의미는 유지한다.
- 기존 프로젝트 개발지침과 thread 개발지침의 관계는 `override`가 아니라 `append`다.

---

## 최종 적용 모델

app-server에 전달할 `developerInstructions`는 아래 두 값을 연결한 결과다.

1. `project.developer_instructions`
2. `thread.developer_instructions`

병합 규칙:

- 빈 문자열은 제거
- 남은 항목을 `\n\n`로 연결

예시:

```text
[프로젝트 공통 개발지침]

[현재 thread 전용 개발지침]
```

이 방식을 택하는 이유는 명확합니다.

- 프로젝트 공통 규칙을 잃지 않는다.
- thread 전용 규칙을 뒤에 덧붙여 우선 맥락을 강화할 수 있다.
- app-server 계약을 바꾸지 않아도 된다.

---

## 저장 모델 설계

### project

기존 유지:

- `developer_instructions`

### thread

신규 필드:

- `developer_instructions`

저장 위치:

- `services/codex-adapter/src/index.js`
  - `normalizeProjectThread()`
  - `createProjectThread()`
  - `updateProjectThread()`
  - thread 영속화/복원 경로

정규화 규칙:

- `String(value ?? "").trim()`
- 값이 없으면 빈 문자열 저장

### 왜 thread에 저장하는가

- issue는 일회성 실행 단위다.
- 개발지침은 해당 채팅 흐름의 장기 제약이다.
- rollover 이후에도 유지돼야 하므로 root thread 메타에 붙는 것이 맞다.

---

## API 설계

### 1. thread 조회 응답 확장

대상:

- `GET /api/projects/{projectId}/threads`

thread 객체에 아래 필드를 추가합니다.

- `developer_instructions`

기존 소비자는 이 필드를 몰라도 깨지지 않습니다.

### 2. thread 수정 API 확장

대상:

- `PATCH /api/threads/{threadId}`

현재는 `name`만 수정할 수 있습니다. 여기에 아래를 추가합니다.

- `developer_instructions`
- `update_developer_instructions`

권장 요청 예시:

```json
{
  "developer_instructions": "응답은 항상 한국어로 하고, 수정 파일 경로는 프로젝트 루트 기준으로 적는다.",
  "update_developer_instructions": true
}
```

### 3. thread 생성 API는 1차에서 유지

대상:

- `POST /api/projects/{projectId}/threads`

1차 구현에서는 thread 생성 API에 개발지침 입력을 추가하지 않습니다.

이유:

- 최소 수정 원칙에 맞다.
- UI 흐름을 단순하게 유지할 수 있다.
- thread 생성 후 개발지침을 편집하는 방식으로 충분히 운용 가능하다.

즉 1차 UX는 아래 순서입니다.

1. thread 생성
2. thread 개발지침 편집
3. 이후 issue 실행

---

## bridge 적용 설계

### 1. thread 메타 확장

`normalizeProjectThread()`에 아래 필드를 추가합니다.

- `developer_instructions`

또한 `updateProjectThread()`가 `name`뿐 아니라 thread 개발지침도 저장할 수 있어야 합니다.

### 2. helper 분리

현재 `getProjectInstructionOverrides()`는 project 기준으로 `baseInstructions`, `developerInstructions`를 만듭니다.

이번 설계에서는 최소 아래 helper를 추가하는 것이 안전합니다.

- `getProjectDeveloperInstruction(userId, projectId)`
- `getThreadDeveloperInstruction(userId, threadId)`
- `buildThreadDeveloperInstructionOverride(userId, threadId)`

권장 반환 예시:

```js
{
  developerInstructions: "..."
}
```

### 3. 적용 시점

적용 시점은 그대로 `ensureCodexThreadForPhysicalThread()`가 맞습니다.

기존 개념:

```js
const instructionOverrides = getProjectInstructionOverrides(userId, physicalThread.project_id);
```

변경 개념:

```js
const instructionOverrides = {
  ...getProjectInstructionOverrides(userId, physicalThread.project_id),
  ...buildThreadDeveloperInstructionOverride(userId, physicalThread.root_thread_id)
};
```

하지만 이 방식은 객체 병합만으로는 부족합니다. `developerInstructions`를 덮어써 버릴 수 있기 때문입니다.

따라서 실제 구현은 아래처럼 `developerInstructions`를 명시적으로 조합해야 합니다.

```js
const projectOverrides = getProjectInstructionOverrides(userId, physicalThread.project_id);
const threadOverrides = buildThreadDeveloperInstructionOverride(userId, physicalThread.root_thread_id);

const instructionOverrides = {
  ...projectOverrides,
  developerInstructions: joinInstructionText(
    projectOverrides.developerInstructions,
    threadOverrides.developerInstructions
  )
};
```

핵심은 `baseInstructions`는 그대로 두고, `developerInstructions`만 thread 기준으로 확장하는 것입니다.

### 4. 실행 중 변경 반영 정책

권장 정책:

- thread 개발지침 수정은 이후 새 physical thread 생성 시점부터 반영
- 이미 열린 Codex thread에는 즉시 재주입하지 않음

이유:

- 현재 구조상 안전한 live replace 경로가 없다.
- 사용자가 보지 못한 내부 상태만 바뀌는 문제가 생길 수 있다.
- rollover 경계에서 반영하는 편이 일관성이 높다.

UI 안내 문구 권장안:

- "이 개발지침은 현재 thread의 다음 실행 흐름부터 반영됩니다."

---

## UI 설계

### 1. Dashboard

대상:

- `apps/dashboard/src/App.jsx`

현재 프로젝트 개발지침 dialog가 이미 있으므로, 같은 패턴을 재사용합니다.

추가 UI:

- thread 선택 영역 또는 context menu에 `개발지침` 항목 추가
- `ThreadDeveloperInstructionDialog`를 얇게 추가하거나 기존 dialog를 일반화

표시 원칙:

- 프로젝트 개발지침과 thread 개발지침을 같은 버튼군에 섞지 않는다.
- dialog 제목에 project와 thread를 함께 표시한다.
- 설명 문구는 `현재 thread 전용 개발지침`이라고 명확히 적는다.

### 2. Mobile

대상:

- `apps/mobile/src/App.jsx`

추가 UI:

- thread 상세 상단 더보기 메뉴에 `개발지침` 추가
- 기존 프로젝트 개발지침 bottom sheet 패턴 재사용

### 3. 혼동 방지 문구

- 프로젝트 개발지침: 프로젝트 전체 공통 규칙
- thread 개발지침: 현재 채팅 흐름에만 추가 적용되는 규칙

금지할 UX:

- `일반지침`과 함께 노출해서 scope를 넓게 보이게 만드는 UI
- thread 개발지침이 project 개발지침을 완전히 대체하는 것처럼 보이는 설명

---

## 이벤트와 동기화

thread 개발지침이 바뀌면 기존 thread 갱신 이벤트 흐름만 유지하면 됩니다.

- `thread.updated`
- `rootThread.updated`
- `bridge.projectThreads.updated`

즉 새 이벤트를 추가할 필요는 없고, thread payload에 `developer_instructions`만 포함되면 됩니다.

---

## 마이그레이션 전략

기존 저장 데이터에는 thread 개발지침 필드가 없습니다.

대응 원칙:

- 읽을 때 필드가 없으면 빈 문자열로 정규화
- 저장 시점부터 새 필드를 포함

별도 마이그레이션 스크립트는 1차 구현에서 불필요합니다.

---

## 단계 분리 원칙

이번 구현은 반드시 `1차 구현`과 `2차 구현`으로 나눕니다.

이유는 두 가지입니다.

- 안정성 확보
  - thread 개발지침은 실제 Codex 실행 입력에 영향을 주는 기능이다.
  - UI까지 한 번에 붙이면 저장/조회 문제와 실행 반영 문제와 화면 상태 문제가 섞여 원인 분리가 어려워진다.
- 확인 용이성
  - 1차에서 API, bridge, 실행 경로만 먼저 고정하면 실제 반영 여부를 좁은 범위에서 검증할 수 있다.
  - 2차에서 UI를 얹으면 사용자 조작 흐름만 추가 검증하면 된다.

즉 1차는 `백엔드 기능 완성 + 실행 반영 확인`, 2차는 `사용자 UI 완성 + 운영 안정화`가 목표다.

---

## 세분화 체크리스트

## 1차 구현

목표:

- thread 개발지침을 저장할 수 있어야 한다.
- thread 개발지침을 조회할 수 있어야 한다.
- 새 Codex physical thread 시작 시 project + thread 개발지침이 함께 반영되어야 한다.
- UI 없이도 API와 내부 실행 경로만으로 기능 검증이 가능해야 한다.

### 1차 구현 범위

- `services/codex-adapter/src/index.js`
- `apps/api/Program.cs`

### 1차 구현 상세 체크리스트

#### A. 저장 모델 확장

- [x] `normalizeProjectThread()`에 `developer_instructions` 필드 추가
- [x] thread 정규화 시 `String(value ?? "").trim()` 규칙 적용
- [x] 기존 저장 데이터에 필드가 없을 때 빈 문자열로 복원되는지 확인
- [x] thread 생성 시 기본값이 빈 문자열인지 확인
- [x] thread 영속화 파일에 신규 필드가 자연스럽게 저장되는지 확인
- [x] thread 복원 후 메모리 상태에 신규 필드가 유지되는지 확인

#### B. thread 수정 경로 확장

- [x] `updateProjectThread()`가 `name` 외에 `developer_instructions` 수정도 처리하도록 확장
- [x] `update_developer_instructions` 플래그가 없는 요청은 기존 rename 동작만 수행하는지 확인
- [x] `update_developer_instructions=true`일 때만 thread 개발지침이 갱신되는지 확인
- [x] thread 개발지침만 수정할 때 `name` 검증에 막히지 않도록 분기 정리
- [x] 이름 수정과 개발지침 수정을 동시에 보내도 안전하게 병합되는지 확인
- [x] thread 소유권 검증 흐름이 기존과 동일하게 유지되는지 확인
- [x] 수정 후 `updated_at`이 갱신되는지 확인

#### C. API 계약 확장

- [x] `PATCH /api/threads/{threadId}` 요청 body에서 `developer_instructions` 읽기
- [x] `PATCH /api/threads/{threadId}` 요청 body에서 `update_developer_instructions` 읽기
- [x] 기존 `name` 수정 API와 충돌 없이 함께 bridge로 전달되는지 확인
- [x] `GET /api/projects/{projectId}/threads` 응답 thread 객체에 `developer_instructions`가 포함되는지 확인
- [ ] 기존 소비자가 필드 추가만으로 깨지지 않는지 확인
- [x] bridge 미연결 시 404/오류 응답 계약이 기존과 동일한지 확인

#### D. 이벤트 payload 유지

- [x] `thread.updated` payload에 `developer_instructions`가 포함되는지 확인
- [x] `rootThread.updated` payload에 `developer_instructions`가 포함되는지 확인
- [x] `bridge.projectThreads.updated`의 thread 목록에 `developer_instructions`가 포함되는지 확인
- [x] 신규 필드 추가로 기존 이벤트 소비 로직이 깨지지 않는지 확인

#### E. 개발지침 병합 helper 추가

- [x] project 개발지침 추출 helper 분리 또는 기존 helper 재사용 범위 정리
- [x] thread 개발지침 추출 helper 추가
- [x] 두 값을 `\n\n`로 연결하는 전용 helper 추가
- [x] 빈 문자열, 공백 문자열, 미정의 값이 연결 결과에 남지 않는지 확인
- [x] project만 있는 경우 기존과 동일한 결과가 나오는지 확인
- [x] thread만 있는 경우 thread 개발지침만 전달되는지 확인
- [x] 둘 다 없을 경우 `developerInstructions`를 불필요하게 보내지 않거나 빈 값이 안전하게 처리되는지 확인

#### F. 실행 경로 반영

- [x] `ensureCodexThreadForPhysicalThread()`에서 최종 `developerInstructions` 조합 로직 적용
- [x] 기존 `baseInstructions` 전달 경로는 그대로 유지되는지 확인
- [x] 최초 physical thread 생성 시 thread 개발지침이 반영되는지 확인
- [x] rollover 후 새 physical thread 생성 시 같은 thread 개발지침이 다시 반영되는지 확인
- [x] 기존 Codex thread binding이 이미 있을 때 불필요한 재생성이 발생하지 않는지 확인
- [x] thread not found 재시도 흐름과 충돌하지 않는지 확인

#### G. 비의도적 영향 차단

- [ ] project 개발지침만 사용하는 기존 프로젝트가 그대로 동작하는지 확인
- [ ] thread rename 동작이 그대로 유지되는지 확인
- [x] issue create / start 동작이 그대로 유지되는지 확인
- [ ] thread delete / rollover / unlock / stop 경로가 신규 필드 때문에 깨지지 않는지 확인
- [x] serialization 순서나 shape 변화로 저장 파일 파싱이 깨지지 않는지 확인

### 1차 구현 확인 체크리스트

#### API 수동 확인

- [x] thread 개발지침 수정 요청이 성공 응답을 반환하는지 확인
- [x] 수정 직후 thread 목록 재조회 시 값이 반영되는지 확인
- [x] 서버 재시작 또는 bridge 재초기화 후에도 값이 유지되는지 확인

#### 실행 수동 확인

- [ ] 프로젝트 공통 개발지침만 저장한 상태에서 실행 결과가 기존과 동일한지 확인
- [x] 같은 프로젝트의 thread A에만 thread 개발지침 저장
- [x] thread A 실행 시 thread 전용 제약이 반영되는지 확인
- [ ] thread B 실행 시 thread A 지침이 섞여 들어가지 않는지 확인
- [x] thread A rollover 후 후속 실행에서 동일 지침이 유지되는지 확인

#### 1차 완료 기준

- [x] UI 없이 API 호출만으로 thread 개발지침 저장/조회가 가능하다
- [x] 새 physical thread 생성 시 개발지침 병합 반영이 확인된다
- [ ] 기존 프로젝트 개발지침 기능에 회귀가 없다
- [ ] rename, issue start, rollover 핵심 경로에 회귀가 없다

---

## 2차 구현

목표:

- Dashboard와 Mobile에서 thread 개발지침을 사용자가 직접 편집할 수 있어야 한다.
- project 개발지침과 thread 개발지침의 scope 차이를 UI에서 명확히 구분해야 한다.
- 저장 직후 사용자가 반영 시점을 오해하지 않도록 안내해야 한다.

### 2차 구현 범위

- `apps/dashboard/src/App.jsx`
- `apps/mobile/src/App.jsx`

### 2차 구현 상세 체크리스트

#### A. Dashboard UI 추가

- [x] thread 선택 영역 또는 thread context menu에 `개발지침` 진입점 추가
- [x] project 개발지침 버튼과 시각적으로 구분되는지 확인
- [x] 현재 선택 thread가 없을 때 버튼/메뉴 비활성화 처리
- [x] dialog 제목에 thread 이름이 표시되는지 확인
- [x] dialog 보조 설명에 `현재 thread 전용 개발지침` scope가 명확히 적히는지 확인
- [x] textarea 초기값이 현재 thread `developer_instructions`와 동기화되는지 확인
- [x] 저장 중 중복 제출 방지
- [x] 저장 성공 후 thread 목록 상태가 즉시 갱신되는지 확인
- [x] 저장 실패 시 기존 recent events 또는 오류 표시에 자연스럽게 연결되는지 확인

#### B. Mobile UI 추가

- [x] thread 상세 상단 더보기 메뉴에 `개발지침` 추가
- [x] project 개발지침 UI와 혼동되지 않는 위치인지 확인
- [x] bottom sheet 또는 dialog에 thread 이름이 표시되는지 확인
- [x] textarea 초기값이 현재 thread 개발지침과 동기화되는지 확인
- [x] 저장 중 재탭 방지
- [x] 저장 성공 후 현재 화면 상태가 즉시 갱신되는지 확인
- [x] 저장 실패 시 사용자에게 오류가 명확히 보이는지 확인

#### C. 반영 시점 안내

- [x] Dashboard에 `다음 실행 흐름부터 반영` 안내 문구 추가
- [x] Mobile에도 동일 의미의 안내 문구 추가
- [x] 즉시 반영되는 기능처럼 보이지 않도록 wording 점검
- [x] project 개발지침과 thread 개발지침의 scope 설명이 서로 충돌하지 않는지 확인

#### D. 상태 동기화

- [x] thread 수정 후 선택된 thread 상태가 즉시 최신값으로 반영되는지 확인
- [x] thread 목록과 상세 화면이 서로 다른 값을 갖지 않는지 확인
- [ ] 새로고침 후 UI가 저장값을 그대로 복원하는지 확인
- [x] bridge 이벤트 수신 후 로컬 state merge가 신규 필드를 잃지 않는지 확인

#### E. UX 회귀 방지

- [ ] 기존 project 개발지침 dialog 동작이 그대로 유지되는지 확인
- [ ] thread rename UI와 충돌하지 않는지 확인
- [ ] context menu 또는 더보기 메뉴의 복잡도가 과도하게 증가하지 않는지 확인
- [ ] 모바일에서 키보드, bottom sheet, 스크롤 동작이 깨지지 않는지 확인

### 2차 구현 확인 체크리스트

#### Dashboard 수동 확인

- [ ] thread 개발지침 열기
- [ ] 저장
- [ ] thread 목록 상태 반영 확인
- [ ] 새로고침 후 값 유지 확인
- [ ] 후속 실행에서 반영 확인

#### Mobile 수동 확인

- [ ] thread 개발지침 열기
- [ ] 저장
- [ ] 현재 thread 화면 반영 확인
- [ ] 새로고침 후 값 유지 확인
- [ ] 후속 실행에서 반영 확인

#### 2차 완료 기준

- [ ] Dashboard에서 thread 개발지침을 안정적으로 편집할 수 있다
- [ ] Mobile에서 thread 개발지침을 안정적으로 편집할 수 있다
- [ ] 반영 시점 안내가 사용자 기대와 실제 동작을 어긋나게 하지 않는다
- [ ] project 개발지침과 thread 개발지침의 역할 구분이 UI에서 명확하다

---

## 3차 구현

목표:

- 저장, 복원, 실행 주입, rollover 재주입까지 자동 검증으로 고정해야 한다.
- Dashboard와 Mobile의 UI 추가가 빌드 수준에서 안정적으로 유지돼야 한다.
- 이후 기능 확장 전에 `thread 개발지침`의 핵심 계약을 회귀 테스트로 잠가야 한다.

### 3차 구현 범위

- `tests/integration/root-thread-rollover.bridge.integration.test.mjs`
- `apps/dashboard/src/App.jsx`
- `apps/mobile/src/App.jsx`
- `docs/thread-developer-instruction-design.md`

### 3차 구현 상세 체크리스트

#### A. 브리지 통합 검증 추가

- [x] thread 개발지침 수정 API 호출이 성공하는지 통합 테스트로 확인
- [x] thread 목록 재조회 시 `developer_instructions`가 유지되는지 확인
- [x] bridge 재시작 후에도 thread 개발지침이 복원되는지 확인
- [x] 최초 `thread/start` 요청의 `developerInstructions`에 project + thread 개발지침이 함께 들어가는지 확인
- [x] rollover 이후 새 physical thread의 `thread/start`에도 동일한 병합 결과가 다시 들어가는지 확인

#### B. UI 회귀 방지

- [x] Dashboard thread 개발지침 UI가 빌드 오류 없이 포함되는지 확인
- [x] Mobile thread 개발지침 UI가 빌드 오류 없이 포함되는지 확인
- [x] 신규 상태 필드(`developer_instructions`)가 thread 정규화 과정에서 유실되지 않는지 확인
- [x] 저장 직후 thread state 갱신이 현재 선택 thread/detail state와 충돌하지 않는지 확인

#### C. 운영 기준 고정

- [x] thread 개발지침은 빈 문자열 저장 시 제거되는 정책으로 고정
- [x] project 개발지침과 thread 개발지침은 `append`이며 overwrite가 아님을 문서와 테스트로 함께 고정
- [x] 반영 시점은 `다음 실행 흐름부터`라는 안내 문구로 UI와 문서를 일치시킨다

### 3차 구현 확인 체크리스트

#### 자동 검증

- [ ] `node --test tests/integration/root-thread-rollover.bridge.integration.test.mjs`
- [x] `npm run build:dashboard`
- [x] `npm run build:mobile`

#### 3차 완료 기준

- [ ] 저장/복원/실행 주입/rollover 재주입이 자동 테스트로 고정된다
- [x] Dashboard와 Mobile 빌드가 모두 통과한다
- [ ] 이후 기능 확장 전에도 현재 계약을 회귀 없이 유지할 수 있다

## 현재 안정성 판단

기준 시점: 2026-03-22

- `thread 개발지침` 기능 자체는 구현되어 있으며, 저장/복원/실행 주입/rollover 재주입을 검증하는 통합 테스트
  `thread 개발지침은 저장 후 재시작에도 유지되고 새 physical thread 시작에 함께 주입된다`는 통과했습니다.
- 혼합 배포 안전성은 `409 unsupported_bridge_feature` 가드와 Dashboard/Mobile 인라인 오류 표시로 보강되어,
  구버전 bridge에서의 모호한 실패를 사용자에게 명확히 드러내도록 정리되었습니다.
- `npm run build:dashboard`, `npm run build:mobile`은 모두 통과했습니다.
- 다만 저장소 기준 전체 자동 검증은 아직 완전히 녹색이 아닙니다.
  `node --test tests/integration/root-thread-rollover.bridge.integration.test.mjs` 전체 실행은 실패 2건으로 종료되었습니다.
- 실패 1: `브리지 root thread rollover 통합 검증`
  persisted thread storage 파일을 직접 읽는 구간에서 `ENOENT`가 발생했습니다.
- 실패 2: `issue 첨부는 생성과 수정 후 유지되고 실행 프롬프트에도 포함된다`
  attachment 응답 shape에 nullable 메타 필드가 포함되어 기존 `deepEqual` 기대값과 불일치했습니다.
- 결론적으로 현재 상태는 `기능 단위 안정성은 높지만, 저장소 전체 회귀 안정성은 아직 보강이 필요함`으로 판단합니다.

---

## 통합 검증 순서

안정성 확보를 위해 검증도 아래 순서로 고정합니다.

1. 1차 구현 코드 반영
2. API 저장/조회 확인
3. 실행 반영 확인
4. rollover 반영 확인
5. 기존 기능 회귀 확인
6. 2차 구현 코드 반영
7. Dashboard 편집 흐름 확인
8. Mobile 편집 흐름 확인
9. 3차 구현 코드 반영
10. 자동 검증 실행
11. 전체 사용자 시나리오 재검증

### 최종 수동 시나리오

1. 프로젝트 공통 개발지침 저장
2. thread A 생성
3. thread B 생성
4. thread A에만 thread 개발지침 저장
5. thread 목록 재조회
6. thread A에서 issue 실행
7. thread B에서 issue 실행
8. thread A rollover 유도
9. thread A 후속 issue 실행
10. Dashboard에서 thread A 개발지침 수정
11. Mobile에서 thread A 개발지침 조회 및 재수정
12. 다시 실행해 최신 지침이 이후 흐름에 반영되는지 확인

---

## 오픈 이슈

### 1. 현재 열려 있는 Codex thread에 즉시 반영할 것인가

1차 설계에서는 하지 않습니다.

### 2. thread 생성 시 개발지침을 함께 받을 것인가

1차 설계에서는 하지 않습니다.

이유는 둘 다 같습니다.

- 현재 구조에서 최소 수정이 아니다.
- 저장 이후 반영 정책이 복잡해진다.
- 먼저 수정 API와 실행 반영 경로를 안정화하는 것이 맞다.

---

## 최종 권장안

현재 코드 기준 가장 합리적인 방향은 아래입니다.

1. thread에 `developer_instructions`만 추가 저장한다.
2. `PATCH /api/threads/{threadId}`에 `developer_instructions`, `update_developer_instructions`를 추가한다.
3. bridge에서 project 개발지침과 thread 개발지침을 연결하는 helper를 만든다.
4. `ensureCodexThreadForPhysicalThread()`에서 최종 `developerInstructions`를 조합해 `thread/start`에 넣는다.
5. UI는 프로젝트 개발지침 편집 패턴을 재사용하되, thread 전용 개발지침으로 scope를 명확히 분리한다.

이 방식이 현재 구조와 가장 잘 맞고, 수정 범위를 가장 작게 유지합니다.
