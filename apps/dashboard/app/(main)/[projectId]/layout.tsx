import { notFound } from "next/navigation";

// A Convex id is 31 to 37 characters of lowercase Crockford base32 (no i, l, o, u).
const CONVEX_ID_SHAPE = /^[0-9a-hjkmnp-tv-z]{31,37}$/;

/**
 * Answers 404 for a segment that cannot be a project id. Every page below
 * casts it to `Id<"projects">`, and a query's validator would otherwise throw
 * on it. Checked on the server with no round trip, so a real project loads no
 * slower.
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}): Promise<React.JSX.Element> {
  const { projectId } = await params;
  if (!CONVEX_ID_SHAPE.test(projectId)) notFound();

  return <>{children}</>;
}
