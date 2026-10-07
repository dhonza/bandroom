import { getSongWhatsNew, recordSongVisit, type Song } from "@bandroom/shared";
import { Alert, Anchor, List } from "@mantine/core";
import { IconSparkles } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { seekTo } from "./store";
import { tapComment } from "../comments/actions";
import { setPanelOpen, setSort } from "../comments/store";

function jumpToTrack(trackId: string) {
  const el = document.querySelector(`[data-track-id="${CSS.escape(trackId)}"]`);
  el?.scrollIntoView({ behavior: "smooth", block: "center" });
  if (el instanceof HTMLElement) {
    el.style.outline = "2px solid var(--mantine-primary-color-filled)";
    setTimeout(() => {
      el.style.outline = "";
    }, 2000);
  }
}

/**
 * "What's new" since the user's last visit (SPEC §11.3): new versions, markers and comments by
 * others; each entry jumps to the change. Opening the page records the visit.
 */
export function WhatsNewBanner({ song }: { song: Song }) {
  const { t } = useTranslation();
  // Outside the ["songs", id] key space so SSE invalidations do not refetch it after the visit.
  const q = useQuery({
    queryKey: ["whatsNew", song.id],
    queryFn: ({ signal }) => api(getSongWhatsNew, { params: { id: song.id } }, { signal }),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const recorded = useRef<string | null>(null);
  useEffect(() => {
    if (!q.isSuccess || recorded.current === song.id) return;
    recorded.current = song.id;
    void api(recordSongVisit, { params: { id: song.id } }).catch(() => undefined);
  }, [q.isSuccess, song.id]);
  const [dismissed, setDismissed] = useState(false);
  const d = q.data;
  if (!d || dismissed) return null;
  if (d.versions.length === 0 && d.markers.length === 0 && d.commentCount === 0) return null;
  return (
    <Alert
      color="blue"
      variant="light"
      icon={<IconSparkles size={18} />}
      title={t("whatsNew.title")}
      withCloseButton
      closeButtonLabel={t("whatsNew.dismiss")}
      onClose={() => {
        setDismissed(true);
      }}
      data-testid="whats-new"
    >
      <List size="sm" spacing={4}>
        {d.versions.map((v) => (
          <List.Item key={v.versionId}>
            <Anchor
              component="button"
              type="button"
              size="sm"
              onClick={() => {
                jumpToTrack(v.trackId);
              }}
            >
              {v.byName
                ? t("whatsNew.version", { track: v.trackName, number: v.number, name: v.byName })
                : t("whatsNew.versionAnon", { track: v.trackName, number: v.number })}
            </Anchor>
          </List.Item>
        ))}
        {d.markers.map((m) => (
          <List.Item key={m.id}>
            <Anchor
              component="button"
              type="button"
              size="sm"
              onClick={() => {
                seekTo(m.startSec);
              }}
            >
              {m.byName
                ? t("whatsNew.marker", { name: m.name, by: m.byName })
                : t("whatsNew.markerAnon", { name: m.name })}
            </Anchor>
          </List.Item>
        ))}
        {d.commentCount > 0 && (
          <List.Item>
            <Anchor
              component="button"
              type="button"
              size="sm"
              data-testid="whats-new-comments"
              onClick={() => {
                // Newest first in the panel, and jump to the earliest new comment.
                setSort("date");
                if (d.firstComment) tapComment(d.firstComment);
                else setPanelOpen(true);
              }}
            >
              {t("whatsNew.comments", { count: d.commentCount })}
            </Anchor>
          </List.Item>
        )}
      </List>
    </Alert>
  );
}
