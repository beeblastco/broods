"use client";

import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { RepoPicker, type RepoChoice } from "@/app/components/RepoPicker";
import { Section } from "@/app/components/Section";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { useSubmit } from "@/app/hooks/useSubmit";
import { resolveCoreEndpoint } from "@/app/lib/coreEndpoint";
import { formatDateTime } from "@/app/lib/formatTime";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";

type GitStatus = FunctionReturnType<typeof api.github.status>;

type Deploy = GitStatus["deploys"][number];

/**
 * The project's GitHub repo: link one (Broods commits a workflow and a key
 * per stage, so a push deploys), or see the linked repo, each branch's
 * latest deploy, and unlink.
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

  return <LinkRepo projectId={projectId} />;
}

function LinkedRepo({
  projectId,
  status,
}: {
  projectId: Id<"projects">;
  status: GitStatus;
}): React.JSX.Element | null {
  const unlink = useMutation(api.github.unlinkRepo);
  const submit = useSubmit();
  const [confirming, setConfirming] = useState(false);
  const repo = status.repo;
  if (!repo) return null;
  const branches = [
    ...(repo.productionBranch
      ? [{ stage: "Production", branch: repo.productionBranch }]
      : []),
    ...(repo.developmentBranch
      ? [{ stage: "Development", branch: repo.developmentBranch }]
      : []),
  ];

  async function handleUnlink(): Promise<void> {
    if (await submit.run(() => unlink({ projectId: projectId }))) {
      setConfirming(false);
    }
  }

  return (
    <Section
      title="Git"
      description="A push to a mapped branch deploys its stage from your GitHub Actions."
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
        {branches.map(({ stage, branch }) => (
          <BranchRow
            key={stage}
            stage={stage}
            branch={branch}
            deploy={status.deploys.find((entry) => entry.branch === branch)}
          />
        ))}
      </dl>
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
      {status.canLink && (
        <div>
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

function BranchRow({
  stage,
  branch,
  deploy,
}: {
  stage: string;
  branch: string;
  deploy: Deploy | undefined;
}): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{stage}</dt>
      <dd className="flex min-w-0 items-center gap-2">
        <span className="font-mono text-xs">{branch}</span>
        {deploy ? (
          <a
            href={deploy.url}
            target="_blank"
            rel="noreferrer"
            className="cursor-pointer truncate text-xs text-muted-foreground hover:underline"
          >
            <DeployWord deploy={deploy} /> {deploy.sha.slice(0, 7)} ·{" "}
            {formatDateTime(deploy.updatedAt)}
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">No deploy yet</span>
        )}
      </dd>
    </>
  );
}

function LinkRepo({
  projectId,
}: {
  projectId: Id<"projects">;
}): React.JSX.Element {
  const linkRepo = useAction(api.github.linkRepo);
  const submit = useSubmit();
  const [choice, setChoice] = useState<RepoChoice | null>(null);
  // Empty lets the server pick: dev, or development where dev is the default branch.
  const [developmentBranch, setDevelopmentBranch] = useState("");
  const endpoint = resolveCoreEndpoint();

  async function handleLink(): Promise<void> {
    if (!choice || !endpoint.ok) return;
    await submit.run(() =>
      linkRepo({
        projectId: projectId,
        target: {
          installationId: choice.installationId,
          repoId: choice.repoId,
          rootDirectory: choice.rootDirectory,
          baseUrl: endpoint.httpBaseUrl,
          developmentBranch: developmentBranch || undefined,
        },
      }),
    );
  }

  return (
    <Section
      title="Git"
      description="Link a GitHub repo. Broods commits a deploy workflow and a key per stage, so the default branch deploys Production and the development branch deploys Development."
    >
      <div className="grid gap-3">
        <RepoPicker projectId={projectId} value={choice} onChange={setChoice} />
        {choice && (
          <div className="grid gap-1">
            <Label htmlFor="git-dev-branch" variant="muted" className="text-xs">
              Development branch
            </Label>
            <Input
              id="git-dev-branch"
              value={developmentBranch}
              placeholder="Default"
              onChange={(event) => setDevelopmentBranch(event.target.value)}
            />
          </div>
        )}
        {!endpoint.ok && (
          <p className="text-xs text-destructive">{endpoint.message}</p>
        )}
        {choice && (
          <div>
            <Button
              size="sm"
              className={
                submit.pending ? "cursor-not-allowed" : "cursor-pointer"
              }
              disabled={submit.pending || !endpoint.ok}
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
