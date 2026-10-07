import type { Song, Track } from "@bandroom/shared";
import { Checkbox, Group, Paper, Select, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { VisitorName, useVisitorName } from "../links/VisitorName";
import { formatClock } from "../player/format";
import { pageState } from "../rehearse/controller";
import { CommentEditor } from "./CommentEditor";
import { composerPayload } from "./model";
import { useCommentActions } from "./queries";
import { closeComposer, highlightComment, updateComposer, useCommentsUi } from "./store";

/** The new-comment form at the top of the panel; its time was captured on the button press. */
export function Composer({ song, tracks }: { song: Song; tracks: readonly Track[] }) {
  const { t } = useTranslation();
  const draft = useCommentsUi((s) => s.composer);
  const { create } = useCommentActions(song.id);
  const visitor = useVisitorName();
  if (!draft) return null;
  const rangeLabel =
    draft.range &&
    `${formatClock(draft.range.start, false)}–${formatClock(draft.range.end, false)}`;
  const timed = draft.startSec !== null;
  return (
    <Paper withBorder p="sm" radius="md" data-testid="comment-composer">
      <Stack gap="xs">
        <Group gap="md" wrap="wrap">
          {draft.range ? (
            <Checkbox
              checked={draft.useRange}
              onChange={(e) => {
                updateComposer({ useRange: e.currentTarget.checked });
              }}
              label={t("comments.useRange", { range: rangeLabel })}
              data-testid="composer-range"
            />
          ) : null}
          {(!draft.range || !draft.useRange) && draft.startSec !== null && (
            <Text size="sm" fw={600} className="tabular-nums" data-testid="composer-time">
              {t("comments.at", { time: formatClock(draft.startSec, false) })}
            </Text>
          )}
          {!timed && !draft.range && (
            <Text size="sm" c="dimmed">
              {t("comments.general")}
            </Text>
          )}
        </Group>
        {tracks.length > 0 && (
          <Select
            size="sm"
            aria-label={t("comments.track")}
            value={draft.trackId ?? "song"}
            onChange={(v) => {
              updateComposer({ trackId: v === "song" || v === null ? null : v });
            }}
            data={[
              { value: "song", label: t("comments.wholeSong") },
              ...tracks.map((x) => ({ value: x.id, label: x.name })),
            ]}
            allowDeselect={false}
            comboboxProps={{ withinPortal: true }}
            data-testid="composer-track"
          />
        )}
        {visitor.active && <VisitorName visitor={visitor} />}
        <CommentEditor
          songId={song.id}
          submitLabel={t("comments.post")}
          onCancel={closeComposer}
          onSubmit={async (text) => {
            if (visitor.active && !(await visitor.save())) return false;
            const loaded = currentLoadedVersions(song.id, tracks);
            const c = await create(composerPayload(draft, text, loaded));
            if (!c) return false;
            closeComposer();
            highlightComment(c.id);
            return true;
          }}
        />
      </Stack>
    </Paper>
  );
}

/** Versions playing in Rehearse mode (the server fills in current versions for the rest). */
function currentLoadedVersions(songId: string, tracks: readonly Track[]): Record<string, string> {
  const s = pageState();
  const out: Record<string, string> = {};
  if (s.songId === songId) for (const p of s.tracks) out[p.track.id] = p.version.id;
  else for (const tr of tracks) if (tr.current) out[tr.id] = tr.current.id;
  return out;
}
