# Windows wake-up boundary for Scheduled Prompts

Phase 7 does not install or own Windows Task Scheduler jobs. The in-process Scheduler runs only while a Parent Pi process is active. When Pi returns, durable Schedules apply their configured missed-run policy.

## Why no automatic OS task

An OS task would introduce a second owner for recurrence, credentials, working directories, model configuration, cleanup, and result delivery. It could bypass current Project Identity, project trust, Agent Profile, CapabilityPolicy, mailbox, and fencing checks.

Phase 7 keeps one authority:

1. Parent Pi loads the durable Schedule.
2. Scheduler revalidates Project Identity, trust, profile digest, credentials, and result route.
3. StateStore grants one fenced Schedule Occurrence claim.
4. A child runs with `scheduled` Execution Role.
5. Result becomes an Artifact and is delivered through the mailbox.

## When an OS wake-up adapter could be considered

Consider a future adapter only when no Parent Pi process is expected to remain active and exact wall-clock wake-up is a product requirement. The Windows task may launch Pi, but it must not implement recurrence or execute the prompt directly.

Any future adapter must:

- reference one opaque Schedule ID, never embed prompt text or credentials
- launch a bounded Parent bootstrap that uses normal project/profile/policy resolution
- use StateStore occurrence claims and fencing before child execution
- quote executable and arguments without a shell
- bind process termination to PID plus creation identity
- install, inspect, disable, and remove tasks idempotently
- avoid storing secrets in task XML, command lines, environment, logs, or history
- verify task owner and executable identity before update/removal
- leave missed-run, retry, Artifact, and mailbox semantics inside Scheduler

Until those gates exist, use `skip` or `run-once` missed policy and keep a Parent Pi session active when wall-clock execution matters.
