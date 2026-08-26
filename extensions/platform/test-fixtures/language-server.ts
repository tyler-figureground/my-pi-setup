import { spawn } from "node:child_process";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import {
  DidOpenTextDocumentNotification,
  ExitNotification,
  InitializeRequest,
  InitializedNotification,
  PublishDiagnosticsNotification,
  ShutdownRequest,
} from "vscode-languageserver-protocol";

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
let grandchildPid: number | undefined;
let environmentValue: string | undefined;
let oversizedOnHover = false;

connection.onRequest(InitializeRequest.type, ({ initializationOptions }) => {
  const options =
    typeof initializationOptions === "object" && initializationOptions !== null
      ? (initializationOptions as Readonly<Record<string, unknown>>)
      : undefined;
  oversizedOnHover = options?.oversizedOnHover === true;
  if (typeof options?.environmentName === "string") {
    environmentValue = process.env[options.environmentName] ?? "missing";
  }
  if (typeof options?.stderrEnvironmentName === "string") {
    process.stderr.write(
      process.env[options.stderrEnvironmentName] ?? "missing",
    );
  }
  if (options?.failInitialization === true)
    throw new Error("fixture initialization failure");
  if (options?.spawnDescendant === true) {
    const grandchild = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { detached: true, stdio: "ignore" },
    );
    grandchildPid = grandchild.pid;
    grandchild.unref();
  }
  return {
    capabilities: { hoverProvider: true, textDocumentSync: 1 },
    serverInfo: { name: "pi-language-fixture", version: "1" },
  };
});
connection.onNotification(InitializedNotification.type, () => {});
connection.onNotification(
  DidOpenTextDocumentNotification.type,
  ({ textDocument }) => {
    void connection.sendNotification(PublishDiagnosticsNotification.type, {
      uri: textDocument.uri,
      version: textDocument.version,
      diagnostics: [],
    });
  },
);
connection.onRequest("textDocument/hover", () => {
  if (oversizedOnHover) {
    process.stdout.write("Content-Length: 104857600\r\n\r\n");
    return new Promise(() => {});
  }
  return {
    contents:
      environmentValue !== undefined
        ? environmentValue
        : grandchildPid === undefined
          ? `fixture-pid:${process.pid}`
          : `grandchild-pid:${grandchildPid}`,
  };
});
connection.onRequest(ShutdownRequest.type, () => undefined);
connection.onNotification(ExitNotification.type, () => process.exit(0));
connection.listen();
