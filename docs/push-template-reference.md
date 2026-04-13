# Push Template Reference

## 목적

- 이 문서는 OctOP API 푸시 알림 문자열 템플릿 환경변수와 치환 가능한 데이터 토큰을 정리한다.
- 대상 구현은 [PushNotificationTemplateService.cs](/Users/jazzlife/Documents/Workspaces/Products/OctOP/apps/api/Push/PushNotificationTemplateService.cs) 기준이다.

## 적용 방식

- API 서버는 아래 환경변수를 읽어 푸시 제목, 본문, 태그, URL 을 만든다.
- 환경변수가 비어 있으면 기본 템플릿을 사용한다.
- 템플릿 안의 `{token}` 형태 문자열은 실제 이벤트 데이터로 치환된다.
- 정의되지 않은 토큰은 그대로 남는다.

## 환경변수

### 완료 알림

- `OCTOP_PUSH_TEMPLATE_COMPLETED_TITLE`
- `OCTOP_PUSH_TEMPLATE_COMPLETED_BODY`
- `OCTOP_PUSH_TEMPLATE_COMPLETED_TAG`

### 실패 알림

- `OCTOP_PUSH_TEMPLATE_FAILED_TITLE`
- `OCTOP_PUSH_TEMPLATE_FAILED_BODY`
- `OCTOP_PUSH_TEMPLATE_FAILED_TAG`

### 공통

- `OCTOP_PUSH_TEMPLATE_DEFAULT_TITLE`
- `OCTOP_PUSH_TEMPLATE_DEFAULT_BODY`
- `OCTOP_PUSH_TEMPLATE_URL`
- `OCTOP_PUSH_TEMPLATE_DASHBOARD_URL`
- `OCTOP_PUSH_TEMPLATE_MOBILE_URL`

## 기본값

```env
OCTOP_PUSH_TEMPLATE_DEFAULT_TITLE=OctOP Push
OCTOP_PUSH_TEMPLATE_DEFAULT_BODY=테스트 푸시입니다.
OCTOP_PUSH_TEMPLATE_COMPLETED_TITLE={projectPrefix}이슈 완료
OCTOP_PUSH_TEMPLATE_COMPLETED_BODY={issueTitleOrId} 이(가) 완료 상태가 되었습니다.
OCTOP_PUSH_TEMPLATE_FAILED_TITLE={projectPrefix}이슈 실패
OCTOP_PUSH_TEMPLATE_FAILED_BODY={issueTitleOrId} 이(가) 실패 상태가 되었습니다.
OCTOP_PUSH_TEMPLATE_COMPLETED_TAG=issue-{issueId}-completed
OCTOP_PUSH_TEMPLATE_FAILED_TAG=issue-{issueId}-failed
OCTOP_PUSH_TEMPLATE_URL=/?bridge_id={bridgeId}&project_id={projectId}&thread_id={threadId}&issue_id={issueId}
OCTOP_PUSH_TEMPLATE_DASHBOARD_URL=/?bridge_id={bridgeId}&project_id={projectId}&thread_id={threadId}&issue_id={issueId}
OCTOP_PUSH_TEMPLATE_MOBILE_URL=/?bridge_id={bridgeId}&project_id={projectId}&thread_id={threadId}&issue_id={issueId}&client_mode=standalone
```

## 치환 가능한 토큰

### 식별자

- `{bridgeId}`: 브릿지 ID
- `{projectId}`: 프로젝트 ID
- `{threadId}`: 스레드 ID
- `{issueId}`: 이슈 ID
- `{sourceAppId}`: 이슈가 생성된 앱 ID. 현재 `dashboard-web` 또는 `mobile-web`
- `{targetAppId}`: 이번 푸시가 전달되는 대상 앱 ID. 현재 `dashboard-web` 또는 `mobile-web`

### 상태

- `{issueStatus}`: 원본 상태값. 현재 `completed` 또는 `failed`
- `{statusLabel}`: 한글 상태 라벨. 현재 `완료` 또는 `실패`

### 이름

- `{projectName}`: 프로젝트 이름. 없으면 빈 문자열
- `{issueTitle}`: 이슈 제목. 없으면 이슈 ID 로 대체된 값이 들어올 수 있음
- `{issueTitleOrId}`: 이슈 제목이 있으면 제목, 없으면 이슈 ID

### 표시 편의값

- `{projectPrefix}`: 프로젝트 이름이 있으면 `프로젝트명 · `, 없으면 빈 문자열

## 예시

### 제목을 더 직접적으로 바꾸기

```env
OCTOP_PUSH_TEMPLATE_COMPLETED_TITLE=[완료] {issueTitleOrId}
OCTOP_PUSH_TEMPLATE_FAILED_TITLE=[실패] {issueTitleOrId}
```

### 본문에 식별자 넣기

```env
OCTOP_PUSH_TEMPLATE_COMPLETED_BODY=프로젝트 {projectName} / 이슈 {issueId}
OCTOP_PUSH_TEMPLATE_FAILED_BODY=브릿지 {bridgeId} 에서 {issueTitleOrId} 처리에 실패했습니다.
```

### 태그를 커스텀하기

```env
OCTOP_PUSH_TEMPLATE_COMPLETED_TAG=octop-{projectId}-{issueId}-done
OCTOP_PUSH_TEMPLATE_FAILED_TAG=octop-{projectId}-{issueId}-failed
```

### 클릭 URL 바꾸기

```env
OCTOP_PUSH_TEMPLATE_DASHBOARD_URL=/?bridge_id={bridgeId}&project_id={projectId}&thread_id={threadId}&issue_id={issueId}
OCTOP_PUSH_TEMPLATE_MOBILE_URL=/?bridge_id={bridgeId}&project_id={projectId}&thread_id={threadId}&issue_id={issueId}&client_mode=standalone
```

## 실제 치환 예시

입력 데이터:

```text
projectName=Push
projectId=project-123
threadId=thread-456
issueId=issue-789
issueTitle=응답해봐
issueStatus=completed
statusLabel=완료
bridgeId=bridge-abc
projectPrefix=Push · 
sourceAppId=dashboard-web
targetAppId=mobile-web
```

템플릿:

```env
OCTOP_PUSH_TEMPLATE_COMPLETED_TITLE={projectPrefix}이슈 {statusLabel}
OCTOP_PUSH_TEMPLATE_COMPLETED_BODY={issueTitleOrId} / {issueId}
OCTOP_PUSH_TEMPLATE_MOBILE_URL=/?bridge_id={bridgeId}&project_id={projectId}&thread_id={threadId}&issue_id={issueId}
```

결과:

```text
title=Push · 이슈 완료
body=응답해봐 / issue-789
url=/?bridge_id=bridge-abc&project_id=project-123&thread_id=thread-456&issue_id=issue-789&client_mode=standalone
```

## 운영 메모

- 템플릿을 바꾸면 API 프로세스 재시작이 필요하다.
- `/api/push/config` 응답의 `templates` 필드로 현재 API 프로세스가 실제로 읽고 있는 템플릿 값을 확인할 수 있다.
- 기존 브라우저 푸시 구독과는 무관하다. 템플릿 변경만으로 재구독은 필요하지 않다.
- `title`, `body`, `tag`, `url` 가 모두 빈 문자열이 되지 않도록 최소한 하나 이상의 의미 있는 기본값을 유지하는 편이 안전하다.
- `source_app_id=mobile-web` 인 이슈는 모바일 구독으로만 전송된다.
- 그 외 이슈는 현재 활성화된 대시보드/모바일 구독 모두로 전송된다.
