/**
 * What a run does at a step boundary near its deadline: yield its worker slot
 * or wind down in its next step. runAgentLoop decides once per boundary in
 * stopWhen and reads the outcome from prepareStep, onEnd and its control
 * surface.
 */

import { AGENT_MAX_TURN_UNLIMITED } from "../shared/domain/agent-config.ts";

/** The decision at each boundary, and what the loop reads back from it. */
export interface DeadlinePolicy {
  /**
   * stopWhen: true when the run should stop here to yield its slot. Past the
   * wind-down line with no open question it yields when it may and a next pass
   * would not start at the step cap; otherwise it winds down instead.
   */
  shouldStop: (stepCount: number, questionsPending: number) => boolean;
  /** prepareStep: the next step is the tool-free last one, with no new steers. */
  isWindingDown: () => boolean;
  /** onEnd and the control surface: the run stopped to give up its slot. */
  hasYielded: () => boolean;
  /** onEnd: a step waiting on an approval stops for that instead of yielding. */
  withdrawYield: () => void;
}

export interface DeadlinePolicyOptions {
  /** When the request or worker budget ends; undefined means no deadline. */
  deadlineMs: number | undefined;
  /** The worker pool will run the conversation on in another slot. */
  canYield: boolean;
  /** How long before the deadline the run stops taking normal steps. */
  windDownMs: number;
  /** The run's step cap, or AGENT_MAX_TURN_UNLIMITED. */
  maxTurn: number;
  /** Clock in epoch ms; a test seam. */
  now: () => number;
}

export function createDeadlinePolicy(
  options: DeadlinePolicyOptions,
): DeadlinePolicy {
  let windingDown = false;
  let yielded = false;

  return {
    shouldStop: (stepCount, questionsPending) => {
      if (
        options.deadlineMs === undefined ||
        options.now() < options.deadlineMs - options.windDownMs ||
        questionsPending > 0
      ) {
        return false;
      }
      yielded =
        options.canYield &&
        (options.maxTurn === AGENT_MAX_TURN_UNLIMITED ||
          stepCount < options.maxTurn);
      windingDown = !yielded;

      return yielded;
    },
    isWindingDown: () => windingDown,
    hasYielded: () => yielded,
    withdrawYield: () => {
      yielded = false;
    },
  };
}
