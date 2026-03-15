# OctOP 실제 사용 테스트 시나리오 체크리스트

## 1. 목적

이 문서는 현재 OctOP의 실제 사용 흐름을 기준으로 다음을 점검하기 위한 수동 테스트 체크리스트입니다.

- 대시보드에서 root thread 기반 칸반이 정상 동작하는지
- 모바일에서 root thread 기반 채팅 흐름이 정상 동작하는지
- rollover 이후에도 사용자는 같은 thread를 계속 사용하는 것처럼 보이는지
- delete 이후 연관 데이터가 정리되고 resurrect되지 않는지
- projection merge, grace window fallback, continuity metadata가 실제 응답과 UI에 반영되는지

이 문서는 `빠르고 반복 가능한 검증`이 목적이므로 issue 프롬프트는 모두 작은 응답으로 통일합니다.

---

## 2. 공통 프롬프트 규칙

### 2.1 기본 프롬프트

모든 issue 프롬프트는 기본적으로 아래 문장을 사용합니다.

```text
현재 워크스페이스 경로
```

의도:

- 응답이 매우 짧아야 함
- 파일 수정 없이 빠르게 완료돼야 함
- rollover와 delete, timeline, projection merge 검증 시 결과 확인이 쉬워야 함

### 2.2 추가 프롬프트 규칙

- 새로운 검증 issue도 가능하면 동일 프롬프트를 사용합니다.
- 필요할 때만 아래 변형을 사용합니다.

```text
현재 워크스페이스 경로만 한 줄로 답해
```

```text
현재 워크스페이스 경로만 코드블록 없이 답해
```

- 테스트 중에는 코드 수정형 프롬프트를 사용하지 않습니다.
- 테스트 중에는 장시간 실행 프롬프트를 사용하지 않습니다.

---

## 3. 사전 조건

### 3.1 서비스 기동

- [ ] API gateway가 기동 중이다.
- [ ] codex-adapter bridge가 기동 중이다.
- [ ] projection-worker가 기동 중이다.
- [ ] dashboard가 접속 가능하다.
- [ ] mobile이 접속 가능하다.
- [ ] 테스트 계정으로 로그인 가능하다.

### 3.2 데이터/환경 조건

- [ ] 테스트용 bridge를 사용한다.
- [ ] 테스트용 project를 하나 준비한다.
- [ ] 기존 중요한 thread가 없는 테스트 환경이다.
- [ ] 브라우저 콘솔을 열 수 있다.
- [ ] API 응답 확인용 도구를 사용할 수 있다.
  - 예: browser devtools network, curl, Bruno, Postman

### 3.3 성공/실패 기준

성공 기준:

- 사용자가 보는 thread는 끝까지 동일한 root thread다.
- rollover 이후에도 issue 목록과 모바일 채팅이 끊기지 않는다.
- handoff summary가 timeline에 보인다.
- delete 이후 관련 데이터가 재등장하지 않는다.

실패 기준:

- 새 physical thread가 사용자에게 별도 thread로 노출된다.
- timeline에서 직전 대화가 사라진다.
- issue 칸반 순서가 깨진다.
- mobile에서 handoff summary가 일반 사용자 메시지처럼 보인다.
- delete 후 thread/issue/message가 다시 나타난다.
- console error, 5xx, 무한 로딩, 빈 화면이 발생한다.

---

## 4. 공통 기록 양식

각 시나리오마다 아래를 기록합니다.

- [ ] 실행 일시
- [ ] 실행자
- [ ] bridge_id
- [ ] project_id
- [ ] root_thread_id
- [ ] 브라우저/디바이스
- [ ] 결과: pass / fail
- [ ] 실패 시 스크린샷 저장
- [ ] 실패 시 network payload 저장
- [ ] 실패 시 console log 저장

---

## 5. 기본 생성 흐름

### 5.1 root thread 생성

- [ ] dashboard 접속
- [ ] 테스트 project 선택
- [ ] 새 thread 생성
- [ ] 생성 직후 thread가 thread 목록에 1개만 보인다.
- [ ] 선택된 thread id를 기록한다.
- [ ] thread 상세 또는 issue board 진입이 정상 동작한다.

기대 결과:

- 사용자에게 보이는 thread는 하나다.
- 이름/updated_at/status가 정상 표시된다.
- mobile에서도 동일한 thread가 하나만 보인다.

### 5.2 첫 issue 생성

- [ ] 선택된 thread에서 issue 생성
- [ ] title은 비워 두거나 짧게 입력
- [ ] prompt는 `현재 워크스페이스 경로`
- [ ] issue가 prep 또는 todo 규칙에 맞게 생성된다.
- [ ] issue detail API에서 `created_physical_thread_id`가 존재하는지 확인한다.

기대 결과:

- issue가 현재 root thread 아래에 보인다.
- issue prompt와 title이 비정상적으로 비어 있지 않다.
- provenance 필드가 응답에 포함된다.

### 5.3 issue 실행

- [ ] issue를 실행 상태로 이동
- [ ] 응답이 빠르게 완료되는지 확인
- [ ] issue detail API에서 `executed_physical_thread_id`가 채워지는지 확인
- [ ] assistant 응답에 워크스페이스 경로가 포함되는지 확인

기대 결과:

- running 후 completed 또는 정상 종료 상태로 전이된다.
- assistant 메시지가 1개 이상 저장된다.
- thread 마지막 메시지가 응답 내용으로 갱신된다.

---

## 6. 대시보드 칸반 시나리오

### 6.1 칸반 기본 정렬

- [ ] prep issue 여러 개 생성
- [ ] todo issue 여러 개 생성
- [ ] prep은 `prep_position`, todo는 `queue_position` 기준으로 보이는지 확인
- [ ] refresh 후에도 순서가 유지되는지 확인

기대 결과:

- prep/todo 정렬이 깨지지 않는다.
- merged board 반환 이후에도 기존 정렬 규칙이 유지된다.

### 6.2 archive 기능

- [ ] done 또는 review 상태 issue를 archive 처리
- [ ] archived list에서만 보이는지 확인
- [ ] restore 시 원래 컬럼으로 돌아오는지 확인
- [ ] root thread delete 전후 archive 상태가 꼬이지 않는지 확인

기대 결과:

- archive는 local state 기준으로만 숨김 처리된다.
- root thread delete 이후 해당 thread scope의 archive 상태가 제거된다.

### 6.3 thread rename / delete

- [ ] thread rename 수행
- [ ] thread list에 즉시 반영되는지 확인
- [ ] 같은 thread를 mobile에서도 다시 로드했을 때 이름이 반영되는지 확인
- [ ] 마지막에 delete는 별도 시나리오에서 수행하므로 여기서는 실행하지 않는다.

---

## 7. 모바일 채팅 시나리오

### 7.1 thread 목록

- [ ] mobile 접속
- [ ] 같은 project/thread가 보이는지 확인
- [ ] dashboard에서 만든 root thread만 보이는지 확인
- [ ] context usage가 표시되는지 확인

기대 결과:

- physical thread는 별도 목록 항목으로 보이지 않는다.
- root thread 하나만 보인다.

### 7.2 메시지 타임라인

- [ ] 생성한 issue의 대화 이력이 채팅형으로 보이는지 확인
- [ ] user prompt와 assistant 응답 순서가 자연스러운지 확인
- [ ] refresh 후에도 같은 순서로 보이는지 확인

기대 결과:

- 모바일은 `/api/threads/{threadId}/issues` + `/api/issues/{issueId}` fan-out 구조로 정상 동작한다.
- issue 간 메시지 합성 결과가 깨지지 않는다.

### 7.3 handoff summary 표시

- [ ] rollover 이후 mobile에서 해당 thread 다시 열기
- [ ] handoff summary가 system message 톤으로 보이는지 확인
- [ ] user message와 visually 구분되는지 확인

기대 결과:

- handoff summary가 일반 사용자 발화처럼 보이지 않는다.
- 채팅 문맥에서 중간 handoff 이벤트로 자연스럽게 보인다.

---

## 8. rollover 시나리오

### 8.1 수동 rollover

- [ ] root thread에 issue를 하나 이상 둔다.
- [ ] issue prompt는 `현재 워크스페이스 경로`
- [ ] `POST /api/threads/{threadId}/rollover` 호출
- [ ] 응답에 `accepted: true`가 오는지 확인
- [ ] continuity API에서 `active_physical_thread_id`가 바뀌는지 확인
- [ ] `rollover_count`가 증가하는지 확인

기대 결과:

- 사용자에게 보이는 thread id는 변하지 않는다.
- 내부 active physical thread만 새 값으로 교체된다.

### 8.2 rollover 후 issue board 연속성

- [ ] dashboard issue board를 새로고침
- [ ] 기존 issue가 같은 root thread 아래 그대로 보이는지 확인
- [ ] issue가 새 thread로 분리되어 보이지 않는지 확인
- [ ] 칸반 정렬이 유지되는지 확인

기대 결과:

- root thread 하나 안에서 이전 issue와 현재 issue가 모두 이어진다.

### 8.3 rollover 후 timeline 연속성

- [ ] `/api/threads/{threadId}/timeline` 호출
- [ ] handoff summary entry가 포함되는지 확인
- [ ] source physical thread의 이전 메시지와 target physical thread의 이후 메시지가 함께 보이는지 확인
- [ ] physical sequence 오름차순으로 자연스럽게 이어지는지 확인

기대 결과:

- timeline에 문맥 단절이 없다.
- 직전 메시지가 비어 보이거나 사라지지 않는다.

### 8.4 read split 확인

- [ ] `/api/threads/{threadId}/issues` 응답의 `continuity.read_split` 확인
- [ ] `/api/threads/{threadId}/timeline` 응답의 `continuity.read_split` 확인
- [ ] `active_source = bridge` 인지 확인
- [ ] `closed_history_source = projection` 인지 확인
- [ ] `projection_catch_up_signal = projected_at >= physical_thread.closed_at` 인지 확인

기대 결과:

- 2차 구현의 read split metadata가 응답에 들어 있다.

---

## 9. grace window / projection merge 시나리오

### 9.1 grace window fallback

- [ ] rollover 직후 바로 `/api/threads/{threadId}/issues` 호출
- [ ] rollover 직후 바로 `/api/threads/{threadId}/timeline` 호출
- [ ] 직전 closed physical thread의 issue/message가 즉시 보이는지 확인

기대 결과:

- projection이 아직 따라오지 못한 경우에도 bridge fallback으로 직전 history가 보인다.

### 9.2 projection catch-up 조기 해제

- [ ] projection worker가 따라온 뒤 같은 API를 다시 호출
- [ ] `projection_caught_up_physical_thread_ids`에 직전 physical thread id가 들어가는지 확인
- [ ] `projection_pending_physical_thread_ids`에서 빠지는지 확인

기대 결과:

- grace window가 남아 있어도 projection이 catch-up 되었으면 projection 우선으로 전환된다.

---

## 10. delete 시나리오

### 10.1 root thread delete

- [ ] dashboard에서 대상 root thread delete
- [ ] thread 목록에서 즉시 사라지는지 확인
- [ ] mobile에서도 사라지는지 확인
- [ ] 선택 중이던 issue/detail이 비정상 상태 없이 정리되는지 확인

기대 결과:

- 사용자 기준 thread 하나를 지우면 관련 continuity 전체가 정리된다.

### 10.2 delete cascade 검증

- [ ] `/api/projects/{projectId}/threads`에 해당 root thread가 없는지 확인
- [ ] `/api/threads/{threadId}/issues` 호출 시 빈 응답 또는 not found 성격의 응답인지 확인
- [ ] `/api/threads/{threadId}/timeline` 호출 시 빈 응답 또는 null thread인지 확인
- [ ] continuity API에서 deleted 상태로 보이거나 비어 있는지 확인

기대 결과:

- root thread, physical thread, issue, summary, timeline projection이 함께 정리된다.

### 10.3 resurrect 방지

- [ ] delete 직후 30초 이내에 dashboard/mobile 반복 새로고침
- [ ] SSE가 다시 연결되어도 삭제된 thread가 나타나지 않는지 확인
- [ ] 브리지 `/health` 및 로그에서 late event drop 증가 여부를 확인

기대 결과:

- delete 후 late event가 와도 root thread가 resurrect되지 않는다.

---

## 11. 재시작/복구 시나리오

### 11.1 브리지 재시작 후 상태 복구

- [ ] root thread 하나와 issue 여러 개를 만든 상태 준비
- [ ] bridge 재시작
- [ ] dashboard 재접속
- [ ] 기존 root thread와 issue가 유지되는지 확인
- [ ] continuity API가 정상인지 확인

기대 결과:

- persisted state에서 정상 복구된다.
- active physical thread 포인터가 깨지지 않는다.

### 11.2 delete 후 브리지 재시작

- [ ] root thread를 삭제
- [ ] bridge 재시작
- [ ] 삭제된 root thread가 다시 나타나지 않는지 확인

기대 결과:

- `deleted_at` 기준 차단이 tombstone miss 이후에도 유지된다.

### 11.3 rollover 후 브리지 재시작

- [ ] rollover 직후 bridge 재시작
- [ ] active physical thread가 마지막 sequence를 가리키는지 확인
- [ ] 이후 새 issue 실행이 마지막 physical thread로 가는지 확인

기대 결과:

- root thread는 최신 physical thread를 계속 active로 사용한다.

---

## 12. 소규모 guided monkey test

이 섹션은 완전 랜덤이 아니라 실제 사용 흐름을 해치지 않는 범위의 가이드드 몽키 테스트입니다.

### 12.1 대시보드 guided monkey

- [ ] root thread 생성
- [ ] issue 5개 생성
- [ ] 모든 prompt는 `현재 워크스페이스 경로`
- [ ] prep 선택/해제 반복
- [ ] issue drag & drop 반복
- [ ] archive / restore 반복
- [ ] issue detail open / close 반복
- [ ] thread rename 반복
- [ ] 중간중간 refresh 반복

실패 조건:

- blank screen
- console error
- issue 중복
- issue 소실
- selection 꼬임
- archive 상태 꼬임

### 12.2 모바일 guided monkey

- [ ] thread open / close 반복
- [ ] 메시지 refresh 반복
- [ ] thread rename / delete 메뉴 진입 반복
- [ ] thread 간 전환 반복
- [ ] 스크롤 최하단/상단 반복

실패 조건:

- 메시지 순서 역전
- handoff summary 톤 깨짐
- 무한 로딩
- 잘못된 thread 열림

---

## 13. API 응답 확인 체크리스트

### 13.1 `/api/threads/{threadId}/issues`

- [ ] `thread.id == root_thread_id`
- [ ] `issues[].root_thread_id` 존재
- [ ] `issues[].created_physical_thread_id` 존재
- [ ] 실행된 issue는 `executed_physical_thread_id` 존재
- [ ] `continuity.root_thread.id` 존재
- [ ] `continuity.active_physical_thread.id` 존재
- [ ] `continuity.read_split` 존재

### 13.2 `/api/threads/{threadId}/timeline`

- [ ] `entries[]`에 handoff summary 존재
- [ ] `entries[].physical_thread_id` 존재
- [ ] `entries[].physical_sequence` 존재
- [ ] sequence 기준으로 정렬이 자연스러움
- [ ] `continuity.read_split` 존재

### 13.3 `/api/threads/{threadId}/continuity`

- [ ] `root_thread`
- [ ] `physical_threads`
- [ ] `active_physical_thread`
- [ ] `handoff_summaries`
- [ ] `recently_closed_physical_threads`

---

## 14. 운영 로그/메트릭 확인

### 14.1 로그 필드

- [ ] `root_thread_id`
- [ ] `physical_thread_id`
- [ ] `source_physical_thread_id`
- [ ] `target_physical_thread_id`
- [ ] `codex_thread_id`
- [ ] `issue_id`
- [ ] `event_type`
- [ ] `drop_reason`

### 14.2 브리지 `/health`

- [ ] `root_thread_rollover_total`
- [ ] `root_thread_rollover_failed_total`
- [ ] `root_thread_rollover_duration_ms`
- [ ] `late_event_drop_total`
- [ ] `root_thread_delete_total`
- [ ] `root_thread_delete_failed_total`

---

## 15. 최종 합격 기준

아래가 모두 만족되면 실제 사용 관점 1차 합격으로 판단합니다.

- [ ] 대시보드에서 root thread 하나만 노출된다.
- [ ] 모바일에서 root thread 하나만 노출된다.
- [ ] 작은 프롬프트 issue가 반복 실행되어도 칸반과 채팅이 안정적이다.
- [ ] rollover 이후에도 같은 thread를 계속 쓰는 것처럼 보인다.
- [ ] handoff summary가 timeline과 mobile에서 자연스럽게 보인다.
- [ ] delete 이후 resurrect가 발생하지 않는다.
- [ ] projection lag 시에도 직전 history가 비지 않는다.
- [ ] 브리지 재시작 후에도 continuity가 유지된다.
- [ ] console/network 치명 오류가 없다.

---

## 16. 후속 메모

- Playwright 자동화 시에도 기본 프롬프트는 `현재 워크스페이스 경로`를 유지합니다.
- 재현 속도를 위해 한 project 안에서 여러 thread를 반복 생성/삭제하는 방식으로 테스트합니다.
- 실패 케이스가 나오면 반드시 `root_thread_id`, `active_physical_thread_id`, `recently_closed_physical_threads`, `read_split` 응답을 같이 저장합니다.
