// Module state lives through a client-side navigation, not a reload. Kept out of the
// canvas so the create dialog, in every page's header, never loads it.
const CREATED_MARKER_MS = 60_000;

let createdProject: { at: number; projectId: string } | null = null;

export function clearCreatedProject(): void {
  createdProject = null;
}

export function isJustCreated(projectId: string): boolean {
  return (
    createdProject?.projectId === projectId &&
    Date.now() - createdProject.at < CREATED_MARKER_MS
  );
}

export function markProjectCreated(projectId: string): void {
  createdProject = { at: Date.now(), projectId: projectId };
}
