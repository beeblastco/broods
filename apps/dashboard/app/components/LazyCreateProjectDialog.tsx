"use client";

import { useEverTrue } from "@/app/hooks/useEverTrue";
import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import type { CreateProjectDialog as Dialog } from "./CreateProjectDialog";

const loadCreateProjectDialog = (): Promise<typeof Dialog> =>
  import("./CreateProjectDialog").then((mod) => mod.CreateProjectDialog);

const CreateProjectDialog = dynamic(loadCreateProjectDialog);

/**
 * The new-project dialog, fetched the first time it opens, so its repo picker is not in every
 * page's first load.
 */
export function LazyCreateProjectDialog(
  props: ComponentProps<typeof Dialog>,
): React.JSX.Element | null {
  const wanted = useEverTrue(props.open);

  return wanted ? <CreateProjectDialog {...props} /> : null;
}
