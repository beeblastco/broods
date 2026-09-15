"use client";

import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
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
  disabled,
  onAnswer,
}: {
  prompts: PendingQuestion[];
  disabled: boolean;
  onAnswer: (answers: QuestionAnswer[]) => void;
}): React.JSX.Element {
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const questions = prompts.flatMap((prompt) =>
    prompt.questions.map((question) => ({
      statusId: prompt.statusId,
      question: question,
    })),
  );
  const answered = questions.filter(
    (entry) => choiceLabel(choices[entry.question.id]) !== "",
  ).length;
  const complete = answered === questions.length;
  const answerBy = Math.min(
    ...prompts.map((prompt) => Date.parse(prompt.answerBy)),
  );

  function choose(questionId: string, choice: Choice): void {
    setChoices((prev) => ({ ...prev, [questionId]: choice }));
  }

  function submit(): void {
    if (!complete || disabled) return;
    const answers = prompts.map((prompt): QuestionAnswer => ({
      statusId: prompt.statusId,
      answers: Object.fromEntries(
        prompt.questions.map((question) => [
          question.id,
          [choiceLabel(choices[question.id])],
        ]),
      ),
    }));
    onAnswer(answers);
  }

  return (
    <div className="rounded-md border border-border bg-background text-xs">
      {questions.map(({ question }) => {
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
                  disabled={disabled}
                  onClick={() =>
                    choose(question.id, { kind: "option", label: option.label })
                  }
                  className={`grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-2 rounded-sm px-1.5 py-1 text-left transition-colors hover:bg-accent/40 disabled:cursor-not-allowed ${
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
                disabled={disabled}
                placeholder="Or type an answer"
                className="mt-1.5 h-7 text-xs"
              />
            )}
          </div>
        );
      })}
      <div className="flex items-center justify-between border-t border-border/60 px-2.5 py-1.5 text-muted-foreground">
        <span>
          {answered} of {questions.length} answered · expires in{" "}
          {expiresIn(answerBy)}
        </span>
        <Button
          size="xs"
          disabled={!complete || disabled}
          onClick={submit}
          className={
            complete && !disabled ? "cursor-pointer" : "cursor-not-allowed"
          }
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

function expiresIn(answerBy: number): string {
  const hours = Math.max(0, Math.round((answerBy - Date.now()) / HOUR_MS));

  return hours >= 48 ? `${Math.floor(hours / 24)}d` : `${hours}h`;
}
