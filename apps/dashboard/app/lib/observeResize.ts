import { flushSync } from "react-dom";

type ResizeCallback = (entries: readonly ResizeObserverEntry[]) => void;

interface Subscription {
  readonly callback: ResizeCallback;
  active: boolean;
}

interface Target {
  readonly subscriptions: Set<Subscription>;
  /** Subscribed since the last delivery, so still owed the current size. */
  waiting: Set<Subscription> | null;
  last: ResizeObserverEntry | null;
}

let observer: ResizeObserver | null = null;
const targets = new Map<Element, Target>();

function sameSize(
  previous: ResizeObserverEntry | null,
  next: ResizeObserverEntry,
): boolean {
  return (
    previous?.contentRect.width === next.contentRect.width &&
    previous.contentRect.height === next.contentRect.height
  );
}

function deliver(entries: readonly ResizeObserverEntry[]): void {
  const batches = new Map<Subscription, ResizeObserverEntry[]>();
  for (const entry of entries) {
    const target = targets.get(entry.target);
    if (!target) continue;
    // Re-observing for a newcomer redelivers an unchanged size to every subscriber.
    const recipients =
      target.waiting && sameSize(target.last, entry)
        ? target.waiting
        : target.subscriptions;
    target.waiting = null;
    target.last = entry;
    for (const subscription of recipients) {
      const batch = batches.get(subscription);
      if (batch) batch.push(entry);
      else batches.set(subscription, [entry]);
    }
  }
  if (batches.size === 0) return;
  flushSync(() => {
    for (const [subscription, batch] of batches) {
      if (!subscription.active) continue;
      try {
        subscription.callback(batch);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  });
}

/** One shared observer; state set in `callback` commits before the browser paints. */
export function observeResize(
  element: Element,
  callback: ResizeCallback,
): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const shared = (observer ??= new ResizeObserver(deliver));
  const subscription: Subscription = { callback: callback, active: true };
  const target = targets.get(element);
  if (!target) {
    targets.set(element, {
      subscriptions: new Set([subscription]),
      waiting: null,
      last: null,
    });
    shared.observe(element);
  } else {
    target.subscriptions.add(subscription);
    if (target.last) {
      (target.waiting ??= new Set()).add(subscription);
      shared.unobserve(element);
      shared.observe(element);
    }
  }

  return () => {
    if (!subscription.active) return;
    subscription.active = false;
    const current = targets.get(element);
    if (!current?.subscriptions.delete(subscription)) return;
    current.waiting?.delete(subscription);
    if (current.subscriptions.size > 0) return;
    targets.delete(element);
    if (targets.size > 0) {
      shared.unobserve(element);
    } else {
      shared.disconnect();
      observer = null;
    }
  };
}
