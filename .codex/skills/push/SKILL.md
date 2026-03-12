---
name: push
description:
  Push current branch changes to origin and create or update the corresponding
  pull request; use when asked to push, publish updates, or create pull request.
---

# Push

## Prerequisites

- `gh` CLI is installed and available in `PATH`.
- `gh auth status` succeeds for GitHub operations in this repo.

## Goals

- Push current branch changes to `origin` safely.
- Create a PR if none exists for the branch, otherwise update the existing PR.
- Keep branch history clean when the remote has moved.

## Related Skills

- `pull`: use this when push is rejected or sync is not clean.

## Steps

1. Identify the current branch and confirm remote state.
2. Run the narrowest repo-appropriate validation before pushing.
   - Prefer a documented project command when one exists.
   - If the repo does not define a single command, run the targeted checks that
     directly prove the changed behavior.
3. Push the branch to `origin` with upstream tracking if needed.
4. If push is rejected:
   - For non-fast-forward or stale-branch issues, run the `pull` skill, rerun
     validation, and push again.
   - For auth, permissions, or workflow restrictions, stop and surface the
     exact error.
5. Ensure a PR exists for the branch:
   - If no PR exists, create one.
   - If a PR exists and is open, update it.
   - If the branch is tied to a closed or merged PR, create a new branch and a
     new PR.
6. Write or refresh the PR body using `.github/pull_request_template.md`.
   - Replace placeholders with concrete scope, validation, and risk notes.
   - Ensure the PR title/body reflect the total branch scope, not only the
     latest commit.
7. If the repository provides a PR body checker, run it and fix all reported
   issues. Otherwise skip that step.
8. Reply with the PR URL from `gh pr view`.

## Commands

```sh
branch=$(git branch --show-current)

git push -u origin HEAD

# If the remote moved, run the pull skill first, then retry:
git push -u origin HEAD

# Only if local history was intentionally rewritten:
git push --force-with-lease origin HEAD

pr_state=$(gh pr view --json state -q .state 2>/dev/null || true)
if [ "$pr_state" = "MERGED" ] || [ "$pr_state" = "CLOSED" ]; then
  echo "Current branch is tied to a closed PR; create a new branch + PR." >&2
  exit 1
fi

pr_title="<clear PR title written for this change>"
if [ -z "$pr_state" ]; then
  gh pr create --title "$pr_title" --body-file /tmp/pr_body.md
else
  gh pr edit --title "$pr_title" --body-file /tmp/pr_body.md
fi

gh pr view --json url -q .url
```

## Notes

- Do not use `--force`; only use `--force-with-lease` as the last resort.
- Distinguish sync problems from remote auth/permission problems.
- If the repo has no single validation entrypoint, record the exact proof you
  ran in the PR body and workpad.
