"use client";

/** Dialog form for creating a new private agent configuration. */
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
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { useState } from "react";

type AgentProvider =
  | "openai"
  | "google"
  | "bedrock"
  | "anthropic"
  | "minimax"
  | "gateway"
  | "custom";

const providerOptions: Array<{
  value: AgentProvider;
  label: string;
  modelPlaceholder: string;
}> = [
  { value: "openai", label: "OpenAI", modelPlaceholder: "gpt-4.1-mini" },
  { value: "google", label: "Google", modelPlaceholder: "gemini-2.5-flash" },
  {
    value: "bedrock",
    label: "Bedrock",
    modelPlaceholder: "anthropic.claude-sonnet-4-5-20250929-v1:0",
  },
  {
    value: "anthropic",
    label: "Anthropic",
    modelPlaceholder: "claude-sonnet-4-5-20250929",
  },
  { value: "minimax", label: "MiniMax", modelPlaceholder: "MiniMax-M2.7" },
  {
    value: "gateway",
    label: "Gateway",
    modelPlaceholder: "openai/gpt-4.1-mini",
  },
  {
    value: "custom",
    label: "Custom OpenAI-compatible",
    modelPlaceholder: "gpt-oss-120b",
  },
];

export function CreateAgentConfigDialog({
  projectId,
  environmentId,
  open,
  onOpenChange,
  initialCanvasPosition,
}: {
  projectId: Id<"projects">;
  environmentId: Id<"environments"> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialCanvasPosition?: { x: number; y: number } | null;
}) {
  const createAgentConfig = useMutation(api.agentConfig.create);

  const [name, setName] = useState("");
  const [provider, setProvider] = useState<AgentProvider>("openai");
  const [modelId, setModelId] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  function resetForm() {
    setName("");
    setProvider("openai");
    setModelId("");
    setCustomBaseUrl("");
    setDescription("");
    setSystemPrompt("");
    setIsCreating(false);
  }

  function handleClose() {
    resetForm();
    onOpenChange(false);
  }

  async function handleCreate() {
    if (!name.trim() || !modelId.trim() || !environmentId) return;

    setIsCreating(true);
    try {
      await createAgentConfig({
        projectId: projectId,
        environmentId: environmentId,
        name: name.trim(),
        provider: provider,
        modelId: modelId.trim(),
        customBaseUrl: provider === "custom" ? customBaseUrl.trim() : undefined,
        description: description.trim() || undefined,
        systemPrompt: systemPrompt.trim() || undefined,
        position: initialCanvasPosition ?? undefined,
      });

      handleClose();
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          resetForm();
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Agent Config</DialogTitle>
          <DialogDescription>
            Configure a new AI agent for your project.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
        >
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="agent-name">Name</Label>
              <Input
                id="agent-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="My Agent"
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="agent-provider">Provider</Label>
              <Select
                value={provider}
                onValueChange={(value) => setProvider(value as AgentProvider)}
              >
                <SelectTrigger id="agent-provider" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {providerOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="agent-model">Model ID</Label>
              <Input
                id="agent-model"
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                placeholder={
                  providerOptions.find((option) => option.value === provider)
                    ?.modelPlaceholder ?? "gpt-4.1-mini"
                }
              />
            </div>
            {provider === "custom" && (
              <div className="grid gap-2">
                <Label htmlFor="agent-base-url">Base URL</Label>
                <Input
                  id="agent-base-url"
                  value={customBaseUrl}
                  onChange={(event) => setCustomBaseUrl(event.target.value)}
                  placeholder="https://api.example.com/v1"
                />
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Agents are private by default. Enable public access later in the
              Details tab when you are ready to deploy.
            </p>
            <div className="grid gap-2">
              <Label htmlFor="agent-description">Description (optional)</Label>
              <Input
                id="agent-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What does this agent do?"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="agent-prompt">System Prompt (optional)</Label>
              <Input
                id="agent-prompt"
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                placeholder="You are a helpful assistant..."
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                !name.trim() ||
                !modelId.trim() ||
                !environmentId ||
                (provider === "custom" && !customBaseUrl.trim()) ||
                isCreating
              }
            >
              {isCreating ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
