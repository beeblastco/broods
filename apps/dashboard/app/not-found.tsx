import { StatusPage } from "@/app/components/StatusPage";
import { Button } from "@/app/components/ui/button";
import Link from "next/link";

// Rendered full page for a malformed id and under the header for a project the
// caller cannot read. The gallery lists the active org's projects either way.
export default function NotFound(): React.JSX.Element {
  return (
    <StatusPage
      title="Project not found"
      description="It was deleted, or you are not a member of its org."
    >
      <Button
        nativeButton={false}
        render={<Link href="/projects" />}
        className="cursor-pointer"
      >
        Back to projects
      </Button>
    </StatusPage>
  );
}
