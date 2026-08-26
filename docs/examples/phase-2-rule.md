---
id: typescript-tests
include:
  - "src/**/*.test.ts"
exclude:
  - "src/generated/**"
priority: 20
---

Test behavior through public module interfaces. Keep filesystem and process assertions in integration tests. Do not assert private helpers or implementation order.
