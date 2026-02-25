"use client";

/** Displays the authenticated user avatar with a dropdown menu for account actions. */
import { LogOut, Moon, Sun, User, FileText, HelpCircle } from "lucide-react";
import { useShooAuth } from "@shoojs/react";
import { signOut } from "@/lib/shoo";
import { useTheme } from "next-themes";
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
    const { identity, claims } = useShooAuth();
    const { theme, setTheme } = useTheme();

    if (!identity.userId) {
        return null;
    }

    const email = claims?.email ?? null;
    const name = claims?.name ?? email ?? "User";
    const picture = claims?.picture ?? null;
    const initials = name
        .split(" ")
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
                        <AvatarFallback className="bg-white/10 text-[10px] font-medium text-white/70">
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

                <DropdownMenuItem onClick={() => setTheme(isDark ? "light" : "dark")}>
                    {isDark ? <Sun /> : <Moon />}
                    {isDark ? "Light mode" : "Dark mode"}
                </DropdownMenuItem>

                <DropdownMenuItem>
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
