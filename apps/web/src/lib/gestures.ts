/** Touch gesture timings shared by the timeline and the marker controls. */

/** How long a press must be held to count as a long-press (opens a context menu). */
export const LONG_PRESS_MS = 500;

/** Two taps on the same item within this window are a double-tap. */
export const DOUBLE_TAP_MS = 400;

/**
 * Swallows the click the browser sends after a pointerup that just opened something under the
 * finger (e.g. a double tap opening an editor): without it the click lands on the new dialog,
 * such as a preset chip. Only the first click within `ms` is dropped.
 */
export function swallowNextClick(ms = DOUBLE_TAP_MS): void {
  if (typeof window === "undefined") return;
  const onClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    done();
  };
  const timer = setTimeout(() => {
    done();
  }, ms);
  const done = () => {
    clearTimeout(timer);
    window.removeEventListener("click", onClick, true);
  };
  window.addEventListener("click", onClick, true);
}
