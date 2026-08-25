# Pi Capability Platform

Shared language for capabilities composed into Tyler's Pi environment.

## Language

**Execution Role**:
Host-assigned identity describing why a Pi session is running and which platform responsibilities it may own.
_Avoid_: Agent type, child type

**Parent**:
Interactive or top-level Pi session allowed to own platform-wide background resources.
_Avoid_: Main agent, root agent

**Project Identity**:
Stable identity shared by a Git repository's main checkout and linked worktrees, or scoped to one canonical directory outside Git.
_Avoid_: Working directory ID, repository path

**Artifact**:
Immutable, content-addressed large body kept outside session and state metadata.
_Avoid_: Attachment, blob record

**State Record**:
Small versioned metadata value used for durable platform coordination.
_Avoid_: Artifact, database row

**Lease**:
Time-bounded exclusive claim carrying a fencing token that rejects stale owners.
_Avoid_: Lock
