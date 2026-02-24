"use client";

import { Button } from "@/app/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/app/components/ui/card";
import { cn } from "@/lib/utils";
import { useShooAuth } from "@shoojs/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Displays login card with Google sign-in via Shoo. */
export function LoginForm({
    className,
    ...props
}: React.ComponentProps<"div">) {
    const { identity, loading, signIn } = useShooAuth();
    const router = useRouter();

    useEffect(() => {
        if (!loading && identity.userId) {
            router.replace("/");
        }
    }, [loading, identity.userId, router]);

    if (loading || identity.userId) {
        return (
            <div className={cn("flex flex-col gap-6", className)} {...props}>
                <Card>
                    <CardContent className="flex items-center justify-center py-12" >
                        <p className="text-muted-foreground text-sm" > Loading...</p>
                    </CardContent>
                </Card>
            </div>
        );
    }

    return (
        <div className={cn("flex flex-col gap-6", className)} {...props}>
            <Card>
                <CardHeader>
                    <CardTitle>Login to your account </CardTitle>
                    <CardDescription>
                        Sign in with your Google account to continue
                    </CardDescription>
                </CardHeader>
                < CardContent >
                    <Button
                        className="w-full"
                        onClick={() => signIn({ requestPii: true })
                        }
                    >
                        <svg className="mr-2" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" >
                            <path
                                d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"
                                fill="currentColor"
                            />
                        </svg>
                        Sign in with Google
                    </Button>
                </CardContent>
            </Card>
        </div>
    );
}
