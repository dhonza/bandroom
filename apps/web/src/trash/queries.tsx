import {
  BATCH_MAX_ITEMS,
  batchDelete,
  batchPurge,
  batchRestore,
  listAdminTrash,
  listProjectTrash,
  type BatchItems,
  type TrashBatchItems,
  type TrashItem,
} from "@bandroom/shared";
import { Button, Group, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { useApiError } from "../api/useApiError";
import { docKeys } from "../documents/queries";
import { projectKeys } from "../features/library/queries";
import { dropDeletedFromQueue } from "../player/dropDeleted";

export const trashKeys = {
  all: ["trash"] as const,
  project: (id: string) => ["trash", "project", id] as const,
  admin: ["trash", "admin"] as const,
};

const UNDO_MS = 8000;

export function useProjectTrash(projectId: string) {
  return useQuery({
    queryKey: trashKeys.project(projectId),
    queryFn: ({ signal }) => api(listProjectTrash, { params: { id: projectId } }, { signal }),
  });
}

export function useAdminTrash() {
  return useQuery({
    queryKey: trashKeys.admin,
    queryFn: ({ signal }) => api(listAdminTrash, undefined, { signal }),
  });
}

/**
 * Everything a batch action may have changed: lists, songs, tracks, versions, documents, the
 * Trash.
 */
export function useInvalidateBatch() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: projectKeys.all });
    void qc.invalidateQueries({ queryKey: ["songs"] });
    void qc.invalidateQueries({ queryKey: docKeys.all });
    void qc.invalidateQueries({ queryKey: trashKeys.all });
  };
}

export const itemCount = (items: BatchItems) =>
  (items.songs?.length ?? 0) + (items.tracks?.length ?? 0) + (items.versions?.length ?? 0);

/**
 * Moves the items to the Trash with an 8 s undo toast (SPEC §11.1, §26.3). Resolves to whether
 * it worked (errors are shown as a toast).
 */
export function useBatchDelete() {
  const { t } = useTranslation();
  const apiError = useApiError();
  const invalidate = useInvalidateBatch();
  const fail = (err: unknown) => notifications.show({ color: "red", message: apiError(err) });
  return async (items: BatchItems): Promise<boolean> => {
    try {
      await api(batchDelete, { body: items });
    } catch (err) {
      fail(err);
      return false;
    }
    invalidate();
    if (items.songs?.length) dropDeletedFromQueue(t, { songIds: items.songs });
    const id = `batch-undo-${String(Date.now())}`;
    notifications.show({
      id,
      autoClose: UNDO_MS,
      message: (
        <Group justify="space-between" wrap="nowrap" gap="sm">
          <Text size="sm">{t("selection.moved", { count: itemCount(items) })}</Text>
          <Button
            size="sm"
            variant="light"
            h={44}
            data-testid="batch-undo"
            onClick={() => {
              notifications.hide(id);
              api(batchRestore, { body: items }).then(invalidate, fail);
            }}
          >
            {t("markers.undo")}
          </Button>
        </Group>
      ),
    });
    return true;
  };
}

/** Splits Trash items into batch bodies of at most 500 ids. */
export function chunkItems(items: readonly TrashItem[]): TrashBatchItems[] {
  const out: TrashBatchItems[] = [];
  for (let i = 0; i < items.length; i += BATCH_MAX_ITEMS) {
    out.push(toBatchItems(items.slice(i, i + BATCH_MAX_ITEMS)));
  }
  return out;
}

export function toBatchItems(items: readonly Pick<TrashItem, "kind" | "id">[]): TrashBatchItems {
  const of = (kind: TrashItem["kind"]) => items.filter((i) => i.kind === kind).map((i) => i.id);
  const out: TrashBatchItems = { songs: of("song"), tracks: of("track"), versions: of("version") };
  const projects = of("project");
  const documents = of("document");
  // Only restore and purge take them (SPEC §26.3); left out when empty.
  if (projects.length > 0) out.projects = projects;
  if (documents.length > 0) out.documents = documents;
  return out;
}

/**
 * The items a restore needs besides the chosen ones (SPEC §26.3): the song (and, for a version,
 * the track) when it is in the Trash too and the user may restore it. Returns null when a needed
 * parent cannot be restored.
 */
export function withParents(
  chosen: readonly TrashItem[],
  all: readonly TrashItem[],
): TrashItem[] | null {
  const out = new Map(chosen.map((i) => [`${i.kind}:${i.id}`, i]));
  const need = (kind: "song" | "track", id: string) => {
    const key = `${kind}:${id}`;
    if (out.has(key)) return true;
    const parent = all.find((i) => i.kind === kind && i.id === id);
    if (!parent?.canRestore) return false;
    out.set(key, parent);
    return true;
  };
  for (const i of chosen) {
    if (i.kind !== "song" && i.song?.deleted && !need("song", i.song.id)) return null;
    if (i.kind === "version" && i.track?.deleted && !need("track", i.track.id)) return null;
  }
  return [...out.values()];
}

/** Parents first: a project, then songs, tracks, versions and documents in them. */
const ORDER: TrashItem["kind"][] = ["project", "song", "track", "version", "document"];
const byKind = (items: readonly TrashItem[], dir: 1 | -1) =>
  [...items].sort((a, b) => dir * (ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)));

/** Restores in chunks, parents first (a later chunk's tracks then find their song restored). */
export async function restoreItems(items: readonly TrashItem[]): Promise<void> {
  for (const body of chunkItems(byKind(items, 1))) await api(batchRestore, { body });
}

/**
 * Purges in chunks, children first (a purged song takes its tracks with it, so they must not
 * come in a later chunk); returns the bytes taken off the usage.
 */
export async function purgeItems(items: readonly TrashItem[]): Promise<number> {
  let bytes = 0;
  for (const body of chunkItems(byKind(items, -1)))
    bytes += (await api(batchPurge, { body })).bytesFreed;
  return bytes;
}
