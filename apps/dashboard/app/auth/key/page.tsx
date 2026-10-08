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
  if (!selfHosted) notFound();
  const { error, returnTo } = await searchParams;

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
