"""Runs the router every 5 minutes and serves its quota history to the management panel.

GET /v1/quota-history?days=N on 127.0.0.1:8318 returns quota_history.snapshot(). It needs
the proxy's management key as a bearer token, which the panel already holds; CORS is open
because the key, not the origin, is what grants access.
"""
import datetime as dt
import hmac
import json
import os
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import quota_history
from reset_router import KEY_FILE

HOST = os.environ.get("QUOTA_HISTORY_HOST", "127.0.0.1")
PORT = int(os.environ.get("QUOTA_HISTORY_PORT", "8318"))
INTERVAL = 300


def management_key():
    with open(KEY_FILE) as handle:
        return handle.read().strip()


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body=None):
        data = b"" if body is None else json.dumps(body, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.reply(204)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path != "/v1/quota-history":
            return self.reply(404, {"error": "not found"})
        supplied = self.headers.get("Authorization", "").encode()
        if not hmac.compare_digest(supplied, ("Bearer " + management_key()).encode()):
            return self.reply(401, {"error": "unauthorized"})
        try:
            days = min(60.0, max(0.1, float(parse_qs(url.query).get("days", ["60"])[0])))
        except ValueError:
            return self.reply(400, {"error": "days must be a number"})
        now = dt.datetime.now(dt.timezone.utc)
        cutoff = (now - dt.timedelta(days=days)).timestamp()
        rows = [r for r in quota_history.load(now) if quota_history.epoch(r["t"]) >= cutoff]
        self.reply(200, quota_history.snapshot(rows, now))

    def log_message(self, *args):
        pass


def loop(run_once):
    while True:
        try:
            run_once()
        except Exception:
            traceback.print_exc()
        time.sleep(INTERVAL)


def serve(run_once):
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    threading.Thread(target=loop, args=(run_once,), daemon=True).start()
    print("serving quota history on http://%s:%d/v1/quota-history" % (HOST, PORT))
    server.serve_forever()
