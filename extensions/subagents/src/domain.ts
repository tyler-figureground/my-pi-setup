/**
 * Domain model for subagents.
 *
 * Everything downstream of a backend (manager, tools, UI) speaks only these
 * types. Backends translate their native streams (pi session events, Claude
 * Agent SDK messages, Codex app-server JSON-RPC notifications) into the
 * normalized `SubagentEvent` union.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { GuardedWorkspaceBinding } from "../../shared/guarded-workspace.ts";
import type {
  ResolvedExecutionPolicy,
  ResolvedProfileIdentity,
} from "../../shared/agent-profile.ts";
import { Data } from "effect";

export const BACKEND_NAMES = ["pi", "claude", "codex"] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];

/** Who initiated the session. User asides stay out of model-facing tooling. */
export type SubagentOrigin = "model" | "btw";

/**
 * Shared reasoning-effort scale (pi's thinking levels). Each backend maps a
 * value to its nearest native equivalent: pi uses it directly, codex
 * translates to its reasoning-effort slugs, claude translates to thinking
 * budgets. Omitted = backend default (pi inherits the parent level).
 */
export const REASONING_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type SubagentStatus = "running" | "done" | "error";

/** Parent-session context resolved by the tool layer and passed opaquely. */
export interface ParentContext {
  readonly parentCwd: string;
  readonly projectTrusted: boolean;
  /** Parent pi model, for the pi backend's "inherit" default. */
  readonly inheritedModel?: { readonly provider: string; readonly id: string };
  readonly inheritedThinkingLevel?: string;
  /** Parent model registry; required by the pi backend to resolve models. */
  readonly modelRegistry?: ModelRegistry;
}

export interface WorkspaceControl {
  renew(): Promise<GuardedWorkspaceBinding>;
  preserve(): Promise<void>;
}

export interface SpawnTask {
  /** Omitted for normal tool-driven spawns. */
  readonly origin?: SubagentOrigin;
  readonly prompt: string;
  readonly title: string;
  readonly cwd: string;
  /**
   * Generic model hint, interpreted per backend:
   * pi: "provider/model-id" or bare model id; claude: model alias;
   * codex: model slug. Omitted = backend default / inherit.
   */
  readonly model?: string;
  /** Shared effort scale; each backend maps it to its native equivalent. */
  readonly reasoningEffort?: ReasoningEffort;
  /** Host-resolved immutable identity. Agent text can never manufacture it. */
  readonly profile?: ResolvedProfileIdentity;
  /** Effective host policy paired with profile identity. */
  readonly execution?: ResolvedExecutionPolicy;
  readonly workspace?: GuardedWorkspaceBinding;
  /** Host-only lifecycle authority; backend adapters must ignore it. */
  readonly workspaceControl?: WorkspaceControl;
  readonly parent: ParentContext;
}

export interface SubagentMeta {
  readonly backend: BackendName;
  /** Display label, e.g. "anthropic/claude-opus-4-5" or "gpt-5-codex". */
  readonly modelLabel?: string;
  /** Context window capacity for utilization display, when known. */
  readonly contextWindow?: number;
  /** pi session file / Claude projects JSONL / Codex rollout path. */
  readonly sessionFilePath?: string;
  /** Claude session id / Codex conversation id. */
  readonly nativeSessionId?: string;
  /** Host metadata attached to every normalized transcript snapshot. */
  readonly profile?: ResolvedProfileIdentity;
  readonly workspace?: GuardedWorkspaceBinding;
}

// --- Transcript ------------------------------------------------------------

export type TranscriptPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "thinking";
      readonly text: string;
      readonly redacted?: boolean;
    }
  | {
      readonly type: "toolCall";
      readonly toolId: string;
      readonly name: string;
      readonly argsPreview?: string;
    };

export type TranscriptItem =
  | { readonly kind: "user"; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly parts: ReadonlyArray<TranscriptPart>;
    }
  | {
      readonly kind: "toolResult";
      readonly toolId: string;
      readonly name: string;
      readonly isError: boolean;
      readonly outputPreview?: string;
    };

export interface LiveToolState {
  readonly toolId: string;
  readonly name: string;
  readonly argsPreview?: string;
  readonly outputPreview?: string;
  readonly done?: boolean;
  readonly isError?: boolean;
}

export interface QueuedMessage {
  readonly text: string;
  readonly kind: "steer" | "follow-up";
}

// --- Events ------------------------------------------------------------------

export type RunOutcome =
  | { readonly _tag: "Completed"; readonly finalText: string }
  | {
      readonly _tag: "Failed";
      readonly errorText: string;
      readonly partialText?: string;
    }
  | { readonly _tag: "Interrupted"; readonly partialText?: string };

/**
 * Normalized activity stream. Previews (`argsPreview`, `outputPreview`) are
 * pre-flattened single-line strings because the UI only ever renders one
 * sanitized line, which keeps three different native tool-result shapes out
 * of the interface.
 */
export type SubagentEvent =
  // lifecycle (a session can run multiple turns via send())
  | { readonly _tag: "RunStarted" }
  | { readonly _tag: "RunSettled"; readonly outcome: RunOutcome }
  // transcript building blocks
  | { readonly _tag: "UserMessage"; readonly text: string }
  | {
      readonly _tag: "AssistantDelta";
      readonly kind: "text" | "thinking";
      readonly delta: string;
    }
  | {
      readonly _tag: "AssistantMessage";
      readonly parts: ReadonlyArray<TranscriptPart>;
    }
  | {
      readonly _tag: "ToolStart";
      readonly toolId: string;
      readonly name: string;
      readonly argsPreview?: string;
    }
  | {
      readonly _tag: "ToolUpdate";
      readonly toolId: string;
      readonly outputPreview?: string;
    }
  | {
      readonly _tag: "ToolEnd";
      readonly toolId: string;
      readonly name: string;
      readonly isError: boolean;
      readonly outputPreview?: string;
    }
  // bookkeeping
  | {
      readonly _tag: "QueueChanged";
      readonly queued: ReadonlyArray<QueuedMessage>;
    }
  | {
      readonly _tag: "UsageChanged";
      /** Context occupancy: how much of the window the next request carries. */
      readonly tokens?: number;
      readonly contextWindow?: number;
      /**
       * Cumulative metered tokens billed by this session so far, across every
       * request it has caused (including compacted-away history and sidechain
       * requests). A total, never a level: it only ever grows within a run and
       * is the sole quantity a whole-attempt token cap may be enforced against.
       * Occupancy is not a spend meter and must never be substituted for it.
       */
      readonly meteredTokens?: number;
    }
  | { readonly _tag: "MetaChanged"; readonly meta: Partial<SubagentMeta> }
  /** Non-fatal diagnostics. Fatal failures arrive as a RunSettled outcome. */
  | { readonly _tag: "BackendError"; readonly message: string };

// --- Snapshot ---------------------------------------------------------------

/**
 * The manager folds `SubagentEvent`s into one snapshot per subagent. This is
 * everything the tools, footer status, and both TUI views read.
 */
export interface SubagentSnapshot {
  readonly id: string;
  readonly origin: SubagentOrigin;
  readonly backend: BackendName;
  readonly title: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly profile?: ResolvedProfileIdentity;
  readonly workspace?: GuardedWorkspaceBinding;
  readonly status: SubagentStatus;
  readonly createdAt: number;
  readonly settledAt?: number;
  readonly errorText?: string;
  readonly meta: SubagentMeta;
  /** Context occupancy for the utilization gauge. Not a spend meter. */
  readonly usage: { readonly tokens?: number; readonly contextWindow?: number };
  /**
   * Cumulative metered spend for the whole session, folded from
   * `UsageChanged.meteredTokens`. Absent `tokens` means the backend proved
   * nothing, so no cap may be enforced from this snapshot.
   */
  readonly metered: { readonly tokens?: number };
  readonly transcript: ReadonlyArray<TranscriptItem>;
  /** Streaming assistant buffers, cleared when the finalized message lands. */
  readonly liveAssistant?: { readonly text: string; readonly thinking: string };
  readonly liveTools: ReadonlyArray<LiveToolState>;
  readonly queued: ReadonlyArray<QueuedMessage>;
  /** Final text of the most recent completed run (v1 `finalOutput`). */
  readonly finalText: string;
  /** Count of finalized assistant messages (for subagent_check). */
  readonly turns: number;
}

/** Final text, or the live streaming buffer while a run is active (v1 `latestOutput`). */
export function latestText(snap: SubagentSnapshot) {
  const live = snap.liveAssistant?.text.trim();
  if (live) return live;
  return snap.finalText;
}

export function formatElapsed(snap: SubagentSnapshot) {
  const end = snap.settledAt ?? Date.now();
  const totalSeconds = Math.max(0, Math.round((end - snap.createdAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;
}

// --- Errors -------------------------------------------------------------------

export class SpawnError extends Data.TaggedError("SpawnError")<{
  readonly message: string;
}> {}

/** Manager-only proof that backend spawn was never invoked. */
export class SupervisorPreDispatchError extends Data.TaggedError(
  "SupervisorPreDispatchError",
)<{
  readonly reason: "capacity" | "shutting-down" | "backend-unavailable";
  readonly message: string;
}> {}

export class BackendUnavailableError extends Data.TaggedError(
  "BackendUnavailableError",
)<{
  readonly message: string;
}> {}

export class ConcurrencyLimitError extends Data.TaggedError(
  "ConcurrencyLimitError",
)<{
  readonly message: string;
}> {}

export class SendError extends Data.TaggedError("SendError")<{
  readonly message: string;
}> {}
