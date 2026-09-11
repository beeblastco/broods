"use client";

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
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/app/components/ui/tabs";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { type ReactNode, useState } from "react";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The plaintext runtime key (fp_agent_…) for the active stage. */
  apiKey: string;
  /** Whether the key was just minted (changes the framing copy). */
  justCreated?: boolean;
}

const SSE_SNIPPET = [
  `import { BroodsClient } from "broods";`,
  `import { api } from "./broods/_generated/api";`,
  ``,
  `// Reads BROODS_API_KEY from your .env automatically.`,
  `const client = new BroodsClient();`,
  ``,
  `// Default transport: server-sent events over plain HTTP.`,
  `for await (const chunk of client.stream(api.agent.agents.yourAgent, {`,
  `  input: "Hello from the SDK!",`,
  `})) {`,
  `  if (chunk.type === "text-delta") process.stdout.write(chunk.text);`,
  `}`,
].join("\n");

const WS_SNIPPET = [
  `import { WebsocketClient } from "broods";`,
  `import { api } from "./broods/_generated/api";`,
  ``,
  `// Reads BROODS_API_KEY from your .env automatically.`,
  `const client = new WebsocketClient();`,
  ``,
  `// Opt-in transport: a full-duplex WebSocket connection.`,
  `for await (const message of client.stream({`,
  `  agent: api.agent.agents.yourAgent,`,
  `  input: "Hello from the SDK!",`,
  `})) {`,
  `  if (message.type === "text-delta") process.stdout.write(message.text);`,
  `}`,
].join("\n");

// VSCode Dark+ token palette, applied by a tiny tokenizer below so the snippets
// read like an editor without pulling in a full highlighter dependency.
const COLOR = {
  comment: "text-[#6a9955]",
  string: "text-[#ce9178]",
  keyword: "text-[#569cd6]",
  func: "text-[#dcdcaa]",
  number: "text-[#b5cea8]",
  variable: "text-[#9cdcfe]",
};

const TS_RE =
  /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(import|from|const|let|var|new|for|await|of|if|else|return|async|function|true|false|null)\b|([A-Za-z_$][\w$]*)(?=\s*\()|(\b\d+(?:\.\d+)?\b)/g;
const BASH_RE =
  /(#[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b([A-Z_][A-Z0-9_]*)(?==)/g;

export function RuntimeKeyDialog({
  open,
  onOpenChange,
  apiKey,
  justCreated = false,
}: DialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-foreground" />
            {justCreated ? "Your runtime API key is ready" : "Runtime API key"}
          </DialogTitle>
          <DialogDescription>
            This key authenticates runtime calls for this stage: agent runs,
            streaming, and the observability views. Treat it like a password.
          </DialogDescription>
        </DialogHeader>

        <RuntimeKeyView apiKey={apiKey} />
      </DialogContent>
    </Dialog>
  );
}

export function RuntimeKeyView({
  apiKey,
  onRotate,
}: {
  apiKey: string;
  onRotate?: () => Promise<void>;
}): React.JSX.Element {
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const maskedKey = "•".repeat(Math.min(apiKey.length, 44));
  // The .env block mirrors the reveal toggle so the secret is never shown by
  // default, but Copy always yields the real line.
  const envDisplay = `BROODS_API_KEY="${showKey ? apiKey : maskedKey}"`;
  const envReal = `BROODS_API_KEY="${apiKey}"`;

  function copyKey(): void {
    navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="grid gap-6">
      <section className="grid gap-2">
        <div className="flex min-h-7 items-center justify-between gap-2">
          <Label className="text-sm font-medium text-foreground">API key</Label>
          {onRotate ? <RotateButton onRotate={onRotate} /> : null}
        </div>
        <div className="flex items-center gap-2">
          <Input
            readOnly
            value={showKey ? apiKey : maskedKey}
            className="h-9 font-mono text-xs text-foreground"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-9 shrink-0 cursor-pointer"
            onClick={() => setShowKey((v) => !v)}
            title={showKey ? "Hide key" : "Reveal key"}
          >
            {showKey ? (
              <EyeOff className="size-3.5" />
            ) : (
              <Eye className="size-3.5" />
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9 shrink-0 cursor-pointer"
            onClick={copyKey}
          >
            {copied ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
            <span className="ml-1">{copied ? "Copied" : "Copy"}</span>
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Stored encrypted at rest. Treat it like a password. Reopen it here
          anytime, or rotate it to invalidate the old one.
        </p>
      </section>

      <section className="grid gap-2">
        <Label className="text-sm font-medium text-foreground">
          Add it to your environment
        </Label>
        <p className="text-xs leading-relaxed text-muted-foreground">
          The SDK reads <Mono>BROODS_API_KEY</Mono> by default. Copy this into
          your <Mono>.env.local</Mono> or <Mono>.env</Mono> file.
        </p>
        <CodeBlock code={envDisplay} copyText={envReal} lang="bash" />
      </section>

      <section className="grid gap-2">
        <Label className="text-sm font-medium text-foreground">
          Stream the response
        </Label>
        <p className="text-xs leading-relaxed text-muted-foreground">
          The SDK streams over <Mono>SSE</Mono> by default, plain HTTP that
          works through any proxy with zero setup. For the lowest latency and a
          full-duplex channel, opt into the WebSocket client.
        </p>
        <Tabs defaultValue="sse" className="mt-1 gap-2">
          <TabsList>
            <TabsTrigger value="sse" className="cursor-pointer">
              SSE · default
            </TabsTrigger>
            <TabsTrigger value="ws" className="cursor-pointer">
              WebSocket
            </TabsTrigger>
          </TabsList>
          <TabsContent value="sse" className="grid gap-2">
            <CodeBlock code={SSE_SNIPPET} lang="ts" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Best for simple request/response runs. No connection to manage,
              and reconnects come for free.
            </p>
          </TabsContent>
          <TabsContent value="ws" className="grid gap-2">
            <CodeBlock code={WS_SNIPPET} lang="ts" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Best for live, interactive runs. Full-duplex, lowest latency,
              cancel mid-stream.
            </p>
          </TabsContent>
        </Tabs>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Calls go to <Mono>gateway.broods.app</Mono> by default; override with{" "}
          <Mono>BROODS_BASE_URL</Mono> for a self-hosted deployment.
        </p>
      </section>
    </div>
  );
}

/** `copyText` overrides what the button copies, so a masked display can still yield the real secret. */
function CodeBlock({
  code,
  lang,
  copyText,
}: {
  code: string;
  lang: "ts" | "bash";
  copyText?: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  function copy(): void {
    navigator.clipboard.writeText(copyText ?? code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border border-border bg-[#1e1e1e] px-4 py-3 font-mono text-[12px] leading-relaxed text-[#d4d4d4]">
        <code>{highlight(code, lang)}</code>
      </pre>
      <button
        type="button"
        onClick={copy}
        title="Copy"
        className="absolute right-2 top-2 flex size-7 cursor-pointer items-center justify-center rounded-md border border-white/10 bg-white/5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
      >
        {copied ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
    </div>
  );
}

function highlight(code: string, lang: "ts" | "bash"): ReactNode[] {
  const re = lang === "bash" ? BASH_RE : TS_RE;
  re.lastIndex = 0;
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const cls =
      lang === "bash"
        ? m[1]
          ? COLOR.comment
          : m[2]
            ? COLOR.string
            : COLOR.variable
        : m[1]
          ? COLOR.comment
          : m[2]
            ? COLOR.string
            : m[3]
              ? COLOR.keyword
              : m[4]
                ? COLOR.func
                : COLOR.number;
    out.push(
      <span key={key++} className={cls}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));

  return out;
}

function Mono({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
      {children}
    </code>
  );
}

function RotateButton({
  onRotate,
}: {
  onRotate: () => Promise<void>;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    setRotating(true);
    setError(null);
    try {
      await onRotate();
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rotate key");
    } finally {
      setRotating(false);
    }
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          Invalidate the current key?
        </span>
        <Button
          variant="destructive"
          size="sm"
          className="h-7 cursor-pointer"
          disabled={rotating}
          onClick={run}
        >
          {rotating ? <Loader2 className="size-3.5 animate-spin" /> : "Rotate"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 cursor-pointer"
          disabled={rotating}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        className="h-7 cursor-pointer text-muted-foreground"
        onClick={() => setConfirming(true)}
      >
        <RefreshCw className="size-3.5" />
        <span className="ml-1">Rotate</span>
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
