import { useCallback, useState } from "react";
import { friendlyError } from "./chain.js";

/**
 * Runs one transaction at a time and tracks its progress for the UI.
 *   const tx = useTx(refresh);
 *   await tx.run("Saving your key", () => vault.commitPieces(commits));
 * Returns the receipt, or null if it failed (tx.error holds a friendly message).
 */
export function useTx(onDone) {
  const [busy, setBusy] = useState(null); // label of the running action
  const [error, setError] = useState(null);
  const [lastOk, setLastOk] = useState(null);

  const run = useCallback(
    async (label, send) => {
      setBusy(label);
      setError(null);
      setLastOk(null);
      try {
        const tx = await send();
        const receipt = await tx.wait();
        setLastOk(label);
        return receipt;
      } catch (e) {
        console.error(e);
        setError(friendlyError(e));
        return null;
      } finally {
        setBusy(null);
        await onDone?.();
      }
    },
    [onDone],
  );

  return { busy, error, lastOk, run, setError };
}
