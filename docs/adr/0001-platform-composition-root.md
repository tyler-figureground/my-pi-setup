---
status: accepted
---

# Compose cross-cutting capabilities through one platform extension

Pi capability modules share one `extensions/platform/` composition root while keeping independent deep interfaces internally. One root gives policy and lifecycle deterministic ordering, prevents duplicate daemons in child roles, and preserves existing extensions behind disabled flags instead of introducing independently ordered platform extensions.
