import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  canCopyContent,
  canDeleteContent,
  canMoveContent,
  canRemoveLossless,
  hasGlobalCapability,
  reorderSongs,
  type BatchItems,
  type Project,
  type SongSummary,
} from "@bandroom/shared";
import {
  ActionIcon,
  Alert,
  Button,
  Center,
  Checkbox,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconCloudCheck,
  IconGripVertical,
  IconListCheck,
  IconMusic,
  IconPlus,
  IconTrash,
  IconDiamondOff,
  IconArrowsTransferUp,
  IconStack2,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { api } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { projectKeys, useProjectSongs } from "../library/queries";
import { CreateSongModal } from "./CreateSongModal";
import { FolderDrop } from "./FolderDrop";
import { offlineItemFor, useOffline } from "../../offline/controller";
import { ProcessingBadge } from "../../processing/ProcessingBadge";
import { setOptimistic } from "../../api/optimistic";
import { SelectionBar } from "../../selection/SelectionBar";
import { songSelection } from "../../selection/store";
import { useLongPress } from "../../selection/useLongPress";
import { useSelection } from "../../selection/useSelection";
import { useBatchDelete } from "../../trash/queries";
import { RemoveLosslessDialog } from "../../lossless/RemoveLosslessDialog";
import { SongLossyBadge } from "../../lossless/SongLossyBadge";
import { useCurrentUser } from "../../auth/session";
import { MultitrackDialog, type MultitrackRequest } from "../../transfer/MultitrackDialog";
import { SongsTransferDialog, type SongsTransferRequest } from "../../transfer/SongsTransferDialog";

/** Devices with a mouse show the selection checkboxes all the time (SPEC §26.1). */
export const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

/** Whether the user may move this song to the Trash (SPEC §26.3). */
const canDeleteSong = (s: SongSummary) => canDeleteContent(s.access.role, "song", false);
/**
 * Whether the user may remove the full quality of a whole song (SPEC §26.4): managers and admins
 * (uploaders do it per version, on the song page). Songs already all lossy are left out.
 */
const canRemoveSong = (s: SongSummary) =>
  s.lossy !== "all" && canRemoveLossless(s.access.role, false);
/** Moving a song (also into a multitrack song) needs the right to delete it (SPEC §26.6). */
const canMoveSong = (s: SongSummary) => canMoveContent(s.access.role, "song", false);
/** Copying needs `edit.any` (SPEC §26.6). */
const canCopySong = (s: SongSummary) => canCopyContent(s.access.role);

/** Songs tab: list with drag-reorder for editors (SPEC §11.2). */
export function SongsList({ project }: { project: Project }) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const qc = useQueryClient();
  const songs = useProjectSongs(project.id);
  const [createOpen, create] = useDisclosure(false);
  const caps = new Set(project.access.capabilities);
  const canReorder = caps.has("edit.any");
  const finePointer = useMediaQuery(FINE_POINTER_QUERY, false);
  const list0 = songs.data?.songs ?? [];
  const selection = useSelection(
    songSelection,
    `project:${project.id}`,
    list0.map((s) => s.id),
  );
  const batchDelete = useBatchDelete();
  const [deleting, setDeleting] = useState(false);
  const [removeItems, setRemoveItems] = useState<BatchItems | null>(null);
  const [multitrack, setMultitrack] = useState<MultitrackRequest | null>(null);
  const [transfer, setTransfer] = useState<SongsTransferRequest | null>(null);
  const user = useCurrentUser();
  const canCreateProject = hasGlobalCapability({ ...user, disabledAt: null }, "project.create");
  // Batch actions available in this list (SPEC §26.1): delete, remove full quality, make
  // multitrack song, copy and move.
  const selectable = list0.some(
    (s) => canDeleteSong(s) || canRemoveSong(s) || canMoveSong(s) || canCopySong(s),
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const reorder = useMutation({
    mutationFn: (songIds: string[]) =>
      api(reorderSongs, { params: { id: project.id }, body: { songIds } }),
    onError: (err) => {
      notifications.show({ color: "red", message: apiError(err) });
      void qc.invalidateQueries({ queryKey: projectKeys.songs(project.id) });
    },
  });

  if (songs.isPending) {
    return (
      <Center mih={120}>
        <Loader />
      </Center>
    );
  }
  if (songs.isError) return <Alert color="red">{apiError(songs.error)}</Alert>;
  const list = songs.data.songs;

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = list.findIndex((s) => s.id === active.id);
    const to = list.findIndex((s) => s.id === over.id);
    const next = arrayMove(list, from, to);
    // Optimistic UI (SPEC §11.1).
    setOptimistic(qc, projectKeys.songs(project.id), { songs: next });
    reorder.mutate(next.map((s) => s.id));
  };

  const selected = list.filter((s) => selection.ids.has(s.id));
  const deletable = selected.filter(canDeleteSong);
  const removable = selected.filter(canRemoveSong);
  const movable = selected.filter(canMoveSong);
  const copyable = selected.filter(canCopySong);
  // A multitrack song is a new song in this project (song.create).
  const mergeable = caps.has("song.create") ? movable : [];
  const openTransfer = (mode: "copy" | "move", newProject: boolean) => {
    const songs = (mode === "move" ? movable : copyable).map((s) => s.id);
    setTransfer({
      songs,
      mode,
      projectId: project.id,
      newProject,
      canMove: movable.length === selected.length,
    });
  };
  const deleteSelected = async () => {
    setDeleting(true);
    const ok = await batchDelete({ songs: deletable.map((s) => s.id) });
    setDeleting(false);
    if (ok) selection.exit();
  };

  return (
    <Stack gap="sm">
      {(caps.has("song.create") || (selectable && !selection.active)) && (
        <Group justify="flex-end" gap="xs">
          {selectable && !selection.active && (
            <Button
              variant="default"
              leftSection={<IconListCheck size={18} />}
              onClick={() => {
                selection.start();
              }}
              data-testid="songs-select"
            >
              {t("selection.select")}
            </Button>
          )}
          {caps.has("song.create") && (
            <Button
              leftSection={<IconPlus size={18} />}
              onClick={create.open}
              data-testid="new-song"
            >
              {t("songs.create")}
            </Button>
          )}
        </Group>
      )}
      {caps.has("song.create") && caps.has("upload") && <FolderDrop project={project} />}
      {list.length === 0 ? (
        <Center mih={200}>
          <Stack align="center" gap="sm">
            <ThemeIcon size={56} radius="xl" variant="light">
              <IconMusic size={28} aria-hidden />
            </ThemeIcon>
            <Text c="dimmed">{t("songs.empty")}</Text>
          </Stack>
        </Center>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={list.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            <Stack gap="xs" data-testid="songs-list">
              {list.map((s, i) => (
                <SongRow
                  key={s.id}
                  song={s}
                  index={i}
                  draggable={canReorder && !selection.active}
                  selectable={selectable}
                  selecting={selection.active}
                  selected={selection.ids.has(s.id)}
                  showCheckbox={selectable && (selection.active || finePointer)}
                  onToggle={() => {
                    selection.toggle(s.id);
                  }}
                />
              ))}
            </Stack>
          </SortableContext>
        </DndContext>
      )}
      {selection.active && (
        <SelectionBar
          count={selected.length}
          total={list.length}
          onSelectAll={() => {
            selection.setAll(list.map((s) => s.id));
          }}
          onExit={selection.exit}
          actions={[
            {
              key: "delete",
              label: t("selection.delete"),
              icon: <IconTrash size={16} />,
              color: "red",
              allowed: deletable.length,
              reason: t("selection.managersOnly", { count: selected.length - deletable.length }),
              loading: deleting,
              onClick: () => {
                void deleteSelected();
              },
            },
            {
              key: "removeLossless",
              label: t("lossless.action"),
              icon: <IconDiamondOff size={16} />,
              allowed: removable.length,
              onClick: () => {
                setRemoveItems({ songs: removable.map((s) => s.id) });
              },
            },
            {
              key: "makeMultitrack",
              label: t("transfer.makeMultitrack"),
              icon: <IconStack2 size={16} />,
              allowed: mergeable.length,
              reason: t("transfer.managersOnly", { count: selected.length - movable.length }),
              onClick: () => {
                setMultitrack({
                  items: { songs: mergeable.map((s) => s.id) },
                  mode: "move",
                  projectId: project.id,
                });
              },
            },
            {
              key: "copyMove",
              label: t("transfer.copyMove"),
              icon: <IconArrowsTransferUp size={16} />,
              allowed: Math.max(copyable.length, movable.length),
              reason: t("transfer.editorsOnly"),
              onClick: () => undefined,
              menu: [
                {
                  key: "copyTo",
                  label: t("transfer.copyTo"),
                  allowed: copyable.length,
                  onClick: () => {
                    openTransfer("copy", false);
                  },
                },
                {
                  key: "moveTo",
                  label: t("transfer.moveTo"),
                  allowed: movable.length,
                  onClick: () => {
                    openTransfer("move", false);
                  },
                },
                ...(canCreateProject
                  ? [
                      {
                        key: "newProject",
                        label: t("transfer.newProject"),
                        allowed: Math.max(copyable.length, movable.length),
                        onClick: () => {
                          openTransfer(movable.length === selected.length ? "move" : "copy", true);
                        },
                      },
                    ]
                  : []),
              ],
            },
          ]}
        />
      )}
      <RemoveLosslessDialog
        items={removeItems}
        onClose={() => {
          setRemoveItems(null);
        }}
        onDone={selection.exit}
      />
      <MultitrackDialog
        request={multitrack}
        onClose={() => {
          setMultitrack(null);
        }}
        onDone={selection.exit}
      />
      <SongsTransferDialog
        request={transfer}
        onClose={() => {
          setTransfer(null);
        }}
        onDone={selection.exit}
      />
      <CreateSongModal projectId={project.id} opened={createOpen} onClose={create.close} />
    </Stack>
  );
}

function SongRow({
  song,
  index,
  draggable,
  selectable,
  selecting,
  selected,
  showCheckbox,
  onToggle,
}: {
  song: SongSummary;
  index: number;
  draggable: boolean;
  selectable: boolean;
  selecting: boolean;
  selected: boolean;
  showCheckbox: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  // Long-press on touch starts selection with this song (SPEC §26.1).
  const longPress = useLongPress(onToggle, selectable && !selecting);
  const offline = useOffline((st) => offlineItemFor(song.id, st.items) !== undefined);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: song.id,
    disabled: !draggable,
  });
  return (
    <Paper
      ref={setNodeRef}
      withBorder
      radius="md"
      data-testid="song-row"
      data-selected={selected || undefined}
      bg={selected ? "var(--mantine-primary-color-light)" : undefined}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
        position: "relative",
        zIndex: isDragging ? 1 : undefined,
      }}
    >
      <Group gap={0} wrap="nowrap">
        {showCheckbox && (
          <Center w={44} h={44} style={{ flex: "none" }}>
            <Checkbox
              checked={selected}
              onChange={onToggle}
              aria-label={t("selection.selectItem", { name: song.title })}
              data-testid="song-row-check"
            />
          </Center>
        )}
        {draggable && (
          <ActionIcon
            ref={setActivatorNodeRef}
            variant="subtle"
            color="gray"
            size={44}
            aria-label={t("songs.dragHandle", { title: song.title })}
            style={{ cursor: "grab", touchAction: "none" }}
            {...attributes}
            {...listeners}
          >
            <IconGripVertical size={18} />
          </ActionIcon>
        )}
        <UnstyledButton
          component={Link}
          to={`/songs/${song.id}`}
          p="sm"
          pl={draggable || showCheckbox ? 0 : "sm"}
          style={{ flex: 1, minWidth: 0, WebkitTouchCallout: "none" }}
          {...longPress}
          onClick={(e) => {
            // In selection mode a tap selects instead of opening the song.
            if (!selecting) return;
            e.preventDefault();
            onToggle();
          }}
          data-testid="song-row-link"
        >
          <Group gap="sm" wrap="nowrap">
            <Text c="dimmed" size="sm" w={24} ta="right" className="tabular-nums">
              {index + 1}
            </Text>
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text fw={600} truncate>
                {song.title}
              </Text>
              {(song.subtitle || song.key) && (
                <Text size="xs" c="dimmed" truncate>
                  {[song.subtitle, song.key].filter(Boolean).join(" · ")}
                </Text>
              )}
            </Stack>
            <Group gap={6} wrap="nowrap" style={{ flex: "none", marginInlineStart: "auto" }}>
              <ProcessingBadge processing={song.processing} />
              <SongLossyBadge lossy={song.lossy} />
              {offline && (
                <Tooltip label={t("offline.button.ready")}>
                  <IconCloudCheck
                    size={18}
                    color="var(--mantine-color-green-6)"
                    aria-label={t("offline.button.ready")}
                    data-testid="song-offline-badge"
                    style={{ flex: "none" }}
                  />
                </Tooltip>
              )}
            </Group>
          </Group>
        </UnstyledButton>
      </Group>
    </Paper>
  );
}
