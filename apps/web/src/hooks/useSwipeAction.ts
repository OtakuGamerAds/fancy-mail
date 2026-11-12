/**
 * Swipe a row to the left to act on it (settle), as on T3 Code's phone app: by finger, by
 * dragging with the mouse, or with two fingers on a trackpad. Past the threshold the action is
 * armed; letting go there runs it while the row slides away, anywhere else it springs back.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";

/** How far before a horizontal move counts as a swipe (and not a click or a scroll). */
const START_PX = 8;
/** Letting go past this much of the row's width (at most MAX_THRESHOLD_PX) runs the action. */
const THRESHOLD_SHARE = 0.32;
const MAX_THRESHOLD_PX = 180;
/** A trackpad swipe ends when the wheel events stop for this long. */
const WHEEL_IDLE_MS = 140;
const SLIDE_OUT_MS = 200;

export interface SwipeState {
  /** How far the row is moved (0 or less). */
  offset: number;
  /** Letting go now runs the action. */
  armed: boolean;
  /** The finger or pointer is down (no transition while it moves). */
  dragging: boolean;
}

const REST: SwipeState = { offset: 0, armed: false, dragging: false };

export function useSwipeAction(run: (() => void) | null) {
  const [state, setState] = useState<SwipeState>(REST);
  const gesture = useRef<{ id: number; x: number; y: number; width: number; swiping: boolean } | null>(null);
  const wheel = useRef<{ offset: number; width: number; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const swallowClick = useRef(false);
  const runRef = useRef(run);
  runRef.current = run;
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const thresholdFor = (width: number) => Math.min(MAX_THRESHOLD_PX, width * THRESHOLD_SHARE);

  const release = useCallback((offset: number, width: number) => {
    const action = runRef.current;
    if (action && -offset >= thresholdFor(width)) {
      setState({ offset: -width, armed: true, dragging: false });
      timers.current.push(
        setTimeout(() => {
          action();
          // Still here (the view keeps settled rows in place): come back.
          timers.current.push(setTimeout(() => setState(REST), 60));
        }, SLIDE_OUT_MS),
      );
    } else {
      setState(REST);
    }
  }, []);

  const move = (offset: number, width: number) => {
    // Past the row's edge it resists.
    const limited = offset < -width ? -width + (offset + width) * 0.2 : offset;
    setState({ offset: Math.min(0, limited), armed: -limited >= thresholdFor(width), dragging: true });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!runRef.current || event.button !== 0 || gesture.current) return;
    // A menu opened from the row lives elsewhere in the page (its events still bubble here).
    if (!event.currentTarget.contains(event.target as Node)) return;
    if ((event.target as HTMLElement).closest("button, a, input, [role=checkbox]")) return;
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, width: event.currentTarget.offsetWidth, swiping: false };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    const dx = event.clientX - g.x;
    const dy = event.clientY - g.y;
    if (!g.swiping) {
      if (Math.abs(dy) > START_PX && Math.abs(dy) > Math.abs(dx)) {
        gesture.current = null; // a scroll
        return;
      }
      if (dx > -START_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      g.swiping = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    move(dx + START_PX, g.width);
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    gesture.current = null;
    if (!g.swiping) return;
    swallowClick.current = true;
    if (event.type === "pointercancel") setState(REST);
    else release(Math.min(0, event.clientX - g.x + START_PX), g.width);
  };

  const onClickCapture = (event: React.MouseEvent) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const onWheel = (event: ReactWheelEvent<HTMLElement>) => {
    if (!runRef.current || event.ctrlKey || !event.currentTarget.contains(event.target as Node)) return;
    const w = wheel.current;
    if (!w && (event.deltaX <= 0 || Math.abs(event.deltaX) < Math.abs(event.deltaY) * 1.5)) return;
    const current = w ?? { offset: 0, width: event.currentTarget.offsetWidth, timer: null };
    wheel.current = current;
    current.offset = Math.min(0, current.offset - event.deltaX);
    move(current.offset, current.width);
    if (current.timer) clearTimeout(current.timer);
    current.timer = setTimeout(() => {
      wheel.current = null;
      release(current.offset, current.width);
    }, WHEEL_IDLE_MS);
  };

  return {
    state,
    handlers: { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd, onClickCapture, onWheel },
  };
}
