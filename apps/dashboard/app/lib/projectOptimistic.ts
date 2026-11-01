/** Optimistic update for a project rename, so every place that shows the name moves at once. */
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { OptimisticLocalStore } from "convex/browser";

// The project list (cards, header switcher) and the project itself (settings).
// Convex drops this on its own when the mutation fails, so the old name comes
// back without a rollback here. The slug is the server's to derive.
export function applyProjectRename(
  localStore: OptimisticLocalStore,
  args: { projectId: Id<"projects">; name: string },
): void {
  const list = localStore.getQuery(api.project.list, {});
  if (list?.some((project) => project._id === args.projectId)) {
    localStore.setQuery(
      api.project.list,
      {},
      list.map((project) =>
        project._id === args.projectId
          ? { ...project, name: args.name }
          : project,
      ),
    );
  }

  const byId = { projectId: args.projectId };
  const project = localStore.getQuery(api.project.getById, byId);
  if (project) {
    localStore.setQuery(api.project.getById, byId, {
      ...project,
      name: args.name,
    });
  }
}
