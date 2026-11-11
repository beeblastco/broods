"use client";

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
import { Textarea } from "@/app/components/ui/textarea";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { useNow } from "@/app/hooks/useNow";
import { analytics } from "@/app/lib/analytics";
import { nextFireAt } from "@/app/lib/cronSchedule";
import { NOT_BLANK } from "@/app/lib/notBlank";
import { useId, useMemo, useRef, useState } from "react";
import { toErrorMessage } from "@/app/lib/errors";

const SCHEDULE_PATTERN = "\\s*(cron|rate|at)\\(.+\\)\\s*";
const SCHEDULE_REGEX = new RegExp(`^${SCHEDULE_PATTERN}$`);
const TIME_ZONES = Intl.supportedValuesOf("timeZone");
const NEXT_RUN: Intl.DateTimeFormatOptions = {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZoneName: "short",
};

const PRESETS: Array<{ label: string; value: string }> = [
  { label: "Every hour", value: "rate(1 hour)" },
  { label: "Every day at 9 AM UTC", value: "cron(0 9 * * ? *)" },
  { label: "Every Monday 09:00", value: "cron(0 9 ? * MON *)" },
  { label: "Every 15 minutes", value: "rate(15 minutes)" },
];

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  paused: "Paused",
};

type Mode = "create" | "edit";

interface Props {
  mode: Mode;
  cron?: Doc<"crons">;
  agents: Array<Pick<Doc<"agents">, "_id" | "name">>;
  onClose: () => void;
}

export function CronDialog({
  mode,
  cron,
  agents,
  onClose,
}: Props): React.JSX.Element {
  const create = useMutation(api.agent.cronsPublic.create);
  const update = useMutation(api.agent.cronsPublic.update);

  const [name, setName] = useState(cron?.name ?? "");
  const [description, setDescription] = useState(cron?.description ?? "");
  const [agentId, setAgentId] = useState<string>(
    cron?.agentId ?? agents[0]?._id ?? "",
  );
  const [storedPrompt] = useState(() => eventsToText(cron?.events));
  const [prompt, setPrompt] = useState(storedPrompt);
  const [conversationKey, setConversationKey] = useState(
    cron?.conversationKey ?? "",
  );
  const [scheduleExpression, setScheduleExpression] = useState(
    cron?.scheduleExpression ?? "",
  );
  const [timezone, setTimezone] = useState(cron?.timezone ?? "UTC");
  const [status, setStatus] = useState<"active" | "paused">(
    cron?.status ?? "active",
  );

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scheduleTouched, setScheduleTouched] = useState(false);
  const [timezoneTouched, setTimezoneTouched] = useState(false);
  const submittingRef = useRef(false);
  const timezoneRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();
  const now = useNow();

  const scheduleValid = SCHEDULE_REGEX.test(scheduleExpression.trim());
  // A zone the runtime cannot format is one the server rejects too.
  const zoneFormat = useMemo((): Intl.DateTimeFormat | null => {
    try {
      return new Intl.DateTimeFormat([], {
        ...NEXT_RUN,
        timeZone: timezone.trim() || "UTC",
      });
    } catch {
      return null;
    }
  }, [timezone]);
  const nextRun =
    scheduleValid && zoneFormat
      ? nextFireAt(
          {
            scheduleExpression: scheduleExpression.trim(),
            timezone: timezone.trim() || undefined,
            status: status,
            lastInvokedAt: cron?.lastInvokedAt,
            createdAt: cron?.createdAt ?? now,
          },
          now,
        )
      : null;
  const showScheduleError = scheduleTouched && !scheduleValid;
  const showTimezoneError = timezoneTouched && zoneFormat === null;
  // An untouched prompt keeps the stored events, which can hold images or several messages.
  const input =
    cron && prompt.trim() === storedPrompt.trim() ? undefined : prompt.trim();
  const canSubmit =
    name.trim().length > 0 &&
    agentId.length > 0 &&
    input !== "" &&
    timezone.trim().length > 0 &&
    scheduleValid &&
    !pending;

  async function handleSubmit(): Promise<void> {
    if (zoneFormat === null) {
      setTimezoneTouched(true);
      timezoneRef.current?.focus();

      return;
    }
    // A textarea takes no `pattern`, so a blank prompt is refused here, the same native way.
    if (input === "") {
      promptRef.current?.setCustomValidity("Write what the agent should do.");
      promptRef.current?.reportValidity();

      return;
    }
    if (!canSubmit) return;
    // `pending` lands a render late; the ref stops a fast double click double-creating.
    if (submittingRef.current) return;

    submittingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        agentId: agentId as Id<"agents">,
        conversationKey: conversationKey.trim() || undefined,
        scheduleExpression: scheduleExpression.trim(),
        timezone: timezoneToSave(cron?.timezone, timezone),
        status: status,
        description: description.trim() || undefined,
      };
      if (mode === "create") {
        await create({ ...payload, input: prompt.trim() });
      } else if (cron) {
        await update({
          cronId: cron._id,
          input: input,
          ...payload,
          conversationKey: conversationKey.trim() || null,
          description: description.trim() || null,
        });
      }
      void analytics.then((posthog): void => {
        posthog.capture(
          mode === "create" ? "scheduler_created" : "scheduler_updated",
          {
            schedule_type: scheduleExpression.trim().split("(", 1)[0],
            status: status,
            has_conversation_key: Boolean(conversationKey.trim()),
          },
        );
      });
      onClose();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      submittingRef.current = false;
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "New scheduler" : "Edit scheduler"}
          </DialogTitle>
          <DialogDescription>
            Runs an agent on a recurring schedule.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <div className="grid gap-3 py-2">
            <div className="grid gap-1">
              <Label htmlFor="cj-name" variant="muted" className="text-xs">
                Name{" "}
                <span aria-hidden="true" className="text-destructive">
                  *
                </span>
              </Label>
              <Input
                id="cj-name"
                required={true}
                pattern={NOT_BLANK}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Daily summary"
              />
            </div>

            <div className="grid gap-1">
              <Label
                htmlFor="cj-description"
                variant="muted"
                className="text-xs"
              >
                Description
              </Label>
              <Input
                id="cj-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional"
              />
            </div>

            <div className="grid gap-1">
              <Label htmlFor="cj-agent" variant="muted" className="text-xs">
                Agent
              </Label>
              {agents.length === 0 ? (
                <p className="text-xs text-destructive">
                  No agents available. Create one before scheduling jobs.
                </p>
              ) : (
                <Select
                  items={agents.map((agent) => ({
                    label: agent.name,
                    value: agent._id,
                  }))}
                  value={agentId}
                  onValueChange={(value) => {
                    if (value !== null) {
                      setAgentId(value);
                    }
                  }}
                >
                  <SelectTrigger
                    id="cj-agent"
                    className="w-full cursor-pointer"
                  >
                    <SelectValue placeholder="Pick an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map((agent) => (
                      <SelectItem
                        key={agent._id}
                        value={agent._id}
                        className="cursor-pointer"
                      >
                        {agent.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="grid gap-1">
              <Label htmlFor="cj-prompt" variant="muted" className="text-xs">
                Prompt{" "}
                <span aria-hidden="true" className="text-destructive">
                  *
                </span>
              </Label>
              <Textarea
                id="cj-prompt"
                // Untouched, an edit keeps stored events that may hold no text.
                required={!cron || storedPrompt.trim() !== ""}
                ref={promptRef}
                value={prompt}
                onChange={(e) => {
                  e.target.setCustomValidity("");
                  setPrompt(e.target.value);
                }}
                placeholder="What should the agent do on each invocation?"
                rows={3}
              />
            </div>

            <div className="grid gap-1">
              <Label htmlFor="cj-conv" variant="muted" className="text-xs">
                Conversation key (optional)
              </Label>
              <Input
                id="cj-conv"
                value={conversationKey}
                onChange={(e) => setConversationKey(e.target.value)}
                placeholder="Reuse a conversation across runs"
              />
            </div>

            <div className="grid gap-1">
              <Label htmlFor="cj-schedule" variant="muted" className="text-xs">
                Schedule expression{" "}
                <span aria-hidden="true" className="text-destructive">
                  *
                </span>
              </Label>
              <Input
                id="cj-schedule"
                required={true}
                pattern={SCHEDULE_PATTERN}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                aria-invalid={showScheduleError}
                aria-describedby={
                  showScheduleError ? `${fieldId}-schedule-error` : undefined
                }
                value={scheduleExpression}
                onChange={(e) => setScheduleExpression(e.target.value)}
                onBlur={() => {
                  if (scheduleExpression !== "") setScheduleTouched(true);
                }}
                onInvalid={() => setScheduleTouched(true)}
                placeholder="rate(1 hour) or cron(0 9 * * ? *)"
                className="font-mono text-xs"
              />
              <div className="flex flex-wrap gap-1.5 pt-1">
                {PRESETS.map((preset) => (
                  <Button
                    key={preset.value}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs cursor-pointer"
                    onClick={() => setScheduleExpression(preset.value)}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
              {showScheduleError && (
                <p
                  id={`${fieldId}-schedule-error`}
                  className="text-xs text-destructive"
                >
                  Must match cron(...), rate(...), or at(...).
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1">
                <Label htmlFor="cj-tz" variant="muted" className="text-xs">
                  Timezone{" "}
                  <span aria-hidden="true" className="text-destructive">
                    *
                  </span>
                </Label>
                <Input
                  ref={timezoneRef}
                  id="cj-tz"
                  list={`${fieldId}-zones`}
                  required={true}
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                  aria-invalid={showTimezoneError}
                  aria-describedby={`${fieldId}-tz-hint`}
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  onBlur={() => setTimezoneTouched(true)}
                  placeholder="UTC"
                />
                <datalist id={`${fieldId}-zones`}>
                  {TIME_ZONES.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </datalist>
                <p
                  id={`${fieldId}-tz-hint`}
                  className={cn(
                    "text-xs",
                    showTimezoneError
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {showTimezoneError
                    ? "Unknown timezone. Pick one from the list."
                    : status === "active" && nextRun !== null && zoneFormat
                      ? `Next run ${zoneFormat.format(nextRun)}`
                      : null}
                </p>
              </div>

              <div className="grid gap-1">
                <Label htmlFor="cj-status" variant="muted" className="text-xs">
                  Status
                </Label>
                <Select
                  items={STATUS_LABELS}
                  value={status}
                  onValueChange={(v) => {
                    if (v === null) return;
                    setStatus(v as "active" | "paused");
                  }}
                >
                  <SelectTrigger
                    id="cj-status"
                    className="w-full cursor-pointer"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active" className="cursor-pointer">
                      Active
                    </SelectItem>
                    <SelectItem value="paused" className="cursor-pointer">
                      Paused
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="cursor-pointer"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className={pending ? "cursor-not-allowed" : "cursor-pointer"}
              disabled={pending}
            >
              {pending ? "Saving..." : mode === "create" ? "Create" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function eventsToText(
  events: Doc<"crons">["events"] | undefined,
): string {
  if (!Array.isArray(events)) return "";
  for (const message of events) {
    if (message?.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .filter((part) => part?.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (text) return text;
    }
  }

  return "";
}

// A job saved with no zone shows "UTC"; leaving it so keeps the stored value, so editing
// another field does not re-register the schedule.
function timezoneToSave(
  stored: string | undefined,
  typed: string,
): string | undefined {
  const next = typed.trim();

  return stored === undefined && next === "UTC" ? undefined : next;
}
