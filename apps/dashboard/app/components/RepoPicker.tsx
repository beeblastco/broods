"use client";

import { GitHubLogo } from "@/app/components/GitHubLogo";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { toErrorMessage } from "@/app/lib/errors";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useRef, useState } from "react";

type Repo = FunctionReturnType<typeof api.github.listRepos>[number];

type Root = FunctionReturnType<typeof api.github.inspectRepo>["roots"][number];

/** The repo and `broods/` folder a link deploys from. */
export interface RepoChoice {
  installationId: number;
  repoId: number;
  fullName: string;
  rootDirectory: string;
}

/**
 * Picks a repo from the org's GitHub accounts and the folder holding its
 * `broods/`, which Broods finds by scanning the default branch. Used by the
 * create dialog's Import tab and the project's Git settings.
 */
export function RepoPicker({
  projectId,
  value,
  onChange,
}: {
  /** Absent while the project is still being created. */
  projectId?: Id<"projects">;
  value: RepoChoice | null;
  onChange: (choice: RepoChoice | null) => void;
}): React.JSX.Element {
  const status = useQuery(api.github.status, { projectId: projectId });
  const listRepos = useAction(api.github.listRepos);
  const inspectRepo = useAction(api.github.inspectRepo);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [roots, setRoots] = useState<Root[] | null>(null);
  // The repo the select shows; `value` stays null until its scan lands.
  const [picked, setPicked] = useState<string | null>(
    value ? String(value.repoId) : null,
  );
  const latestPick = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const installationCount = status?.installations.length ?? 0;

  useEffect(() => {
    if (installationCount === 0) return;
    let cancelled = false;
    listRepos({ projectId: projectId })
      .then((list): void => {
        if (!cancelled) setRepos(list);
      })
      .catch((err: unknown): void => {
        if (!cancelled) setError(toErrorMessage(err));
      });

    return () => {
      cancelled = true;
    };
  }, [installationCount, listRepos, projectId]);

  // Publishes the choice only once its scan lands, and only for the latest pick.
  async function pickRepo(repoKey: string): Promise<void> {
    const repo = repos?.find((entry) => String(entry.repoId) === repoKey);
    if (!repo) return;
    const pick = ++latestPick.current;
    setPicked(repoKey);
    setRoots(null);
    setError(null);
    onChange(null);
    try {
      const inspected = await inspectRepo({
        projectId: projectId,
        installationId: repo.installationId,
        repoId: repo.repoId,
      });
      if (pick !== latestPick.current) return;
      setRoots(inspected.roots);
      onChange({
        installationId: repo.installationId,
        repoId: repo.repoId,
        fullName: repo.fullName,
        rootDirectory: inspected.roots[0]?.rootDirectory ?? "",
      });
    } catch (err) {
      if (pick === latestPick.current) setError(toErrorMessage(err));
    }
  }

  if (status === undefined) {
    return <p className="text-xs text-muted-foreground">Loading...</p>;
  }
  if (installationCount === 0) {
    return (
      <div className="grid gap-2">
        <p className="text-xs text-muted-foreground">
          Connect a GitHub account to import its repos.
        </p>
        <ConnectGitHubButton disabled={!status.canConnect} />
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Label htmlFor="repo-picker" variant="muted" className="text-xs">
          Repository
        </Label>
        <Select
          items={(repos ?? []).map((repo) => ({
            value: String(repo.repoId),
            label: repo.fullName,
          }))}
          value={picked}
          onValueChange={(next) => {
            if (next !== null) void pickRepo(next);
          }}
        >
          <SelectTrigger
            id="repo-picker"
            className="w-full cursor-pointer"
            disabled={repos === null}
          >
            <SelectValue
              placeholder={repos === null ? "Loading repos..." : "Pick a repo"}
            />
          </SelectTrigger>
          <SelectContent>
            {(repos ?? []).map((repo) => (
              <SelectItem
                key={repo.repoId}
                value={String(repo.repoId)}
                className="cursor-pointer"
              >
                {repo.fullName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {picked && roots === null && !error && (
        <p className="text-xs text-muted-foreground">Scanning for broods/...</p>
      )}
      {value && roots !== null && (
        <RootField value={value} roots={roots} onChange={onChange} />
      )}
      {status.canConnect && <ConnectGitHubButton label="Add GitHub account" />}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** Opens the Broods GitHub App's install page; GitHub returns to this page. */
export function ConnectGitHubButton({
  label = "Connect GitHub",
  disabled = false,
}: {
  label?: string;
  disabled?: boolean;
}): React.JSX.Element {
  const begin = useMutation(api.github.begin);
  const [error, setError] = useState<string | null>(null);

  async function connect(): Promise<void> {
    setError(null);
    try {
      const { url } = await begin({
        returnTo: `${window.location.pathname}${window.location.search}`,
      });
      window.location.assign(url);
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }

  return (
    <div className="grid justify-items-start gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={disabled ? "cursor-not-allowed" : "cursor-pointer"}
        disabled={disabled}
        onClick={() => void connect()}
      >
        <GitHubLogo className="size-3.5" />
        {label}
      </Button>
      {disabled && (
        <p className="text-xs text-muted-foreground">
          Ask an org admin to connect GitHub.
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

// The folder holding broods/: a pick between the folders the scan found, or typed when it found none or one.
function RootField({
  value,
  roots,
  onChange,
}: {
  value: RepoChoice;
  roots: Root[];
  onChange: (choice: RepoChoice) => void;
}): React.JSX.Element {
  return (
    <div className="grid gap-1">
      <Label htmlFor="repo-root" variant="muted" className="text-xs">
        Folder holding broods/
      </Label>
      {roots.length > 1 ? (
        <Select
          items={roots.map((root) => ({
            value: root.rootDirectory,
            label: root.rootDirectory || "/",
          }))}
          value={value.rootDirectory}
          onValueChange={(next) => {
            if (next !== null) onChange({ ...value, rootDirectory: next });
          }}
        >
          <SelectTrigger id="repo-root" className="w-full cursor-pointer">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {roots.map((root) => (
              <SelectItem
                key={root.rootDirectory}
                value={root.rootDirectory}
                className="cursor-pointer"
              >
                {root.rootDirectory || "/"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id="repo-root"
          value={value.rootDirectory}
          placeholder="/ (repo root)"
          onChange={(event) =>
            onChange({ ...value, rootDirectory: event.target.value })
          }
        />
      )}
      <p className="text-xs text-muted-foreground">
        {roots.length === 0
          ? "No broods/ found yet. Pushes deploy once one exists here."
          : `Found broods/ in ${roots.length === 1 ? roots[0]?.rootDirectory || "the repo root" : `${roots.length} folders`}.`}
      </p>
    </div>
  );
}
