import { notFound } from "next/navigation";
import { KeyForm } from "@/app/auth/key/KeyForm";
import { parseReturnTo } from "@/app/lib/authConfig";
import { selfHosted } from "@/app/lib/selfHostSession";

/** The self-hosted sign-in: the admin key, nothing else. A 404 on a WorkOS deployment. */
export default async function KeyPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string | string[];
    returnTo?: string | string[];
  }>;
}): Promise<React.JSX.Element> {
  // Read the query first: it makes the page render per request, so the build
  // cannot prerender the 404 when the signing key only exists at runtime.
  const { error, returnTo } = await searchParams;
  if (!selfHosted) notFound();

  return (
    <main className="flex h-screen w-screen items-center justify-center bg-background p-4">
      <KeyForm
        rejected={error !== undefined}
        returnTo={
          parseReturnTo(typeof returnTo === "string" ? returnTo : null) ?? "/"
        }
      />
    </main>
  );
}
