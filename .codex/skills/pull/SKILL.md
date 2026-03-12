---
name: pull
description:
  Pull latest origin/main into the current local branch and resolve merge
  conflicts (aka update-branch). Use when Codex needs to sync a feature branch
  with origin, perform a merge-based update (not rebase), and guide conflict
  resolution best practices.
---

# Pull

## Workflow

1. Verify git status is clean or commit/stash changes before merging.
2. Ensure rerere is enabled locally:
   - `git config rerere.enabled true`
   - `git config rerere.autoupdate true`
3. Confirm remotes and branches:
   - Ensure the `origin` remote exists.
   - Ensure the current branch is the one to receive the merge.
4. Fetch latest refs:
   - `git fetch origin`
5. Sync the remote feature branch first:
   - `git pull --ff-only origin $(git branch --show-current)`
6. Merge in order:
   - Prefer `git -c merge.conflictstyle=zdiff3 merge origin/main`
7. If conflicts appear, resolve them one file at a time, then:
   - `git add <files>`
   - `git commit` or `git merge --continue`
8. Verify with repo-appropriate checks after the merge.
9. Summarize the merge:
   - Call out the most difficult conflicts and how they were resolved.
   - Note any assumptions or follow-ups.

## Conflict Resolution Guidance

- Inspect context before editing:
  - `git status`
  - `git diff`
  - `git diff --merge`
  - `git diff :1:path :2:path`
  - `git diff :1:path :3:path`
- Summarize the intent of both sides before choosing a resolution.
- Prefer minimal, intention-preserving edits.
- Preserve user-visible behavior and API contracts unless the incoming change
  clearly supersedes them.
- For generated files, resolve source conflicts first, then regenerate.
- For import conflicts, keep both sides temporarily if intent is unclear, then
  remove the unused imports after checks pass.
- After resolving, ensure no conflict markers remain with `git diff --check`.

## When To Ask The User

Do not ask unless there is no safe, reversible alternative.

Ask only when:

- the correct resolution depends on product intent not inferable from code,
  tests, or nearby docs;
- the conflict changes an external contract or migration in a risky way;
- two mutually exclusive designs have no local signal to break the tie;
- the merge implies data loss or irreversible side effects without a safe
  default;
- the intended target branch or remote cannot be determined locally.
