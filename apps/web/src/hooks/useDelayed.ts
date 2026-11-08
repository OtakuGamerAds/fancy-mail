import { useEffect, useState } from "react";

/** `value` once it has been true for `delayMs` (a spinner that never flashes). */
export function useDelayed(value: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!value) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return shown;
}
