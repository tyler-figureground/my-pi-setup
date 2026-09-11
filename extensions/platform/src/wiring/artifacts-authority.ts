/**
 * One-shot direct-user authority for Artifact Publication.
 *
 * In-memory, per-process issuer of `artifact-user-authority` tokens, each
 * bound to one approval scope and valid for 2 minutes. `issue` runs only in
 * `/artifacts` (`wiring/artifacts-command.ts`) after a `ctx.ui.confirm` yes.
 * `ArtifactPublisher` calls `verify`, which deletes the grant before checking
 * it, so a token is spent even when the check fails. `clear` runs on
 * capability stop. Owned by `wiring/artifacts.ts`; `composition.ts` hands its
 * `authority` to the publisher.
 *
 * See: docs/architecture/phase-9-artifacts.md
 */

import { randomUUID } from "node:crypto";
import type { ArtifactUserAuthorityToken } from "../artifacts/index.ts";

export function createArtifactAuthority(clock: () => number) {
  const grants = new Map<string, { scope: string; expiresAt: number }>();
  return {
    issue(scope: string): ArtifactUserAuthorityToken {
      for (const [value, grant] of grants) {
        if (grant.expiresAt <= clock()) grants.delete(value);
      }
      const value = randomUUID();
      grants.set(value, { scope, expiresAt: clock() + 2 * 60_000 });
      return { kind: "artifact-user-authority", value, scope };
    },
    verify(token: ArtifactUserAuthorityToken, scope: string) {
      const grant = grants.get(token.value);
      grants.delete(token.value);
      return (
        token.kind === "artifact-user-authority" &&
        token.scope === scope &&
        grant?.scope === scope &&
        grant.expiresAt > clock()
      );
    },
    clear() {
      grants.clear();
    },
  };
}
