"use client";

import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { useNow } from "@/app/hooks/useNow";
import { useState } from "react";
import type {
  PendingQuestion,
  QuestionAnswer,
} from "../../../../../packages/broods/src/websocket-contracts";

const HOUR_MS = 60 * 60 * 1000;

type Choice =
  | { kind: "option"; label: string }
  | { kind: "text"; text: string };

/**
 * The open `ask_questions` prompts at the end of a chat turn. One option row
 * per choice, a text field when the question allows it, one Answer button for
 * every question. Submits `answers` keyed by prompt statusId.
 */
export function QuestionCard({
  prompts,
  onAnswer,
}: {
  prompts: PendingQuestion[];
  onAnswer: (answers: QuestionAnswer[]) => void;
}): React.JSX.Element {
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const now = useNow();
  const questions = prompts.flatMap((prompt) => prompt.questions);
  const answered = questions.filter(
    (question) => choiceLabel(choices[question.id]) !== "",
  ).length;
  const answerBy = Math.min(
    ...prompts.map((prompt) => Date.parse(prompt.answerBy)),
  );

  function choose(questionId: string, choice: Choice): void {
    setChoices((prev) => ({ ...prev, [questionId]: choice }));
  }

  function submit(): void {
    onAnswer(
      prompts.map((prompt): QuestionAnswer => ({
        statusId: prompt.statusId,
        answers: Object.fromEntries(
          prompt.questions.map((question) => [
            question.id,
            [choiceLabel(choices[question.id])],
          ]),
        ),
      })),
    );
  }

  return (
    <div className="rounded-md border border-border bg-background text-xs">
      {questions.map((question) => {
        const current = choices[question.id];

        return (
          <div
            key={question.id}
            className="border-b border-border/60 px-2.5 py-2 last:border-b-0"
          >
            <p className="mb-1.5 flex items-center gap-2">
              <span className="rounded-sm border border-border px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                {question.header}
              </span>
              <span className="text-foreground">{question.question}</span>
            </p>
            {question.options.map((option) => {
              const selected =
                current?.kind === "option" && current.label === option.label;

              return (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={selected}
                  onClick={() =>
                    choose(question.id, { kind: "option", label: option.label })
                  }
                  className={`grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-2 rounded-sm px-1.5 py-1 text-left transition-colors hover:bg-accent/40 ${
                    selected ? "bg-accent/60" : ""
                  }`}
                >
                  <span
                    className={`size-3 self-center rounded-full border ${
                      selected
                        ? "border-foreground bg-foreground shadow-[inset_0_0_0_2px_var(--background)]"
                        : "border-muted-foreground/60"
                    }`}
                  />
                  <span className="text-foreground">{option.label}</span>
                  <span className="text-muted-foreground">
                    {option.description}
                  </span>
                </button>
              );
            })}
            {question.allowFreeText && (
              <Input
                value={current?.kind === "text" ? current.text : ""}
                onChange={(event) =>
                  choose(question.id, {
                    kind: "text",
                    text: event.target.value,
                  })
                }
                placeholder="Or type an answer"
                className="h-7 text-xs"
              />
            )}
          </div>
        );
      })}
      <div className="flex items-center justify-between border-t border-border/60 px-2.5 py-1.5 text-muted-foreground">
        <span>
          {answered} of {questions.length} answered · expires in{" "}
          {expiresIn(answerBy, now)}
        </span>
        <Button
          size="xs"
          disabled={answered < questions.length}
          onClick={submit}
        >
          Answer
        </Button>
      </div>
    </div>
  );
}

function choiceLabel(choice: Choice | undefined): string {
  if (!choice) return "";

  return choice.kind === "option" ? choice.label : choice.text.trim();
}

function expiresIn(answerBy: number, now: number): string {
  const hours = Math.max(0, Math.round((answerBy - now) / HOUR_MS));

  return hours >= 48 ? `${Math.floor(hours / 24)}d` : `${hours}h`;
}
