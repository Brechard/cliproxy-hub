"""Quota history for the CLIProxyAPI Claude and Codex pools: one row per account per router run."""
import datetime as dt
import json
import os
import threading

from reset_router import parse_time

HISTORY = os.path.expanduser(
    os.environ.get("QUOTA_HISTORY_FILE", "~/.local/share/cliproxy-reset-router/history.jsonl"))
NAMES = os.path.expanduser(
    os.environ.get("QUOTA_HISTORY_NAMES", "~/.config/cliproxy-reset-router/names.json"))
KEEP = dt.timedelta(days=60)
HOUR = 3600
LABELS = {"session": "5-hour", "weekly_all": "Weekly"}
_lock = threading.Lock()


def epoch(value):
    return int(parse_time(value).timestamp()) if value else None


def limits(usage):
    """Normalize /api/oauth/usage into [{label, percent, resets_at}]."""
    out = []
    for entry in usage.get("limits") or []:
        kind = entry.get("kind")
        label = LABELS.get(kind)
        if label is None:
            model = ((entry.get("scope") or {}).get("model") or {}).get("display_name")
            label = "Weekly · %s" % model if kind == "weekly_scoped" and model else kind
        out.append({"label": label, "percent": entry.get("percent"),
                    "resets_at": entry.get("resets_at")})
    if not out:
        for key, label in (("five_hour", "5-hour"), ("seven_day", "Weekly")):
            window = usage.get(key) or {}
            if window.get("utilization") is not None:
                out.append({"label": label, "percent": window["utilization"],
                            "resets_at": window.get("resets_at")})
    # No 5-hour entry means no session window is open: nothing used.
    if not any(entry["label"] == "5-hour" for entry in out):
        out.insert(0, {"label": "5-hour", "percent": 0, "resets_at": None})
    return out


def codex_window_label(seconds, suffix=None):
    if seconds == 5 * HOUR:
        label = "5-hour"
    elif seconds == 7 * 24 * HOUR:
        label = "Weekly"
    elif seconds and 28 * 24 * HOUR <= seconds <= 31 * 24 * HOUR:
        label = "Monthly"
    elif seconds:
        label = "%dh" % round(seconds / HOUR)
    else:
        label = "Window"
    return "%s · %s" % (label, suffix) if suffix else label


def codex_limits(usage):
    """Normalize ChatGPT /wham/usage into [{label, percent, resets_at}]."""
    out = []

    def add(rate_limit, suffix=None):
        for key in ("primary_window", "secondary_window"):
            window = (rate_limit or {}).get(key)
            if not isinstance(window, dict) or window.get("used_percent") is None:
                continue
            reset = window.get("reset_at")
            out.append({
                "label": codex_window_label(window.get("limit_window_seconds"), suffix),
                "percent": window["used_percent"],
                "resets_at": dt.datetime.fromtimestamp(reset, dt.timezone.utc).isoformat()
                if isinstance(reset, (int, float)) else None,
            })

    add(usage.get("rate_limit"))
    for extra in usage.get("additional_rate_limits") or []:
        if isinstance(extra, dict):
            add(extra.get("rate_limit"), extra.get("limit_name") or extra.get("metered_feature"))
    return out


def account_name(file_name):
    return file_name[:-5] if file_name.endswith(".json") else file_name


def record(accounts, now, priorities, path=None):
    """accounts: [{name, usage, provider}]; provider is "claude" (default) or "codex"."""
    lines = "".join(json.dumps({
        "t": now.isoformat(),
        "account": account_name(account["name"]),
        "provider": account.get("provider", "claude"),
        "priority": priorities.get(account["name"]),
        "limits": (codex_limits if account.get("provider") == "codex" else limits)(
            account["usage"]),
    }) + "\n" for account in accounts)
    with _lock, open(path or HISTORY, "a") as handle:
        handle.write(lines)


def load(now, path=None):
    """Rows from the last KEEP; rewrites the file when older rows fall out."""
    path = path or HISTORY
    with _lock:
        if not os.path.exists(path):
            return []
        with open(path) as handle:
            lines = [line for line in handle if line.strip()]
        cutoff = (now - KEEP).timestamp()
        rows, dropped = [], False
        for line in lines:
            try:
                row = json.loads(line)
                keep = epoch(row["t"]) >= cutoff
            except (ValueError, KeyError, TypeError):
                keep = False
            if keep:
                rows.append(row)
            else:
                dropped = True
        if dropped:
            temp = path + ".tmp"
            with open(temp, "w") as handle:
                handle.writelines(json.dumps(row) + "\n" for row in rows)
            os.replace(temp, path)
    return rows


def load_names(path=None):
    """Optional {account: display name} map, e.g. {"codex-4f70cac2-x@y.com-plus": "Greg"}."""
    try:
        with open(path or NAMES) as handle:
            names = json.load(handle)
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in names.items() if isinstance(k, str) and isinstance(v, str) and v}


def snapshot(rows, now, names=None):
    """{now, accounts: [{name, provider, priority, sampled, latest, series: {label: [[t, %, reset]]}}]}

    Rows without a provider predate Codex history and are Claude. `names` relabels accounts
    for display only; rows keep the auth file name so history survives a rename of the label.
    """
    names = names or {}
    accounts = {}
    for row in rows:
        t = epoch(row["t"])
        provider = row.get("provider") or "claude"
        account = accounts.setdefault((provider, row["account"]), {
            "name": names.get(row["account"], row["account"]), "provider": provider, "series": {}})
        account.update(priority=row.get("priority"), sampled=t, latest=[
            {"label": e["label"], "percent": e["percent"], "reset": epoch(e["resets_at"])}
            for e in row["limits"]])
        for entry in row["limits"]:
            if entry["percent"] is not None:
                account["series"].setdefault(entry["label"], []).append(
                    [t, entry["percent"], epoch(entry["resets_at"])])
    return {"now": int(now.timestamp()),
            "accounts": sorted(accounts.values(), key=lambda a: (a["provider"], a["name"]))}
