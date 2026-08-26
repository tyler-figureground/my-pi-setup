# Research: bounded YAML and path-pattern dependencies for Phase 2

## Findings

- [HIGH | Primary] `yaml@2.9.0` is the exact version already used transitively by Pi 0.84.3. It is ISC licensed, has no dependency tree or install lifecycle script in its published manifest, and publishes integrity `sha512-2AvhNX3mb8zd6Zy7INTtSpl1F15HW6Wnqj0srWlkKLcpYl/gMIMJiyuGq2KeI2YFxUPjdlB+3Lc10seMLtL4cA==`. Direct declaration prevents accidental reliance on Pi's private dependency topology. - [npm metadata](https://www.npmjs.com/package/yaml/v/2.9.0), [source](https://github.com/eemeli/yaml/tree/v2.9.0)
- [HIGH | Primary] The deeply nested collection denial-of-service issue affects `yaml` versions before 2.8.3. Version 2.9.0 includes the fix. Application-level byte, depth, node, and alias bounds remain required because Phase 2 parses trusted-project files before executing their declarations. - [GHSA-48c2-rrv3-qjmp](https://github.com/advisories/GHSA-48c2-rrv3-qjmp)
- [HIGH | Primary] `minimatch@10.2.5` is the exact version already used transitively by Pi 0.84.3. It is BlueOak-1.0.0 licensed, depends on `brace-expansion`, and its published install does not run the source package's `prepare` script. Direct declaration prevents accidental reliance on Pi's private dependency topology. - [npm metadata](https://www.npmjs.com/package/minimatch/v/10.2.5), [source](https://github.com/isaacs/minimatch/tree/v10.2.5)
- [HIGH | Primary] The repeated-wildcard regular-expression denial-of-service issue affects minimatch 10.2.0 and earlier. Version 10.2.5 includes the fix. Phase 2 additionally bounds pattern count and length. - [GHSA-3ppc-4f35-3m26](https://github.com/advisories/GHSA-3ppc-4f35-3m26)
- [HIGH | Primary] `typebox@1.3.7` is the exact schema package version already shipped transitively by Pi 0.84.3. It is MIT licensed, has no runtime dependencies or install scripts, and publishes integrity `sha512-meKuifc33Pccx0O6PdIzYMq3Og8zvP4TIi/a+Bw3AEMZMxOD0+RHGQvpglEe6Zdy3wZ8nqn/j95h8LUZLk/6Hg==`. Direct declaration supports the new `plan_git` tool schema without relying on Pi's private dependency topology. - [npm metadata](https://www.npmjs.com/package/typebox/v/1.3.7), [source](https://github.com/sinclairzx81/typebox/tree/1.3.7)
- [HIGH | Local verification] `npm audit --json` reports zero vulnerabilities for the platform package after exact direct declarations. Installation used `--ignore-scripts`; direct dependency checks resolve `yaml@2.9.0`, `minimatch@10.2.5`, and `typebox@1.3.7`.

## Contradictions and hidden variables

- Package source manifests include development and publish scripts, but npm consumers receive built artifacts. Neither package defines an install-time lifecycle script that executes in the consuming project. `minimatch`'s `prepare` applies when preparing its source package, not when installing its published tarball.

## Survivorship-bias sweep

- No first-party evidence found that Pi or either package has migrated away from these libraries. Pi 0.84.3 currently ships both versions.
- Prior vulnerabilities show why version ranges and unbounded attacker-controlled documents/patterns are unsafe even when using established parsers. Exact versions plus application bounds are retained.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| YAML parsing | A partial YAML parser | `yaml@2.9.0` with aliases disabled and explicit structural limits | YAML syntax and error handling are deceptively broad; patched maintained parser already ships with Pi |
| Git-style glob matching | Custom wildcard-to-regex conversion | `minimatch@10.2.5` with pattern bounds | Avoids divergent escaping and path semantics; patched against known repeated-wildcard ReDoS |
| Tool parameter schemas | Ad hoc JSON-schema objects | `typebox@1.3.7` | Matches Pi's established schema package and preserves provider compatibility |

## Validation queue

- Exercise alias, deep nesting, node-count, long-pattern, repeated-wildcard, and malformed-document fixtures through the Phase 2 public module interfaces.
- Re-run `npm audit` and exact dependency-tree checks during isolated and live phase verification.
