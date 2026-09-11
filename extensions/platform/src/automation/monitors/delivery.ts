/**
 * Reactive Monitor result delivery: maps one matched batch onto a
 * `SessionBroker.send` Mailbox Message to the monitor's result-route
 * session. The message carries only the summary and the evidence Artifact
 * id, digest, and size, labelled untrusted with no authority.
 *
 * Called from the monitor's Trigger Binding in `index.ts`, downstream of the
 * TriggerEngine. The request id is derived from the delivery id, and a
 * still-queued message reports `offline`. Wired in `src/composition.ts`.
 * See: docs/architecture/phase-7-automation.md (Internal adapter seams)
 */

import type { SessionBroker } from "../../messaging/index.ts";
import type { MonitorDelivery } from "./model.ts";

export function createSessionBrokerMonitorDelivery(
  broker: Pick<SessionBroker, "send">,
): MonitorDelivery {
  return {
    async deliver(request, signal) {
      const delivered = await broker.send(
        {
          requestId: `monitor-delivery:${request.deliveryId}`,
          recipients: [{ piSessionId: request.route.sessionId }],
          summary: request.summary,
          body: {
            kind: "text",
            mediaType: "text/plain; charset=utf-8",
            text: [
              request.summary,
              "Trust: untrusted. Authority: none.",
              `Evidence Artifact: ${request.evidence.id}`,
              `SHA-256: ${request.evidence.sha256}`,
              `Bytes: ${request.evidence.size}`,
            ].join("\n"),
          },
          delivery: { mode: "pi/when-idle", version: 1 },
        },
        signal,
      );
      if (!delivered.ok) {
        return {
          ok: false,
          error: {
            code: "delivery_failed",
            message: "Monitor result delivery failed.",
            retryable: delivered.error.retryable,
          },
        };
      }
      return {
        ok: true,
        value: {
          state: delivered.value.deliveries.some(
            ({ state }) => state === "queued",
          )
            ? "offline"
            : "delivered",
        },
      };
    },
  };
}
