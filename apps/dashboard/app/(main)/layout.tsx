import { SIDEBAR_COOKIE } from "@/app/lib/navigation";
import { cookies } from "next/headers";
import { MainShell } from "./MainShell";

/**
 * Reads the sidebar's pinned or hidden state on the server, so a reload paints
 * it the way it was left instead of flashing open first. The root layout
 * already reads the request, so this adds no dynamic rendering.
 */
export default async function MainLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): Promise<React.JSX.Element> {
  const sidebar = (await cookies()).get(SIDEBAR_COOKIE)?.value;

  return (
    <MainShell defaultSidebarOpen={sidebar !== "false"}>{children}</MainShell>
  );
}
