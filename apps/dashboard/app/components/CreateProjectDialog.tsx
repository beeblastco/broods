"use client";

/** Reusable dialog for creating a new project with a random name pre-filled. */
import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { uniqueNamesGenerator, adjectives, animals, NumberDictionary } from "unique-names-generator";
import { Button } from "@/app/components/ui/button";
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

const numberDict = NumberDictionary.generate({ min: 100, max: 999 });

/** Generate a random project name like "bold-panda-427". */
export function randomProjectName(): string {
    return uniqueNamesGenerator({
        dictionaries: [adjectives, animals, numberDict],
        separator: "-",
        length: 3,
    });
}

/** Dialog that creates a new project and navigates to it on success. */
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
        if (open) setName(randomProjectName());
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
                        <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!name.trim() || isCreating}>
                            {isCreating ? "Creating..." : "Create"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
