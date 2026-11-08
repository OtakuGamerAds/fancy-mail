import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/**
 * Drag handle for a column's right edge. The width follows the pointer while dragging and is
 * committed (and stored) on release; double-click resets it.
 */
export function useColumnResize(options: {
  width: number;
  min: number;
  max: number;
  onChange(width: number): void;
  defaultWidth: number;
}) {
  const { width, min, max, onChange, defaultWidth } = options;
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; width: number } | null>(null);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      start.current = { x: event.clientX, width };
      setDragging(true);
      document.body.style.cursor = "col-resize";
    },
    [width],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!start.current) return;
      const next = Math.max(min, Math.min(max, start.current.width + event.clientX - start.current.x));
      onChange(next);
    },
    [min, max, onChange],
  );

  const end = useCallback(() => {
    start.current = null;
    setDragging(false);
    document.body.style.cursor = "";
  }, []);

  return {
    dragging,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: end,
      onPointerCancel: end,
      onLostPointerCapture: end,
      onDoubleClick: () => onChange(defaultWidth),
      "data-dragging": dragging ? "" : undefined,
      role: "separator" as const,
      "aria-orientation": "vertical" as const,
      className: "col-resizer",
    },
  };
}
