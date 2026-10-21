"use client";

/**
 * Read-only file preview under the workspace file tree. The selected file shows
 * in one transient tab; Enter keeps it open as a pinned tab, so several files
 * can be reviewed side by side. Data-free: the caller loads contents.
 */
import type { CodeLanguage } from "@/app/components/side-panel/CodeEditor";
import type { FileRecord } from "@/app/components/side-panel/WorkspaceFilesTab";
import { IconTooltip } from "@/app/components/IconTooltip";
import { Button } from "@/app/components/ui/button";
import { toErrorMessage } from "@/app/lib/errors";
import { cn } from "@/app/lib/utils";
import { Check, Copy, Download, X } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

// Both are heavy (CodeMirror, and Streamdown's Shiki and Mermaid), so they load
// only once a file is opened.
const CodeEditor = dynamic(
  () =>
    import("@/app/components/side-panel/CodeEditor").then((m) => m.CodeEditor),
  { ssr: false },
);
const Streamdown = dynamic(
  () => import("streamdown").then((m) => m.Streamdown),
  { ssr: false },
);

export type FileContent =
  | { kind: "text"; text: string }
  | { kind: "image"; url: string };

export interface PreviewTab {
  file: FileRecord;
  pinned: boolean;
}

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; content: FileContent }
  | { status: "failed"; error: string };

type PreviewKind = "text" | "image" | "tooLarge" | "binary";

// The dashboard upload limit; larger files only offer Download.
const MAX_PREVIEW_BYTES = 512 * 1024;
// Holding an arrow key walks many rows; only the one it stops on loads.
const LOAD_DELAY_MS = 150;
const IMAGE_EXTENSIONS = new Set(["gif", "jpeg", "jpg", "png", "svg", "webp"]);
const BINARY_EXTENSIONS = new Set([
  "7z",
  "avi",
  "bin",
  "dmg",
  "exe",
  "gz",
  "ico",
  "jar",
  "mov",
  "mp3",
  "mp4",
  "otf",
  "pdf",
  "rar",
  "so",
  "tar",
  "tgz",
  "ttf",
  "wasm",
  "wav",
  "woff",
  "woff2",
  "zip",
]);
const MARKDOWN_EXTENSIONS = new Set(["markdown", "md", "mdx"]);
const CODE_LANGUAGES: Record<string, CodeLanguage> = {
  cjs: "javascript",
  js: "javascript",
  json: "javascript",
  jsx: "typescript",
  mjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
};

/**
 * The preview's tabs, driven by the tree's selection. Call `show` when a file
 * is selected, `pin` when it is opened with Enter, and `rename` after a rename.
 */
export function usePreviewTabs(
  files: FileRecord[] | undefined,
  selected: string | null,
): {
  tabs: PreviewTab[];
  activePath: string | null;
  show: (path: string) => void;
  pin: (path: string) => void;
  close: (path: string) => void;
  rename: (path: string, newPath: string) => void;
} {
  const [pinned, setPinned] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  // The transient tab the user closed; it reopens on the next selection.
  const [dismissed, setDismissed] = useState<string | null>(null);

  const byPath = new Map((files ?? []).map((file) => [file.path, file]));
  const selectedFile = selected ? byPath.get(selected) : undefined;
  const transient =
    selectedFile &&
    !selectedFile.isFolder &&
    !pinned.includes(selectedFile.path) &&
    dismissed !== selectedFile.path
      ? selectedFile
      : undefined;
  const tabs: PreviewTab[] = [
    ...pinned.flatMap((path) => {
      const file = byPath.get(path);

      return file ? [{ file: file, pinned: true }] : [];
    }),
    ...(transient ? [{ file: transient, pinned: false }] : []),
  ];
  const activePath = tabs.some((tab) => tab.file.path === active)
    ? active
    : (tabs.at(-1)?.file.path ?? null);

  return {
    tabs: tabs,
    activePath: activePath,
    show: (path) => {
      setActive(path);
      setDismissed(null);
    },
    pin: (path) => {
      setPinned((prev) => (prev.includes(path) ? prev : [...prev, path]));
      setActive(path);
    },
    close: (path) => {
      if (pinned.includes(path)) {
        setPinned((prev) => prev.filter((p) => p !== path));
      } else {
        setDismissed(path);
      }
    },
    rename: (path, newPath) => {
      setPinned((prev) => prev.map((p) => (p === path ? newPath : p)));
      if (active === path) setActive(newPath);
    },
  };
}

/** The tab strip and the active file's contents, read-only. */
export function FilePreview({
  tabs,
  activePath,
  onActivate,
  onPin,
  onClose,
  loadFile,
  fileUrl,
}: {
  tabs: PreviewTab[];
  activePath: string | null;
  onActivate: (path: string) => void;
  onPin: (path: string) => void;
  onClose: (path: string) => void;
  loadFile: (file: FileRecord) => Promise<FileContent>;
  fileUrl: (file: FileRecord) => Promise<string>;
}): React.JSX.Element {
  const active = tabs.find((tab) => tab.file.path === activePath)?.file;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Open files"
        className="flex shrink-0 overflow-x-auto border-b border-border"
      >
        {tabs.map(({ file, pinned }) => {
          const isActive = file.path === activePath;

          return (
            <div
              key={file.path}
              className={cn(
                "group flex shrink-0 items-center border-r border-border",
                isActive
                  ? "bg-background text-foreground"
                  : "bg-muted/30 text-muted-foreground",
              )}
            >
              <button
                role="tab"
                aria-selected={isActive}
                data-pinned={pinned || undefined}
                title={
                  pinned
                    ? file.path
                    : `${file.path} (double-click to keep open)`
                }
                className={cn(
                  "cursor-pointer py-1.5 pr-1 pl-2.5 font-mono text-2xs outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
                  !pinned && "italic",
                )}
                onClick={() => onActivate(file.path)}
                onDoubleClick={() => onPin(file.path)}
              >
                {file.name}
              </button>
              <button
                aria-label={`Close ${file.name}`}
                className="mr-1 flex size-4 cursor-pointer items-center justify-center rounded-sm opacity-60 hover:bg-muted hover:opacity-100"
                onClick={() => onClose(file.path)}
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
      {active && (
        <FileBody
          key={contentKey(active)}
          file={active}
          loadFile={loadFile}
          fileUrl={fileUrl}
        />
      )}
    </div>
  );
}

function FileBody({
  file,
  loadFile,
  fileUrl,
}: {
  file: FileRecord;
  loadFile: (file: FileRecord) => Promise<FileContent>;
  fileUrl: (file: FileRecord) => Promise<string>;
}): React.JSX.Element {
  const kind = previewKind(file);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [view, setView] = useState<"preview" | "source">("preview");
  const [copied, setCopied] = useState(false);
  const extension = extensionOf(file.name);
  const isMarkdown = MARKDOWN_EXTENSIONS.has(extension);

  useEffect(() => {
    if (kind !== "text" && kind !== "image") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      loadFile(file)
        .then((content) => {
          if (!cancelled) setState({ status: "loaded", content: content });
        })
        .catch((error: unknown) => {
          if (!cancelled)
            setState({ status: "failed", error: toErrorMessage(error) });
        });
    }, LOAD_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [file, kind, loadFile]);

  const text =
    state.status === "loaded" && state.content.kind === "text"
      ? state.content.text
      : null;
  const isBinary = kind === "binary" || (text?.includes("\u0000") ?? false);

  const download = (): void => {
    void fileUrl(file).then((url) => window.open(url, "_blank", "noopener"));
  };

  const copy = (): void => {
    if (text === null) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      role="tabpanel"
      aria-label={file.path}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">
          {file.path}
        </span>
        {file.sizeBytes !== undefined && (
          <span className="shrink-0 text-3xs text-muted-foreground">
            {formatBytes(file.sizeBytes)}
          </span>
        )}
        {isMarkdown && text !== null && !isBinary && (
          <div className="ml-1 flex shrink-0 overflow-hidden rounded-sm border border-border">
            {(["preview", "source"] as const).map((option) => (
              <button
                key={option}
                aria-pressed={view === option}
                className={cn(
                  "cursor-pointer px-2 py-0.5 text-3xs capitalize",
                  view === option
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground",
                )}
                onClick={() => setView(option)}
              >
                {option}
              </button>
            ))}
          </div>
        )}
        {text !== null && !isBinary && (
          <IconTooltip label={copied ? "Copied" : "Copy contents"}>
            <Button
              size="icon-xs"
              variant="ghost"
              className="cursor-pointer"
              onClick={copy}
            >
              {copied ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </Button>
          </IconTooltip>
        )}
        <IconTooltip label={`Download ${file.name}`}>
          <Button
            size="icon-xs"
            variant="ghost"
            className="cursor-pointer"
            onClick={download}
          >
            <Download className="size-3.5" />
          </Button>
        </IconTooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {kind === "tooLarge" || isBinary ? (
          <PreviewNotice
            text={
              kind === "tooLarge"
                ? "Files over 512 KiB are not previewed."
                : "No preview for this file type."
            }
            onDownload={download}
          />
        ) : (
          <PreviewContent
            file={file}
            state={state}
            markdown={isMarkdown && view === "preview"}
            language={CODE_LANGUAGES[extension] ?? "plain"}
          />
        )}
      </div>
    </div>
  );
}

/** What a previewable file shows: loading, its error, an image, rendered Markdown or code. */
function PreviewContent({
  file,
  state,
  markdown,
  language,
}: {
  file: FileRecord;
  state: LoadState;
  markdown: boolean;
  language: CodeLanguage;
}): React.JSX.Element {
  if (state.status === "loading") {
    return <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>;
  }
  if (state.status === "failed") {
    return <p className="px-3 py-2 text-xs text-destructive">{state.error}</p>;
  }
  if (state.content.kind === "image") {
    return (
      <div className="flex h-full items-center justify-center overflow-auto p-3">
        {/* oxlint-disable-next-line nextjs/no-img-element -- a short-lived presigned URL next/image cannot optimise */}
        <img
          src={state.content.url}
          alt={file.name}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }
  if (markdown) {
    return (
      <div className="h-full overflow-y-auto px-4 py-3">
        <Streamdown className="text-sm wrap-break-word [&>*:first-child]:mt-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto">
          {state.content.text}
        </Streamdown>
      </div>
    );
  }

  return (
    <div className="h-full p-1.5">
      <CodeEditor
        value={state.content.text}
        onChange={() => {}}
        readOnly
        language={language}
        height="100%"
      />
    </div>
  );
}

function PreviewNotice({
  text,
  onDownload,
}: {
  text: string;
  onDownload: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-start gap-2 px-3 py-3">
      <p className="text-xs text-muted-foreground">{text}</p>
      <Button
        size="sm"
        variant="outline"
        className="cursor-pointer"
        onClick={onDownload}
      >
        <Download className="size-3.5" />
        Download
      </Button>
    </div>
  );
}

/** Whether the preview shows a file as an image, from a URL rather than its text. */
export function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

/** Reloads the body when the file changes on disk, not only when its path does. */
function contentKey(file: FileRecord): string {
  return `${file.path}:${file.updatedAt ?? ""}:${file.sizeBytes ?? ""}`;
}

function extensionOf(name: string): string {
  return name.includes(".") ? (name.split(".").pop()?.toLowerCase() ?? "") : "";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function previewKind(file: FileRecord): PreviewKind {
  const extension = extensionOf(file.name);
  if (isImageFile(file.name)) return "image";
  if ((file.sizeBytes ?? 0) > MAX_PREVIEW_BYTES) return "tooLarge";
  if (BINARY_EXTENSIONS.has(extension)) return "binary";

  return "text";
}
