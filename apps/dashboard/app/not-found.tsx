import { StatusPage } from "@/app/components/StatusPage";
import { Button } from "@/app/components/ui/button";
import Link from "next/link";

// Any unknown route, a malformed project id included. A well-formed project id
// the caller cannot read gets its own copy in `[projectId]/layout.tsx`.
export default function NotFound(): React.JSX.Element {
  return (
    <StatusPage
      title="Page not found"
      description="Check the address, or start from your projects."
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
