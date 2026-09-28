"use client";

import { CopyButton } from "@/app/components/CopyButton";
import { Button } from "@/app/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/app/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/app/components/ui/field";
import { Input } from "@/app/components/ui/input";
import { Separator } from "@/app/components/ui/separator";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/app/components/ui/tabs";
import { useNow } from "@/app/hooks/useNow";
import { resolveCoreEndpoint } from "@/app/lib/coreEndpoint";
import { formatDate } from "@/app/lib/formatTime";
import type { api } from "@broods/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { Eye, EyeOff, KeyRound, RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { relativeTime } from "../../sandbox/components/sandboxFormat";

const DESCRIPTION =
  "One key for runs, streaming and observability on this stage.";

const INSTALL_SNIPPET = "bun add broods";

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
  comment: "text-code-comment",
  string: "text-code-string",
  keyword: "text-code-keyword",
  func: "text-code-function",
  number: "text-code-number",
  variable: "text-code-variable",
};

const TS_RE =
  /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(import|from|const|let|var|new|for|await|of|if|else|return|async|function|true|false|null)\b|([A-Za-z_$][\w$]*)(?=\s*\()|(\b\d+(?:\.\d+)?\b)/g;
const BASH_RE =
  /(#[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b([A-Z_][A-Z0-9_]*)(?==)/g;

type RevealedKey = NonNullable<
  FunctionReturnType<typeof api.agent.deployments.revealKeyForStage>
>;

/** Who minted the key and when it last authenticated; absent fields render as nothing. */
type RuntimeKeyMeta = Omit<RevealedKey, "apiKey">;

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The plaintext runtime key (fp_agent_…) for the active stage. */
  apiKey: string;
  /** Whether the key was just minted (changes the title). */
  justCreated?: boolean;
}

interface FieldsProps {
  apiKey: string;
  meta?: RuntimeKeyMeta;
  onRotate?: () => Promise<void>;
}

interface ViewProps {
  apiKey: string;
  /** The reveal query's result; its metadata shows only while it describes `apiKey`. */
  revealed?: RevealedKey | null;
  onRotate?: () => Promise<void>;
}

/** Opened by the dashboard page right after it mints the stage's first key. */
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
            {justCreated ? "Your runtime key is ready" : "Runtime key"}
          </DialogTitle>
          <DialogDescription>{DESCRIPTION}</DialogDescription>
        </DialogHeader>

        <RuntimeKeyFields apiKey={apiKey} />
      </DialogContent>
    </Dialog>
  );
}

/** The dashboard's "API key" tab: gateway URL, runtime key and a quickstart in one card. */
export function RuntimeKeyView({
  apiKey,
  revealed,
  onRotate,
}: ViewProps): React.JSX.Element {
  // A just-rotated key shows no metadata until the reveal query catches up.
  const meta = revealed?.apiKey === apiKey ? revealed : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Runtime</CardTitle>
        <CardDescription>{DESCRIPTION}</CardDescription>
      </CardHeader>
      <CardContent>
        <RuntimeKeyFields apiKey={apiKey} meta={meta} onRotate={onRotate} />
      </CardContent>
    </Card>
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
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border border-border bg-code-background px-4 py-3 font-mono text-xs leading-relaxed text-code-foreground">
        <code>{highlight(code, lang)}</code>
      </pre>
      <div className="absolute right-2 top-2">
        <CopyButton value={copyText ?? code} label="snippet" />
      </div>
    </div>
  );
}

function curlSnippet(gatewayUrl: string): string {
  return [
    `curl -N ${gatewayUrl}/v1/runs \\`,
    `  -H "Authorization: Bearer $BROODS_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{`,
    `    "agentId": "your-agent-id",`,
    `    "eventId": "unique-id",`,
    `    "conversationKey": "conversation-identifier",`,
    `    "events": [{ "role": "user", "content": [{ "type": "text", "text": "Hello from cURL!" }] }]`,
    `  }'`,
  ].join("\n");
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

// "Created Sep 2 by Ada · last used 4m ago", dropping each part the row does not know.
function KeyMetaLine({ meta }: { meta?: RuntimeKeyMeta }): React.JSX.Element {
  const now = useNow();
  const created = meta?.createdAt
    ? `Created ${formatDate(meta.createdAt)}${meta.createdBy ? ` by ${meta.createdBy}` : ""}`
    : meta?.createdBy
      ? `Created by ${meta.createdBy}`
      : null;
  const lastUsed = meta?.lastUsedAt
    ? `last used ${relativeTime(meta.lastUsedAt, now)}`
    : null;
  const parts = [created, lastUsed].filter(
    (part): part is string => part !== null,
  );

  return <FieldDescription>{parts.join(" · ")}</FieldDescription>;
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
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-xs text-muted-foreground">
          Invalidate the current key?
        </span>
        <Button
          variant="destructive"
          size="xs"
          className="cursor-pointer"
          disabled={rotating}
          onClick={run}
        >
          {rotating ? "Rotating" : "Rotate"}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          className="cursor-pointer"
          disabled={rotating}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 flex-col items-end">
      <Button
        variant="outline"
        size="xs"
        tone="muted"
        className="cursor-pointer"
        onClick={() => setConfirming(true)}
      >
        <RefreshCw />
        Rotate
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

// The fields and quickstart shared by the tab's card and the just-minted dialog.
function RuntimeKeyFields({
  apiKey,
  meta,
  onRotate,
}: FieldsProps): React.JSX.Element {
  const [showKey, setShowKey] = useState(false);
  const endpoint = resolveCoreEndpoint();
  const gatewayUrl = endpoint.ok ? endpoint.httpBaseUrl : null;
  const maskedKey = "•".repeat(Math.min(apiKey.length, 44));
  // The .env block mirrors the reveal toggle so the secret is never shown by
  // default, but Copy always yields the real lines.
  const baseUrlLine = gatewayUrl ? `\nBROODS_BASE_URL="${gatewayUrl}"` : "";
  const envDisplay = `BROODS_API_KEY="${showKey ? apiKey : maskedKey}"${baseUrlLine}`;
  const envReal = `BROODS_API_KEY="${apiKey}"${baseUrlLine}`;

  // Each label sits in a fixed-width wrapper: a horizontal Field grows a
  // label that is its direct child.
  return (
    <FieldGroup>
      <Field orientation="horizontal">
        <div className="w-28 shrink-0">
          <FieldLabel>Gateway URL</FieldLabel>
        </div>
        {gatewayUrl ? (
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <Input readOnly value={gatewayUrl} className="font-mono text-xs" />
            <CopyButton value={gatewayUrl} label="gateway URL" />
          </div>
        ) : (
          <FieldDescription>
            {endpoint.ok ? null : endpoint.message}
          </FieldDescription>
        )}
      </Field>
      <Field orientation="horizontal" className="items-start">
        <div className="w-28 shrink-0">
          <FieldLabel>Runtime key</FieldLabel>
        </div>
        <FieldContent>
          <div className="flex items-center gap-1">
            <Input
              readOnly
              value={showKey ? apiKey : maskedKey}
              className="font-mono text-xs"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              tone="muted"
              className="cursor-pointer"
              aria-label={showKey ? "Hide key" : "Reveal key"}
              onClick={() => setShowKey((v) => !v)}
            >
              {showKey ? <EyeOff /> : <Eye />}
            </Button>
            <CopyButton value={apiKey} label="runtime key" />
          </div>
          <div className="flex items-start justify-between">
            <KeyMetaLine meta={meta} />
            {onRotate ? <RotateButton onRotate={onRotate} /> : null}
          </div>
        </FieldContent>
      </Field>

      <Separator />

      <div className="grid gap-4">
        <h3 className="text-sm font-semibold">Quickstart</h3>
        <ol className="grid gap-4">
          <Step n={1} title="Install">
            <CodeBlock code={INSTALL_SNIPPET} lang="bash" />
          </Step>
          <Step n={2} title="Add to .env">
            <CodeBlock code={envDisplay} copyText={envReal} lang="bash" />
          </Step>
          <Step n={3} title="Run an agent">
            <Tabs defaultValue="sdk">
              <TabsList>
                <TabsTrigger value="sdk" className="cursor-pointer">
                  SDK
                </TabsTrigger>
                <TabsTrigger value="ws" className="cursor-pointer">
                  WebSocket
                </TabsTrigger>
                {gatewayUrl ? (
                  <TabsTrigger value="curl" className="cursor-pointer">
                    cURL
                  </TabsTrigger>
                ) : null}
              </TabsList>
              <TabsContent value="sdk">
                <CodeBlock code={SSE_SNIPPET} lang="ts" />
              </TabsContent>
              <TabsContent value="ws">
                <CodeBlock code={WS_SNIPPET} lang="ts" />
              </TabsContent>
              {gatewayUrl ? (
                <TabsContent value="curl">
                  <CodeBlock code={curlSnippet(gatewayUrl)} lang="bash" />
                </TabsContent>
              ) : null}
            </Tabs>
          </Step>
        </ol>
      </div>
    </FieldGroup>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <li className="grid gap-2">
      <p className="text-sm font-medium">
        <span className="text-muted-foreground tabular-nums">{n}</span> {title}
      </p>
      {children}
    </li>
  );
}
