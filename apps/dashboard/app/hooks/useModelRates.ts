"use client";

import { modelKey, type ModelRef } from "@/app/lib/modelCost";
import { api } from "@broods/convex/_generated/api";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";

type ModelRates = FunctionReturnType<typeof api.logs.fetchModelRates>;

/**
 * Rates for models seen on the trace stream, which have no usage row yet:
 * live runs on the Usage tab and task prices on Tracing. The models are
 * deduped and sorted, so the query re-runs only when the set changes, and the
 * last rates stay while a new set loads, so prices never blink out.
 * `loading` is true until the current set's rates have arrived.
 */
export function useModelRates(models: ModelRef[]): {
  rates: ModelRates | undefined;
  loading: boolean;
} {
  const refs = [
    ...new Map(
      models.map((model) => [
        modelKey(model),
        { modelProvider: model.modelProvider, modelId: model.modelId },
      ]),
    ).entries(),
  ]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, model]) => model);
  // Convex compares args by value, so a new array with the same models keeps
  // the subscription.
  const rows = useQuery(
    api.logs.fetchModelRates,
    refs.length > 0 ? { models: refs } : "skip",
  );
  const [held, setHeld] = useState<ModelRates | undefined>(undefined);
  if (rows !== undefined && rows !== held) setHeld(rows);

  return {
    rates: rows ?? held,
    loading: refs.length > 0 && rows === undefined,
  };
}
