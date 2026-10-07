import {
  REACTION_EMOJIS,
  type Comment,
  type CommentReply,
  type Song,
  type Track,
} from "@bandroom/shared";
import {
  ActionIcon,
  Avatar,
  Badge,
  Box,
  Button,
  Group,
  Menu,
  Paper,
  Popover,
  Stack,
  Text,
} from "@mantine/core";
import {
  IconArrowBackUp,
  IconCheck,
  IconDots,
  IconMoodSmile,
  IconPencil,
  IconRepeat,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useFormatters } from "../i18n/format";
import { formatClock } from "../player/format";
import { loopComment, tapComment } from "./actions";
import { CommentBody } from "./CommentBody";
import { CommentEditor } from "./CommentEditor";
import { ContextBadge } from "./ContextBadge";
import { isPending } from "../offline/pending";
import { useInkOnColor } from "../theme/ink";
import { authorColor, initials } from "./model";
import { useCommentActions, useCommentPermissions } from "./queries";
import { useCommentsUi } from "./store";

function authorName(t: TFunction, c: CommentReply): string {
  return c.author.name || t("comments.deletedUser");
}

/** Reactions: existing ones as toggles plus the fixed set in a popover (SPEC §8). */
function Reactions({
  c,
  songId,
  canReact,
}: {
  c: CommentReply;
  songId: string;
  canReact: boolean;
}) {
  const { t } = useTranslation();
  const { react } = useCommentActions(songId);
  const [open, setOpen] = useState(false);
  if (c.reactions.length === 0 && !canReact) return null;
  return (
    <Group gap={4} wrap="wrap" data-testid="comment-reactions">
      {c.reactions.map((r) => (
        <Button
          key={r.emoji}
          size="compact-sm"
          h={32}
          miw={44}
          variant={r.mine ? "light" : "default"}
          disabled={!canReact}
          onClick={() => void react(c, r.emoji as (typeof REACTION_EMOJIS)[number], !r.mine)}
          aria-pressed={r.mine}
          aria-label={t("comments.reactionLabel", { emoji: r.emoji, count: r.count })}
          data-testid="comment-reaction"
        >
          {r.emoji} {r.count}
        </Button>
      ))}
      {canReact && (
        <Popover opened={open} onChange={setOpen} position="top-start" withinPortal>
          <Popover.Target>
            <ActionIcon
              size={44}
              variant="subtle"
              color="gray"
              aria-label={t("comments.react")}
              onClick={() => {
                setOpen((o) => !o);
              }}
              data-testid="comment-react"
            >
              <IconMoodSmile size={18} />
            </ActionIcon>
          </Popover.Target>
          <Popover.Dropdown p={4}>
            <Group gap={2} wrap="wrap" maw={220}>
              {REACTION_EMOJIS.map((e) => {
                const mine = c.reactions.some((r) => r.emoji === e && r.mine);
                return (
                  <ActionIcon
                    key={e}
                    size={44}
                    variant={mine ? "light" : "subtle"}
                    color="gray"
                    aria-label={e}
                    onClick={() => {
                      setOpen(false);
                      void react(c, e, !mine);
                    }}
                    data-testid="reaction-option"
                  >
                    <Text size="lg">{e}</Text>
                  </ActionIcon>
                );
              })}
            </Group>
          </Popover.Dropdown>
        </Popover>
      )}
    </Group>
  );
}

/** Header, body, reactions and own/editor actions of a comment or reply. */
function CommentContent({
  c,
  song,
  usernames,
  top,
  onReply,
}: {
  c: CommentReply;
  song: Song;
  usernames: readonly string[];
  top: Comment;
  onReply?: () => void;
}) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const { canComment, canReact, canModify } = useCommentPermissions(song);
  const { edit, remove, resolve } = useCommentActions(song.id);
  const [editing, setEditing] = useState(false);
  const name = authorName(t, c);
  // Written offline and not sent yet: only replies until the server has it (SPEC §13).
  const pending = isPending(c.id);
  const modifiable = !c.deleted && !pending && canModify(c);
  const isTop = c.parentId === null;
  const ink = useInkOnColor();
  return (
    <Group align="flex-start" gap="sm" wrap="nowrap">
      <Avatar
        size={isTop ? 32 : 26}
        radius="xl"
        color={authorColor(c.author)}
        variant="filled"
        styles={{ placeholder: { color: `var(--mantine-color-${ink(authorColor(c.author))})` } }}
      >
        {initials(name)}
      </Avatar>
      <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
        <Group gap={6} wrap="wrap">
          <Text size="sm" fw={700}>
            {c.deleted ? t("comments.deletedComment") : name}
          </Text>
          {c.author.kind === "imported" && !c.deleted && (
            <Text size="xs" c="dimmed">
              {t("comments.imported")}
            </Text>
          )}
          {c.author.kind === "link" && !c.deleted && (
            <Badge size="xs" variant="light" color="gray" data-testid="comment-via-link">
              {t("comments.viaLink")}
            </Badge>
          )}
          <Text size="xs" c="dimmed" title={fmt.dateTime(c.createdAt)}>
            {fmt.relative(c.createdAt)}
          </Text>
          {pending && (
            <Badge size="xs" variant="light" color="yellow" data-testid="comment-pending">
              {t("offline.pendingSync")}
            </Badge>
          )}
          {c.editedAt !== null && !c.deleted && (
            <Text size="xs" c="dimmed" data-testid="comment-edited">
              {t("comments.edited")}
            </Text>
          )}
        </Group>
        {editing ? (
          <CommentEditor
            songId={song.id}
            initial={c.body}
            submitLabel={t("common.save")}
            testId="comment-edit-input"
            onCancel={() => {
              setEditing(false);
            }}
            onSubmit={async (text) => {
              const ok = await edit(c, text);
              if (ok) setEditing(false);
              return ok;
            }}
          />
        ) : c.deleted ? (
          <Text size="sm" c="dimmed" fs="italic">
            {t("comments.deletedBody")}
          </Text>
        ) : (
          <CommentBody body={c.body} usernames={usernames} />
        )}
        {!c.deleted && !editing && (
          <Group gap={4} wrap="wrap" justify="space-between">
            <Reactions c={c} songId={song.id} canReact={canReact && !pending} />
            <Group gap={0} wrap="nowrap">
              {onReply && canComment && (
                <Button
                  variant="subtle"
                  size="compact-sm"
                  h={44}
                  leftSection={<IconArrowBackUp size={16} />}
                  onClick={onReply}
                  data-testid="comment-reply"
                >
                  {t("comments.reply")}
                </Button>
              )}
              {isTop && modifiable && (
                <Button
                  variant="subtle"
                  size="compact-sm"
                  h={44}
                  color={top.resolvedAt !== null ? "gray" : "green"}
                  leftSection={<IconCheck size={16} />}
                  onClick={() => void resolve(top, top.resolvedAt === null)}
                  data-testid="comment-resolve"
                >
                  {top.resolvedAt !== null ? t("comments.reopen") : t("comments.resolve")}
                </Button>
              )}
              {modifiable && (
                <Menu position="bottom-end" withinPortal>
                  <Menu.Target>
                    <ActionIcon
                      size={44}
                      variant="subtle"
                      color="gray"
                      aria-label={t("comments.more")}
                      data-testid="comment-menu"
                    >
                      <IconDots size={18} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item
                      leftSection={<IconPencil size={14} />}
                      onClick={() => {
                        setEditing(true);
                      }}
                      data-testid="comment-edit"
                    >
                      {t("common.edit")}
                    </Menu.Item>
                    <Menu.Item
                      color="red"
                      leftSection={<IconTrash size={14} />}
                      onClick={() => void remove(c)}
                      data-testid="comment-delete"
                    >
                      {t("common.delete")}
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              )}
            </Group>
          </Group>
        )}
      </Stack>
    </Group>
  );
}

/** A top-level comment with its time chip, track, context badge and replies (SPEC §8). */
export function CommentItem({
  comment: c,
  song,
  tracks,
  usernames,
}: {
  comment: Comment;
  song: Song;
  tracks: readonly Track[];
  usernames: readonly string[];
}) {
  const { t } = useTranslation();
  const highlighted = useCommentsUi((s) => s.highlighted === c.id);
  const { create } = useCommentActions(song.id);
  const [replying, setReplying] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [highlighted]);
  const track = c.trackId ? tracks.find((x) => x.id === c.trackId) : undefined;
  const time =
    c.startSec === null
      ? null
      : c.endSec === null
        ? formatClock(c.startSec, false)
        : `${formatClock(c.startSec, false)}–${formatClock(c.endSec, false)}`;
  return (
    <Paper
      ref={ref}
      withBorder
      p="sm"
      radius="md"
      data-testid="comment-item"
      data-comment-id={c.id}
      data-highlighted={highlighted || undefined}
      data-resolved={c.resolvedAt !== null || undefined}
      style={{
        borderColor: highlighted ? "var(--mantine-primary-color-filled)" : undefined,
        borderWidth: highlighted ? 2 : undefined,
        opacity: c.resolvedAt !== null ? 0.75 : undefined,
      }}
    >
      <Stack gap="xs">
        <Group gap={6} wrap="wrap">
          {time ? (
            <Button
              size="compact-sm"
              h={32}
              variant="light"
              className="tabular-nums"
              onClick={() => {
                tapComment(c);
              }}
              aria-label={t("comments.seekTo", { time })}
              data-testid="comment-time"
            >
              {time}
            </Button>
          ) : (
            <Badge variant="outline" color="gray" tt="none">
              {t("comments.general")}
            </Badge>
          )}
          {track && (
            <Badge variant="light" color={track.color} tt="none">
              {track.name}
            </Badge>
          )}
          {c.resolvedAt !== null && (
            <Badge variant="light" color="green" tt="none" data-testid="comment-resolved-badge">
              {c.resolvedByName
                ? t("comments.resolvedBy", { name: c.resolvedByName })
                : t("comments.resolved")}
            </Badge>
          )}
          {c.endSec !== null && (
            <Button
              size="compact-sm"
              h={32}
              variant="subtle"
              color="yellow"
              leftSection={<IconRepeat size={14} />}
              onClick={() => {
                loopComment(c);
              }}
              data-testid="comment-loop"
            >
              {t("markers.loopThis")}
            </Button>
          )}
        </Group>
        {!c.deleted && <ContextBadge comment={c} songId={song.id} tracks={tracks} />}
        <CommentContent
          c={c}
          song={song}
          usernames={usernames}
          top={c}
          onReply={
            c.deleted
              ? undefined
              : () => {
                  setReplying(true);
                }
          }
        />
        {(c.replies.length > 0 || replying) && (
          <Box pl={{ base: "sm", xs: 42 }}>
            <Stack gap="sm">
              {c.replies.map((r) => (
                <CommentContent key={r.id} c={r} song={song} usernames={usernames} top={c} />
              ))}
              {replying && (
                <CommentEditor
                  songId={song.id}
                  submitLabel={t("comments.reply")}
                  testId="comment-reply-input"
                  onCancel={() => {
                    setReplying(false);
                  }}
                  onSubmit={async (text) => {
                    const ok = (await create({ body: text, parentId: c.id })) !== null;
                    if (ok) setReplying(false);
                    return ok;
                  }}
                />
              )}
            </Stack>
          </Box>
        )}
      </Stack>
    </Paper>
  );
}
