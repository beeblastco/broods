import { notFound } from "next/navigation";
import { KeyForm } from "@/app/auth/key/KeyForm";
import { parseReturnTo } from "@/app/lib/authConfig";
import { selfHosted } from "@/app/lib/selfHostSession";

export default async function KeyPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string | string[];
    returnTo?: string | string[];
  }>;
}): Promise<React.JSX.Element> {
  // Await first: rendering per request keeps the build from baking in the runtime 404.
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
