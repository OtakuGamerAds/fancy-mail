import type { ServerEvent } from "@fancy-mail/contracts";

/** In-process pub/sub for server events. Subscribers must not throw (errors are swallowed). */
export interface EventBus {
  publish(event: ServerEvent): void;
  /** Returns the function that unsubscribes. */
  subscribe(fn: (event: ServerEvent) => void): () => void;
}

export function createEventBus(onError?: (error: unknown) => void): EventBus {
  const subscribers = new Set<(event: ServerEvent) => void>();
  return {
    publish(event) {
      for (const fn of [...subscribers]) {
        try {
          fn(event);
        } catch (error) {
          onError?.(error);
        }
      }
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };
}
