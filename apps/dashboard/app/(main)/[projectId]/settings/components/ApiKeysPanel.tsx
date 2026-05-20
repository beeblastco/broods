"use client";

/** API Keys panel: generate, view, and revoke project API keys. */
import { Button } from "@/app/components/ui/button";
import { Badge } from "@/app/components/ui/badge";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/app/components/ui/dialog";
import type { Id } from "@/convex/_generated/dataModel";
import { Copy, Eye, EyeOff, Key, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

interface Props {
    /** Project this settings panel belongs to. */
    projectId: Id<"projects">;
}

function generateSecret() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function ApiKeysPanel({ projectId: _projectId }: Props) {
    const [apiKeys, setApiKeys] = useState<Array<{ id: string; name: string; key: string; createdAt: string }>>([]);
    const [showKey, setShowKey] = useState<string | null>(null);
    const [newKeyName, setNewKeyName] = useState("");
    const [showNewKeyDialog, setShowNewKeyDialog] = useState(false);
    const [generatedKey, setGeneratedKey] = useState("");

    function handleGenerateApiKey() {
        const newKey = `cherry_coke_prod_sk_${generateSecret()}`;
        setGeneratedKey(newKey);
        setApiKeys((prev) => [
            ...prev,
            { id: Date.now().toString(), name: newKeyName || "New Key", key: newKey, createdAt: new Date().toISOString().split("T")[0] },
        ]);
        setNewKeyName("");
        setShowNewKeyDialog(true);
    }

    function handleDeleteApiKey(id: string) {
        setApiKeys((prev) => prev.filter((k) => k.id !== id));
    }

    function copyToClipboard(text: string) {
        navigator.clipboard.writeText(text);
    }

    return (
        <>
            <div className="grid gap-4">
                {apiKeys.length === 0 && (
                    <div className="rounded-lg border border-border bg-card px-4 py-8 text-center">
                        <Key className="size-8 mx-auto mb-2 text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">No API keys yet. Generate one to get started.</p>
                    </div>
                )}
                {apiKeys.map((apiKey) => (
                    <div key={apiKey.id} className="rounded-lg border border-border bg-card px-4 py-3">
                        <div className="flex items-center gap-3">
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium text-foreground">{apiKey.name}</span>
                                    <Badge variant="secondary" className="text-xs">Active</Badge>
                                </div>
                                <div className="flex items-center gap-1.5 mt-1">
                                    <code className="font-mono text-xs text-muted-foreground truncate">
                                        {showKey === apiKey.id ? apiKey.key : apiKey.key.replace(/.(?=.{4})/g, "•")}
                                    </code>
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        className="cursor-pointer text-muted-foreground hover:text-foreground"
                                        onClick={() => setShowKey(showKey === apiKey.id ? null : apiKey.id)}
                                    >
                                        {showKey === apiKey.id ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        className="cursor-pointer text-muted-foreground hover:text-foreground"
                                        onClick={() => copyToClipboard(apiKey.key)}
                                    >
                                        <Copy className="size-3.5" />
                                    </Button>
                                </div>
                                <span className="text-xs text-muted-foreground">Created {apiKey.createdAt}</span>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon-xs"
                                className="cursor-pointer text-muted-foreground transition-colors hover:text-destructive"
                                onClick={() => handleDeleteApiKey(apiKey.id)}
                            >
                                <Trash2 className="size-4" />
                            </Button>
                        </div>
                    </div>
                ))}
                <div className="flex items-center gap-2">
                    <Input
                        value={newKeyName}
                        onChange={(e) => setNewKeyName(e.target.value)}
                        placeholder="Key name (e.g., Production)"
                        className="flex-1"
                    />
                    <Button size="sm" className="cursor-pointer" onClick={handleGenerateApiKey}>
                        <Plus className="size-4 mr-1" />
                        Generate Key
                    </Button>
                </div>
            </div>

            <Dialog
                open={showNewKeyDialog}
                onOpenChange={(open) => {
                    if (!open) {
                        setShowNewKeyDialog(false);
                        setGeneratedKey("");
                    }
                }}
            >
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>API Key Generated</DialogTitle>
                        <DialogDescription asChild>
                            <div className="grid gap-3 text-sm text-muted-foreground">
                                <p>Your new API key has been generated. Copy it now &mdash; you won&apos;t be able to see it again.</p>
                            </div>
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-3 py-2">
                        <Label htmlFor="new-api-key" className="grid gap-1">
                            <span>Your API Key</span>
                            <code className="font-mono text-sm bg-muted px-3 py-2 rounded-md break-all block">{generatedKey}</code>
                        </Label>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" className="cursor-pointer" onClick={() => copyToClipboard(generatedKey)}>
                            <Copy className="size-4 mr-1" />Copy Key
                        </Button>
                        <Button className="cursor-pointer" onClick={() => { setShowNewKeyDialog(false); setGeneratedKey(""); }}>
                            Done
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
