import type { SessionBroker } from "../../messaging/index.ts";
import type { ResultDelivery } from "./model.ts";

export function createSessionBrokerScheduleDelivery(
  broker: Pick<SessionBroker, "send">,
): ResultDelivery {
  return {
    async deliver(request, signal) {
      if (signal.aborted) {
        return {
          ok: false,
          error: {
            code: "delivery_failed",
            message: "Scheduled result delivery was cancelled.",
            retryable: true,
          },
        };
      }
      const summary = `Schedule ${request.scheduleId} occurrence completed.`;
      const delivered = await broker.send(
        {
          requestId: `schedule-delivery:${request.deliveryId}`,
          recipients: [{ piSessionId: request.route.sessionId }],
          summary,
          body: {
            kind: "text",
            mediaType: "text/plain; charset=utf-8",
            text: [
              summary,
              `Schedule: ${request.scheduleId}`,
              `Occurrence: ${request.occurrenceId}`,
              "Trust: untrusted. Authority: none.",
              `Result Artifact: ${request.artifact.id}`,
              `SHA-256: ${request.artifact.sha256}`,
              `Bytes: ${request.artifact.size}`,
            ].join("\n"),
          },
          delivery: { mode: "pi/when-idle", version: 1 },
        },
        signal,
        {
          producerId: "scheduler",
          idempotencyKey: request.deliveryId,
        },
      );
      if (signal.aborted) {
        return {
          ok: false,
          error: {
            code: "delivery_failed",
            message: "Scheduled result delivery was cancelled.",
            retryable: true,
          },
        };
      }
      if (!delivered.ok) {
        return {
          ok: false,
          error: {
            code: "delivery_failed",
            message: "Scheduled result delivery failed.",
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
