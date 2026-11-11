import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { OptimisticLocalStore } from "convex/browser";

// The slug is the server's to derive, so only the name moves here.
export function applyProjectRename(
  localStore: OptimisticLocalStore,
  args: { projectId: Id<"projects">; name: string },
): void {
  const list = localStore.getQuery(api.dashboardReads.projects, {});
  if (list?.some((project) => project._id === args.projectId)) {
    localStore.setQuery(
      api.dashboardReads.projects,
      {},
      list.map((project) =>
        project._id === args.projectId
          ? { ...project, name: args.name }
          : project,
      ),
    );
  }

  const byId = { projectId: args.projectId };
  const project = localStore.getQuery(api.dashboardReads.projectById, byId);
  if (project) {
    localStore.setQuery(api.dashboardReads.projectById, byId, {
      ...project,
      name: args.name,
    });
  }
}
