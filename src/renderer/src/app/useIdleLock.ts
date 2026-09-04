import { useEffect, useRef } from 'react';

/**
 * Lock the app back to the sign-in screen after a period of no input.
 *
 * `idle_lock_minutes` was a setting the Settings screen offered and nothing
 * honoured — a shop would set it, believe the counter locked itself, and it
 * never would. One PC is shared by the owner and the counter staff, so an
 * unattended session is exactly how a salesman ends up acting as the owner.
 *
 * Activity is anything the counter actually does: pointer, keyboard, scroll,
 * touch. The timer is reset on each, so a busy counter never locks mid-sale.
 * A value of 0 (or a nonsense one) disables locking rather than locking
 * instantly, which would make the app unusable.
 */
export function useIdleLock(minutes: number, onLock: () => void): void {
  // Keep the callback in a ref so a re-rendered parent does not restart the
  // timer on every render and effectively prevent the lock from ever firing.
  const lockRef = useRef(onLock);
  lockRef.current = onLock;

  useEffect(() => {
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    const ms = minutes * 60_000;

    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => lockRef.current(), ms);
    };

    const EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'] as const;
    for (const e of EVENTS) window.addEventListener(e, reset, { passive: true });
    reset();

    return () => {
      clearTimeout(timer);
      for (const e of EVENTS) window.removeEventListener(e, reset);
    };
  }, [minutes]);
}
