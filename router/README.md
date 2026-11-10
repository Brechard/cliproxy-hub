# Reset router

Soonest-reset-first routing for a CLIProxyAPI Claude pool.

Stock CLIProxyAPI spreads new sessions across accounts. Quota left on an account when its weekly
window resets is lost, so new sessions should go to the usable account that resets soonest. Every
5 minutes the router reads each Claude account's 5-hour and weekly usage through the proxy's
Management API and sets credential priorities (higher wins):

- usable accounts rank by soonest weekly reset; an unknown reset ranks last;
- an account at 100% of its 5-hour or weekly limit drops to priority 0;
- a failed usage read leaves every priority unchanged.

Running sessions keep their account while session affinity holds (`routing.session-affinity`),
so priorities only steer new and idle sessions.

It also records every reading to `~/.local/share/cliproxy-reset-router/history.jsonl` (60 days)
and serves it at `http://127.0.0.1:8318/v1/quota-history?days=N` for the panel's quota history
chart. That endpoint takes the management key as a bearer token, like the Management API.

It talks only to the Management API on `127.0.0.1:8317` (override with `CLIPROXY_URL`) and uses
Python 3.9+ stdlib only.

## Install (macOS)

1. Save the management key to `~/.cli-proxy-api/management-key.txt` and `chmod 600` it.
2. Run `router/install.sh`. It copies the scripts to `~/.local/share/cliproxy-reset-router` and
   loads the `local.cliproxy-reset-router` launchd job.

The job runs `reset_router.py --serve`, which keeps running, routes every 5 minutes and serves
history. `python3 reset_router.py --dry-run` prints what it would set without changing anything.
Tests: `cd router && python3 -m unittest`.
