"use client";

import { CopyButton } from "@/app/components/CopyButton";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import { useNow } from "@/app/hooks/useNow";
import { resolveCoreEndpoint } from "@/app/lib/coreEndpoint";
import { toErrorMessage } from "@/app/lib/errors";
import { formatDate } from "@/app/lib/formatTime";
import { navHref } from "@/app/lib/navigation";
import type { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type ReactNode, useState } from "react";
import { relativeTime } from "../../sandbox/components/sandboxFormat";

const DESCRIPTION = "Runs and observes this stage. Rotate it when it leaks.";

const DOCS_URL = "https://docs.broods.app/reference/sdk";

// VSCode Dark+ token palette, applied by a tiny tokenizer below so the snippet
// reads like an editor without pulling in a full highlighter dependency.
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
  /** The plaintext runtime key (bsk_…) for the active stage. */
  apiKey: string;
  /** Whether the key was just minted (changes the title). */
  justCreated?: boolean;
}

interface ViewProps {
  apiKey: string;
  /** The reveal query's result; its metadata shows only while it describes `apiKey`. */
  revealed?: RevealedKey | null;
  onRotate?: () => Promise<void>;
  /** The project and stage the key belongs to, for the Deployment section. */
  projectId?: Id<"projects">;
  projectSlug?: string;
  stageSlug?: string;
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
          <DialogTitle>
            {justCreated ? "Your runtime key is ready" : "Runtime key"}
          </DialogTitle>
          <DialogDescription>{DESCRIPTION}</DialogDescription>
        </DialogHeader>
        <KeyRow key={apiKey} apiKey={apiKey} />
        <ConnectSnippet apiKey={apiKey} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The dashboard's "Runtime key" tab in the Convex settings shape: a title and
 * one sentence on the left, the control on the right, one rule between
 * sections, no card, no numbered steps, no tabs.
 */
export function RuntimeKeyView({
  apiKey,
  revealed,
  onRotate,
  projectId,
  projectSlug,
  stageSlug,
}: ViewProps): React.JSX.Element {
  // A just-rotated key shows no metadata until the reveal query catches up.
  const meta = revealed?.apiKey === apiKey ? revealed : undefined;
  const endpoint = resolveCoreEndpoint();
  const gatewayUrl = endpoint.ok ? endpoint.httpBaseUrl : null;
  const searchParams = useSearchParams();

  return (
    <div className="divide-y divide-border">
      <SettingsRow title="Deployment" description="Where this stage answers.">
        <ValueRow label="Gateway URL">
          {gatewayUrl ? (
            <>
              <Input
                readOnly
                value={gatewayUrl}
                className="font-mono text-xs"
              />
              <CopyButton value={gatewayUrl} label="gateway URL" />
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {endpoint.ok ? null : endpoint.message}
            </p>
          )}
        </ValueRow>
        {projectSlug && stageSlug && (
          <ValueRow label="Stage">
            <Input
              readOnly
              value={`${projectSlug} / ${stageSlug}`}
              className="font-mono text-xs"
            />
          </ValueRow>
        )}
      </SettingsRow>

      <SettingsRow title="Runtime key" description={DESCRIPTION}>
        <KeyRow key={apiKey} apiKey={apiKey} onRotate={onRotate} />
        <p className="text-2xs text-muted-foreground">
          <KeyMetaLine meta={meta} />
          {projectId && (
            <>
              {" · "}
              <Link
                href={`${navHref(projectId, "/settings", searchParams.get("stage"))}${searchParams.get("stage") ? "&" : "?"}tab=keys`}
                className="cursor-pointer text-foreground underline-offset-3 hover:underline"
              >
                all keys for this project
              </Link>
            </>
          )}
        </p>
      </SettingsRow>

      <SettingsRow title="Connect" description="Three lines to a first run.">
        <ConnectSnippet apiKey={apiKey} gatewayUrl={gatewayUrl} />
      </SettingsRow>
    </div>
  );
}

/** One settings section: words on the left, the control on the right. */
function SettingsRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <section className="grid gap-3 py-5 md:grid-cols-[14rem_minmax(0,1fr)] md:gap-8">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="grid min-w-0 gap-3">{children}</div>
    </section>
  );
}

/** A labeled value with its controls beside it. */
function ValueRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="grid gap-1">
      <span className="text-2xs text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-1">{children}</div>
    </div>
  );
}

/** The masked key with reveal, copy and, on the tab, rotate. */
function KeyRow({
  apiKey,
  onRotate,
}: {
  apiKey: string;
  onRotate?: () => Promise<void>;
}): React.JSX.Element {
  const [showKey, setShowKey] = useState(false);
  const maskedKey = "•".repeat(Math.min(apiKey.length, 44));

  return (
    <div className="flex min-w-0 items-center gap-1">
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
      {onRotate && <RotateButton onRotate={onRotate} />}
    </div>
  );
}

/** The three lines that reach a first run, and where to read on. */
function ConnectSnippet({
  apiKey,
  gatewayUrl,
}: {
  apiKey: string;
  gatewayUrl?: string | null;
}): React.JSX.Element {
  const [showKey, setShowKey] = useState(false);
  const maskedKey = "•".repeat(Math.min(apiKey.length, 44));
  const baseUrl = gatewayUrl ? `  BROODS_BASE_URL="${gatewayUrl}"` : "";
  const lines = (key: string): string =>
    [
      `npm install broods`,
      `BROODS_API_KEY="${key}"${baseUrl}`,
      `await new BroodsClient().stream(api.agents.myAgent, { input: "Hello" })`,
    ].join("\n");

  return (
    <div className="grid gap-2">
      <div className="relative">
        <pre className="overflow-x-auto rounded-md border border-border bg-code-background px-4 py-3 font-mono text-xs leading-relaxed text-code-foreground">
          <code>{highlight(lines(showKey ? apiKey : maskedKey))}</code>
        </pre>
        <div className="absolute top-2 right-2 flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            tone="muted"
            className="cursor-pointer"
            aria-label={
              showKey ? "Hide key in snippet" : "Reveal key in snippet"
            }
            onClick={() => setShowKey((v) => !v)}
          >
            {showKey ? <EyeOff /> : <Eye />}
          </Button>
          <CopyButton value={lines(apiKey)} label="snippet" />
        </div>
      </div>
      <p className="text-2xs text-muted-foreground">
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="cursor-pointer text-foreground underline-offset-3 hover:underline"
        >
          Docs
        </a>
        {" · "}
        <a
          href={`${DOCS_URL}#websocket`}
          target="_blank"
          rel="noreferrer"
          className="cursor-pointer text-foreground underline-offset-3 hover:underline"
        >
          WebSocket
        </a>
        {gatewayUrl && (
          <>
            {" · "}
            <CurlLink gatewayUrl={gatewayUrl} />
          </>
        )}
      </p>
    </div>
  );
}

/** Copies a cURL request for the stage; the plain HTTP route for anyone without the SDK. */
function CurlLink({ gatewayUrl }: { gatewayUrl: string }): React.JSX.Element {
  const snippet = [
    `curl -N ${gatewayUrl}/v1/runs \\`,
    `  -H "Authorization: Bearer $BROODS_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{ "agentId": "your-agent-id", "eventId": "unique-id", "conversationKey": "conversation-identifier", "events": [{ "role": "user", "content": [{ "type": "text", "text": "Hello" }] }] }'`,
  ].join("\n");

  return (
    <span className="inline-flex items-center gap-0.5">
      cURL
      <CopyButton value={snippet} label="cURL request" />
    </span>
  );
}

function highlight(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  let key = 0;
  code.split("\n").forEach((line, index) => {
    if (index > 0) out.push("\n");
    const re =
      line.startsWith("npm") || line.startsWith("BROODS") ? BASH_RE : TS_RE;
    re.lastIndex = 0;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) out.push(line.slice(last, m.index));
      const cls =
        re === BASH_RE
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
    if (last < line.length) out.push(line.slice(last));
  });

  return out;
}

// "Created Sep 2 by Ada, last used 4m ago", dropping each part the row does not know.
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

  return (
    <>
      {[created, lastUsed]
        .filter((part): part is string => part !== null)
        .join(", ")}
    </>
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
      setError(toErrorMessage(e));
    } finally {
      setRotating(false);
    }
  }

  if (confirming) {
    return (
      <span className="flex shrink-0 items-center gap-1">
        <Button
          variant="destructive"
          size="sm"
          className="cursor-pointer"
          disabled={rotating}
          onClick={run}
        >
          {rotating ? "Rotating" : "Rotate now"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="cursor-pointer"
          disabled={rotating}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </Button>
      </span>
    );
  }

  return (
    <span className="flex shrink-0 items-center gap-1">
      <Button
        variant="outline"
        size="sm"
        tone="muted"
        className="cursor-pointer"
        onClick={() => setConfirming(true)}
      >
        Rotate
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
}
