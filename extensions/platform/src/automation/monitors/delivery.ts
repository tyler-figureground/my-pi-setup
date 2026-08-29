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
