import datetime as dt
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest import mock

import history_server
import quota_history as qh

NOW = dt.datetime(2026, 11, 10, 12, tzinfo=dt.timezone.utc)
RESET = int(dt.datetime(2026, 11, 12, tzinfo=dt.timezone.utc).timestamp())
WEEKLY = {"seven_day": {"utilization": 40.0, "resets_at": "2026-11-12T00:00:00Z"}}


class Limits(unittest.TestCase):
    def test_labels_scoped_limits_and_fills_closed_session(self):
        usage = {"limits": [
            {"kind": "weekly_all", "percent": 5, "resets_at": "2026-11-14T00:00:00Z", "scope": None},
            {"kind": "weekly_scoped", "percent": 7, "resets_at": "2026-11-14T00:00:00Z",
             "scope": {"model": {"display_name": "Fable"}}},
        ]}
        self.assertEqual([(l["label"], l["percent"]) for l in qh.limits(usage)],
                         [("5-hour", 0), ("Weekly", 5), ("Weekly · Fable", 7)])

    def test_falls_back_to_windows_without_limits_list(self):
        usage = {"five_hour": {"utilization": 16.0, "resets_at": "2026-11-10T12:30:00Z"},
                 "seven_day": {"utilization": 97.0, "resets_at": "2026-11-10T20:00:00Z"}}
        self.assertEqual([(l["label"], l["percent"]) for l in qh.limits(usage)],
                         [("5-hour", 16.0), ("Weekly", 97.0)])


class History(unittest.TestCase):
    def test_load_drops_rows_older_than_keep_and_snapshot_groups_series(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "history.jsonl")
            account = [{"name": "A.json", "usage": WEEKLY}]
            qh.record(account, NOW - dt.timedelta(days=61), {"A.json": 10}, path)
            qh.record(account, NOW, {"A.json": 10}, path)
            rows = qh.load(NOW, path)
            with open(path) as handle:
                self.assertEqual(len(handle.readlines()), 1)
            snapshot = qh.snapshot(rows, NOW)["accounts"][0]
            self.assertEqual((snapshot["name"], snapshot["priority"]), ("A", 10))
            self.assertEqual(snapshot["series"]["Weekly"], [[int(NOW.timestamp()), 40.0, RESET]])


class Server(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = os.path.join(tmp.name, "history.jsonl")
        qh.record([{"name": "A.json", "usage": WEEKLY}], dt.datetime.now(dt.timezone.utc), {}, path)
        for patch in (mock.patch.object(qh, "HISTORY", path),
                      mock.patch.object(history_server, "management_key", lambda: "secret")):
            patch.start()
            self.addCleanup(patch.stop)
        server = ThreadingHTTPServer(("127.0.0.1", 0), history_server.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.url = "http://127.0.0.1:%d/v1/quota-history" % server.server_port

    def get(self, token):
        request = urllib.request.Request(self.url, headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(request) as response:
            return response.headers, json.load(response)

    def test_returns_history_with_the_management_key(self):
        headers, body = self.get("secret")
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
        self.assertEqual(body["accounts"][0]["name"], "A")

    def test_rejects_a_wrong_key(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("wrong")
        self.assertEqual(caught.exception.code, 401)


if __name__ == "__main__":
    unittest.main()
