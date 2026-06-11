"use client";

/** Displays the authenticated user avatar with a dropdown menu for account actions. */
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/app/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useConvexAuth } from "convex/react";
import {
  Building2,
  FileText,
  HelpCircle,
  LogOut,
  Moon,
  ScrollText,
  Settings,
  Shield,
  Sun,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { FULL_ROUTE_PREFETCH } from "@/app/lib/prefetch";

export function UserMenu() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { user, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
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
  if (isLoading) {
    return (
      <button
        aria-label="Loading account"
        className="relative flex size-6 items-center justify-center rounded-full ring-1 ring-white/10"
        disabled
        type="button"
      >
        <Avatar size="sm">
          <AvatarFallback className="bg-muted text-[10px] font-medium text-muted-foreground">
            ...
          </AvatarFallback>
        </Avatar>
      </button>
    );
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
  const isDark = theme === "dark";

  return (
    <DropdownMenu onOpenChange={warmAccountRoutes}>
      <DropdownMenuTrigger asChild>
        <button className="relative flex size-6 items-center justify-center rounded-full ring-1 ring-white/10 transition-all hover:ring-white/25 focus:outline-none data-[state=open]:ring-2 data-[state=open]:ring-white/40">
          <Avatar size="sm">
            {picture && <AvatarImage src={picture} alt={name} />}
            <AvatarFallback className="bg-muted text-[10px] font-medium text-muted-foreground">
              {initials}
            </AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-56">
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
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => e.preventDefault()}
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
        <DropdownMenuSeparator />
        <DropdownMenuItem className="cursor-pointer" asChild>
          <a
            href="https://docs.beeblast.co/"
            target="_blank"
            rel="noopener noreferrer"
          >
            <FileText />
            Documents
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem className="cursor-pointer" asChild>
          <a
            href="https://beeblast.co/terms"
            target="_blank"
            rel="noopener noreferrer"
          >
            <ScrollText />
            Terms of Service
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem className="cursor-pointer" asChild>
          <a
            href="https://beeblast.co/privacy"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Shield />
            Privacy Policy
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem>
          <HelpCircle />
          Support
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => signOut()}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
