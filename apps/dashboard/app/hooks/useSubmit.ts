import { toErrorMessage } from "@/app/lib/errors";
import { useState } from "react";

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
