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
