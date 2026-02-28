"use client";

/** Displays the authenticated user avatar with a dropdown menu for account actions. */
import { LogOut, Moon, Sun, User, FileText, HelpCircle } from "lucide-react";
import { useShooAuth } from "@shoojs/react";
import { signOut } from "@/lib/shoo";
import { useConvexAuth } from "convex/react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { Avatar, AvatarFallback, AvatarImage } from "@/app/components/ui/avatar";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";

export function UserMenu() {
    const { isLoading, isAuthenticated } = useConvexAuth();
    const { identity, claims } = useShooAuth({
        callbackPath: "/auth/callback",
        autoSessionMonitor: false,
    });
    const { theme, setTheme } = useTheme();
    const router = useRouter();

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

    const email = claims?.email ?? null;
    const name = claims?.name ?? email ?? (identity.userId ? "Account" : "User");
    const picture = claims?.picture ?? null;
    const initials = name
        .split(" ")
        .filter(Boolean)
        .map((s: string) => s[0])
        .slice(0, 2)
        .join("")
        .toUpperCase();

    const isDark = theme === "dark";

    return (
        <DropdownMenu>
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
                            <p className="text-xs leading-none text-muted-foreground">{email}</p>
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

                <DropdownMenuItem onClick={() => router.push("/account")}>
                    <User />
                    Account Settings
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                <DropdownMenuItem>
                    <FileText />
                    Documents
                </DropdownMenuItem>

                <DropdownMenuItem>
                    <HelpCircle />
                    Support
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                <DropdownMenuItem variant="destructive" onClick={signOut}>
                    <LogOut />
                    Sign out
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
