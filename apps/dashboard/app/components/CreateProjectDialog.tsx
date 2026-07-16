"use client";

/** Reusable dialog for creating a new project with a random name pre-filled. */
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
import { api } from "@broods/convex/_generated/api";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** Generate a random project name like "bold-panda-427". */
export async function randomProjectName(): Promise<string> {
    // Load the name dictionaries only when the dialog is opened.
    const { uniqueNamesGenerator, adjectives, animals, NumberDictionary } = await import(
        "unique-names-generator"
    );
    const numberDict = NumberDictionary.generate({ min: 100, max: 999 });

    return uniqueNamesGenerator({
        dictionaries: [adjectives, animals, numberDict],
        separator: "-",
        length: 3,
    });
}

/**
 * Dialog that creates a new project and navigates to its Development canvas on
 * success. Initializing Production is left to the environment selector, since a
 * project this new has no Development configuration to copy into it.
 */
export function CreateProjectDialog({
    open,
    onOpenChange,
    description = "Give your new project a name to get started.",
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    description?: string;
}) {
    const createProject = useMutation(api.project.create);
    const router = useRouter();
    const [name, setName] = useState("");
    const [isCreating, setIsCreating] = useState(false);

    useEffect(() => {
        if (!open) return;

        let isCancelled = false;

        randomProjectName()
            .then((generatedName) => {
                if (!isCancelled) {
                    setName(generatedName);
                }
            })
            .catch(() => {
                if (!isCancelled) {
                    setName("new-project");
                }
            });

        return () => {
            isCancelled = true;
        };
    }, [open]);

    function handleOpenChange(next: boolean) {
        if (!next) setName("");
        onOpenChange(next);
    }

    async function handleCreate() {
        if (!name.trim()) return;
        setIsCreating(true);
        try {
            const id = await createProject({ name: name.trim(), description: undefined });
            handleOpenChange(false);
            router.push(`/${id}`);
        } finally {
            setIsCreating(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-sm">
                <DialogHeader>
                    <DialogTitle>Create Project</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        handleCreate();
                    }}
                >
                    <div className="grid gap-3 py-4">
                        <Label htmlFor="create-project-name">Project name</Label>
                        <Input
                            id="create-project-name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            autoFocus
                        />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" className="cursor-pointer" onClick={() => handleOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" className="cursor-pointer disabled:cursor-not-allowed" disabled={!name.trim() || isCreating}>
                            {isCreating ? "Creating..." : "Create"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
