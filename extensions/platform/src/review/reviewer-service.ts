/**
 * Event-bus bridge from the platform's LocalReview to the reviewer that the
 * subagent extension runs.
 *
 * `localReviewerFor` emits each request on `platform:local-review` and
 * rejects on the next microtask if no handler claimed it (the subagent
 * extension is not loaded in this session). `bindLocalReviewer`, called from
 * extensions/subagents/index.ts, claims each request exactly once and
 * settles it with the reviewer's result.
 *
 * See: docs/architecture/phase-4-language-review.md
 */

import type { ReviewRequest, ReviewerAdapter } from "./index.ts";

const CHANNEL = "platform:local-review";

interface EventBusLike {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

interface ReviewInvocation {
  readonly request: ReviewRequest;
  handled: boolean;
  resolve(value: Awaited<ReturnType<ReviewerAdapter["review"]>>): void;
  reject(error: unknown): void;
}

export function bindLocalReviewer(
  eventBus: EventBusLike,
  reviewer: ReviewerAdapter,
) {
  return eventBus.on(CHANNEL, (value) => {
    const invocation = value as ReviewInvocation;
    if (!invocation || invocation.handled) return;
    invocation.handled = true;
    void reviewer
      .review(invocation.request)
      .then(invocation.resolve, invocation.reject);
  });
}

export function localReviewerFor(eventBus: EventBusLike): ReviewerAdapter {
  return {
    review(request) {
      return new Promise((resolve, reject) => {
        const invocation: ReviewInvocation = {
          request,
          handled: false,
          resolve,
          reject,
        };
        eventBus.emit(CHANNEL, invocation);
        queueMicrotask(() => {
          if (!invocation.handled)
            reject(
              new Error(
                "Local review requires the subagent extension in this session.",
              ),
            );
        });
      });
    },
  };
}
