import { AGENT_MAX_TURN_UNLIMITED } from "../shared/domain/agent-config.ts";

export interface DeadlinePolicy {
  shouldStop: (stepCount: number, questionsPending: number) => boolean;
  /** The next step is the tool-free last one, with no new steers. */
  isWindingDown: () => boolean;
  hasYielded: () => boolean;
  withdrawYield: () => void;
}

export interface DeadlinePolicyOptions {
  deadlineMs: number | undefined;
  canYield: boolean;
  windDownMs: number;
  maxTurn: number;
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
