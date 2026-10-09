import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { SESSION_QUERY_KEY } from "../auth/session";
import { useTakesDeps } from "../record/session";
import { startTakes } from "../record/takes";
import { startOffline, useOffline } from "./controller";
import { setServiceWorkerUser, usePwa } from "./pwa";

/**
 * Starts the logged-in user's offline data (SPEC §13): tells the service worker whose caches to
 * serve, opens the offline store (auto-update, outbox), and reports replayed offline changes.
 * Recorded takes (SPEC §9) start with it: recovery after a crash, uploads waiting for the network.
 */
export function OfflineSession({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const controlled = usePwa((s) => s.controlled);
  const lastReplay = useOffline((s) => s.lastReplay);
  const lastGone = useOffline((s) => s.lastGone);

  // A downloaded song or project was deleted on the server: its copy was removed (SPEC §13).
  useEffect(() => {
    if (!lastGone) return;
    notifications.show({
      id: `offline-gone-${String(lastGone.at)}`,
      color: "yellow",
      autoClose: 10_000,
      message:
        lastGone.kind === "song"
          ? t("offline.goneSong", { title: lastGone.title })
          : t("offline.goneProject", { title: lastGone.title }),
    });
  }, [lastGone, t]);

  useTakesDeps();
  useEffect(() => {
    void setServiceWorkerUser(userId);
    // Recorded takes (SPEC §9) use the offline database: after it opened.
    void startOffline(userId)
      .catch(() => undefined)
      .then(() => startTakes(userId));
  }, [userId]);

  // Once the worker controls the page, read the session through it so it is kept for offline use.
  useEffect(() => {
    if (controlled) void qc.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  }, [controlled, qc]);

  useEffect(() => {
    if (!lastReplay) return;
    for (const songId of lastReplay.songIds) {
      void qc.invalidateQueries({ queryKey: ["songs", songId] });
    }
    if (lastReplay.sent > 0) {
      notifications.show({
        color: "green",
        message: t("offline.outbox.sent", { count: lastReplay.sent }),
      });
    }
    const locked = lastReplay.dropped.filter((d) => d.locked === true).length;
    const other = lastReplay.dropped.length - locked;
    if (locked > 0) {
      notifications.show({
        color: "yellow",
        autoClose: 10_000,
        message: t("offline.outbox.locked", { count: locked }),
      });
    }
    if (other > 0) {
      notifications.show({
        color: "yellow",
        autoClose: 10_000,
        message: t("offline.outbox.dropped", { count: other }),
      });
    }
  }, [lastReplay, qc, t]);

  return null;
}
