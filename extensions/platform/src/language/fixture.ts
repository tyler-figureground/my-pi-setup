import type {
  FixtureLanguageServerAdapter,
  FixtureLanguageServerDefinition,
} from "./model.ts";

export function createFixtureLanguageServerAdapter(
  servers: Readonly<Record<string, FixtureLanguageServerDefinition>>,
): FixtureLanguageServerAdapter {
  let starts = 0;
  let closes = 0;
  const notifications: Array<{
    serverId: string;
    method: string;
    params: Readonly<Record<string, unknown>>;
  }> = [];
  const requests: Array<{
    serverId: string;
    method: string;
    params: unknown;
  }> = [];
  return {
    async connect({ definition }, signal) {
      signal.throwIfAborted();
      starts++;
      const server = servers[definition.id];
      if (!server) throw new Error(`Unknown fixture server: ${definition.id}`);
      if (server.startupDelayMs) {
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            signal.removeEventListener("abort", abort);
            resolve();
          };
          const timer = setTimeout(finish, server.startupDelayMs);
          const abort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          };
          signal.addEventListener("abort", abort, { once: true });
        });
      }
      signal.throwIfAborted();
      const notificationHandlers = new Set<
        (method: string, params: unknown) => void
      >();
      const closeHandlers = new Set<() => void>();
      let closed = false;
      const publish = (method: string, params?: unknown) => {
        if (closed) return;
        for (const handler of notificationHandlers) handler(method, params);
      };
      const close = () => {
        if (closed) return;
        closed = true;
        closes++;
        for (const handler of closeHandlers) handler();
      };
      return {
        capabilities: structuredClone(server.capabilities),
        async request(method, params, requestSignal) {
          requestSignal?.throwIfAborted();
          if (closed)
            throw new Error("Fixture language server connection closed");
          requests.push({ serverId: definition.id, method, params });
          let removeAbort = () => {};
          const aborted = new Promise<never>((_resolve, reject) => {
            const abort = () => {
              reject(
                requestSignal?.reason ??
                  new DOMException("Aborted", "AbortError"),
              );
            };
            requestSignal?.addEventListener("abort", abort, { once: true });
            removeAbort = () =>
              requestSignal?.removeEventListener("abort", abort);
          });
          try {
            const result = await Promise.race([
              Promise.resolve().then(() =>
                server.onRequest?.({
                  method,
                  params,
                  signal: requestSignal,
                  publish,
                  close,
                }),
              ),
              aborted,
            ]);
            if (closed)
              throw new Error("Fixture language server connection closed");
            return result;
          } finally {
            removeAbort();
          }
        },
        async notify(method, params) {
          if (closed)
            throw new Error("Fixture language server connection closed");
          const record =
            typeof params === "object" && params !== null
              ? (structuredClone(params) as Readonly<Record<string, unknown>>)
              : {};
          notifications.push({
            serverId: definition.id,
            method,
            params: record,
          });
          await server.onNotification?.({ method, params, publish, close });
        },
        onNotification(handler) {
          notificationHandlers.add(handler);
          return () => notificationHandlers.delete(handler);
        },
        onClose(handler) {
          closeHandlers.add(handler);
          return () => closeHandlers.delete(handler);
        },
        async close() {
          close();
        },
      };
    },
    inspect: () => ({
      starts,
      closes,
      notifications: structuredClone(notifications),
      requests: structuredClone(requests),
    }),
  };
}
