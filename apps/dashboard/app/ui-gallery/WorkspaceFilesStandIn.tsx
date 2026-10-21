"use client";

/**
 * The workspace file explorer over an in-memory file list, once as a writer
 * and once as a member. The view is the real one; uploads, renames, deletes
 * and downloads change the list here and are written to `[data-files-log]`
 * for a spec.
 */
import type { FileContent } from "@/app/components/side-panel/FilePreview";
import {
  renamedPath,
  withoutPath,
  withRenamedPath,
  WorkspaceFilesView,
  type FileRecord,
} from "@/app/components/side-panel/WorkspaceFilesTab";
import { useCallback, useState } from "react";

const FILES: FileRecord[] = [
  { path: "docs", name: "docs", isFolder: true },
  { path: "docs/guide.md", name: "guide.md", isFolder: false, sizeBytes: 2048 },
  { path: "docs/api", name: "api", isFolder: true },
  { path: "docs/api/openapi.yaml", name: "openapi.yaml", isFolder: false },
  { path: "README.md", name: "README.md", isFolder: false, sizeBytes: 512 },
  { path: "notes.txt", name: "notes.txt", isFolder: false, sizeBytes: 64 },
  { path: "agent.ts", name: "agent.ts", isFolder: false, sizeBytes: 300 },
  { path: "logo.svg", name: "logo.svg", isFolder: false, sizeBytes: 200 },
  {
    path: "build.log",
    name: "build.log",
    isFolder: false,
    sizeBytes: 600 * 1024,
  },
  { path: "assets.zip", name: "assets.zip", isFolder: false, sizeBytes: 4096 },
];

const CONTENTS: Record<string, string> = {
  "docs/guide.md": "# Getting started\n\nRun `broods dev` in the project.\n",
  "docs/api/openapi.yaml": "openapi: 3.1.0\ninfo:\n  title: Broods API\n",
  "README.md": "# Support docs\n\nWhat the support agent reads.\n",
  "notes.txt": "TODO: add the refund policy.\n",
  "agent.ts":
    'import { defineAgent } from "broods";\n\nexport default defineAgent({ model: "claude-haiku-5-5" });\n',
};

const LOGO_URL = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="28" fill="#e8b04b"/></svg>',
)}`;

// A Convex rename has no optimistic update: the new row arrives with the query.
const RENAME_LATENCY_MS = 100;

export function WorkspaceFilesStandIn({
  canWrite,
}: {
  canWrite: boolean;
}): React.JSX.Element {
  const [files, setFiles] = useState(FILES);
  const [log, setLog] = useState<string[]>([]);
  const record = useCallback(
    (entry: string): void => setLog((prev) => [...prev, entry]),
    [],
  );
  const loadFile = useCallback(
    async (file: FileRecord): Promise<FileContent> =>
      file.path === "logo.svg"
        ? { kind: "image", url: LOGO_URL }
        : { kind: "text", text: CONTENTS[file.path] ?? "" },
    [],
  );
  const fileUrl = useCallback(
    async (file: FileRecord): Promise<string> => {
      record(`download ${file.path}`);

      return "about:blank";
    },
    [record],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-120 w-80 flex-col border border-border">
        <WorkspaceFilesView
          files={files}
          uploading={new Set()}
          error={null}
          canWrite={canWrite}
          onDismissError={() => {}}
          loadFile={loadFile}
          fileUrl={fileUrl}
          onUpload={async (entries) => {
            setFiles((prev) => [
              ...prev,
              ...entries.map(({ file, path }) => ({
                path: path,
                name: file.name,
                isFolder: false,
              })),
            ]);
            record(`upload ${entries.map(({ path }) => path).join(",")}`);
          }}
          onDelete={async (node) => {
            setFiles((prev) => withoutPath(prev, node.path));
            record(`delete ${node.path}`);
          }}
          onRename={async (node, newName) => {
            const newPath = renamedPath(node.path, newName);
            await new Promise((resolve) =>
              setTimeout(resolve, RENAME_LATENCY_MS),
            );
            // A name already taken is refused, the way the backend refuses it.
            if (files.some((f) => f.path === newPath)) {
              record(`refused ${node.path} ${newPath}`);

              return false;
            }
            setFiles((prev) => withRenamedPath(prev, node.path, newPath));
            record(`rename ${node.path} ${newPath}`);

            return true;
          }}
        />
      </div>
      <ol data-files-log className="text-2xs">
        {log.map((entry, index) => (
          <li key={index}>{entry}</li>
        ))}
      </ol>
    </div>
  );
}
