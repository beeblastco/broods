import { StatusPage } from "@/app/components/StatusPage";
import { Button } from "@/app/components/ui/button";
import Link from "next/link";

// The org switcher lives in the header this page replaces, so the only way on
// is the gallery, which lists the active org's projects.
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
