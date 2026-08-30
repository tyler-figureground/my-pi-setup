import type { SessionBroker } from "../messaging/index.ts";
import type { GoalDeliveryPort } from "./ports.ts";

/**
 * Goal outcome delivery through the Session Broker mailbox.
 *
 * The Goal runtime already refuses to deliver the same outcome twice, and the
 * broker is handed the same delivery identifier as its host idempotency key, so
 * a retry after a crash re-uses the existing message instead of posting a
 * duplicate. The message body is metadata only: it names the Goal and its
 * state, never worker output.
 */
export function createSessionBrokerGoalDelivery(
  broker: Pick<SessionBroker, "send">,
  route: { readonly sessionId: string },
): GoalDeliveryPort {
  return {
    async deliver(request) {
      const summary = request.summary.slice(0, 500);
      const delivered = await broker.send(
        {
          requestId: `goal-delivery-${request.deliveryId}`,
          recipients: [{ piSessionId: route.sessionId }],
          summary,
          body: {
            kind: "text",
            mediaType: "text/plain; charset=utf-8",
            text: [
              summary,
              `Goal: ${request.goalId}`,
              `State: ${request.state}`,
              `Run generation: ${request.runGeneration}`,
              "Trust: untrusted. Authority: none.",
              "Inspect with /goals for bounded detail.",
            ].join("\n"),
          },
          delivery: { mode: "pi/when-idle", version: 1 },
        },
        undefined,
        { producerId: "goals", idempotencyKey: request.deliveryId },
      );
      if (!delivered.ok) {
        return {
          ok: false,
          error: {
            code: "storage_failed",
            message: "Goal outcome delivery failed.",
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
