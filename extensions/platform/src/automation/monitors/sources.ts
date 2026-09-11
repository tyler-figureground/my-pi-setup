/**
 * Production `MonitorSourceFactory`: dispatches each Reactive Monitor to its
 * terminal, filesystem, poll, or WebSocket source factory. Built by
 * `src/composition.ts` and handed to `createMonitorRegistry` (`index.ts`).
 *
 * The filesystem factory always exists; the others exist only when
 * composition supplies their options (a terminal observation source, named
 * poll adapters, allowed WebSocket origins). Opening an unavailable kind
 * rejects rather than falling back.
 * See: docs/architecture/phase-7-automation.md (MonitorRegistry)
 */

import {
  createFileSystemMonitorSourceFactory,
  type FileSystemMonitorSourceOptions,
} from "./filesystem-source.ts";
import {
  createPollMonitorSourceFactory,
  type PollMonitorSourceOptions,
} from "./poll-source.ts";
import { createTerminalMonitorSourceFactory } from "./terminal-source.ts";
import {
  createWebSocketMonitorSourceFactory,
  type WebSocketMonitorSourceOptions,
} from "./websocket-source.ts";
import type { MonitorSourceFactory } from "./model.ts";

type TerminalSource = Parameters<typeof createTerminalMonitorSourceFactory>[0];

export interface ProductionMonitorSourceOptions {
  readonly terminal?: TerminalSource;
  readonly filesystem?: FileSystemMonitorSourceOptions;
  readonly poll?: PollMonitorSourceOptions;
  readonly websocket?: WebSocketMonitorSourceOptions;
}

export function createProductionMonitorSourceFactory(
  options: ProductionMonitorSourceOptions,
): MonitorSourceFactory {
  const factories = {
    ...(options.terminal
      ? { terminal: createTerminalMonitorSourceFactory(options.terminal) }
      : {}),
    filesystem: createFileSystemMonitorSourceFactory(options.filesystem),
    ...(options.poll
      ? { poll: createPollMonitorSourceFactory(options.poll) }
      : {}),
    ...(options.websocket
      ? { websocket: createWebSocketMonitorSourceFactory(options.websocket) }
      : {}),
  };
  return {
    open(definition, emit, signal) {
      const factory =
        definition.source.kind === "file"
          ? factories.filesystem
          : factories[definition.source.kind];
      if (!factory) {
        return Promise.reject(
          new Error(`Monitor source ${definition.source.kind} is unavailable.`),
        );
      }
      return factory.open(definition, emit, signal);
    },
  };
}
