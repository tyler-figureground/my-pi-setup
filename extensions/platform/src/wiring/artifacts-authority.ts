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
