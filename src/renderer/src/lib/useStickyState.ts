/**
 * `useState` that survives leaving the screen and coming back.
 *
 * Drop-in for `useState` — same tuple, same setter semantics including the
 * updater form. The only addition is a key, which must be unique across the
 * app because the backing store is one flat map.
 */
import { useCallback, useRef, useState } from 'react';
import { readScreenState, writeScreenState } from './screenState.js';

export function useStickyState<T>(
  key: string,
  initial: T | (() => T),
): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    const saved = readScreenState<T>(key);
    if (saved !== undefined) return saved;
    return typeof initial === 'function' ? (initial as () => T)() : initial;
  });

  // The setter must not change identity between renders: these values feed
  // effects and memo deps all over the screens.
  const latest = useRef(value);
  latest.current = value;

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const resolved =
        typeof next === 'function' ? (next as (prev: T) => T)(latest.current) : next;
      latest.current = resolved;
      writeScreenState(key, resolved);
      setValue(resolved);
    },
    [key],
  );

  return [value, set];
}
