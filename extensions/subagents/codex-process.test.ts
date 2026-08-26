import assert from "node:assert/strict";
import test from "node:test";
import { codexProcessInvocation } from "./src/backends/codex.ts";

test("Windows command shims run through cmd.exe without Node spawn EINVAL", () => {
  assert.deepEqual(
    codexProcessInvocation(
      "C:\\Program Files\\npm\\codex.cmd",
      "win32",
      "C:\\Windows\\System32\\cmd.exe",
    ),
    {
      file: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\Program Files\\npm\\codex.cmd" --disable multi_agent app-server --stdio"',
      ],
      windowsVerbatimArguments: true,
    },
  );
});

test("Windows batch shims use the same guarded cmd.exe boundary", () => {
  assert.deepEqual(
    codexProcessInvocation(
      "C:\\Program Files\\npm\\codex.bat",
      "win32",
      "C:\\Windows\\System32\\cmd.exe",
    ),
    {
      file: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\Program Files\\npm\\codex.bat" --disable multi_agent app-server --stdio"',
      ],
      windowsVerbatimArguments: true,
    },
  );
});

test("native Codex executables spawn directly", () => {
  assert.deepEqual(
    codexProcessInvocation("C:\\tools\\codex.exe", "win32", "cmd.exe"),
    {
      file: "C:\\tools\\codex.exe",
      args: ["--disable", "multi_agent", "app-server", "--stdio"],
      windowsVerbatimArguments: false,
    },
  );
  assert.deepEqual(codexProcessInvocation("/usr/bin/codex", "linux"), {
    file: "/usr/bin/codex",
    args: ["--disable", "multi_agent", "app-server", "--stdio"],
    windowsVerbatimArguments: false,
  });
});
