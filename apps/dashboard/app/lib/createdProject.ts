// The project the create dialog just made, read once by its canvas. Module
// state, so it lives through the client-side navigation and not a reload.
// It expires so a canvas opened much later never shows a stale notice. Kept
// out of the canvas so the dialog, in every page's header, never loads it.
const CREATED_MARKER_MS = 60_000;

let createdProject: { at: number; projectId: string } | null = null;

/** Drops the marker: its canvas has shown it, or the stage has no key. */
export function clearCreatedProject(): void {
  createdProject = null;
}

/** Whether `projectId` is the one the create dialog just opened. */
export function isJustCreated(projectId: string): boolean {
  return (
    createdProject?.projectId === projectId &&
    Date.now() - createdProject.at < CREATED_MARKER_MS
  );
}

/** Called by the create dialog right before it opens the new project. */
export function markProjectCreated(projectId: string): void {
  createdProject = { at: Date.now(), projectId: projectId };
}
