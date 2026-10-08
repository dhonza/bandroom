import {
  canActOn,
  canDeleteContent,
  canRemoveLossless,
  deleteTrackVersion,
  listTrackVersions,
  reorderTrackVersions,
  setCurrentTrackVersion,
  updateTrackVersion,
  type BatchItems,
  type Song,
  type StackVersion,
  type Track,
} from "@bandroom/shared";
import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Group,
  Loader,
  Menu,
  Modal,
  Paper,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconArrowDown,
  IconArrowsExchange,
  IconArrowUp,
  IconDiamondOff,
  IconDots,
  IconDownload,
  IconHeadphones,
  IconListCheck,
  IconPencil,
  IconStar,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { useCurrentUser } from "../../auth/session";
import { useFormatters } from "../../i18n/format";
import { storedQuality } from "../../lib/audioFormat";
import { downloadUrl, formatDuration } from "../../lib/media";
import { PHONE_QUERY } from "../../shell/mediaQueries";
import { songKeys } from "../library/queries";
import { SelectionBar } from "../../selection/SelectionBar";
import { versionSelection } from "../../selection/store";
import { useLongPress } from "../../selection/useLongPress";
import { useSelection } from "../../selection/useSelection";
import { useBatchDelete } from "../../trash/queries";
import { FINE_POINTER_QUERY } from "../project/SongsList";
import { LossyBadge, useLossyReason } from "../../lossless/LossyBadge";
import { RemoveLosslessDialog } from "../../lossless/RemoveLosslessDialog";

/** Rehearse-mode actions in the stack: listen to a version for me, or A/B it (SPEC §11.3). */
export interface VersionStackRehearse {
  playingId: string;
  onListen: (v: StackVersion, all: StackVersion[]) => void;
  onAB: (v: StackVersion, all: StackVersion[]) => void;
}

/**
 * Version stack of a track (SPEC §11.3): number, label, uploader, date, notes, current badge;
 * make current (editor), edit label/notes (own/any), reorder (editor), download, delete.
 */
export function VersionStackModal({
  track,
  song,
  opened,
  onClose,
  rehearse,
}: {
  track: Track;
  song: Song;
  opened: boolean;
  onClose: () => void;
  rehearse?: VersionStackRehearse;
}) {
  const { t } = useTranslation();
  const isPhone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const qc = useQueryClient();
  const apiError = useApiError();
  const key = songKeys.versions(song.id, track.id);
  const versions = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api(listTrackVersions, { params: { id: track.id } }, { signal }),
    enabled: opened,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: songKeys.detail(song.id) });
  };
  const onError = (err: unknown) => notifications.show({ color: "red", message: apiError(err) });
  const makeCurrent = useMutation({
    mutationFn: (versionId: string) =>
      api(setCurrentTrackVersion, { params: { id: track.id }, body: { versionId } }),
    onSuccess: refresh,
    onError,
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) =>
      api(reorderTrackVersions, { params: { id: track.id }, body: { versionIds: ids } }),
    onSuccess: refresh,
    onError,
  });
  const list = versions.data?.versions ?? [];
  const canReorder = song.access.capabilities.includes("edit.any");
  const user = useCurrentUser();
  const finePointer = useMediaQuery(FINE_POINTER_QUERY, false);
  const selection = useSelection(
    versionSelection,
    `track:${track.id}`,
    list.map((v) => v.id),
  );
  const batchDelete = useBatchDelete();
  const [deleting, setDeleting] = useState(false);
  // Batch actions in the stack (SPEC §26.1): delete own versions (contributors) or any (editors).
  const canDeleteVersion = (v: StackVersion) =>
    canDeleteContent(song.access.role, "version", v.uploadedBy === user.id);
  // Remove full quality (SPEC §26.4): managers any version, uploaders their own; only versions
  // that still have their full-quality files.
  const canRemoveVersion = (v: StackVersion) =>
    v.archived === null && canRemoveLossless(song.access.role, v.uploadedBy === user.id);
  const [removeItems, setRemoveItems] = useState<BatchItems | null>(null);
  const selectable = list.some((v) => canDeleteVersion(v) || canRemoveVersion(v));
  const selected = list.filter((v) => selection.ids.has(v.id));
  const deletable = selected.filter(canDeleteVersion);
  const removable = selected.filter(canRemoveVersion);
  const deleteSelected = async () => {
    setDeleting(true);
    const ok = await batchDelete({ versions: deletable.map((v) => v.id) });
    setDeleting(false);
    if (ok) {
      selection.exit();
      refresh();
    }
  };
  const move = (i: number, dir: -1 | 1) => {
    const ids = list.map((v) => v.id);
    const j = i + dir;
    const a = ids[i];
    const b = ids[j];
    if (a === undefined || b === undefined) return;
    ids[i] = b;
    ids[j] = a;
    reorder.mutate(ids);
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t("versions.title", { track: track.name })}
      fullScreen={isPhone}
      size="lg"
    >
      {versions.isPending ? (
        <Loader size="sm" />
      ) : (
        <Stack gap="xs" data-testid="version-stack">
          {selectable && !selection.active && list.length > 1 && (
            <Group justify="flex-end">
              <Button
                variant="default"
                size="compact-sm"
                h={44}
                leftSection={<IconListCheck size={16} />}
                onClick={() => {
                  selection.start();
                }}
                data-testid="versions-select"
              >
                {t("selection.select")}
              </Button>
            </Group>
          )}
          {list.map((v, i) => (
            <VersionItem
              key={v.id}
              version={v}
              song={song}
              selection={
                selectable
                  ? {
                      selecting: selection.active,
                      selected: selection.ids.has(v.id),
                      showCheckbox: selection.active || finePointer,
                      onToggle: () => {
                        selection.toggle(v.id);
                      },
                    }
                  : undefined
              }
              canMakeCurrent={song.access.capabilities.includes("version.setCurrent")}
              onMakeCurrent={() => {
                makeCurrent.mutate(v.id);
              }}
              canReorder={canReorder}
              first={i === 0}
              last={i === list.length - 1}
              onMove={(dir) => {
                move(i, dir);
              }}
              onChanged={refresh}
              onRemoveLossless={
                canRemoveVersion(v) && v.status === "ready"
                  ? () => {
                      setRemoveItems({ versions: [v.id] });
                    }
                  : undefined
              }
              {...(rehearse && {
                rehearse: {
                  playing: rehearse.playingId === v.id,
                  onListen: () => {
                    rehearse.onListen(v, list);
                    onClose();
                  },
                  onAB: () => {
                    rehearse.onAB(v, list);
                    onClose();
                  },
                },
              })}
            />
          ))}
          {selection.active && (
            <SelectionBar
              testId="versions-selection-bar"
              inModal
              count={selected.length}
              total={list.length}
              onSelectAll={() => {
                selection.setAll(list.map((v) => v.id));
              }}
              onExit={selection.exit}
              actions={[
                {
                  key: "delete",
                  label: t("selection.delete"),
                  icon: <IconTrash size={16} />,
                  color: "red",
                  allowed: deletable.length,
                  reason: t("selection.notYours", { count: selected.length - deletable.length }),
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
                  reason: t("lossless.notAllowed", {
                    count: selected.length - removable.length,
                  }),
                  onClick: () => {
                    setRemoveItems({ versions: removable.map((v) => v.id) });
                  },
                },
              ]}
            />
          )}
        </Stack>
      )}
      <RemoveLosslessDialog
        items={removeItems}
        onClose={() => {
          setRemoveItems(null);
        }}
        onDone={() => {
          selection.exit();
          refresh();
        }}
      />
    </Modal>
  );
}

/** A version's part in the stack's selection (SPEC §26.1). */
interface VersionItemSelection {
  selecting: boolean;
  selected: boolean;
  showCheckbox: boolean;
  onToggle: () => void;
}

function VersionItem({
  version: v,
  song,
  selection,
  canMakeCurrent,
  onMakeCurrent,
  canReorder,
  first,
  last,
  onMove,
  onChanged,
  onRemoveLossless,
  rehearse,
}: {
  version: StackVersion;
  song: Song;
  canMakeCurrent: boolean;
  onMakeCurrent: () => void;
  canReorder: boolean;
  first: boolean;
  last: boolean;
  onMove: (dir: -1 | 1) => void;
  onChanged: () => void;
  /** Set when the user may remove this version's full quality (SPEC §26.4). */
  onRemoveLossless?: (() => void) | undefined;
  rehearse?: { playing: boolean; onListen: () => void; onAB: () => void };
  selection?: VersionItemSelection | undefined;
}) {
  const { t } = useTranslation();
  const user = useCurrentUser();
  const fmt = useFormatters();
  const apiError = useApiError();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(v.label);
  const [notes, setNotes] = useState(v.notes);
  const lossyReason = useLossyReason();
  const own = v.uploadedBy === user.id;
  const canEdit = canActOn(song.access.role, "edit", own);
  const canDelete = canActOn(song.access.role, "delete", own);
  const onError = (err: unknown) => notifications.show({ color: "red", message: apiError(err) });
  const save = useMutation({
    mutationFn: () => api(updateTrackVersion, { params: { id: v.id }, body: { label, notes } }),
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
    onError,
  });
  const del = useMutation({
    mutationFn: () => api(deleteTrackVersion, { params: { id: v.id } }),
    onSuccess: onChanged,
    onError,
  });

  const selecting = selection?.selecting === true;
  const longPress = useLongPress(
    () => selection?.onToggle(),
    selection !== undefined && !selecting,
  );

  return (
    <Paper
      withBorder
      radius="md"
      p="sm"
      data-testid="version-item"
      data-number={v.number}
      data-selected={selection?.selected || undefined}
      bg={selection?.selected ? "var(--mantine-primary-color-light)" : undefined}
      {...longPress}
      onClickCapture={(e) => {
        longPress.onClickCapture(e);
        if (!selecting || e.isPropagationStopped()) return;
        // In selection mode a tap anywhere on the version (buttons included) selects it.
        e.preventDefault();
        e.stopPropagation();
        selection.onToggle();
      }}
      style={{ cursor: selecting ? "pointer" : undefined, WebkitTouchCallout: "none" }}
    >
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        {selection?.showCheckbox && (
          <Checkbox
            checked={selection.selected}
            onChange={selection.onToggle}
            aria-label={t("selection.selectItem", { name: `v${String(v.number)}` })}
            styles={{ body: { minHeight: 44, minWidth: 32, alignItems: "center" } }}
            data-testid="version-item-check"
          />
        )}
        <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
          <Group gap={6} wrap="wrap">
            <Badge variant="light" color="gray">
              {t("tracks.versionBadge", { number: v.number })}
            </Badge>
            {v.isCurrent && <Badge color="teal">{t("versions.current")}</Badge>}
            {rehearse?.playing && (
              <Badge color="blue" variant="filled">
                {t("rehearse.versionPlaying")}
              </Badge>
            )}
            {v.status !== "ready" && (
              <Badge variant="outline" color={v.status === "failed" ? "red" : "gray"}>
                {v.status === "failed" ? t("tracks.failed") : t("versions.processing")}
              </Badge>
            )}
            <LossyBadge version={v} size="sm" />
            <Text fw={600} size="sm" truncate>
              {v.label || t("versions.noLabel")}
            </Text>
          </Group>
          <Text size="xs" c="dimmed">
            {[
              v.uploaderName ?? t("versions.unknownUploader"),
              fmt.dateTime(v.createdAt),
              v.media ? formatDuration(v.media.durationSec) : null,
              storedQuality(v, t),
              v.originalFilename,
              v.storedBytes !== undefined
                ? t("storage.stored", { size: fmt.bytes(v.storedBytes) })
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          {v.archived && (
            <Text size="xs" c="dimmed" data-testid="version-archived">
              {lossyReason(v)}
            </Text>
          )}
          {rehearse && !rehearse.playing && v.status === "ready" && (
            <Group gap="xs" mt={4}>
              <Button
                size="sm"
                variant="light"
                leftSection={<IconHeadphones size={16} />}
                onClick={rehearse.onListen}
                data-testid="version-listen"
              >
                {t("rehearse.listenVersion")}
              </Button>
              <Button
                size="sm"
                variant="default"
                leftSection={<IconArrowsExchange size={16} />}
                onClick={rehearse.onAB}
                data-testid="version-ab"
              >
                {t("rehearse.abWithPlaying")}
              </Button>
            </Group>
          )}
          {v.notes && !editing && (
            <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
              {v.notes}
            </Text>
          )}
          {editing && (
            <Stack gap="xs" mt={4}>
              <TextInput
                label={t("versions.label")}
                value={label}
                maxLength={120}
                onChange={(e) => {
                  setLabel(e.currentTarget.value);
                }}
              />
              <Textarea
                label={t("versions.notes")}
                value={notes}
                autosize
                minRows={2}
                maxLength={5000}
                onChange={(e) => {
                  setNotes(e.currentTarget.value);
                }}
              />
              <Group justify="flex-end">
                <Button
                  variant="default"
                  size="xs"
                  onClick={() => {
                    setEditing(false);
                  }}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  size="xs"
                  loading={save.isPending}
                  onClick={() => {
                    save.mutate();
                  }}
                >
                  {t("common.save")}
                </Button>
              </Group>
            </Stack>
          )}
        </Stack>
        {/* The actions step aside while selecting (a tap selects the version). */}
        <Group gap={0} wrap="nowrap" display={selecting ? "none" : undefined}>
          {canMakeCurrent && !v.isCurrent && v.status === "ready" && (
            <Button
              size="compact-sm"
              variant="light"
              mih={44}
              leftSection={<IconStar size={14} />}
              onClick={onMakeCurrent}
              data-testid="make-current"
            >
              {t("versions.makeCurrent")}
            </Button>
          )}
          {canReorder && (
            <>
              <ActionIcon
                variant="subtle"
                color="gray"
                size={44}
                disabled={first}
                aria-label={t("versions.moveUp")}
                onClick={() => {
                  onMove(-1);
                }}
              >
                <IconArrowUp size={16} />
              </ActionIcon>
              <ActionIcon
                variant="subtle"
                color="gray"
                size={44}
                disabled={last}
                aria-label={t("versions.moveDown")}
                onClick={() => {
                  onMove(1);
                }}
              >
                <IconArrowDown size={16} />
              </ActionIcon>
            </>
          )}
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon
                variant="subtle"
                color="gray"
                size={44}
                aria-label={t("common.actions")}
                data-testid="version-actions"
              >
                <IconDots size={18} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {canEdit && (
                <Menu.Item
                  leftSection={<IconPencil size={16} />}
                  onClick={() => {
                    setEditing(true);
                  }}
                >
                  {t("versions.edit")}
                </Menu.Item>
              )}
              {v.downloads.map((f) => (
                <Menu.Item
                  key={f}
                  component="a"
                  href={downloadUrl(v.id, f)}
                  download
                  leftSection={<IconDownload size={16} />}
                >
                  {t(`tracks.download.${f}`)}
                </Menu.Item>
              ))}
              {onRemoveLossless && (
                <Menu.Item
                  leftSection={<IconDiamondOff size={16} />}
                  onClick={onRemoveLossless}
                  data-testid="remove-lossless-version"
                >
                  {t("lossless.action")}
                </Menu.Item>
              )}
              {canDelete && (
                <Menu.Item
                  color="red"
                  leftSection={<IconTrash size={16} />}
                  onClick={() => {
                    del.mutate();
                  }}
                  data-testid="delete-version"
                >
                  {t("versions.delete")}
                </Menu.Item>
              )}
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>
    </Paper>
  );
}
