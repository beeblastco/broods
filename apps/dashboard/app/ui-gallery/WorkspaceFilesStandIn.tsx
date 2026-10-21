"use client";

/**
 * The workspace file explorer over an in-memory file list, once as a writer
 * and once as a member. The view is the real one; uploads, renames and deletes
 * change the list here and are written to `[data-files-log]` for a spec.
 */
import {
  WorkspaceFilesView,
  type FileRecord,
} from "@/app/components/side-panel/WorkspaceFilesTab";
import { useState } from "react";

const FILES: FileRecord[] = [
  { path: "docs", name: "docs", isFolder: true },
  { path: "docs/guide.md", name: "guide.md", isFolder: false, sizeBytes: 2048 },
  { path: "docs/api", name: "api", isFolder: true },
  { path: "docs/api/openapi.yaml", name: "openapi.yaml", isFolder: false },
  { path: "README.md", name: "README.md", isFolder: false, sizeBytes: 512 },
  { path: "notes.txt", name: "notes.txt", isFolder: false, sizeBytes: 64 },
];

export function WorkspaceFilesStandIn({
  canWrite,
}: {
  canWrite: boolean;
}): React.JSX.Element {
  const [files, setFiles] = useState(FILES);
  const [log, setLog] = useState<string[]>([]);
  const record = (entry: string): void => setLog((prev) => [...prev, entry]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-80 w-72 flex-col border border-border">
        <WorkspaceFilesView
          files={files}
          uploading={new Set()}
          error={null}
          canWrite={canWrite}
          onDismissError={() => {}}
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
            setFiles((prev) =>
              prev.filter(
                (f) =>
                  f.path !== node.path && !f.path.startsWith(`${node.path}/`),
              ),
            );
            record(`delete ${node.path}`);
          }}
          onRename={async (node, newName) => {
            const slash = node.path.lastIndexOf("/");
            const newPath =
              slash === -1
                ? newName
                : `${node.path.slice(0, slash)}/${newName}`;
            setFiles((prev) =>
              prev.map((f) =>
                f.path === node.path
                  ? { ...f, path: newPath, name: newName }
                  : f,
              ),
            );
            record(`rename ${node.path} ${newPath}`);
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
