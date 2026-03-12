---
name: land
description:
  Land a PR by monitoring conflicts, resolving them, waiting for checks, and
  squash-merging when green; use when asked to land, merge, or shepherd a PR to
  completion.
---

# Land

## Goals

- Ensure the PR is conflict-free with `main`.
- Keep CI green and fix failures when they occur.
- Squash-merge the PR once checks pass.
- Keep the watcher loop running until the PR is merged unless truly blocked.

## Preconditions

- `gh` CLI is authenticated.
- You are on the PR branch with a clean working tree.

## Steps

1. Locate the PR for the current branch.
2. Confirm repo-appropriate local validation is green before any push.
3. If the working tree has uncommitted changes, use the `commit` skill and
   publish with the `push` skill first.
4. Check mergeability and conflicts against `main`.
5. If conflicts exist, use the `pull` skill to merge `origin/main`, resolve
   conflicts, then use the `push` skill to publish the updated branch.
6. Ensure all review comments are acknowledged and any required fixes are
   handled before merging.
7. Watch checks until complete.
8. If checks fail, inspect logs, fix the issue, commit with the `commit` skill,
   push with the `push` skill, and restart the watch.
9. When all checks are green and review feedback is addressed, squash-merge
   using the PR title/body for the merge subject/body.
10. Before implementing review feedback, confirm it does not conflict with the
    user's stated intent or task context.
11. For each review comment, choose one of: accept, clarify, or push back. Give
    the reviewer a concrete response before pushing changes.

## Commands

```sh
branch=$(git branch --show-current)
pr_number=$(gh pr view --json number -q .number)
pr_title=$(gh pr view --json title -q .title)
pr_body=$(gh pr view --json body -q .body)
mergeable=$(gh pr view --json mergeable -q .mergeable)

if [ "$mergeable" = "CONFLICTING" ]; then
  # Run the pull skill, then publish with the push skill.
  exit 1
fi

python3 .codex/skills/land/land_watch.py

gh pr merge --squash --subject "$pr_title" --body "$pr_body"
```

## Async Watch Helper

Preferred:

```sh
python3 .codex/skills/land/land_watch.py
```

Exit codes:

- `2`: review comments detected
- `3`: CI checks failed
- `4`: PR head updated remotely

## Failure Handling

- If checks fail, inspect `gh pr checks` and `gh run view --log`, fix the
  problem locally, commit, push, and retry.
- If mergeability is `UNKNOWN`, wait and re-check.
- Do not merge while human or Codex review comments are still outstanding.
- Do not enable auto-merge unless the repository explicitly allows it and all
  required checks are already green.

## Review Handling

- Treat human review comments as blocking until addressed or explicitly pushed
  back with justification.
- Codex review issue comments usually start with `## Codex Review`.
- Reply to inline review comments inline, and reply to top-level Codex review
  comments in the issue thread with a `[codex]` prefix.
- When feedback requires code changes:
  - acknowledge the feedback first,
  - implement the fix,
  - reply with the fix summary and commit SHA,
  - rerun validation before merge.
