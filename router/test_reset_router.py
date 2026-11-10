import datetime as dt
import unittest

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


if __name__ == "__main__":
    unittest.main()
