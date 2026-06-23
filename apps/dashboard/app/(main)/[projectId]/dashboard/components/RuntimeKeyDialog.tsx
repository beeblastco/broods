"use client";

/** Reveals an environment's runtime API key (fp_agent_…) with copy controls and a ready-to-run SDK snippet. */
import { Button } from "@/app/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Check, Copy, Eye, EyeOff, KeyRound } from "lucide-react";
import { useState } from "react";

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The plaintext runtime key (fp_agent_…) for the active environment. */
    apiKey: string;
    /** Whether the key was just minted (changes the framing copy). */
    justCreated?: boolean;
}

/** Build the copy-pasteable SDK example for the runtime key. */
function sdkSnippet(): string {
    return [
        `import { BroodsClient } from "broods";`,
        `import { api } from "./broods/_generated/api";`,
        ``,
        `// Reads BROODS_API_KEY from the environment by default.`,
        `const client = new BroodsClient({ apiKey: process.env.BROODS_API_KEY });`,
        ``,
        `const result = await client.agent(api.agents.yourAgent).run({`,
        `  input: "Hello from the SDK!",`,
        `});`,
        ``,
        `console.log(result.text);`,
    ].join("\n");
}

/** Dialog that surfaces the runtime API key plus how to wire it into the Client SDK. */
export function RuntimeKeyDialog({ open, onOpenChange, apiKey, justCreated = false }: Props) {
    const [showKey, setShowKey] = useState(false);
    const [copied, setCopied] = useState<"key" | "snippet" | "env" | null>(null);

    const snippet = sdkSnippet();
    const envLine = `export BROODS_API_KEY="${apiKey}"`;

    function copy(text: string, which: "key" | "snippet" | "env") {
        navigator.clipboard.writeText(text);
        setCopied(which);
        setTimeout(() => setCopied(null), 1500);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <KeyRound className="size-4 text-foreground" />
                        {justCreated ? "Your runtime API key is ready" : "Runtime API key"}
                    </DialogTitle>
                    <DialogDescription>
                        This key authenticates runtime calls for this environment — agent runs,
                        streaming, and the observability views. Treat it like a password.
                    </DialogDescription>
                </DialogHeader>

                <div className="grid gap-5 py-1">
                    {/* The key itself */}
                    <div className="grid gap-1.5">
                        <Label className="text-xs text-muted-foreground">API key</Label>
                        <div className="flex items-center gap-2">
                            <Input
                                readOnly
                                value={showKey ? apiKey : "•".repeat(Math.min(apiKey.length, 40))}
                                className="h-9 font-mono text-xs"
                            />
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-9 shrink-0 cursor-pointer"
                                onClick={() => setShowKey((v) => !v)}
                                title={showKey ? "Hide key" : "Reveal key"}
                            >
                                {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-9 shrink-0 cursor-pointer"
                                onClick={() => copy(apiKey, "key")}
                            >
                                {copied === "key" ? <Check className="size-3.5 mr-1" /> : <Copy className="size-3.5 mr-1" />}
                                {copied === "key" ? "Copied" : "Copy"}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Stored encrypted at rest — you can reopen it here anytime, or rotate it to
                            invalidate the old one.
                        </p>
                    </div>

                    {/* Use it from the SDK */}
                    <div className="grid gap-1.5">
                        <Label className="text-xs text-muted-foreground">Use it with the Client SDK</Label>
                        <p className="text-xs text-muted-foreground">
                            Expose the key to your app, then call your deployed agents through the
                            generated <code className="font-mono">api</code> object:
                        </p>
                        <div className="relative">
                            <pre className="overflow-x-auto rounded-md border bg-muted/50 px-3 py-3 font-mono text-[11px] leading-relaxed text-foreground">
                                {snippet}
                            </pre>
                            <Button
                                variant="outline"
                                size="sm"
                                className="absolute right-2 top-2 h-7 cursor-pointer"
                                onClick={() => copy(snippet, "snippet")}
                            >
                                {copied === "snippet" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                            </Button>
                        </div>
                        <div className="flex items-center gap-2">
                            <code className="flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-[11px]">
                                {envLine}
                            </code>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="shrink-0 cursor-pointer"
                                onClick={() => copy(envLine, "env")}
                            >
                                {copied === "env" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Calls go to <code className="font-mono">gateway.broods.app</code> by default;
                            override with <code className="font-mono">BROODS_BASE_URL</code> for a
                            self-hosted core.
                        </p>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
