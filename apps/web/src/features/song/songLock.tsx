import {
  editLockedOut,
  lockedOut,
  lockSong,
  unlockSong,
  type Capability,
  type Song,
} from "@bandroom/shared";
import { ActionIcon, Alert, Box, Menu, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconLock, IconLockOpen } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { useFormatters } from "../../i18n/format";
import { songKeys } from "../library/queries";

/**
 * Song lock (SPEC §25.12). The server refuses frozen changes (`SONG_LOCKED`); the client keeps
 * the controls visible but disabled, with a "Song is locked" hint.
 */
export function isSongLocked(song: Pick<Song, "locked">): boolean {
  return song.locked !== null;
}

/** "Locked by Jana since 5 Oct 2026, 14:03" (or without the name for link visitors). */
export function useLockLabel(song: Pick<Song, "locked">): string | null {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const lock = song.locked;
  if (!lock) return null;
  const date = fmt.dateTime(lock.at);
  return lock.by.displayName
    ? t("songs.lock.lockedBy", { name: lock.by.displayName, date })
    : t("songs.lock.lockedSince", { date });
}

/**
 * Which lock disables a control needing `capability`: an open edit session (SPEC §24.7) or the
 * song lock (SPEC §25.12); null when neither does.
 */
export function frozenBy(
  song: Pick<Song, "locked" | "editing">,
  capability: Capability,
): "editing" | "locked" | null {
  if (editLockedOut(!!song.editing, capability)) return "editing";
  if (lockedOut(song.locked !== null, capability)) return "locked";
  return null;
}

/**
 * Wraps a control that a lock disables: the tooltip explains why (`reason`: the song lock or an
 * edit session). The wrapper takes the hover, since a disabled button gets no pointer events.
 */
export function LockedHint({
  locked,
  reason = "locked",
  children,
}: {
  locked: boolean;
  reason?: "locked" | "editing" | null;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  if (!locked) return children;
  const label = reason === "editing" ? t("edit.editing") : t("songs.lock.locked");
  return (
    <Tooltip label={label} events={{ hover: true, focus: true, touch: true }}>
      <span style={{ display: "inline-flex" }} data-testid="song-locked-hint">
        {children}
      </span>
    </Tooltip>
  );
}

/**
 * Lock toggle in the song header: editors switch it; everyone else sees the lock icon while the
 * song is locked.
 */
export function SongLockButton({ song, size = 44 }: { song: Song; size?: number }) {
  const { t } = useTranslation();
  const { locked, label, canToggle, toggle } = useSongLockToggle(song);
  if (!canToggle && !locked) return null;
  // An edit session freezes the song lock too (SPEC §24.7).
  const editFrozen = !!song.editing;
  const icon = locked ? <IconLock size={20} /> : <IconLockOpen size={20} />;
  const tip = locked
    ? `${label ?? t("songs.lock.locked")}${canToggle ? ` · ${t("songs.lock.unlock")}` : ""}`
    : t("songs.lock.lockHint");
  return (
    <Tooltip label={tip} multiline w={280}>
      {canToggle ? (
        <ActionIcon
          size={size}
          variant={locked ? "light" : "subtle"}
          color={locked ? "yellow" : "gray"}
          loading={toggle.isPending}
          disabled={editFrozen}
          aria-pressed={locked}
          aria-label={locked ? t("songs.lock.unlock") : t("songs.lock.lock")}
          onClick={() => {
            toggle.mutate();
          }}
          data-testid="song-lock-toggle"
        >
          {icon}
        </ActionIcon>
      ) : (
        <ActionIcon
          size={size}
          variant="light"
          color="yellow"
          component="span"
          role="img"
          aria-label={label ?? t("songs.lock.locked")}
          data-testid="song-lock-state"
        >
          {icon}
        </ActionIcon>
      )}
    </Tooltip>
  );
}

/** The lock as an item of a "⋯" menu (phones and landscape, SPEC §31.2, §31.6). */
export function SongLockMenuItem({ song }: { song: Song }) {
  const { t } = useTranslation();
  const { locked, label, canToggle, toggle } = useSongLockToggle(song);
  if (!canToggle && !locked) return null;
  if (!canToggle) {
    return (
      <Menu.Item disabled leftSection={<IconLock size={14} />} data-testid="song-lock-state">
        {label ?? t("songs.lock.locked")}
      </Menu.Item>
    );
  }
  return (
    <Menu.Item
      leftSection={locked ? <IconCheck size={14} /> : <Box w={14} />}
      rightSection={locked ? <IconLock size={14} /> : <IconLockOpen size={14} />}
      disabled={!!song.editing || toggle.isPending}
      onClick={() => {
        toggle.mutate();
      }}
      role="menuitemcheckbox"
      aria-checked={locked}
      data-testid="song-lock-toggle"
    >
      {t("songs.lock.lock")}
    </Menu.Item>
  );
}

function useSongLockToggle(song: Song) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const apiError = useApiError();
  const locked = isSongLocked(song);
  const label = useLockLabel(song);
  const canToggle = song.access.capabilities.includes("edit.any");
  const toggle = useMutation({
    mutationFn: () => api(locked ? unlockSong : lockSong, { params: { id: song.id } }),
    onSuccess: (res) => {
      qc.setQueryData(songKeys.detail(song.id), res);
      notifications.show({
        color: "teal",
        message: res.song.locked ? t("songs.lock.lockedDone") : t("songs.lock.unlockedDone"),
      });
    },
    onError: (err) => {
      notifications.show({ color: "red", message: apiError(err) });
    },
  });
  return { locked, label, canToggle, toggle };
}

/** Banner on the song page while it is locked. */
export function SongLockBanner({ song }: { song: Song }) {
  const { t } = useTranslation();
  const label = useLockLabel(song);
  if (!song.locked) return null;
  const canToggle = song.access.capabilities.includes("edit.any");
  return (
    <Alert
      color="yellow"
      variant="light"
      icon={<IconLock size={18} />}
      title={label}
      data-testid="song-lock-banner"
    >
      {t("songs.lock.banner")}
      {canToggle ? ` ${t("songs.lock.bannerEditor")}` : ""}
    </Alert>
  );
}
