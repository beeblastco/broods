"use client";

import { RepoPicker, type RepoChoice } from "@/app/components/RepoPicker";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { Switch } from "@/app/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/app/components/ui/tabs";
import { resolveCoreEndpoint } from "@/app/lib/coreEndpoint";
import { markProjectCreated } from "@/app/lib/createdProject";
import { toErrorMessage } from "@/app/lib/errors";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { analytics } from "@/app/lib/analytics";
import { useEffect, useState } from "react";

/** Generate a random project name like "bold-panda-427". */
export async function randomProjectName(): Promise<string> {
  // Load the name dictionaries only when the dialog is opened.
  const { uniqueNamesGenerator, adjectives, animals, NumberDictionary } =
    await import("unique-names-generator");
  const numberDict = NumberDictionary.generate({ min: 100, max: 999 });

  return uniqueNamesGenerator({
    dictionaries: [adjectives, animals, numberDict],
    separator: "-",
    length: 3,
  });
}

/** How a new project starts: empty, from an existing repo, or with a new repo. */
type Source = "empty" | "import" | "new";

/**
 * Dialog that creates a new project, Railway-style: empty, imported from a
 * GitHub repo (linked so a push deploys), or with a new repo Broods creates
 * through GitHub. Empty lands on the Development canvas; a repo lands on the
 * project's Git settings. The GitHub starts show only when the deployment has
 * the GitHub App.
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
  description = "Name your new project.",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  description?: string;
}): React.JSX.Element {
  const createProject = useMutation(api.project.create);
  const beginGitHub = useMutation(api.github.begin);
  const linkRepo = useAction(api.github.linkRepo);
  const github = useQuery(api.github.status, open ? {} : "skip");
  const router = useRouter();
  const [source, setSource] = useState<Source>("empty");
  // The project a failed link or GitHub hop already made, reused on retry.
  const [createdId, setCreatedId] = useState<Id<"projects"> | null>(null);
  const [repo, setRepo] = useState<RepoChoice | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [isPrivate, setIsPrivate] = useState(true);
  const [name, setName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    let isCancelled = false;

    randomProjectName()
      .then((generatedName) => {
        // A repo picked before the name resolved keeps its name.
        if (!isCancelled) {
          setName((current) => current || generatedName);
        }
      })
      .catch(() => {
        if (!isCancelled) {
          setName((current) => current || "new-project");
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [open]);

  function handleOpenChange(next: boolean): void {
    if (!next) {
      setName("");
      setError(null);
      setSource("empty");
      setRepo(null);
      setCreatedId(null);
    }
    onOpenChange(next);
  }

  async function handleCreate(): Promise<void> {
    if (!name.trim()) return;
    setIsCreating(true);
    setError(null);
    const endpoint = resolveCoreEndpoint();
    try {
      if (source !== "empty" && !endpoint.ok) throw new Error(endpoint.message);
      const id =
        createdId ??
        (await createProject({ name: name.trim(), description: undefined }));
      if (!createdId) {
        setCreatedId(id);
        void analytics.then((posthog): void => {
          posthog.capture("project_created", { source: source });
        });
        markProjectCreated(id);
      }
      const baseUrl = endpoint.ok ? endpoint.httpBaseUrl : "";
      if (source === "new" && owner) {
        // GitHub signs the user in, then the callback creates and links the repo.
        const { url } = await beginGitHub({
          createRepo: {
            projectId: id,
            owner: owner,
            name: name.trim(),
            private: isPrivate,
            baseUrl: baseUrl,
          },
        });
        window.location.assign(url);

        return;
      }
      if (source === "import" && repo) {
        await linkRepo({
          projectId: id,
          target: {
            installationId: repo.installationId,
            repoId: repo.repoId,
            rootDirectory: repo.rootDirectory.replace(/^\/+|\/+$/g, ""),
            baseUrl: baseUrl,
          },
        });
      }
      handleOpenChange(false);
      router.push(source === "empty" ? `/${id}` : `/${id}/settings?tab=git`);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setIsCreating(false);
    }
  }

  const owners = github?.installations ?? [];
  const ready =
    name.trim().length > 0 &&
    (source === "empty" ||
      (source === "import" && repo !== null) ||
      (source === "new" && owner !== null));

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleCreate();
          }}
        >
          <div className="grid gap-3 py-4">
            {github?.configured && (
              <Tabs
                value={source}
                onValueChange={(next) => setSource(next as Source)}
              >
                <TabsList className="w-full">
                  <TabsTrigger value="empty" className="cursor-pointer">
                    Empty
                  </TabsTrigger>
                  <TabsTrigger value="import" className="cursor-pointer">
                    Import repo
                  </TabsTrigger>
                  <TabsTrigger value="new" className="cursor-pointer">
                    New repo
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            )}
            {source === "import" && (
              <RepoPicker
                value={repo}
                onChange={(choice) => {
                  setRepo(choice);
                  const repoName = choice?.fullName.split("/")[1];
                  if (repoName && choice?.repoId !== repo?.repoId) {
                    setName(repoName);
                  }
                }}
              />
            )}
            <Label htmlFor="create-project-name">
              {source === "new" ? "Project and repo name" : "Project name"}
            </Label>
            <Input
              id="create-project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              // A retry reuses the project already made under this name.
              disabled={createdId !== null}
              autoFocus
            />
            {source === "new" && (
              <NewRepoFields
                owners={owners.map((installation) => installation.login)}
                owner={owner}
                onOwnerChange={setOwner}
                isPrivate={isPrivate}
                onPrivateChange={setIsPrivate}
              />
            )}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className="cursor-pointer"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="cursor-pointer"
              disabled={!ready || isCreating}
            >
              {isCreating
                ? "Creating..."
                : source === "new"
                  ? "Create on GitHub"
                  : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Where the new repo goes and whether it is private.
function NewRepoFields({
  owners,
  owner,
  onOwnerChange,
  isPrivate,
  onPrivateChange,
}: {
  owners: string[];
  owner: string | null;
  onOwnerChange: (owner: string) => void;
  isPrivate: boolean;
  onPrivateChange: (isPrivate: boolean) => void;
}): React.JSX.Element {
  // No account yet: the picker shows Connect GitHub (or who to ask).
  if (owners.length === 0) {
    return <RepoPicker value={null} onChange={() => undefined} />;
  }

  return (
    <>
      <Label htmlFor="create-project-owner">GitHub owner</Label>
      <Select
        items={owners.map((login) => ({ value: login, label: login }))}
        value={owner}
        onValueChange={(next) => {
          if (next !== null) onOwnerChange(next);
        }}
      >
        <SelectTrigger
          id="create-project-owner"
          className="w-full cursor-pointer"
        >
          <SelectValue placeholder="Pick an account" />
        </SelectTrigger>
        <SelectContent>
          {owners.map((login) => (
            <SelectItem key={login} value={login} className="cursor-pointer">
              {login}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex items-center gap-2">
        <Switch
          id="create-project-private"
          checked={isPrivate}
          onCheckedChange={onPrivateChange}
          className="cursor-pointer"
        />
        <Label htmlFor="create-project-private">Private repository</Label>
      </div>
    </>
  );
}
