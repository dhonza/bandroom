import { useEffect, useRef, useState } from "react";

/**
 * A saved setting edited with a control that commits each change (e.g. a slider: every keyboard
 * step is a change and a commit). The control shows the local value until the saved value has
 * caught up with the last commit, and saves run one at a time with the latest value last. So a
 * quick second change is neither computed from a stale saved value (the local value is never
 * dropped before the saved one arrives) nor reverted by an older save finishing later.
 *
 * Returns `[value, change, commit]`; `save` resolves when the saved value is updated (it may
 * reach `saved` a render later) and rejects on failure, which shows the saved value again.
 */
export function useSavedSetting<T>(
  saved: T,
  save: (value: T) => Promise<unknown>,
): [T, (value: T) => void, (value: T) => void] {
  const [local, setLocal] = useState<{ value: T } | null>(null);
  /** Bumped when a save settles, so the effect below re-checks. */
  const [settled, setSettled] = useState(0);
  const saveRef = useRef(save);
  const saving = useRef(false);
  const queued = useRef<{ value: T } | null>(null);
  /** The last committed value. */
  const target = useRef<{ value: T } | null>(null);

  useEffect(() => {
    saveRef.current = save;
  });

  // Back to the saved value once it shows the last commit and nothing is pending.
  useEffect(() => {
    const goal = target.current;
    if (!local || !goal || saving.current || queued.current) return;
    if (Object.is(local.value, goal.value) && Object.is(saved, goal.value)) setLocal(null);
  }, [saved, local, settled]);

  const run = (value: T) => {
    saving.current = true;
    void saveRef.current(value).then(
      () => {
        settle(false);
      },
      () => {
        settle(true);
      },
    );
  };
  const settle = (failed: boolean) => {
    saving.current = false;
    const next = queued.current;
    queued.current = null;
    if (next) run(next.value);
    else if (failed) setLocal(null);
    setSettled((n) => n + 1);
  };

  const change = (value: T) => {
    setLocal({ value });
  };
  const commit = (value: T) => {
    target.current = { value };
    setLocal({ value });
    if (saving.current) queued.current = { value };
    else if (Object.is(value, saved)) setLocal(null);
    else run(value);
  };
  return [local ? local.value : saved, change, commit];
}
