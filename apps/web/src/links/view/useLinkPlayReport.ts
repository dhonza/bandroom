import { recordLinkPlay } from "@bandroom/shared";
import { useEffect, useRef } from "react";
import { api } from "../../api/client";
import { useListen } from "../../player/listenStore";
import { useRehearse } from "../../rehearse/controller";

/**
 * Link analytics (SPEC §3.5, §14.3): tells the server once per song and mode when playback
 * starts in the link view. Full play sessions with completion arrive with M13 (§14.2).
 */
export function useLinkPlayReport(): void {
  const listening = useListen((s) =>
    s.status === "playing" ? (s.queue[s.index]?.songId ?? null) : null,
  );
  const rehearsing = useRehearse((s) => (s.status === "playing" ? s.songId : null));
  const reported = useRef(new Set<string>());
  useEffect(() => {
    const report = (songId: string, mode: "listen" | "rehearse") => {
      const key = `${mode}:${songId}`;
      if (reported.current.has(key)) return;
      reported.current.add(key);
      void api(recordLinkPlay, { params: { id: songId }, body: { mode } }).catch(() => undefined);
    };
    if (listening) report(listening, "listen");
    if (rehearsing) report(rehearsing, "rehearse");
  }, [listening, rehearsing]);
}
