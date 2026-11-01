import { expect, test } from "bun:test";
import { observeResize } from "../app/lib/observeResize";

class FakeObserver {
  static instances: FakeObserver[] = [];
  readonly observed = new Set<Element>();
  observeCalls = 0;

  constructor(readonly callback: ResizeObserverCallback) {
    FakeObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observeCalls += 1;
    this.observed.add(element);
  }

  unobserve(element: Element): void {
    this.observed.delete(element);
  }

  disconnect(): void {
    this.observed.clear();
  }

  resize(target: Element, width: number, height: number): void {
    const entry = {
      target: target,
      contentRect: { width: width, height: height },
    };
    this.callback(
      [entry as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

globalThis.ResizeObserver = FakeObserver as unknown as typeof ResizeObserver;

function latest(): FakeObserver {
  const observer = FakeObserver.instances.at(-1);
  if (!observer) throw new Error("no observer yet");

  return observer;
}

const element = (): Element => ({}) as Element;

const widths = (into: number[]) => (entries: readonly ResizeObserverEntry[]) =>
  into.push(...entries.map((entry) => entry.contentRect.width));

test("subscribers share one observer and each gets its element's sizes", () => {
  const before = FakeObserver.instances.length;
  const a = element();
  const b = element();
  const seenA: number[] = [];
  const seenB: number[] = [];
  const stopA = observeResize(a, widths(seenA));
  const stopB = observeResize(b, widths(seenB));
  expect(FakeObserver.instances.length).toBe(before + 1);

  latest().resize(a, 100, 10);
  latest().resize(b, 200, 10);
  expect(seenA).toEqual([100]);
  expect(seenB).toEqual([200]);

  stopA();
  stopB();
});

test("a late subscriber gets the current size; the others do not see it twice", () => {
  const el = element();
  const first: number[] = [];
  const late: number[] = [];
  const stopFirst = observeResize(el, widths(first));
  latest().resize(el, 100, 50);

  const observeCalls = latest().observeCalls;
  const stopLate = observeResize(el, widths(late));
  expect(latest().observeCalls).toBe(observeCalls + 1);
  latest().resize(el, 100, 50);
  expect(first).toEqual([100]);
  expect(late).toEqual([100]);

  latest().resize(el, 120, 50);
  expect(first).toEqual([100, 120]);
  expect(late).toEqual([100, 120]);

  stopFirst();
  stopLate();
});

test("an unsubscribed callback hears nothing, and the last one out disconnects", () => {
  const el = element();
  const seen: number[] = [];
  const stop = observeResize(el, widths(seen));
  const observer = latest();
  stop();
  stop();
  observer.resize(el, 100, 10);
  expect(seen).toEqual([]);
  expect(observer.observed.size).toBe(0);

  const again = observeResize(el, widths(seen));
  expect(latest()).not.toBe(observer);
  again();
});
