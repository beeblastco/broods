import { toErrorMessage } from "@/app/lib/errors";
import { useState } from "react";

/**
 * One in-flight write at a time, for a dialog's submit or a row's action:
 * `pending` disables the button while it runs, `error` is the rejection in
 * words, and `run` resolves true when the write went through.
 */
export function useSubmit(): {
  pending: boolean;
  error: string | null;
  run: (write: () => Promise<unknown>) => Promise<boolean>;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return {
    pending: pending,
    error: error,
    run: async (write) => {
      setPending(true);
      setError(null);
      try {
        await write();

        return true;
      } catch (err) {
        setError(toErrorMessage(err));

        return false;
      } finally {
        setPending(false);
      }
    },
  };
}
