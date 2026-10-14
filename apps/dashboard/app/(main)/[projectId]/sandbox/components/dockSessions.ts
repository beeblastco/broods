/**
 * The sandbox dock's sessions: which shells and log tails are open, grouped by
 * sandbox in tab order, and which one is shown. Pure, so the table owns the
 * state and the dock only renders it.
 */

import type { Id } from "@broods/convex/_generated/dataModel";

export type DockSessionKind = "shell" | "logs";

/** One session in the dock: a numbered shell on a sandbox, or its log tail. */
export interface DockSession {
  key: string;
  instanceId: Id<"sandboxInstances">;
  kind: DockSessionKind;
  /** The shell's number within its sandbox; 0 for the log tail. */
  shell: number;
}

/** The dock's sessions in tab order, grouped by sandbox, and the one shown. */
export interface DockState {
  sessions: DockSession[];
  active: string;
}

/**
 * Closes a session. The shown one passes to its neighbour; the dock closes
 * (null) with its last session.
 */
export function closeDockSession(
  state: DockState,
  key: string,
): DockState | null {
  const index = state.sessions.findIndex((session) => session.key === key);
  const sessions = state.sessions.filter((session) => session.key !== key);
  if (sessions.length === 0) return null;
  const active =
    state.active === key
      ? sessions[Math.min(index, sessions.length - 1)]!.key
      : state.active;

  return { sessions: sessions, active: active };
}

/**
 * Shows a sandbox's session of this kind, opening one when it has none. With
 * `fresh` a shell always opens anew, next to that sandbox's other sessions.
 */
export function openDockSession(
  state: DockState | null,
  instanceId: Id<"sandboxInstances">,
  kind: DockSessionKind,
  fresh = false,
): DockState {
  const sessions = state?.sessions ?? [];
  const own = sessions.filter((session) => session.instanceId === instanceId);
  const existing = own.find((session) => session.kind === kind);
  if (existing && !(fresh && kind === "shell")) {
    return { sessions: sessions, active: existing.key };
  }
  const shell =
    kind === "logs"
      ? 0
      : Math.max(0, ...own.map((session) => session.shell)) + 1;
  const session: DockSession = {
    key: `${instanceId}:${kind}:${shell}`,
    instanceId: instanceId,
    kind: kind,
    shell: shell,
  };
  const after = sessions.findLastIndex(
    (candidate) => candidate.instanceId === instanceId,
  );
  const next =
    after === -1
      ? [...sessions, session]
      : [
          ...sessions.slice(0, after + 1),
          session,
          ...sessions.slice(after + 1),
        ];

  return { sessions: next, active: session.key };
}

/**
 * Drops the sessions whose sandbox row is gone, so a terminated instance
 * leaves the dock; null once none is left.
 */
export function pruneDock(
  state: DockState | null,
  instances: { _id: Id<"sandboxInstances"> }[],
): DockState | null {
  if (!state) return null;
  const ids = new Set(instances.map((instance) => instance._id));
  const sessions = state.sessions.filter((session) =>
    ids.has(session.instanceId),
  );
  if (sessions.length === 0) return null;
  const active = sessions.some((session) => session.key === state.active)
    ? state.active
    : sessions[0]!.key;

  return { sessions: sessions, active: active };
}
