import { recordLinkPlay } from "@bandroom/shared";
import { useEffect, useRef } from "react";
import { api } from "../../api/client";
import { useRehearse } from "../../rehearse/controller";

/**
 * Link analytics (SPEC §3.5, §14.3): tells the server once per song when playback starts in the
 * link view. There is one player since M21, so the mode is always "rehearse" (SPEC §27.4).
 */
export function useLinkPlayReport(): void {
  const playing = useRehearse((s) => (s.status === "playing" ? s.songId : null));
  const reported = useRef(new Set<string>());
  useEffect(() => {
    if (!playing || reported.current.has(playing)) return;
    reported.current.add(playing);
    void api(recordLinkPlay, { params: { id: playing }, body: { mode: "rehearse" } }).catch(
      () => undefined,
    );
  }, [playing]);
}
