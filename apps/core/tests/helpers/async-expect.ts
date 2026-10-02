/**
 * Gives Bun's asynchronous expectation chains their runtime Promise return type.
 */

import { expect, type Matchers } from "bun:test";

type PromisedMatcher<Matcher> = Matcher extends (
  ...arguments_: infer Arguments
) => unknown
  ? (...arguments_: Arguments) => Promise<void>
  : Matcher;

type PromisedMatchers<Value> = {
  [Key in keyof Matchers<Value>]: Key extends "not"
    ? PromisedMatchers<unknown>
    : PromisedMatcher<Matchers<Value>[Key]>;
};

interface AsyncExpectation<Value> {
  rejects: PromisedMatchers<unknown>;
  resolves: PromisedMatchers<Awaited<Value>>;
}

type ExpectAsync = <Value>(
  actual: Value,
  customFailMessage?: string,
) => AsyncExpectation<Value>;

export const expectAsync = expect as unknown as ExpectAsync;
