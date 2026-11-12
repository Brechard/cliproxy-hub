import datetime as dt
import unittest
from unittest import mock

import reset_router
from reset_router import desired_priorities

NOW = dt.datetime(2026, 11, 6, 12, tzinfo=dt.timezone.utc)


def account(name, weekly=None, weekly_reset=None, five=None, five_reset=None):
    def iso(hours):
        return None if hours is None else (NOW + dt.timedelta(hours=hours)).isoformat()
    return {"name": name, "usage": {
        "seven_day": {"utilization": weekly, "resets_at": iso(weekly_reset)},
        "five_hour": {"utilization": five, "resets_at": iso(five_reset)},
    }}


class DesiredPriorities(unittest.TestCase):
    def test_soonest_weekly_reset_ranks_first(self):
        result = desired_priorities([
            account("late", weekly=10, weekly_reset=96),
            account("soon", weekly=70, weekly_reset=8),
        ], NOW)
        self.assertGreater(result["soon"], result["late"])

    def test_exhausted_account_drops_below_usable_ones(self):
        result = desired_priorities([
            account("weekly-out", weekly=100, weekly_reset=2),
            account("five-out", weekly=20, weekly_reset=3, five=100, five_reset=1),
            account("ok", weekly=50, weekly_reset=90),
        ], NOW)
        self.assertEqual(result, {"weekly-out": 0, "five-out": 0, "ok": 10})

    def test_window_that_already_reset_counts_as_usable(self):
        result = desired_priorities([
            account("stale", weekly=100, weekly_reset=-1),
            account("other", weekly=10, weekly_reset=40),
        ], NOW)
        self.assertGreater(result["other"], result["stale"])
        self.assertGreater(result["stale"], 0)

    def test_unknown_weekly_reset_ranks_after_known_ones(self):
        result = desired_priorities([
            account("unknown"),
            account("known", weekly=5, weekly_reset=150),
        ], NOW)
        self.assertGreater(result["known"], result["unknown"])


class RunOnce(unittest.TestCase):
    FILES = [
        {"name": "A.json", "provider": "claude", "auth_index": 1, "priority": 10},
        {"name": "B.json", "provider": "claude", "auth_index": 2, "priority": 20},
        {"name": "codex-x.json", "provider": "codex", "auth_index": 3, "priority": 20,
         "id_token": {"chatgpt_account_id": "acct"}},
        {"name": "codex-off.json", "provider": "codex", "auth_index": 4, "disabled": True},
    ]

    def run_with(self, codex_status=200):
        calls, recorded = [], []

        def management(key, method, path, body=None):
            calls.append((method, path, body))
            if path == "auth-files":
                return {"files": self.FILES}
            if path == "api-call" and "chatgpt.com" in body["url"]:
                return {"status_code": codex_status, "body": {"rate_limit": {}}}
            if path == "api-call":
                reset = (NOW + dt.timedelta(hours=8 if body["auth_index"] == 1 else 90)).isoformat()
                return {"status_code": 200, "body": {
                    "seven_day": {"utilization": 10, "resets_at": reset}}}
            return {}

        import quota_history
        with mock.patch.object(reset_router, "management", management), \
                mock.patch("builtins.open", mock.mock_open(read_data="key")), \
                mock.patch.object(quota_history, "record",
                                  lambda accounts, now, priorities: recorded.append(
                                      (accounts, priorities))):
            status = reset_router.run_once()
        return status, calls, recorded

    def test_routes_claude_and_records_codex_without_changing_its_priority(self):
        status, calls, recorded = self.run_with()
        self.assertEqual(status, 0)
        patches = [c[2] for c in calls if c[0] == "PATCH"]
        self.assertEqual(patches, [{"name": "A.json", "priority": 20},
                                   {"name": "B.json", "priority": 10}])
        codex_reads = [c[2] for c in calls if c[1] == "api-call" and "chatgpt" in c[2]["url"]]
        self.assertEqual(len(codex_reads), 1)
        self.assertEqual(codex_reads[0]["header"]["Chatgpt-Account-Id"], "acct")
        accounts, priorities = recorded[0]
        self.assertEqual([(a["name"], a["provider"]) for a in accounts],
                         [("A.json", "claude"), ("B.json", "claude"), ("codex-x.json", "codex")])
        self.assertEqual(priorities["codex-x.json"], 20)

    def test_codex_failure_does_not_block_claude_routing(self):
        status, calls, recorded = self.run_with(codex_status=401)
        self.assertEqual(status, 0)
        self.assertEqual(len([c for c in calls if c[0] == "PATCH"]), 2)
        self.assertEqual([a["provider"] for a in recorded[0][0]], ["claude", "claude"])


if __name__ == "__main__":
    unittest.main()
