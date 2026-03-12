#!/usr/bin/env python3
import asyncio
import json
import random
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any

POLL_SECONDS = 10
CHECKS_APPEAR_TIMEOUT_SECONDS = 120
CODEX_BOTS = {
    "chatgpt-codex-connector[bot]",
    "github-actions[bot]",
    "codex-gc-app[bot]",
    "app/codex-gc-app",
}
MAX_GH_RETRIES = 5
BASE_GH_BACKOFF_SECONDS = 2


@dataclass
class PrInfo:
    number: int
    url: str
    head_sha: str
    mergeable: str | None
    merge_state: str | None


class RateLimitError(RuntimeError):
    pass


def is_rate_limit_error(error: str) -> bool:
    return "HTTP 429" in error or "rate limit" in error.lower()


async def run_gh(*args: str) -> str:
    max_delay = BASE_GH_BACKOFF_SECONDS * (2 ** (MAX_GH_RETRIES - 1))
    delay_seconds = BASE_GH_BACKOFF_SECONDS
    last_error = "gh command failed"
    for attempt in range(1, MAX_GH_RETRIES + 1):
        proc = await asyncio.create_subprocess_exec(
            "gh",
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode == 0:
            return stdout.decode()
        error = stderr.decode().strip() or "gh command failed"
        if not is_rate_limit_error(error):
            raise RuntimeError(error)
        last_error = error
        if attempt >= MAX_GH_RETRIES:
            break
        jitter = random.uniform(0, delay_seconds)
        await asyncio.sleep(min(delay_seconds + jitter, max_delay))
        delay_seconds = min(delay_seconds * 2, max_delay)
    raise RateLimitError(last_error)


async def get_pr_info() -> PrInfo:
    data = await run_gh(
        "pr",
        "view",
        "--json",
        "number,url,headRefOid,mergeable,mergeStateStatus",
    )
    parsed = json.loads(data)
    return PrInfo(
        number=parsed["number"],
        url=parsed["url"],
        head_sha=parsed["headRefOid"],
        mergeable=parsed.get("mergeable"),
        merge_state=parsed.get("mergeStateStatus"),
    )


async def get_paginated_list(endpoint: str) -> list[dict[str, Any]]:
    page = 1
    items: list[dict[str, Any]] = []
    while True:
        data = await run_gh(
            "api",
            "--method",
            "GET",
            endpoint,
            "-f",
            "per_page=100",
            "-f",
            f"page={page}",
        )
        batch = json.loads(data)
        if not batch:
            break
        items.extend(batch)
        page += 1
    return items


async def get_issue_comments(pr_number: int) -> list[dict[str, Any]]:
    return await get_paginated_list(
        f"repos/{{owner}}/{{repo}}/issues/{pr_number}/comments",
    )


async def get_review_comments(pr_number: int) -> list[dict[str, Any]]:
    return await get_paginated_list(
        f"repos/{{owner}}/{{repo}}/pulls/{pr_number}/comments",
    )


async def get_reviews(pr_number: int) -> list[dict[str, Any]]:
    page = 1
    reviews: list[dict[str, Any]] = []
    while True:
        data = await run_gh(
            "api",
            "--method",
            "GET",
            f"repos/{{owner}}/{{repo}}/pulls/{pr_number}/reviews",
            "-f",
            "per_page=100",
            "-f",
            f"page={page}",
        )
        batch = json.loads(data)
        if not batch:
            break
        reviews.extend(batch)
        page += 1
    return reviews


async def get_check_runs(head_sha: str) -> list[dict[str, Any]]:
    page = 1
    check_runs: list[dict[str, Any]] = []
    while True:
        data = await run_gh(
            "api",
            "--method",
            "GET",
            f"repos/{{owner}}/{{repo}}/commits/{head_sha}/check-runs",
            "-f",
            "per_page=100",
            "-f",
            f"page={page}",
        )
        payload = json.loads(data)
        batch = payload.get("check_runs", [])
        if not batch:
            break
        check_runs.extend(batch)
        total_count = payload.get("total_count")
        if total_count is not None and len(check_runs) >= total_count:
            break
        page += 1
    return check_runs


def parse_time(value: str) -> datetime:
    normalized = value.replace("Z", "+00:00")
    return datetime.fromisoformat(normalized)


CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")


def sanitize_terminal_output(value: str) -> str:
    return CONTROL_CHARS_RE.sub("", value)


def check_timestamp(check: dict[str, Any]) -> datetime | None:
    for key in ("completed_at", "started_at", "run_started_at", "created_at"):
        value = check.get(key)
        if value:
            return parse_time(value)
    return None


def dedupe_check_runs(check_runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    latest_by_name: dict[str, dict[str, Any]] = {}
    for check in check_runs:
        name = check.get("name", "unknown")
        timestamp = check_timestamp(check)
        if name not in latest_by_name:
            latest_by_name[name] = check
            continue
        existing = latest_by_name[name]
        existing_timestamp = check_timestamp(existing)
        if timestamp is None:
            continue
        if existing_timestamp is None or timestamp > existing_timestamp:
            latest_by_name[name] = check
    return list(latest_by_name.values())


def summarize_checks(check_runs: list[dict[str, Any]]) -> tuple[bool, bool, list[str]]:
    if not check_runs:
        return True, False, ["no checks reported"]
    check_runs = dedupe_check_runs(check_runs)
    pending = False
    failed = False
    failures: list[str] = []
    for check in check_runs:
        status = check.get("status")
        conclusion = check.get("conclusion")
        name = check.get("name", "unknown")
        if status != "completed":
            pending = True
            continue
        if conclusion not in ("success", "skipped", "neutral"):
            failed = True
            failures.append(f"{name}: {conclusion}")
    return pending, failed, failures


def latest_review_request_at(comments: list[dict[str, Any]]) -> datetime | None:
    latest: datetime | None = None
    for comment in comments:
        if is_codex_bot_user(comment.get("user", {})):
            continue
        body = comment.get("body") or ""
        if "@codex review" not in body:
            continue
        timestamp = comment_time(comment)
        if timestamp is None:
            continue
        if latest is None or timestamp > latest:
            latest = timestamp
    return latest


def filter_codex_comments(
    comments: list[dict[str, Any]],
    review_requested_at: datetime | None,
) -> list[dict[str, Any]]:
    latest_codex_reply = latest_codex_reply_by_thread(comments)
    latest_issue_ack = latest_codex_issue_reply_time(comments)
    codex_comments = [c for c in comments if is_codex_bot_user(c.get("user", {}))]
    filtered: list[dict[str, Any]] = []
    for comment in codex_comments:
        created_time = comment_time(comment)
        if created_time is None:
            continue
        if review_requested_at is not None and created_time <= review_requested_at:
            continue
        is_threaded = bool(
            comment.get("in_reply_to_id") or comment.get("pull_request_review_id")
        )
        if not is_threaded:
            if latest_issue_ack is not None and created_time <= latest_issue_ack:
                continue
        else:
            thread_root = thread_root_id(comment)
            last_reply = None
            if thread_root is not None:
                last_reply = latest_codex_reply.get(thread_root)
            if last_reply is not None and created_time <= last_reply:
                continue
        filtered.append(comment)
    return filtered


def thread_root_id(comment: dict[str, Any]) -> int | None:
    return comment.get("in_reply_to_id") or comment.get("id")


def latest_codex_reply_by_thread(comments: list[dict[str, Any]]) -> dict[int, datetime]:
    latest: dict[int, datetime] = {}
    for comment in comments:
        if not is_user_codex_reply(comment):
            continue
        root = thread_root_id(comment)
        timestamp = comment_time(comment)
        if root is None or timestamp is None:
            continue
        if root not in latest or timestamp > latest[root]:
            latest[root] = timestamp
    return latest


def latest_codex_issue_reply_time(comments: list[dict[str, Any]]) -> datetime | None:
    latest: datetime | None = None
    for comment in comments:
        if not is_user_codex_reply(comment):
            continue
        if comment.get("in_reply_to_id") or comment.get("pull_request_review_id"):
            continue
        timestamp = comment_time(comment)
        if timestamp is None:
            continue
        if latest is None or timestamp > latest:
            latest = timestamp
    return latest


def comment_time(comment: dict[str, Any]) -> datetime | None:
    for key in ("updated_at", "submitted_at", "created_at"):
        value = comment.get(key)
        if value:
            return parse_time(value)
    return None


def is_codex_bot_user(user: dict[str, Any]) -> bool:
    login = (user or {}).get("login") or ""
    return login in CODEX_BOTS


def is_user_codex_reply(comment: dict[str, Any]) -> bool:
    user = comment.get("user", {})
    if is_codex_bot_user(user):
        return False
    body = comment.get("body") or ""
    return body.strip().startswith("[codex]")


def unresolved_review_comments(
    comments: list[dict[str, Any]],
    reviews: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    dismissed_review_ids = {
        review["id"] for review in reviews if review.get("state") == "DISMISSED"
    }
    latest_reply = latest_codex_reply_by_thread(comments)
    unresolved: list[dict[str, Any]] = []
    for comment in comments:
        if not is_blocking_review_comment(comment, dismissed_review_ids):
            continue
        root = thread_root_id(comment)
        timestamp = comment_time(comment)
        if root is None or timestamp is None:
            unresolved.append(comment)
            continue
        reply_time = latest_reply.get(root)
        if reply_time is None or reply_time < timestamp:
            unresolved.append(comment)
    return unresolved


def is_blocking_review_comment(
    comment: dict[str, Any],
    dismissed_review_ids: set[int],
) -> bool:
    user = comment.get("user", {})
    if is_codex_bot_user(user):
        return False
    if comment.get("pull_request_review_id") in dismissed_review_ids:
        return False
    body = (comment.get("body") or "").strip()
    if not body:
        return False
    return True


async def wait_for_check_runs(head_sha: str) -> list[dict[str, Any]]:
    deadline = asyncio.get_event_loop().time() + CHECKS_APPEAR_TIMEOUT_SECONDS
    while True:
        check_runs = await get_check_runs(head_sha)
        if check_runs:
          return check_runs
        if asyncio.get_event_loop().time() >= deadline:
            return []
        await asyncio.sleep(POLL_SECONDS)


async def main() -> int:
    pr = await get_pr_info()
    print(f"watching {sanitize_terminal_output(pr.url)}")

    while True:
        issue_comments, review_comments, reviews = await asyncio.gather(
            get_issue_comments(pr.number),
            get_review_comments(pr.number),
            get_reviews(pr.number),
        )

        review_requested_at = latest_review_request_at(issue_comments)
        codex_issue_comments = filter_codex_comments(issue_comments, review_requested_at)
        unresolved_reviews = unresolved_review_comments(review_comments, reviews)
        if codex_issue_comments or unresolved_reviews:
            return 2

        latest_pr = await get_pr_info()
        if latest_pr.head_sha != pr.head_sha:
            return 4

        check_runs = await wait_for_check_runs(pr.head_sha)
        pending, failed, failures = summarize_checks(check_runs)
        if failed:
            for failure in failures:
                print(sanitize_terminal_output(failure))
            return 3
        if not pending:
            return 0

        await asyncio.sleep(POLL_SECONDS)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
