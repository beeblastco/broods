import type { Metadata } from "next";
import { sectionTitle } from "../sectionTitle";
import { SectionRoute } from "./SectionRoute";

// Names the tab on a fresh load; SectionRoute renames it when a link changes the URL.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ section?: string[] }>;
}): Promise<Metadata> {
  const { section = [] } = await params;
  const title = section.length > 1 ? null : sectionTitle(section[0] ?? "");

  return title === null ? {} : { title: title };
}

export default function ProjectSectionPage(): React.JSX.Element {
  return <SectionRoute />;
}
