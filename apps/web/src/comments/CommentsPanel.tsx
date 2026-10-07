import type { Comment, Song, Track } from "@bandroom/shared";
import {
  ActionIcon,
  Alert,
  Button,
  Chip,
  Drawer,
  Group,
  Menu,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconDownload, IconMessageCircle, IconMessagePlus } from "@tabler/icons-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSongTracks } from "../features/library/queries";
import { DocsButton } from "../documents/DocsPanel";
import { commentAtPlayhead } from "./actions";
import { useCommentDeepLink } from "./useCommentDeepLink";
import { useLinkMode } from "../links/linkMode";
import { DESKTOP_QUERY } from "../shell/mediaQueries";
import { CommentItem } from "./CommentItem";
import { LockedHint } from "../features/song/songLock";
import { Composer } from "./Composer";
import { buildCommentExport, download } from "./export";
import { authorsOf, filterComments, mentionUsernames, openCount, sortComments } from "./model";
import { useCommentPermissions, useMentionable, useSongComments } from "./queries";
import { setFilters, setPanelOpen, setSort, useCommentsUi } from "./store";

function useSongTrackList(songId: string): Track[] {
  return useSongTracks(songId).data?.tracks ?? [];
}

/**
 * Comment buttons for the song page ("Comments (N)" and "Comment at playhead") and the panel
 * itself.
 */
export function SongComments({ song }: { song: Song }) {
  const { t } = useTranslation();
  const { comments, truncated } = useSongComments(song.id);
  const { mayComment, locked } = useCommentPermissions(song);
  const n = openCount(comments);
  useCommentDeepLink(comments);
  const linkMode = useLinkMode((s) => s.token !== null);
  const linkView = useLinkMode((s) => s.view);
  // A link without comments (none allowed, band comments hidden) shows no comment tools.
  if (linkView && !linkView.allowComments && !linkView.showComments) return null;
  return (
    <>
      <Group gap="xs" wrap="wrap" data-testid="comment-toolbar">
        <Button
          variant="light"
          h={44}
          leftSection={<IconMessageCircle size={18} />}
          onClick={() => {
            setPanelOpen(true);
          }}
          data-testid="open-comments"
          aria-label={t("comments.openPanel", { count: n })}
        >
          {t("comments.button", { count: n })}
        </Button>
        {mayComment && (
          <LockedHint locked={locked}>
            <Button
              variant="default"
              h={44}
              leftSection={<IconMessagePlus size={18} />}
              disabled={locked}
              onClick={() => {
                commentAtPlayhead();
              }}
              data-testid="comment-at-playhead"
            >
              {t("comments.atPlayhead")}
            </Button>
          </LockedHint>
        )}
        {!linkMode && <DocsButton song={song} />}
      </Group>
      <CommentsPanel song={song} comments={comments} truncated={truncated} />
    </>
  );
}

function CommentsPanel({
  song,
  comments,
  truncated,
}: {
  song: Song;
  comments: readonly Comment[];
  truncated: boolean;
}) {
  const { t } = useTranslation();
  const desktop = useMediaQuery(DESKTOP_QUERY, false, { getInitialValueInEffect: false });
  const open = useCommentsUi((s) => s.panelOpen);
  const filters = useCommentsUi((s) => s.filters);
  const sort = useCommentsUi((s) => s.sort);
  const composer = useCommentsUi((s) => s.composer);
  const linkMode = useLinkMode((s) => s.token !== null);
  const { canComment, userId, mayComment, locked } = useCommentPermissions(song);
  const tracks = useSongTrackList(song.id);
  const users = useMentionable(song.id, canComment).data?.users;
  // Mentions of every user who can view the song are highlighted; viewers fall back to authors.
  const usernames = useMemo(() => mentionUsernames(users, comments), [users, comments]);
  const shown = useMemo(
    () => sortComments(filterComments(comments, filters, userId), sort),
    [comments, filters, userId, sort],
  );
  const hiddenResolved = comments.filter((c) => c.resolvedAt !== null).length;
  const authors = useMemo(() => authorsOf(comments), [comments]);
  const visibleTracks = tracks.filter((x) => comments.some((c) => c.trackId === x.id));

  const exportAs = (format: "md" | "csv") => {
    const file = buildCommentExport(
      format,
      `${song.title} – ${t("comments.title")}`,
      comments,
      tracks,
      {
        imported: t("comments.imported"),
        deletedUser: t("comments.deletedUser"),
        open: t("comments.statusOpen"),
        resolved: t("comments.resolved"),
        deleted: t("comments.deletedComment"),
        header: ["time", "author", "track", "text", "status"].map((k) =>
          t(`comments.columns.${k as "time"}`),
        ),
      },
    );
    download(file.name, file.type, file.text);
  };

  return (
    <Drawer
      opened={open}
      onClose={() => {
        setPanelOpen(false);
      }}
      position={desktop ? "right" : "bottom"}
      size={desktop ? 420 : "85%"}
      title={t("comments.title")}
      withOverlay={!desktop}
      lockScroll={!desktop}
      trapFocus={!desktop}
      closeOnClickOutside={!desktop}
      closeButtonProps={
        { "aria-label": t("common.close"), "data-testid": "comments-close" } as object
      }
      data-testid="comments-panel"
    >
      <Stack gap="sm" pb="md">
        <Group gap="xs" wrap="wrap" justify="space-between">
          {mayComment && (
            <LockedHint locked={locked}>
              <Button
                h={44}
                variant="light"
                leftSection={<IconMessagePlus size={18} />}
                disabled={locked}
                onClick={() => {
                  commentAtPlayhead();
                }}
                data-testid="panel-comment-at-playhead"
              >
                {t("comments.atPlayhead")}
              </Button>
            </LockedHint>
          )}
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon
                size={44}
                variant="subtle"
                color="gray"
                aria-label={t("comments.export")}
                data-testid="comments-export"
              >
                <IconDownload size={18} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>{t("comments.export")}</Menu.Label>
              <Menu.Item
                onClick={() => {
                  exportAs("md");
                }}
                data-testid="export-md"
              >
                {t("comments.exportMarkdown")}
              </Menu.Item>
              <Menu.Item
                onClick={() => {
                  exportAs("csv");
                }}
                data-testid="export-csv"
              >
                {t("comments.exportCsv")}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>

        {mayComment && locked && (
          <Alert color="yellow" variant="light" data-testid="comments-locked">
            {t("songs.lock.banner")}
          </Alert>
        )}
        {composer && canComment && <Composer song={song} tracks={tracks} />}

        {truncated && (
          <Alert color="yellow" data-testid="comments-truncated">
            {t("comments.truncated", { n: comments.length })}
          </Alert>
        )}

        <Group gap="xs" wrap="wrap">
          <SegmentedControl
            size="sm"
            value={sort}
            onChange={(v) => {
              setSort(v === "date" ? "date" : "time");
            }}
            data={[
              { value: "time", label: t("comments.sortTime") },
              { value: "date", label: t("comments.sortDate") },
            ]}
            aria-label={t("comments.sort")}
            data-testid="comments-sort"
          />
          {!linkMode && (
            <Chip
              size="sm"
              checked={filters.mentionsMe}
              onChange={(v) => {
                setFilters({ mentionsMe: v });
              }}
              data-testid="filter-mentions"
            >
              {t("comments.mentionsMe")}
            </Chip>
          )}
        </Group>
        <Group gap="xs" wrap="wrap" grow>
          {authors.length > 1 && (
            <Select
              size="sm"
              placeholder={t("comments.allAuthors")}
              aria-label={t("comments.author")}
              clearable
              value={filters.author}
              onChange={(v) => {
                setFilters({ author: v });
              }}
              data={authors.map((a) => ({ value: a.key, label: a.name }))}
              comboboxProps={{ withinPortal: true }}
              style={{ minWidth: 140 }}
            />
          )}
          {visibleTracks.length > 0 && (
            <Select
              size="sm"
              placeholder={t("comments.allTracks")}
              aria-label={t("comments.track")}
              clearable
              value={filters.track}
              onChange={(v) => {
                setFilters({ track: v });
              }}
              data={[
                { value: "song", label: t("comments.wholeSong") },
                ...visibleTracks.map((x) => ({ value: x.id, label: x.name })),
              ]}
              comboboxProps={{ withinPortal: true }}
              style={{ minWidth: 140 }}
            />
          )}
        </Group>
        <Switch
          checked={filters.showResolved}
          onChange={(e) => {
            setFilters({ showResolved: e.currentTarget.checked });
          }}
          label={t("comments.showResolved", { count: hiddenResolved })}
          data-testid="filter-resolved"
        />

        {shown.length === 0 ? (
          <Text c="dimmed" size="sm" data-testid="comments-empty">
            {comments.length === 0 ? t("comments.empty") : t("comments.noneMatch")}
          </Text>
        ) : (
          <Stack gap="sm" data-testid="comments-list">
            {shown.map((c) => (
              <CommentItem
                key={c.id}
                comment={c}
                song={song}
                tracks={tracks}
                usernames={usernames}
              />
            ))}
          </Stack>
        )}
      </Stack>
    </Drawer>
  );
}
