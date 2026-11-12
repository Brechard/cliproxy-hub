#!/usr/bin/python3
"""Soonest-reset-first routing for a local CLIProxyAPI Claude pool, plus Codex usage history.

Every run reads each pooled Claude account's 5-hour and weekly usage through the
proxy's management API and sets credential priorities so new sessions go to the
usable account whose weekly window resets soonest. Quota left at a reset is lost.
Running sessions keep their account (session affinity outranks priority).
Codex accounts are only read for the history chart; their priorities stay as set.

Talks only to the management API on 127.0.0.1. Never redeems or spends anything.
With --serve it runs every 5 minutes and serves the recorded quota history to the
management panel (see history_server.py); without it, it runs once.
"""
import datetime as dt
import json
import os
import re
import sys
import urllib.request

BASE = os.environ.get("CLIPROXY_URL", "http://127.0.0.1:8317")
KEY_FILE = os.path.expanduser("~/.cli-proxy-api/management-key.txt")
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
# The usage endpoint answers 429 without a Claude Code user agent.
USAGE_HEADERS = {
    "Authorization": "Bearer $TOKEN$",
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": "claude-code/2.1.318",
}
CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
CODEX_USAGE_HEADERS = {
    "Authorization": "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "User-Agent": "codex-tui",
}


def parse_time(value):
    if not value:
        return None
    # Python 3.9's fromisoformat accepts only 3- or 6-digit fractions.
    value = re.sub(r"\.(\d+)", lambda m: "." + (m.group(1) + "000000")[:6], value)
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def window(usage, name):
    entry = usage.get(name) or {}
    return entry.get("utilization"), parse_time(entry.get("resets_at"))


def desired_priorities(accounts, now):
    """accounts: [{name, usage}] with usage from /api/oauth/usage.

    Usable accounts rank by soonest weekly reset; an account with no known weekly
    reset ranks after those with one. Exhausted accounts get 0. Higher wins.
    """
    usable, exhausted = [], []
    for account in accounts:
        weekly_used, weekly_reset = window(account["usage"], "seven_day")
        five_used, five_reset = window(account["usage"], "five_hour")
        weekly_out = weekly_used is not None and weekly_used >= 100 and (
            weekly_reset is None or weekly_reset > now)
        five_out = five_used is not None and five_used >= 100 and (
            five_reset is None or five_reset > now)
        if weekly_out or five_out:
            exhausted.append(account["name"])
        else:
            usable.append((weekly_reset is None or weekly_reset <= now,
                           weekly_reset or now, account["name"]))
    usable.sort()
    result = {name: 0 for name in exhausted}
    for index, (_, _, name) in enumerate(usable):
        result[name] = 10 * (len(usable) - index)
    return result


def management(key, method, path, body=None):
    request = urllib.request.Request(
        BASE + "/v0/management/" + path,
        data=None if body is None else json.dumps(body).encode(),
        method=method,
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def read_usage(key, auth_index):
    response = management(key, "POST", "api-call", {
        "auth_index": auth_index, "method": "GET", "url": USAGE_URL, "header": USAGE_HEADERS,
    })
    if not 200 <= response.get("status_code", 0) < 300:
        raise RuntimeError("usage read returned HTTP %s" % response.get("status_code"))
    body = response.get("body")
    return json.loads(body) if isinstance(body, str) else body


def read_codex_usage(key, entry):
    """Codex usage for one ChatGPT login. Read-only: never touches reset credits."""
    id_token = entry.get("id_token") if isinstance(entry.get("id_token"), dict) else {}
    header = dict(CODEX_USAGE_HEADERS)
    if id_token.get("chatgpt_account_id"):
        header["Chatgpt-Account-Id"] = id_token["chatgpt_account_id"]
    response = management(key, "POST", "api-call", {
        "auth_index": entry["auth_index"], "method": "GET", "url": CODEX_USAGE_URL, "header": header,
    })
    if not 200 <= response.get("status_code", 0) < 300:
        raise RuntimeError("usage read returned HTTP %s" % response.get("status_code"))
    body = response.get("body")
    return json.loads(body) if isinstance(body, str) else body


def route_claude(key, files, now, dry_run):
    """Set Claude priorities. Returns (accounts read, priorities set or None)."""
    accounts = []
    for entry in files:
        try:
            accounts.append({"name": entry["name"], "provider": "claude",
                             "usage": read_usage(key, entry["auth_index"])})
        except Exception as error:
            # Ranking on partial data could route away from the right account.
            print("%s: %s; leaving priorities unchanged" % (entry["name"], error))
            return accounts, None
    desired = desired_priorities(accounts, now)
    for entry in files:
        current = entry.get("priority") or 0
        target = desired[entry["name"]]
        usage = next(a["usage"] for a in accounts if a["name"] == entry["name"])
        weekly_used, weekly_reset = window(usage, "seven_day")
        five_used, _ = window(usage, "five_hour")
        if target != current or dry_run or sys.stdout.isatty():
            print("%s %s: weekly %s%% resets %s, 5h %s%%, priority %s -> %s" % (
                now.isoformat(timespec="seconds"), entry["name"], weekly_used, weekly_reset,
                five_used, current, target))
        if target != current and not dry_run:
            management(key, "PATCH", "auth-files/fields", {"name": entry["name"], "priority": target})
    return accounts, desired


def read_codex(key, files):
    """Codex accounts are recorded for the chart only; their priorities are left alone."""
    accounts = []
    for entry in files:
        try:
            accounts.append({"name": entry["name"], "provider": "codex",
                             "usage": read_codex_usage(key, entry)})
        except Exception as error:
            print("%s: %s; not recorded this run" % (entry["name"], error))
    return accounts


def run_once(dry_run=False):
    with open(KEY_FILE) as handle:
        key = handle.read().strip()
    now = dt.datetime.now(dt.timezone.utc)
    files = [f for f in management(key, "GET", "auth-files")["files"] if not f.get("disabled")]
    claude, desired = route_claude(
        key, [f for f in files if f.get("provider") == "claude"], now, dry_run)
    if dry_run:
        return 0 if desired is not None else 1
    try:
        codex = read_codex(key, [f for f in files if f.get("provider") == "codex"])
    except Exception as error:
        print("codex usage: %s" % error)
        codex = []
    priorities = dict(desired or {})
    priorities.update({f["name"]: f.get("priority") for f in files if f.get("provider") == "codex"})
    try:
        import quota_history
        quota_history.record(claude + codex, now, priorities)
    except Exception as error:
        # History is a view; it must never block routing.
        print("quota history: %s" % error)
    return 0 if desired is not None else 1


def main():
    if "--serve" in sys.argv:
        import history_server
        return history_server.serve(run_once)
    return run_once("--dry-run" in sys.argv)


if __name__ == "__main__":
    sys.exit(main())
