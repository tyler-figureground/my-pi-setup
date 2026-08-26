const assignment =
  /\b(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|client[-_]?secret)\b\s*[:=]\s*[^\s,;]+/i;
const bearer = /\bbearer\s+[a-z0-9._~+\-/]+=*/i;
const knownToken =
  /\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/i;
const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;

export function containsLikelySecret(value: string) {
  return (
    assignment.test(value) ||
    bearer.test(value) ||
    knownToken.test(value) ||
    privateKey.test(value)
  );
}
