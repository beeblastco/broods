import { SIDEBAR_COOKIE } from "@/app/lib/navigation";
import { cookies } from "next/headers";
import { MainShell } from "./MainShell";

// Read on the server so a reload paints the sidebar as left; the root layout is already dynamic.
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
