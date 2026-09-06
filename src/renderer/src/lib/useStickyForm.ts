/**
 * Keeps an antd form's values across leaving the screen and coming back.
 *
 * antd holds values inside the form instance, not in React state, so
 * `useStickyState` cannot see them. This snapshots on every change and refills
 * on mount.
 *
 * Restoring is skipped until the screen says it is ready (`enabled`), because a
 * form that loads a record asynchronously must not have a stale draft written
 * over the freshly-fetched values, nor the other way round.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { FormInstance } from 'antd';
import { clearScreenState, readScreenState, writeScreenState } from './screenState.js';

interface Options {
  /** Hold off restoring until the screen has whatever it needs to render the
   * form (catalog lists, the record being edited). Defaults to true. */
  enabled?: boolean;
}

export interface StickyForm {
  /** Wire to the Form's `onValuesChange`. */
  onValuesChange: () => void;
  /** Drop the draft — call after a successful save, or on an explicit cancel. */
  clear: () => void;
  /** True when this mount refilled the form from a previous visit. Screens use
   * it to tell the user their work came back rather than silently restoring. */
  restored: boolean;
}

export function useStickyForm<T extends object>(
  key: string,
  form: FormInstance<T>,
  { enabled = true }: Options = {},
): StickyForm {
  const restored = useRef(false);
  const done = useRef(false);

  useEffect(() => {
    if (!enabled || done.current) return;
    done.current = true;
    const saved = readScreenState<T>(key);
    if (saved === undefined) return;
    form.setFieldsValue(saved);
    restored.current = true;
  }, [enabled, form, key]);

  const onValuesChange = useCallback(() => {
    // Snapshot the whole form rather than the changed field: a later restore
    // needs every value, and these forms are far too small for that to matter.
    writeScreenState(key, form.getFieldsValue());
  }, [form, key]);

  const clear = useCallback(() => {
    clearScreenState(key);
    restored.current = false;
  }, [key]);

  return { onValuesChange, clear, restored: restored.current };
}
