# Phase 3 performance

Date: 2026-08-25

Warm startup benchmark used the same disposable `pi --print` harness and repository extension set as Phase 2. One warmup preceded ten measured runs.

| Measurement | Phase 3 |
|---|---:|
| Median startup | 3271.6 ms |
| Mean startup | 3256.8 ms |
| Minimum | 3153.3 ms |
| Maximum | 3355.2 ms |
| Median change from Phase 2 | -136.8 ms (-4.0%) |

Profile startup with no profile files performs bounded empty-directory discovery. Workspace startup opens/migrates the existing SQLite state adapter, queries current-project records, and binds no watcher, timer, process, or socket.

Resolved profile instructions and skills enter only profiled child context. Guarded workspace metadata remains outside parent model context except bounded logical IDs/status requested through tools.
