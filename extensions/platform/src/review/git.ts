import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createTwoFilesPatch } from "diff";
import type {
  ResolvedReviewTarget,
  ReviewCapture,
  ReviewCapturedFile,
  ReviewGitAdapter,
  ReviewTarget,
} from "./index.ts";

const execFileAsync = promisify(execFile);
const MAX_CHANGED_FILES = 256;
const MAX_SOURCE_FILES = 10_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FINGERPRINT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FINGERPRINT_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURE_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_DIFF_BYTES = 512 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const gitNullDevice = process.platform === "win32" ? "NUL" : "/dev/null";

export interface CreateReviewGitAdapterOptions {
  readonly root: string;
  readonly projectId: string;
  readonly clock?: () => number;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function boundedRevision(value: string, label: string) {
  if (
    !value ||
    Buffer.byteLength(value) > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error(`${label} is invalid.`);
  return value;
}

function boundedRemote(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))
    throw new Error("Remote name is invalid.");
  return value;
}

function gitArgs(args: readonly string[]) {
  return [
    "-c",
    `core.hooksPath=${gitNullDevice}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "diff.external=",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
    "-c",
    "protocol.http.allow=always",
    "-c",
    "protocol.file.allow=always",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "credential.helper=",
    "-c",
    "core.askPass=",
    "--no-pager",
    ...args,
  ];
}

function gitEnvironment() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
  };
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error("Review cancelled.");
}

function canonicalRelative(value: string) {
  const slash = value.replaceAll("\\", "/");
  const normalized = path.posix.normalize(slash);
  if (
    !slash ||
    slash.includes("\0") ||
    path.posix.isAbsolute(slash) ||
    /^[A-Za-z]:\//.test(slash) ||
    normalized === ".." ||
    normalized.startsWith("../")
  )
    throw new Error(`Git returned unsafe path ${JSON.stringify(value)}.`);
  return normalized;
}

function capturedText(content: Buffer) {
  if (content.includes(0)) return undefined;
  const text = content.toString("utf8");
  return Buffer.from(text, "utf8").equals(content) ? text : undefined;
}

function lineCount(content: Buffer) {
  if (content.length === 0) return 0;
  let count = 1;
  for (const byte of content) if (byte === 10) count += 1;
  if (content.at(-1) === 10) count -= 1;
  return count;
}

function normalizeCrLf(content: Buffer) {
  const normalized = Buffer.allocUnsafe(content.length);
  let offset = 0;
  for (let index = 0; index < content.length; index += 1) {
    const byte = content[index]!;
    if (byte === 13 && content[index + 1] === 10) continue;
    normalized[offset++] = byte;
  }
  return normalized.subarray(0, offset);
}

function safelyEquivalentText(
  indexBody: Buffer,
  worktreeBody: Buffer,
  normalizeEol: boolean,
) {
  if (indexBody.equals(worktreeBody)) return true;
  if (!normalizeEol || indexBody.includes(0) || worktreeBody.includes(0))
    return false;
  return normalizeCrLf(indexBody).equals(normalizeCrLf(worktreeBody));
}

function changedRanges(diff: string) {
  const ranges: ReviewCapturedFile["changed"] extends readonly (infer T)[]
    ? T[]
    : never = [];
  const pattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  for (const match of diff.matchAll(pattern)) {
    const baseStart = Number(match[1]);
    const baseCount = match[2] === undefined ? 1 : Number(match[2]);
    const targetStart = Number(match[3]);
    const targetCount = match[4] === undefined ? 1 : Number(match[4]);
    if (baseCount > 0)
      ranges.push({
        side: "base",
        startLine: baseStart,
        endLine: baseStart + baseCount - 1,
      });
    if (targetCount > 0)
      ranges.push({
        side: "target",
        startLine: targetStart,
        endLine: targetStart + targetCount - 1,
      });
  }
  return ranges;
}

function rawPatch(
  file: string,
  before: Buffer,
  after: Buffer,
  beforeLabel: string,
  afterLabel: string,
) {
  if (before.equals(after)) return "";
  if (
    before.includes(0) ||
    after.includes(0) ||
    before.length + after.length > MAX_TEXT_DIFF_BYTES
  )
    return `diff --git a/${file} b/${file}\nBinary files ${beforeLabel} and ${afterLabel} differ\n`;
  return createTwoFilesPatch(
    `a/${file}`,
    `b/${file}`,
    before.toString("utf8"),
    after.toString("utf8"),
    beforeLabel,
    afterLabel,
    { context: 0 },
  );
}

function syntheticUntrackedDiff(file: string, content: Buffer) {
  if (content.includes(0))
    return `diff --git a/${file} b/${file}\nnew file mode 100644\nBinary files /dev/null and b/${file} differ\n`;
  const text = content.toString("utf8");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

export function createReviewGitAdapter(
  options: CreateReviewGitAdapterOptions,
): ReviewGitAdapter {
  const configuredRoot = path.resolve(options.root);
  const clock = options.clock ?? Date.now;

  const runOptional = async (
    args: readonly string[],
    signal?: AbortSignal,
    allowFailure = false,
  ) => {
    throwIfAborted(signal);
    try {
      const result = await execFileAsync("git", gitArgs(args), {
        cwd: configuredRoot,
        encoding: "utf8",
        env: gitEnvironment(),
        windowsHide: true,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_DIFF_BYTES + 64 * 1024,
        signal,
      });
      return result.stdout;
    } catch (error) {
      if (allowFailure) return undefined;
      throw new Error(
        `Git ${args[0] ?? "command"} failed: ${errorMessage(error)}`,
        {
          cause: error,
        },
      );
    }
  };
  const run = async (args: readonly string[], signal?: AbortSignal) => {
    const output = await runOptional(args, signal);
    if (output === undefined) throw new Error("Git returned no output.");
    return output;
  };

  const runBytes = (
    args: readonly string[],
    signal?: AbortSignal,
    maxBytes = MAX_FILE_BYTES,
    input?: Buffer,
  ) =>
    new Promise<Buffer>((resolve, reject) => {
      throwIfAborted(signal);
      const child = execFile(
        "git",
        gitArgs(args),
        {
          cwd: configuredRoot,
          encoding: "buffer",
          env: gitEnvironment(),
          windowsHide: true,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: maxBytes + 64 * 1024,
          signal,
        },
        (error, stdout) => {
          if (error) {
            reject(
              new Error(
                `Git ${args[0] ?? "command"} failed: ${error.message}`,
                { cause: error },
              ),
            );
            return;
          }
          resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
        },
      );
      if (input) child.stdin?.end(input);
    });

  const textAttributes = async (
    files: readonly string[],
    signal?: AbortSignal,
  ) => {
    if (files.length === 0)
      return new Map<string, { text: string; eol: string }>();
    const output = await runBytes(
      ["check-attr", "-z", "--stdin", "text", "eol"],
      signal,
      MAX_CAPTURE_MANIFEST_BYTES,
      Buffer.from(`${files.join("\0")}\0`),
    );
    const tokens = output.toString("utf8").split("\0");
    if (tokens.at(-1) === "") tokens.pop();
    if (tokens.length !== files.length * 6)
      throw new Error("Git returned malformed text attributes.");
    const attributes = new Map<string, { text: string; eol: string }>();
    for (let index = 0; index < tokens.length; index += 3) {
      const file = canonicalRelative(tokens[index]!);
      const name = tokens[index + 1];
      const value = tokens[index + 2]!;
      const current = attributes.get(file) ?? {
        text: "unspecified",
        eol: "unspecified",
      };
      if (name === "text") current.text = value;
      else if (name === "eol") current.eol = value;
      else throw new Error("Git returned an unexpected text attribute.");
      attributes.set(file, current);
    }
    return attributes;
  };

  const resolveCommit = async (revision: string, signal?: AbortSignal) =>
    (
      await run(
        [
          "rev-parse",
          "--verify",
          "--quiet",
          "--end-of-options",
          `${boundedRevision(revision, "Revision")}^{commit}`,
        ],
        signal,
      )
    ).trim();

  const readWorkingFile = async (
    relative: string,
    maxBytes = MAX_FILE_BYTES,
  ) => {
    const root = await realpath(configuredRoot);
    const lexical = path.resolve(root, relative);
    const relativeToRoot = path.relative(root, lexical);
    if (
      relativeToRoot === ".." ||
      relativeToRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeToRoot)
    )
      throw new Error(`Review path escapes project: ${relative}`);
    const status = await lstat(lexical);
    if (status.isSymbolicLink()) return Buffer.from(await readlink(lexical));
    if (!status.isFile())
      throw new Error(`Review path is not a regular file: ${relative}`);
    if (status.size > maxBytes)
      throw new Error(`Review file exceeds ${maxBytes} bytes: ${relative}`);
    const canonical = await realpath(lexical);
    const canonicalRelative = path.relative(root, canonical);
    if (
      canonicalRelative === ".." ||
      canonicalRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(canonicalRelative)
    )
      throw new Error(`Review path resolves outside project: ${relative}`);
    const body = await readFile(canonical);
    if (body.length > maxBytes)
      throw new Error(
        `Review file changed size beyond ${maxBytes} bytes: ${relative}`,
      );
    return body;
  };

  const workingObjectIdentity = async (
    relative: string,
    signal?: AbortSignal,
  ) => {
    const root = await realpath(configuredRoot);
    const lexical = path.resolve(root, relative);
    let status;
    try {
      status = await lstat(lexical);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return { exists: false as const };
      throw error;
    }
    if (status.isSymbolicLink())
      return { exists: true as const, oid: "<symbolic-link>" };
    if (!status.isFile())
      throw new Error(`Review path is not a regular file: ${relative}`);
    const canonical = await realpath(lexical);
    const relation = path.relative(root, canonical);
    if (
      relation === ".." ||
      relation.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relation)
    )
      throw new Error(`Review path resolves outside project: ${relative}`);
    const oid = await runOptional(
      ["hash-object", "--no-filters", "--", relative],
      signal,
      true,
    );
    return { exists: true as const, oid: oid?.trim() ?? "<unhashable>" };
  };

  const readObjectFile = async (
    revision: string,
    relative: string,
    signal?: AbortSignal,
  ) => {
    const expression = revision ? `${revision}:${relative}` : `:${relative}`;
    const oid = await runOptional(
      ["rev-parse", "--verify", "--quiet", "--end-of-options", expression],
      signal,
      true,
    );
    if (!oid?.trim()) return Buffer.alloc(0);
    return runBytes(["cat-file", "blob", oid.trim()], signal);
  };

  const listZ = async (args: readonly string[], signal?: AbortSignal) =>
    (await run(args, signal))
      .split("\0")
      .filter(Boolean)
      .map(canonicalRelative);

  const fingerprint = async (signal?: AbortSignal) => {
    const files = await listZ(
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      signal,
    );
    if (files.length > MAX_SOURCE_FILES)
      throw new Error(`Review source exceeds ${MAX_SOURCE_FILES} files.`);
    const hash = createHash("sha256");
    const head = (await run(["rev-parse", "--verify", "HEAD"], signal)).trim();
    hash.update("head\0").update(head).update("\0");
    const indexPath = (
      await run(
        ["rev-parse", "--path-format=absolute", "--git-path", "index"],
        signal,
      )
    ).trim();
    const index = await readFile(indexPath).catch(() => Buffer.alloc(0));
    hash.update("index\0").update(index);
    let bytes = 0;
    for (const file of files.sort()) {
      throwIfAborted(signal);
      const body = await readWorkingFile(
        file,
        MAX_FINGERPRINT_FILE_BYTES,
      ).catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return Buffer.from("<missing>");
        throw error;
      });
      bytes += body.length;
      if (bytes > MAX_FINGERPRINT_TOTAL_BYTES)
        throw new Error(
          `Review source exceeds ${MAX_FINGERPRINT_TOTAL_BYTES} aggregate bytes.`,
        );
      hash.update("file\0").update(file).update("\0").update(body);
    }
    return hash.digest("hex");
  };

  const parseTree = (output: string, source: "head" | "index") => {
    const entries = new Map<string, { mode: string; oid: string }>();
    for (const item of output.split("\0").filter(Boolean)) {
      const tab = item.indexOf("\t");
      if (tab < 0) throw new Error(`Git returned malformed ${source} entry.`);
      const metadata = item.slice(0, tab).split(" ");
      const file = canonicalRelative(item.slice(tab + 1));
      if (source === "index") {
        if (metadata.length !== 3 || metadata[2] !== "0")
          throw new Error(
            `Unmerged index entry cannot be reviewed safely: ${file}`,
          );
      } else if (metadata.length !== 3 || metadata[1] !== "blob") {
        continue;
      }
      entries.set(file, {
        mode: metadata[0]!,
        oid: source === "index" ? metadata[1]! : metadata[2]!,
      });
    }
    return entries;
  };

  const captureUncommitted = async (
    target: Extract<ReviewTarget, { kind: "uncommitted" }>,
    head: string,
    sourceFingerprint: string,
    signal?: AbortSignal,
  ): Promise<ReviewCapture> => {
    const headEntries = parseTree(
      await run(["ls-tree", "-r", "-z", head], signal),
      "head",
    );
    const indexEntries = parseTree(
      await run(["ls-files", "--stage", "-z"], signal),
      "index",
    );
    const untracked = await listZ(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      signal,
    );
    const candidates = [
      ...new Set([...headEntries.keys(), ...indexEntries.keys(), ...untracked]),
    ].sort();
    if (candidates.length > MAX_SOURCE_FILES)
      throw new Error(`Review source exceeds ${MAX_SOURCE_FILES} files.`);
    const blobCache = new Map<string, Promise<Buffer>>();
    const blob = (oid: string | undefined) => {
      if (!oid) return Promise.resolve(Buffer.alloc(0));
      let pending = blobCache.get(oid);
      if (!pending) {
        pending = runBytes(["cat-file", "blob", oid], signal);
        blobCache.set(oid, pending);
      }
      return pending;
    };
    const comparisonBlobCache = new Map<string, Promise<Buffer>>();
    const comparisonBlob = (oid: string) => {
      let pending = comparisonBlobCache.get(oid);
      if (!pending) {
        pending = runBytes(
          ["cat-file", "blob", oid],
          signal,
          MAX_FINGERPRINT_FILE_BYTES,
        );
        comparisonBlobCache.set(oid, pending);
      }
      return pending;
    };
    const attributes = await textAttributes(candidates, signal);
    const autocrlf = (
      await runOptional(["config", "--get", "core.autocrlf"], signal, true)
    )
      ?.trim()
      .toLowerCase();
    const autocrlfNormalizes =
      autocrlf === "" ||
      autocrlf === "true" ||
      autocrlf === "yes" ||
      autocrlf === "on" ||
      autocrlf === "1" ||
      autocrlf === "input";
    const untrackedSet = new Set(untracked);
    const capturedFiles: ReviewCapturedFile[] = [];
    let capturedBytes = 0;
    const stagedPatches: string[] = [];
    const unstagedPatches: string[] = [];
    const untrackedPatches: string[] = [];

    for (const file of candidates) {
      throwIfAborted(signal);
      const headEntry = headEntries.get(file);
      const indexEntry = indexEntries.get(file);
      const isUntracked = untrackedSet.has(file);
      const worktreeIdentity = await workingObjectIdentity(file, signal);
      const stagedChanged =
        headEntry?.oid !== indexEntry?.oid ||
        headEntry?.mode !== indexEntry?.mode;
      let unstagedChanged =
        !isUntracked &&
        (worktreeIdentity.exists
          ? worktreeIdentity.oid !== indexEntry?.oid
          : indexEntry !== undefined);
      if (
        unstagedChanged &&
        worktreeIdentity.exists &&
        indexEntry !== undefined
      ) {
        const attribute = attributes.get(file);
        const normalizeEol =
          attribute?.text !== "unset" &&
          (attribute?.text === "set" ||
            attribute?.text === "auto" ||
            attribute?.eol === "lf" ||
            attribute?.eol === "crlf" ||
            autocrlfNormalizes);
        if (normalizeEol) {
          const [indexBody, worktreeBody] = await Promise.all([
            comparisonBlob(indexEntry.oid),
            readWorkingFile(file, MAX_FINGERPRINT_FILE_BYTES),
          ]);
          if (safelyEquivalentText(indexBody, worktreeBody, true))
            unstagedChanged = false;
        }
      }
      if (!stagedChanged && !unstagedChanged && !isUntracked) continue;

      const baseBody = await blob(headEntry?.oid);
      const indexBody = await blob(indexEntry?.oid);
      const worktreeMissing = !worktreeIdentity.exists;
      const worktreeBody = worktreeMissing
        ? Buffer.alloc(0)
        : await readWorkingFile(file);

      const stagedPatch = stagedChanged
        ? rawPatch(file, baseBody, indexBody, "HEAD", "INDEX")
        : "";
      const unstagedPatch = unstagedChanged
        ? rawPatch(file, indexBody, worktreeBody, "INDEX", "WORKTREE")
        : "";
      const untrackedPatch = isUntracked
        ? syntheticUntrackedDiff(file, worktreeBody)
        : "";
      if (stagedPatch) stagedPatches.push(stagedPatch);
      if (unstagedPatch) unstagedPatches.push(unstagedPatch);
      if (untrackedPatch) untrackedPatches.push(untrackedPatch);
      const stagedRanges = changedRanges(stagedPatch).map((range) => ({
        ...range,
        side: range.side === "target" ? ("index" as const) : range.side,
      }));
      const unstagedRanges = changedRanges(unstagedPatch).map((range) => ({
        ...range,
        side:
          range.side === "base" ? ("index" as const) : ("worktree" as const),
      }));
      const untrackedRanges = changedRanges(untrackedPatch).map((range) => ({
        ...range,
        side: range.side === "target" ? ("worktree" as const) : range.side,
      }));
      capturedFiles.push({
        path: file,
        baseLineCount: lineCount(baseBody),
        targetLineCount: Math.max(
          lineCount(indexBody),
          lineCount(worktreeBody),
        ),
        indexLineCount: lineCount(indexBody),
        worktreeLineCount: lineCount(worktreeBody),
        indexExists: indexEntry !== undefined,
        worktreeExists: !worktreeMissing,
        content: {
          ...(capturedText(baseBody) === undefined
            ? { baseBase64: baseBody.toString("base64") }
            : { base: capturedText(baseBody) }),
          ...(capturedText(indexBody) === undefined
            ? { indexBase64: indexBody.toString("base64") }
            : { index: capturedText(indexBody) }),
          ...(capturedText(worktreeBody) === undefined
            ? { worktreeBase64: worktreeBody.toString("base64") }
            : { worktree: capturedText(worktreeBody) }),
        },
        changed: [...stagedRanges, ...unstagedRanges, ...untrackedRanges],
      });
      capturedBytes += Buffer.byteLength(JSON.stringify(capturedFiles.at(-1)));
      if (capturedBytes > MAX_CAPTURE_MANIFEST_BYTES)
        throw new Error(
          `Review capture exceeds ${MAX_CAPTURE_MANIFEST_BYTES} manifest bytes.`,
        );
    }
    if (capturedFiles.length > MAX_CHANGED_FILES)
      throw new Error(
        `Review target exceeds ${MAX_CHANGED_FILES} changed files.`,
      );
    const diff = [
      "===== STAGED CHANGES (HEAD -> INDEX) =====",
      ...stagedPatches,
      "===== UNSTAGED CHANGES (INDEX -> WORKTREE) =====",
      ...unstagedPatches,
      "===== UNTRACKED FILES =====",
      ...untrackedPatches,
    ].join("\n");
    if (Buffer.byteLength(diff) > MAX_DIFF_BYTES)
      throw new Error(`Review diff exceeds ${MAX_DIFF_BYTES} bytes.`);
    const after = await fingerprint(signal);
    if (after !== sourceFingerprint)
      throw new Error(
        "Source changed while the review target was being captured.",
      );
    return {
      requested: target,
      resolved: {
        kind: "uncommitted",
        head,
        targetId: `snapshot:${sourceFingerprint}`,
      },
      projectId: options.projectId,
      root: await realpath(configuredRoot),
      diff,
      files: capturedFiles,
      sourceFingerprint,
      freshness: { kind: "not-applicable" },
      capturedAt: clock(),
    };
  };

  const capture = async (
    target: ReviewTarget,
    captureOptions: {
      readonly signal?: AbortSignal;
      readonly allowStaleBase: boolean;
    },
  ): Promise<ReviewCapture> => {
    const signal = captureOptions.signal;
    const sourceFingerprint = await fingerprint(signal);
    const head = await resolveCommit("HEAD", signal);
    let base: string;
    let targetCommit: string | undefined;
    let resolved: ResolvedReviewTarget;
    let freshness: ReviewCapture["freshness"] = { kind: "not-applicable" };

    if (target.kind === "uncommitted") {
      return captureUncommitted(target, head, sourceFingerprint, signal);
    } else if (target.kind === "commit") {
      targetCommit = await resolveCommit(target.revision, signal);
      const parent = await resolveCommit(`${targetCommit}^`, signal).catch(
        async () =>
          (
            await run(["hash-object", "-t", "tree", gitNullDevice], signal)
          ).trim(),
      );
      base = parent;
      resolved = {
        kind: "commit",
        head,
        base,
        to: targetCommit,
        targetId: targetCommit,
      };
    } else if (target.kind === "range") {
      const from = await resolveCommit(target.from, signal);
      const to = await resolveCommit(target.to, signal);
      base =
        target.comparison === "merge-base"
          ? (await run(["merge-base", from, to], signal)).trim()
          : from;
      targetCommit = to;
      resolved = {
        kind: "range",
        head,
        base,
        from,
        to,
        targetId: `${base}..${to}`,
      };
    } else {
      const remote = boundedRemote(target.remote ?? "origin");
      let branch = target.branch;
      if (!branch) {
        const symbolic = await runOptional(
          ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`],
          signal,
          true,
        );
        branch = symbolic?.trim().replace(`refs/remotes/${remote}/`, "");
      }
      branch = boundedRevision(branch ?? "main", "Base branch");
      await run(["check-ref-format", "--branch", branch], signal);
      const remoteUrl = (
        await run(["config", "--get", `remote.${remote}.url`], signal)
      ).trim();
      if (
        !remoteUrl ||
        remoteUrl.startsWith("-") ||
        /[\u0000-\u001f\u007f]/.test(remoteUrl) ||
        (!/^https?:\/\//i.test(remoteUrl) &&
          !/^file:\/\//i.test(remoteUrl) &&
          !path.isAbsolute(remoteUrl))
      )
        throw new Error(
          "Review fetch permits only HTTPS, HTTP, file, or absolute local remotes.",
        );
      const remoteRef = `refs/remotes/${remote}/${branch}`;
      const fetched = await runOptional(
        [
          "fetch",
          "--no-tags",
          "--",
          remoteUrl,
          `+refs/heads/${branch}:${remoteRef}`,
        ],
        signal,
        true,
      );
      if (fetched === undefined && !captureOptions.allowStaleBase)
        throw new Error(
          `Could not fetch ${remote}/${branch}; stale base review was not allowed.`,
        );
      const remoteCommit = await resolveCommit(remoteRef, signal);
      base = (await run(["merge-base", remoteCommit, head], signal)).trim();
      targetCommit = head;
      const counts = (
        await run(
          ["rev-list", "--left-right", "--count", `${head}...${remoteCommit}`],
          signal,
        )
      )
        .trim()
        .split(/\s+/)
        .map(Number);
      freshness =
        fetched === undefined
          ? {
              kind: "unknown",
              reason: `Fetch of ${remote}/${branch} failed; using existing remote ref.`,
            }
          : { kind: "fresh", ahead: counts[0] ?? 0, behind: counts[1] ?? 0 };
      resolved = {
        kind: "base",
        head,
        base,
        to: head,
        targetId: `${base}..${head}`,
      };
    }

    const trackedArgs = [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      base,
      targetCommit!,
    ];
    const diff = await run(trackedArgs, signal);
    const trackedFiles = await listZ(
      [
        "diff",
        "--name-only",
        "-z",
        "--no-ext-diff",
        "--no-textconv",
        base,
        targetCommit!,
      ],
      signal,
    );
    const files = [...new Set(trackedFiles)].sort();
    if (files.length > MAX_CHANGED_FILES)
      throw new Error(
        `Review target exceeds ${MAX_CHANGED_FILES} changed files.`,
      );

    const capturedFiles: ReviewCapturedFile[] = [];
    let capturedBytes = 0;
    for (const file of files) {
      throwIfAborted(signal);
      const baseBody = await readObjectFile(base, file, signal);
      const targetBody = await readObjectFile(targetCommit!, file, signal);
      const fileDiff = await run(
        [
          "diff",
          "--unified=0",
          "--no-ext-diff",
          "--no-textconv",
          base,
          targetCommit!,
          "--",
          file,
        ],
        signal,
      );
      capturedFiles.push({
        path: file,
        baseLineCount: lineCount(baseBody),
        targetLineCount: lineCount(targetBody),
        content: {
          ...(capturedText(baseBody) === undefined
            ? { baseBase64: baseBody.toString("base64") }
            : { base: capturedText(baseBody) }),
          ...(capturedText(targetBody) === undefined
            ? { targetBase64: targetBody.toString("base64") }
            : { target: capturedText(targetBody) }),
        },
        changed: changedRanges(fileDiff),
      });
      capturedBytes += Buffer.byteLength(JSON.stringify(capturedFiles.at(-1)));
      if (capturedBytes > MAX_CAPTURE_MANIFEST_BYTES)
        throw new Error(
          `Review capture exceeds ${MAX_CAPTURE_MANIFEST_BYTES} manifest bytes.`,
        );
    }
    if (Buffer.byteLength(diff) > MAX_DIFF_BYTES)
      throw new Error(`Review diff exceeds ${MAX_DIFF_BYTES} bytes.`);
    const after = await fingerprint(signal);
    if (after !== sourceFingerprint)
      throw new Error(
        "Source changed while the review target was being captured.",
      );
    return {
      requested: target,
      resolved,
      projectId: options.projectId,
      root: await realpath(configuredRoot),
      diff,
      files: capturedFiles,
      sourceFingerprint,
      freshness,
      capturedAt: clock(),
    };
  };

  return { capture, fingerprint };
}
