"use client";

/** Reveals an environment's runtime API key (fp_agent_…) with copy controls, a .env snippet, and a WebSocket streaming example. */
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
import { Streamdown } from "streamdown";

interface DialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The plaintext runtime key (fp_agent_…) for the active environment. */
    apiKey: string;
    /** Whether the key was just minted (changes the framing copy). */
    justCreated?: boolean;
}

/** WebSocket streaming example — recommended for the best, lowest-latency experience. */
const WS_SNIPPET = [
    `import { WebsocketClient } from "broods";`,
    `import { api } from "./broods/_generated/api";`,
    ``,
    `// Reads BROODS_API_KEY from your .env automatically.`,
    `const client = new WebsocketClient();`,
    ``,
    `// Stream tokens live — lowest latency, fully bidirectional.`,
    `for await (const message of client.stream({`,
    `  agent: api.agents.yourAgent,`,
    `  input: "Hello from the SDK!",`,
    `})) {`,
    `  if (message.type === "text-delta") process.stdout.write(message.text);`,
    `}`,
].join("\n");

// Shiki-highlighted (github-dark / github-light) code blocks via Streamdown, minus
// its download button, with prose margins reset so they sit flush in our sections.
const CODE_CLASS =
    "text-sm [&>*]:my-0 [&_pre]:!my-0 [&_[data-streamdown=code-block]]:!my-0 " +
    "[&_[data-streamdown=code-block-download-button]]:hidden " +
    "[&_pre]:text-[12px] [&_pre]:leading-relaxed [&_code]:text-[12px]";

/** Renders a single fenced code block with VSCode-style syntax highlighting. */
function CodeBlock({ code, language }: { code: string; language: string }) {
    return (
        <Streamdown className={CODE_CLASS}>{`\`\`\`${language}\n${code}\n\`\`\``}</Streamdown>
    );
}

/** Inline `<code>` styling for prose mentions of env vars and hosts. */
function Mono({ children }: { children: React.ReactNode }) {
    return (
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">{children}</code>
    );
}

/** The reusable runtime-key body: the secret, its .env line, and the WebSocket SDK example. */
export function RuntimeKeyView({ apiKey }: { apiKey: string }) {
    const [showKey, setShowKey] = useState(false);
    const [copied, setCopied] = useState(false);
    const envLine = `BROODS_API_KEY="${apiKey}"`;

    function copyKey() {
        navigator.clipboard.writeText(apiKey);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }

    return (
        <div className="grid gap-6">
            {/* The key itself */}
            <section className="grid gap-2">
                <Label className="text-sm font-medium text-foreground">API key</Label>
                <div className="flex items-center gap-2">
                    <Input
                        readOnly
                        value={showKey ? apiKey : "•".repeat(Math.min(apiKey.length, 44))}
                        className="h-9 font-mono text-xs text-foreground"
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
                        onClick={copyKey}
                    >
                        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                        <span className="ml-1">{copied ? "Copied" : "Copy"}</span>
                    </Button>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                    Stored encrypted at rest — treat it like a password. Reopen it here anytime, or rotate it to
                    invalidate the old one.
                </p>
            </section>

            {/* Drop it into the environment */}
            <section className="grid gap-2">
                <Label className="text-sm font-medium text-foreground">Add it to your environment</Label>
                <p className="text-xs leading-relaxed text-muted-foreground">
                    The SDK reads <Mono>BROODS_API_KEY</Mono> by default — copy this into your{" "}
                    <Mono>.env.local</Mono> or <Mono>.env</Mono> file.
                </p>
                <CodeBlock code={envLine} language="bash" />
            </section>

            {/* Stream over WebSocket */}
            <section className="grid gap-2">
                <Label className="text-sm font-medium text-foreground">Stream over WebSocket</Label>
                <p className="text-xs leading-relaxed text-muted-foreground">
                    WebSocket streaming gives the lowest latency and a bidirectional connection — the best experience
                    for live agent runs.
                </p>
                <CodeBlock code={WS_SNIPPET} language="ts" />
                <p className="text-xs leading-relaxed text-muted-foreground">
                    Calls go to <Mono>gateway.broods.app</Mono> by default; override with <Mono>BROODS_BASE_URL</Mono>{" "}
                    for a self-hosted core.
                </p>
            </section>
        </div>
    );
}

/** Dialog that surfaces the runtime API key right after it is minted. */
export function RuntimeKeyDialog({ open, onOpenChange, apiKey, justCreated = false }: DialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <KeyRound className="size-4 text-foreground" />
                        {justCreated ? "Your runtime API key is ready" : "Runtime API key"}
                    </DialogTitle>
                    <DialogDescription>
                        This key authenticates runtime calls for this environment — agent runs, streaming, and the
                        observability views. Treat it like a password.
                    </DialogDescription>
                </DialogHeader>

                <RuntimeKeyView apiKey={apiKey} />
            </DialogContent>
        </Dialog>
    );
}
