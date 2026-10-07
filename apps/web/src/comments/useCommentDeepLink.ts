import type { Comment } from "@bandroom/shared";
import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { activePlayer, seekTo } from "../markers/store";
import { highlightComment, setFilters } from "./store";

/** `?comment=<id>&t=<sec>` (notification deep links): open, highlight and seek, once. */
export function useCommentDeepLink(comments: readonly Comment[]) {
  const [params, setParams] = useSearchParams();
  const id = params.get("comment");
  const loaded = comments.length > 0;
  useEffect(() => {
    if (!id || !loaded) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (!activePlayer() && tries < 50) return;
      clearInterval(timer);
      const c = comments.find((x) => x.id === id || x.replies.some((r) => r.id === id));
      const at = Number(params.get("t"));
      if (c) {
        if (c.resolvedAt !== null) setFilters({ showResolved: true });
        highlightComment(c.id);
        const sec = c.startSec ?? (Number.isFinite(at) ? at : null);
        if (sec !== null) seekTo(sec);
      }
      setParams(
        (p) => {
          p.delete("comment");
          p.delete("t");
          return p;
        },
        { replace: true },
      );
    }, 100);
    return () => {
      clearInterval(timer);
    };
  }, [id, loaded, comments, params, setParams]);
}
