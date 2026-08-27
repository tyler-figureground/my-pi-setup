const oppositeTokens = [
  ["always", "never"],
  ["allow", "deny"],
  ["allowed", "denied"],
  ["enable", "disable"],
  ["enabled", "disabled"],
  ["must", "must-not"],
  ["should", "should-not"],
  ["true", "false"],
] as const;

function boundedTokens(value: string) {
  if (Buffer.byteLength(value) > 4 * 1024) return undefined;
  const tokens = value.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 256) ?? [];
  return tokens.length <= 256 ? tokens : undefined;
}

function tokenEditDistanceAtMostOne(left: string, right: string) {
  if (left === right) return true;
  if (left.length > 64 || right.length > 64) return false;
  if (Math.abs(left.length - right.length) > 1) return false;
  let differences = 0;
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    differences += 1;
    if (differences > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return (
    differences +
      Number(leftIndex < left.length || rightIndex < right.length) <=
    1
  );
}

function hasOppositeTokens(left: readonly string[], right: readonly string[]) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const includesNot = (tokens: ReadonlySet<string>) =>
    tokens.has("not") || tokens.has("never") || tokens.has("no");
  if (includesNot(leftSet) !== includesNot(rightSet)) return true;
  return oppositeTokens.some(
    ([positive, negative]) =>
      (leftSet.has(positive) && rightSet.has(negative)) ||
      (leftSet.has(negative) && rightSet.has(positive)),
  );
}

export function isConservativeNearDuplicate(left: string, right: string) {
  const leftTokens = boundedTokens(left);
  const rightTokens = boundedTokens(right);
  if (
    !leftTokens ||
    !rightTokens ||
    leftTokens.length < 4 ||
    leftTokens.length !== rightTokens.length ||
    hasOppositeTokens(leftTokens, rightTokens)
  )
    return false;
  let changed = 0;
  for (let index = 0; index < leftTokens.length; index += 1) {
    if (leftTokens[index] === rightTokens[index]) continue;
    if (!tokenEditDistanceAtMostOne(leftTokens[index]!, rightTokens[index]!))
      return false;
    changed += 1;
    if (changed > 1) return false;
  }
  return changed === 1;
}

export function contradictionClaim(content: string) {
  const normalized = content
    .trim()
    .toLocaleLowerCase()
    .replace(/[.!?]+$/, "");
  const assignment = /^(.+?)\s+(?:should be|is|are|=|:)\s+(.+)$/.exec(
    normalized,
  );
  if (assignment)
    return { subject: assignment[1]!.trim(), value: assignment[2]!.trim() };
  const positive = /^(?:use|prefer|enable|allow)\s+(.+)$/.exec(normalized);
  if (positive) return { subject: positive[1]!.trim(), value: "enabled" };
  const negative = /^(?:do not use|don't use|avoid|disable|deny)\s+(.+)$/.exec(
    normalized,
  );
  if (negative) return { subject: negative[1]!.trim(), value: "disabled" };
  return undefined;
}
