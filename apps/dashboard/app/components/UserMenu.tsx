"use client";

/** The account row at the sidebar's foot, and the menu it opens upward. */
import { useSignedIn } from "@/app/hooks/useSignedIn";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/app/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/app/components/ui/sidebar";
import { FULL_ROUTE_PREFETCH } from "@/app/lib/prefetch";
import { DEFAULT_PLAN, isMaxPlan, PLAN_CONFIGS } from "@/app/lib/pricing";
import { api } from "@broods/convex/_generated/api";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useConvexAuth, useQuery } from "convex/react";
import {
  Building2,
  ChevronsUpDown,
  FileText,
  HelpCircle,
  LogOut,
  Moon,
  ScrollText,
  Settings,
  Shield,
  Sparkles,
  Sun,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useParams, useRouter } from "next/navigation";
import { useCallback } from "react";

export function UserMenu(): React.JSX.Element | null {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { user, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const params = useParams<{ projectId?: string }>();
  const currentUser = useQuery(
    api.user.getCurrent,
    useSignedIn() ? {} : "skip",
  );
  // Warm the account/org routes the moment the menu opens so the first click
  // paints instantly instead of stalling on a cold chunk + data fetch.
  const warmAccountRoutes = useCallback(
    (open: boolean) => {
      if (!open) return;

      router.prefetch("/settings/account", FULL_ROUTE_PREFETCH);
      router.prefetch("/settings/org", FULL_ROUTE_PREFETCH);
    },
    [router],
  );

  if (!isLoading && !isAuthenticated) {
    return null;
  }

  const firstName = user?.firstName ?? "";
  const lastName = user?.lastName ?? "";
  const name = (`${firstName} ${lastName}`.trim() || user?.email) ?? "User";
  const email = user?.email ?? null;
  const picture = user?.profilePictureUrl ?? null;
  const initials = name
    .split(" ")
    .filter(Boolean)
    .map((s: string) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const plan = currentUser?.plan ?? DEFAULT_PLAN;
  const isDark = theme === "dark";
  // Billing lives on a project's dashboard, so the upgrade needs one open.
  const upgradeHref =
    params.projectId && !isMaxPlan(plan)
      ? `/${params.projectId}/dashboard?tab=billing`
      : null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu onOpenChange={warmAccountRoutes}>
          <DropdownMenuTrigger
            disabled={isLoading}
            render={<SidebarMenuButton size="lg" />}
          >
            <Avatar>
              {picture && <AvatarImage src={picture} alt={name} />}
              <AvatarFallback>{isLoading ? "..." : initials}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {PLAN_CONFIGS[plan].label} plan
              </span>
            </div>
            <ChevronsUpDown className="ml-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            sideOffset={4}
            className="w-(--anchor-width) min-w-56"
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium leading-none">{name}</p>
                  {email && (
                    <p className="text-xs leading-none text-muted-foreground">
                      {email}
                    </p>
                  )}
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            {upgradeHref && (
              <>
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => router.push(upgradeHref)}
                >
                  <Sparkles />
                  Upgrade to Pro
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuGroup>
              <DropdownMenuItem
                closeOnClick={false}
                className="cursor-pointer"
                onClick={() => setTheme(isDark ? "light" : "dark")}
              >
                {isDark ? <Sun /> : <Moon />}
                {isDark ? "Light mode" : "Dark mode"}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer"
                onClick={() => router.push("/settings/account")}
              >
                <Settings />
                Account settings
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer"
                onClick={() => router.push("/settings/org")}
              >
                <Building2 />
                Organization
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                className="cursor-pointer"
                render={
                  <a
                    href="https://docs.broods.app/"
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                }
              >
                <FileText />
                Documents
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer"
                render={
                  <a
                    href="https://docs.broods.app/terms"
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                }
              >
                <ScrollText />
                Terms of Service
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer"
                render={
                  <a
                    href="https://docs.broods.app/privacy"
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                }
              >
                <Shield />
                Privacy Policy
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer"
                render={
                  <a
                    href="https://docs.broods.app/support"
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                }
              >
                <HelpCircle />
                Support
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              className="cursor-pointer"
              onClick={() => signOut()}
            >
              <LogOut />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
