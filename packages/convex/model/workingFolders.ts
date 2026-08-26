/**
 * Pure extraConfig transforms for attaching/detaching an agent's working
 * folders (ticket 18). Kept pure so the narrow-and-add invariant — refs are
 * only appended or removed, every other branch stays byte-identical — is
 * directly unit-testable.
 */

export interface WorkspaceRef {
  name: string;
  workspaceId: string;
}

export function workspaceRefsOf(
  extra: Record<string, unknown>,
): WorkspaceRef[] {
  return Array.isArray(extra.workspaces)
    ? (extra.workspaces as WorkspaceRef[])
    : [];
}

/** Append one folder ref (and the sandbox ref when the agent had none). */
export function withWorkingFolder(
  extra: Record<string, unknown>,
  ref: WorkspaceRef,
  sandboxId: string,
): Record<string, unknown> {
  return {
    ...extra,
    workspaces: [...workspaceRefsOf(extra), ref],
    sandbox: sandboxId,
  };
}

/** Remove exactly one folder ref; everything else stays untouched. */
export function withoutWorkingFolder(
  extra: Record<string, unknown>,
  workspaceId: string,
): Record<string, unknown> {
  const remaining = workspaceRefsOf(extra).filter(
    (ref) => ref.workspaceId !== workspaceId,
  );

  return {
    ...extra,
    ...(remaining.length > 0
      ? { workspaces: remaining }
      : { workspaces: undefined }),
  };
}
