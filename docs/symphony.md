# Symphony Local Run

이 저장소는 Symphony Elixir를 repo 외부 서비스로 실행하고, 현재 저장소를 작업 대상으로 clone하는 방식으로 동작합니다.

## Secret handling

- `LINEAR_API_KEY`는 Git에 저장하지 않습니다.
- `scripts/symphony/setup-secrets.sh`가 macOS Keychain에 `octop.symphony.linear_api_key` 서비스명으로 저장합니다.
- 비밀이 아닌 값(`LINEAR_PROJECT_SLUG`, `SYMPHONY_WORKSPACE_ROOT`, `SOURCE_REPO_URL`)만 `.env.symphony.local`에 저장됩니다.

## First-time setup

```bash
scripts/symphony/setup-secrets.sh
scripts/symphony/doctor.sh
scripts/symphony/run.sh
```

## Notes

- `scripts/symphony/run.sh`는 필요한 경우 `mise`, `gh`를 Homebrew로 설치합니다.
- Symphony 원본은 `.vendor/symphony`에 로컬 clone되며 `.gitignore`로 제외됩니다.
- 기본 대시보드 포트는 `4100`입니다.
- 로그는 `.symphony/log` 아래에 기록됩니다.
