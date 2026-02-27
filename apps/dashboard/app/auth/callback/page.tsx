/** Shoo OAuth callback landing page. */
import {
    Card,
    CardContent,
} from "@/app/components/ui/card";
import { Loader2 } from "lucide-react";

export default function ShooCallback() {
    return (
        <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
            <div className="w-full max-w-sm">
                <Card>
                    <CardContent className="flex flex-col items-center justify-center gap-3 py-12">
                        <Loader2 className="size-6 animate-spin text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">
                            Signing in...
                        </p>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
