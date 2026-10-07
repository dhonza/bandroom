import {
  canActOn,
  lockedOut,
  createMarker,
  deleteMarker,
  listSongMarkers,
  restoreMarker,
  updateMarker,
  type CreateMarker,
  type Marker,
  type Song,
  type UpdateMarker,
  uuidv7,
} from "@bandroom/shared";
import { Button, Group, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api/client";
import { enqueue, shouldQueueOffline, useOffline } from "../offline/controller";
import { tempId } from "../offline/outbox";
import { isPending, withPendingMarkers } from "../offline/pending";
import { isLinkMode } from "../links/linkMode";
import { useApiError } from "../api/useApiError";
import { useOptionalUser } from "../auth/session";
import { byStart } from "./model";
import { setMarkers } from "./store";
import { setOptimistic } from "../api/optimistic";

export const markerKeys = {
  list: (songId: string) => ["songs", songId, "markers"] as const,
};

type MarkerList = { markers: Marker[]; timelineRev: number };

/** The song's markers and sections, mirrored into the timeline store for shortcuts. */
export function useSongMarkers(songId: string) {
  const q = useQuery({
    queryKey: markerKeys.list(songId),
    queryFn: async ({ signal }) => {
      const res = await api(listSongMarkers, { params: { id: songId } }, { signal });
      // Offline changes not sent yet (SPEC §13 outbox).
      return {
        ...res,
        markers: withPendingMarkers(res.markers, useOffline.getState().outbox, songId),
      };
    },
  });
  // Merged again here: after a reload the outbox can load after the list (SPEC §13).
  const outbox = useOffline((s) => s.outbox);
  const markers = useMemo(
    () => [...withPendingMarkers(q.data?.markers ?? [], outbox, songId)].sort(byStart),
    [q.data, outbox, songId],
  );
  useEffect(() => {
    setMarkers(markers);
  }, [markers]);
  return { ...q, markers };
}

/**
 * Who may add and edit (SPEC §3.2: `annotate.own` for own items, `annotate.any` for all). A
 * locked song (SPEC §25.12) allows neither; `mayCreate` keeps the add buttons visible (disabled).
 */
export function useMarkerPermissions(song: Song) {
  const userId = useOptionalUser()?.id ?? null;
  const caps = song.access.capabilities;
  const locked = song.locked !== null;
  const mayCreate = caps.includes("annotate.own");
  const canCreate = mayCreate && !lockedOut(locked, "annotate.own");
  const canEdit = useCallback(
    (m: Marker) =>
      !lockedOut(locked, "annotate.own") &&
      canActOn(song.access.role, "annotate", userId !== null && m.createdBy === userId),
    [song.access.role, userId, locked],
  );
  return { canCreate, canEdit, mayCreate, locked };
}

const UNDO_MS = 8000;

/** A change that failed only for lack of network goes to the offline outbox (SPEC §13). */
function offlineQueue(err: unknown): boolean {
  return !isLinkMode() && shouldQueueOffline(err);
}

/** How a marker created offline looks until the server has it (lanes are recomputed there). */
function offlineMarker(
  songId: string,
  body: CreateMarker,
  id: string,
  user: { id: string; displayName: string } | null,
): Marker {
  const now = Date.now();
  return {
    id,
    songId,
    type: body.type,
    name: body.name,
    color: body.color,
    note: body.note ?? "",
    startSec: body.startSec,
    endSec: body.type === "section" ? (body.endSec ?? null) : null,
    anchor: "time",
    startBeat: null,
    endBeat: null,
    lane: 0,
    createdBy: user?.id ?? null,
    createdByName: user?.displayName ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Create / update / delete with optimistic cache updates (SPEC §11.1 instant feedback) and an
 * 8 s undo toast for deletes (SPEC §11.1 undo over confirm).
 */
export function useMarkerActions(songId: string) {
  const qc = useQueryClient();
  const user = useOptionalUser();
  const { t } = useTranslation();
  const apiError = useApiError();
  const key = markerKeys.list(songId);

  const patchCache = useCallback(
    (fn: (list: Marker[]) => Marker[]) => {
      setOptimistic<MarkerList>(qc, key, (old) =>
        old ? { ...old, markers: fn(old.markers) } : old,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key is derived from songId
    [qc, songId],
  );
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: key });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key is derived from songId
  }, [qc, songId]);
  const fail = useCallback(
    (err: unknown) => {
      notifications.show({ color: "red", message: apiError(err) });
      refresh();
    },
    [apiError, refresh],
  );

  const create = useCallback(
    async (body: CreateMarker): Promise<Marker | null> => {
      const requestId = uuidv7();
      try {
        const { marker } = await api(createMarker, {
          params: { id: songId },
          body: { ...body, requestId },
        });
        patchCache((list) => [...list.filter((m) => m.id !== marker.id), marker]);
        refresh(); // lanes of other sections may have changed
        return marker;
      } catch (err) {
        if (offlineQueue(err)) {
          const preview = offlineMarker(songId, body, tempId(requestId), user);
          patchCache((list) => [...list, preview]);
          await enqueue(
            "marker.create",
            songId,
            { tempId: preview.id, body: { ...body, requestId }, preview },
            requestId,
          );
          return preview;
        }
        fail(err);
        return null;
      }
    },
    [songId, patchCache, refresh, fail, user],
  );

  const update = useCallback(
    async (m: Marker, patch: UpdateMarker): Promise<void> => {
      patchCache((list) =>
        list.map((x) =>
          x.id === m.id
            ? {
                ...x,
                ...patch,
                endSec: x.type === "section" ? (patch.endSec ?? x.endSec) : null,
              }
            : x,
        ),
      );
      const editedAt = Date.now();
      try {
        if (isPending(m.id)) throw new ApiError(0, { code: "NETWORK", message: "not sent yet" });
        const { marker } = await api(updateMarker, { params: { id: m.id }, body: patch });
        patchCache((list) => list.map((x) => (x.id === marker.id ? marker : x)));
        refresh();
      } catch (err) {
        if (offlineQueue(err)) {
          await enqueue("marker.update", songId, { markerId: m.id, patch, base: m, editedAt });
          return;
        }
        fail(err);
      }
    },
    [songId, patchCache, refresh, fail],
  );

  const remove = useCallback(
    async (m: Marker): Promise<void> => {
      patchCache((list) => list.filter((x) => x.id !== m.id));
      try {
        if (isPending(m.id)) throw new ApiError(0, { code: "NETWORK", message: "not sent yet" });
        await api(deleteMarker, { params: { id: m.id } });
      } catch (err) {
        // Offline: deleted when back online (no undo toast; the server has nothing to restore yet).
        if (offlineQueue(err)) await enqueue("marker.delete", songId, { markerId: m.id });
        else fail(err);
        return;
      }
      const id = `marker-undo-${m.id}`;
      const undo = async () => {
        notifications.hide(id);
        try {
          const { marker } = await api(restoreMarker, { params: { id: m.id } });
          patchCache((list) => [...list.filter((x) => x.id !== marker.id), marker]);
          refresh();
        } catch (err) {
          fail(err);
        }
      };
      notifications.show({
        id,
        autoClose: UNDO_MS,
        message: (
          <Group justify="space-between" wrap="nowrap" gap="sm">
            <Text size="sm">
              {t(m.type === "section" ? "markers.sectionDeleted" : "markers.markerDeleted", {
                name: m.name,
              })}
            </Text>
            <Button
              size="sm"
              variant="light"
              h={44}
              onClick={() => void undo()}
              data-testid="marker-undo"
            >
              {t("markers.undo")}
            </Button>
          </Group>
        ),
      });
      refresh();
    },
    [songId, patchCache, refresh, fail, t],
  );

  return { create, update, remove };
}
