"use client";

import { StatusPage } from "@/app/components/StatusPage";
import { Button } from "@/app/components/ui/button";
import type { ErrorInfo } from "next/error";
import Link from "next/link";

// Wraps the (main) layout too, so a throw in the header lands here as well.
export default function RouteError({
  error,
  retry,
}: ErrorInfo): React.JSX.Element {
  return (
    <StatusPage title="This page failed to load" error={error}>
      <Button onClick={retry} className="cursor-pointer">
        Try again
      </Button>
      <Button
        variant="outline"
        nativeButton={false}
        render={<Link href="/projects" />}
        className="cursor-pointer"
      >
        Back to projects
      </Button>
    </StatusPage>
  );
}
