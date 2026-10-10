import type { Song } from "@bandroom/shared";
import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import {
  IconDots,
  IconFileText,
  IconLink,
  IconLockAccess,
  IconSettings,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { openDocsPanel } from "../../documents/store";
import { FollowMenuItem } from "../../notifications/FollowButton";
import { OfflineMenuItem, OfflineModal } from "../../offline/OfflineButton";
import { SongLockMenuItem } from "./songLock";

/** Page sections the song's "⋯" menu jumps to (SPEC §31.2: share, documents, delete…). */
export const SONG_SECTION_IDS = {
  links: "song-links-section",
  access: "song-access-section",
  delete: "song-delete-section",
} as const;

/** Dialogs opened from the song's "⋯" menus: they outlive the menu's dropdown. */
export const useSongMenuUi = create<{ offline: boolean; preferences: boolean }>(() => ({
  offline: false,
  preferences: false,
}));

export function openSongPreferences(): void {
  useSongMenuUi.setState({ preferences: true });
}

export function closeSongPreferences(): void {
  useSongMenuUi.setState({ preferences: false });
}

function jumpTo(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * The song's actions as menu items (SPEC §31.2): on phones and in landscape also offline, follow
 * and lock (`compact`), which desktop shows as icons in the header; then documents and the jumps
 * to the page's sharing, access and delete sections.
 */
export function SongMenuItems({ song, compact }: { song: Song; compact: boolean }) {
  const { t } = useTranslation();
  const caps = new Set(song.access.capabilities);
  return (
    <>
      {compact && (
        <>
          <OfflineMenuItem
            target={{ kind: "song", id: song.id, title: song.title, projectId: song.project.id }}
            onOpen={() => {
              useSongMenuUi.setState({ offline: true });
            }}
          />
          <FollowMenuItem target="song" id={song.id} />
          <SongLockMenuItem song={song} />
          <Menu.Divider />
        </>
      )}
      <Menu.Item
        leftSection={<IconFileText size={14} />}
        onClick={() => {
          openDocsPanel(null);
        }}
        data-testid="song-more-docs"
      >
        {t("documents.panelTitle")}
      </Menu.Item>
      {caps.has("link.manage") && (
        <Menu.Item
          leftSection={<IconLink size={14} />}
          onClick={() => {
            jumpTo(SONG_SECTION_IDS.links);
          }}
        >
          {t("links.title")}
        </Menu.Item>
      )}
      {caps.has("grants.manage") && (
        <Menu.Item
          leftSection={<IconLockAccess size={14} />}
          onClick={() => {
            jumpTo(SONG_SECTION_IDS.access);
          }}
        >
          {t("grants.songTitle")}
        </Menu.Item>
      )}
      {caps.has("song.delete") && (
        <Menu.Item
          color="red"
          leftSection={<IconTrash size={14} />}
          onClick={() => {
            jumpTo(SONG_SECTION_IDS.delete);
          }}
        >
          {t("songs.delete")}
        </Menu.Item>
      )}
    </>
  );
}

/** The header's "⋯" (SPEC §31.2). */
export function SongMoreMenu({
  song,
  compact,
  size,
}: {
  song: Song;
  compact: boolean;
  size: number;
}) {
  const { t } = useTranslation();
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <Tooltip label={t("songs.moreActions")}>
          <ActionIcon
            size={size}
            variant="subtle"
            color="gray"
            aria-label={t("songs.moreActions")}
            data-testid="song-more"
          >
            <IconDots size={20} />
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown miw={220}>
        <SongMenuItems song={song} compact={compact} />
      </Menu.Dropdown>
    </Menu>
  );
}

/** "Song preferences": the gear that opens the song's own edit dialog (keeps `edit-song`). */
export function SongPreferencesButton({ song, size }: { song: Song; size: number }) {
  const { t } = useTranslation();
  if (!song.access.capabilities.includes("edit.any")) return null;
  return (
    <Tooltip label={t("songs.preferences")}>
      <ActionIcon
        size={size}
        variant="subtle"
        color="gray"
        disabled={!!song.editing}
        aria-label={t("songs.preferences")}
        onClick={openSongPreferences}
        data-testid="edit-song"
      >
        <IconSettings size={20} />
      </ActionIcon>
    </Tooltip>
  );
}

/** The offline estimate opened from a "⋯" menu. */
export function SongMenuDialogs({ song }: { song: Song }) {
  const offline = useSongMenuUi((s) => s.offline);
  if (!offline) return null;
  return (
    <OfflineModal
      target={{ kind: "song", id: song.id, title: song.title, projectId: song.project.id }}
      onClose={() => {
        useSongMenuUi.setState({ offline: false });
      }}
    />
  );
}
