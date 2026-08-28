# Wrap cron-parser as a calendar calculator

Phase 7 wraps exact `cron-parser@5.10.0` only for strict five-field parsing and bounded next-occurrence iteration; Scheduler retains recurrence state, timers, missed-run policy, claims, execution, and persistence. Raw cron-parser shifts some nonexistent DST wall times, so the wrapper independently validates each candidate's local fields, skips shifted gaps, and accepts only the earliest repeated local instant. Package-owned jobs/timers and broader cron operators are rejected.
