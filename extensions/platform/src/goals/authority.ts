import { digestOf } from "./digest.ts";
import type {
  GoalCommand,
  GoalCommandAuthority,
  GoalOutcome,
} from "./model.ts";

/**
 * Command authority.
 *
 * Direct user authority is opaque to the model: it is bound to the exact
 * command digest, to this project and session, and it expires. An Agent-authored
 * command carrying a copied token still fails, because any edit to the command
 * changes the digest the host approved.
 *
 * The token itself carries no meaning inside this module. Only the host that
 * ran the confirmation can say whether a token was ever issued, so a direct
 * user command is refused unless a host verifier proves it. A runtime built
 * without a verifier can therefore never accept direct user authority: an
 * arbitrary non-empty string is not a proof.
 */

export function goalCommandDigest(command: GoalCommand) {
  return digestOf("goal-command-v1", command);
}

/** Bound for one opaque approval token. */
export const GOAL_AUTHORITY_TOKEN_MAX_LENGTH = 512;

export interface GoalAuthorityVerification {
  readonly command: GoalCommand;
  readonly authority: GoalCommandAuthority;
  /** Digest recomputed from the exact command, never the caller's copy. */
  readonly commandDigest: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly now: number;
}

/**
 * Host-only proof that this exact token was issued for this exact command.
 *
 * The verifier never sees model-authored state and never returns a reason: it
 * answers yes or no, so a rejected token cannot become an oracle.
 */
export interface GoalAuthorityVerifier {
  verify(request: GoalAuthorityVerification): boolean;
}

export interface GoalAuthorityContext {
  readonly now: number;
  readonly projectId: string;
  readonly sessionId: string;
  /** Objective, criteria, dependency, budget, and disposition changes. */
  readonly requireDirectUser: boolean;
  /** Host issuer. Absent means direct user authority cannot be proven. */
  readonly verifier?: GoalAuthorityVerifier | undefined;
}

function denied(reason: string): GoalOutcome<never> {
  return {
    ok: false,
    error: {
      code: "authority_denied",
      message: `Goal command authority was refused: ${reason}.`,
      retryable: false,
      details: { reason },
    },
  };
}

export function verifyGoalAuthority(
  command: GoalCommand,
  authority: GoalCommandAuthority,
  context: GoalAuthorityContext,
): GoalOutcome<{ readonly actor: GoalCommandAuthority["actor"] }> {
  if (!authority || typeof authority !== "object") return denied("missing");
  if (authority.actor !== "direct-user" && authority.actor !== "agent")
    return denied("unknown_actor");
  if (context.requireDirectUser && authority.actor !== "direct-user")
    return denied("direct_user_required");
  if (
    typeof authority.actorId !== "string" ||
    authority.actorId.length === 0 ||
    authority.actorId.length > 512
  )
    return denied("invalid_actor");
  const commandDigest = goalCommandDigest(command);
  if (authority.commandDigest !== commandDigest)
    return denied("digest_mismatch");
  if (
    authority.projectId !== context.projectId ||
    authority.sessionId !== context.sessionId
  )
    return denied("binding_mismatch");
  if (authority.actor === "direct-user") {
    if (typeof authority.token !== "string" || authority.token.length === 0)
      return denied("missing_token");
    if (authority.token.length > GOAL_AUTHORITY_TOKEN_MAX_LENGTH)
      return denied("invalid_token");
    if (
      typeof authority.expiresAt !== "number" ||
      !Number.isFinite(authority.expiresAt) ||
      authority.expiresAt <= context.now
    )
      return denied("expired");
    if (!context.verifier) return denied("unverifiable_token");
    let accepted = false;
    try {
      accepted =
        context.verifier.verify({
          command,
          authority,
          commandDigest,
          projectId: context.projectId,
          sessionId: context.sessionId,
          now: context.now,
        }) === true;
    } catch {
      accepted = false;
    }
    if (!accepted) return denied("token_rejected");
  }
  return { ok: true, value: { actor: authority.actor } };
}
