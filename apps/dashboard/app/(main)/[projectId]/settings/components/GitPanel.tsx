"use client";

import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { RepoPicker, type RepoChoice } from "@/app/components/RepoPicker";
import { Section } from "@/app/components/Section";
import { Button } from "@/app/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import { useSubmit } from "@/app/hooks/useSubmit";
import { resolveCoreEndpoint } from "@/app/lib/coreEndpoint";
import { formatDateTime } from "@/app/lib/formatTime";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useState } from "react";

// `~` cannot appear in a git ref, so no branch is ever named this.
const OFF = "~off";

const STAGES = [
  { key: "development", label: "Development" },
  { key: "production", label: "Production" },
] as const;

type GitStatus = FunctionReturnType<typeof api.github.status>;

type Deploy = GitStatus["deploys"][number];

/** Each stage's branch, or `OFF` when no push deploys it. */
type Mapping = Record<(typeof STAGES)[number]["key"], string>;

/**
 * The project's GitHub repo: link one and pick which branch deploys each
 * stage (Broods commits the workflow and a key per stage), then change those
 * branches, see each one's latest deploy, or unlink.
 */
export function GitPanel({
  projectId,
}: {
  projectId: Id<"projects">;
}): React.JSX.Element {
  const status = useQuery(api.github.status, { projectId: projectId });

  if (status === undefined) {
    return (
      <Section title="Git">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </Section>
    );
  }
  // A linked project keeps its details and Unlink even if the App is later removed.
  if (status.repo) return <LinkedRepo projectId={projectId} status={status} />;
  if (!status.configured) {
    return (
      <Section title="Git">
        <p className="text-sm text-muted-foreground">
          GitHub is not set up on this Broods deployment.
        </p>
      </Section>
    );
  }

  return <LinkRepo projectId={projectId} status={status} />;
}

function LinkedRepo({
  projectId,
  status,
}: {
  projectId: Id<"projects">;
  status: GitStatus;
}): React.JSX.Element | null {
  const unlink = useMutation(api.github.unlinkRepo);
  const linkRepo = useAction(api.github.linkRepo);
  const submit = useSubmit();
  const [confirming, setConfirming] = useState(false);
  const branches = useRepoBranches(projectId, status);
  const [edited, setEdited] = useState<Mapping | null>(null);
  const repo = status.repo;
  const current = linkedMapping(repo);
  const mapping = edited ?? current;
  const changed =
    mapping.development !== current.development ||
    mapping.production !== current.production;
  const endpoint = resolveCoreEndpoint();

  if (!repo) return null;

  async function handleSave(): Promise<void> {
    if (!repo || !endpoint.ok) return;
    const saved = await submit.run(() =>
      linkRepo({
        projectId: projectId,
        target: {
          installationId: repo.installationId,
          repoId: repo.repoId,
          rootDirectory: repo.rootDirectory,
          baseUrl: endpoint.httpBaseUrl,
          ...targetBranches(mapping),
        },
      }),
    );
    if (saved) setEdited(null);
  }

  async function handleUnlink(): Promise<void> {
    if (await submit.run(() => unlink({ projectId: projectId }))) {
      setConfirming(false);
    }
  }

  return (
    <Section
      title="Git"
      description="A push to a stage's branch deploys it from your GitHub Actions."
    >
      <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Repository</dt>
        <dd>
          <a
            href={`${status.webUrl ?? "https://github.com"}/${repo.fullName}`}
            target="_blank"
            rel="noreferrer"
            className="cursor-pointer underline-offset-2 hover:underline"
          >
            {repo.fullName}
          </a>
        </dd>
        <dt className="text-muted-foreground">Folder</dt>
        <dd className="font-mono text-xs">{repo.rootDirectory || "/"}</dd>
      </dl>
      <StageBranches
        branches={branches ?? []}
        mapping={mapping}
        onChange={setEdited}
        disabled={!status.canLink || branches === null || submit.pending}
        deploys={status.deploys}
        saved={current}
      />
      <LinkNotices repo={repo} />
      <MappingProblem mapping={mapping} />
      {status.canLink && (
        <div className="flex gap-2">
          {changed && (
            <Button
              size="sm"
              className={
                submit.pending ? "cursor-not-allowed" : "cursor-pointer"
              }
              disabled={
                submit.pending ||
                !endpoint.ok ||
                mappingProblem(mapping) !== null
              }
              onClick={() => void handleSave()}
            >
              {submit.pending ? "Saving..." : "Save"}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            tone="muted-destructive"
            className="cursor-pointer"
            onClick={() => setConfirming(true)}
          >
            Unlink repository
          </Button>
        </div>
      )}
      {submit.error && (
        <p className="text-xs text-destructive">{submit.error}</p>
      )}
      {confirming && (
        <DeleteConfirmDialog
          open={true}
          onOpenChange={setConfirming}
          resourceName={repo.fullName}
          resourceType="repository link"
          verb="Unlink"
          critical={false}
          onConfirm={handleUnlink}
          isDeleting={submit.pending}
        />
      )}
    </Section>
  );
}

function LinkRepo({
  projectId,
  status,
}: {
  projectId: Id<"projects">;
  status: GitStatus;
}): React.JSX.Element {
  const linkRepo = useAction(api.github.linkRepo);
  const submit = useSubmit();
  const [choice, setChoice] = useState<RepoChoice | null>(null);
  // Edits belong to the repo they were made for; another pick starts from its defaults.
  const [edited, setEdited] = useState<{
    repoId: number;
    mapping: Mapping;
  } | null>(null);
  const endpoint = resolveCoreEndpoint();
  const mapping =
    choice && edited?.repoId === choice.repoId
      ? edited.mapping
      : choice
        ? defaultMapping(choice.branches[0] ?? "main", status.hasProduction)
        : null;

  async function handleLink(): Promise<void> {
    if (!choice || !mapping || !endpoint.ok) return;
    await submit.run(() =>
      linkRepo({
        projectId: projectId,
        target: {
          installationId: choice.installationId,
          repoId: choice.repoId,
          rootDirectory: choice.rootDirectory,
          baseUrl: endpoint.httpBaseUrl,
          ...targetBranches(mapping),
        },
      }),
    );
  }

  return (
    <Section
      title="Git"
      description="Link a GitHub repo and pick the branch each stage deploys from. Broods commits a deploy workflow and a key per stage."
    >
      <div className="grid gap-3">
        <RepoPicker projectId={projectId} value={choice} onChange={setChoice} />
        {choice && mapping && (
          <StageBranches
            branches={choice.branches}
            mapping={mapping}
            onChange={(next) =>
              setEdited({ repoId: choice.repoId, mapping: next })
            }
            disabled={submit.pending}
          />
        )}
        {mapping && <MappingProblem mapping={mapping} />}
        {!endpoint.ok && (
          <p className="text-xs text-destructive">{endpoint.message}</p>
        )}
        {choice && mapping && (
          <div>
            <Button
              size="sm"
              className={
                submit.pending ? "cursor-not-allowed" : "cursor-pointer"
              }
              disabled={
                submit.pending ||
                !endpoint.ok ||
                mappingProblem(mapping) !== null
              }
              onClick={() => void handleLink()}
            >
              {submit.pending ? "Linking..." : "Link repository"}
            </Button>
          </div>
        )}
        {submit.error && (
          <p className="text-xs text-destructive">{submit.error}</p>
        )}
      </div>
    </Section>
  );
}

// What the link needs from the user: repo secrets any branch can read, or a setup PR to merge.
function LinkNotices({
  repo,
}: {
  repo: NonNullable<GitStatus["repo"]>;
}): React.JSX.Element {
  return (
    <>
      {!repo.protectedSecrets && (
        <p className="text-xs text-warning">
          This GitHub plan has no environments on private repos, so the deploy
          keys are repo secrets: anyone who can push a branch can read
          Production&apos;s.
        </p>
      )}
      {repo.setupPullRequestUrl && (
        <p className="text-xs text-warning">
          A branch is protected, so the deploy workflow waits in a{" "}
          <a
            href={repo.setupPullRequestUrl}
            target="_blank"
            rel="noreferrer"
            className="cursor-pointer underline"
          >
            pull request
          </a>
          . Merge it to deploy on push.
        </p>
      )}
    </>
  );
}

// One row per stage: its branch or Off, and with `deploys` the branch's latest run.
function StageBranches({
  branches,
  mapping,
  onChange,
  disabled,
  deploys,
  saved,
}: {
  branches: string[];
  mapping: Mapping;
  onChange: (mapping: Mapping) => void;
  disabled: boolean;
  deploys?: Deploy[];
  /** The mapping on GitHub now; a branch's runs show only under the stage it deploys. */
  saved?: Mapping;
}): React.JSX.Element {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Stage</TableHead>
          <TableHead>Branch</TableHead>
          {deploys && <TableHead>Last deploy</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {STAGES.map(({ key, label }) => {
          const branch = mapping[key];
          // Development may name a branch the link cuts, such as a new `dev`.
          const options = [
            ...new Set([
              ...branches,
              ...(branch === OFF ? [] : [branch]),
              ...(key === "development" ? ["dev"] : []),
            ]),
          ];
          const deploy =
            saved?.[key] === branch
              ? deploys?.find((entry) => entry.branch === branch)
              : undefined;

          return (
            <TableRow key={key}>
              <TableCell>{label}</TableCell>
              <TableCell>
                <Select
                  items={[
                    { value: OFF, label: "Off" },
                    ...options.map((name) => ({
                      value: name,
                      label: branches.includes(name) ? name : `${name} (new)`,
                    })),
                  ]}
                  value={branch}
                  onValueChange={(next) => {
                    if (next !== null) onChange({ ...mapping, [key]: next });
                  }}
                >
                  <SelectTrigger
                    aria-label={`${label} branch`}
                    className={`w-44 font-mono text-xs ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
                    disabled={disabled}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={OFF} className="cursor-pointer">
                      Off
                    </SelectItem>
                    {options.map((name) => (
                      <SelectItem
                        key={name}
                        value={name}
                        className="cursor-pointer font-mono text-xs"
                      >
                        {branches.includes(name) ? name : `${name} (new)`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TableCell>
              {deploys && (
                <TableCell>
                  <span className="text-xs text-muted-foreground">
                    {branch === OFF ? (
                      "Not deployed"
                    ) : deploy ? (
                      <a
                        href={deploy.url}
                        target="_blank"
                        rel="noreferrer"
                        className="cursor-pointer hover:underline"
                      >
                        <DeployWord deploy={deploy} /> {deploy.sha.slice(0, 7)}{" "}
                        · {formatDateTime(deploy.updatedAt)}
                      </a>
                    ) : (
                      "No deploy yet"
                    )}
                  </span>
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function MappingProblem({
  mapping,
}: {
  mapping: Mapping;
}): React.JSX.Element | null {
  const problem = mappingProblem(mapping);

  return problem ? <p className="text-xs text-destructive">{problem}</p> : null;
}

// A run in words: still deploying, deployed, or failed.
function DeployWord({ deploy }: { deploy: Deploy }): React.JSX.Element {
  if (deploy.status !== "completed") {
    return <span className="text-info">Deploying</span>;
  }

  return deploy.conclusion === "success" ? (
    <span className="text-success">Deployed</span>
  ) : (
    <span className="text-destructive">Failed</span>
  );
}

// The linked repo's branches for the pickers: null while they load, [] when GitHub cannot
// list them.
function useRepoBranches(
  projectId: Id<"projects">,
  status: GitStatus,
): string[] | null {
  const inspectRepo = useAction(api.github.inspectRepo);
  const [branches, setBranches] = useState<string[] | null>(null);
  const installationId = status.repo?.installationId;
  const repoId = status.repo?.repoId;
  // A save can cut a new branch, so the list reloads when the mapping changes.
  const mapped = `${status.repo?.productionBranch}|${status.repo?.developmentBranch}`;

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- fetches the repo's branches from GitHub
  useEffect(() => {
    if (installationId === undefined || repoId === undefined) return;
    if (!status.canLink) return;
    let cancelled = false;
    inspectRepo({
      projectId: projectId,
      installationId: installationId,
      repoId: repoId,
    })
      .then((inspected): void => {
        if (!cancelled) setBranches(inspected.branches);
      })
      .catch((): void => {
        if (!cancelled) setBranches([]);
      });

    return () => {
      cancelled = true;
    };
  }, [inspectRepo, installationId, mapped, projectId, repoId, status.canLink]);

  return branches;
}

// What a link deploys by default, as the server picks it: Production only when the project has it.
function defaultMapping(
  defaultBranch: string,
  hasProduction: boolean,
): Mapping {
  return hasProduction
    ? {
        development: defaultBranch === "dev" ? "development" : "dev",
        production: defaultBranch,
      }
    : { development: defaultBranch, production: OFF };
}

// The linked repo's branches as a mapping, Off for an unmapped stage.
function linkedMapping(repo: GitStatus["repo"]): Mapping {
  return {
    development: repo?.developmentBranch ?? OFF,
    production: repo?.productionBranch ?? OFF,
  };
}

// Why the mapping cannot be saved, or null.
function mappingProblem(mapping: Mapping): string | null {
  if (mapping.development === OFF && mapping.production === OFF) {
    return "Pick a branch for at least one stage.";
  }
  if (mapping.development === mapping.production) {
    return "Production and Development need different branches.";
  }

  return null;
}

// The link target's branch fields: a name, or null for a stage no push deploys.
function targetBranches(mapping: Mapping): {
  productionBranch: string | null;
  developmentBranch: string | null;
} {
  return {
    productionBranch: mapping.production === OFF ? null : mapping.production,
    developmentBranch: mapping.development === OFF ? null : mapping.development,
  };
}
