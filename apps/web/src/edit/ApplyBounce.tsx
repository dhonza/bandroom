import {
  Alert,
  Button,
  Checkbox,
  Group,
  Loader,
  Progress,
  Radio,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { DEFAULT_EDIT_SONG_NAMING, editSongTrackName, type EditSongNaming } from "@bandroom/shared";
import {
  IconAlertTriangle,
  IconCheck,
  IconFileExport,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppModal } from "../components/ResponsivePanel";
import { chosenSet, titleRanges, toggleRange, type NamedRange } from "./bounceNaming";
import { ReviewSummary, TrashNote } from "./ReviewSummary";
import { openEditDialog, useEdit } from "./store";
import {
  useApplyActions,
  useEditReview,
  useRenderProgress,
  type BounceKind,
  type ReviewOptions,
} from "./applyFlow";

/** Apply's review dialog (SPEC §24.8): a plain confirm with the numbers. */
export function ApplyDialog() {
  const { t } = useTranslation();
  const opened = useEdit((s) => s.dialog === "apply");
  return (
    <AppModal
      opened={opened}
      onClose={close}
      title={t("edit.applyTitle")}
      centered
      size="lg"
      data-testid="edit-apply-dialog"
    >
      <ApplyBody />
    </AppModal>
  );
}

const close = () => {
  openEditDialog(null);
};

/** The dialog's content: mounted per opening, so each opening saves and reviews afresh. */
function ApplyBody() {
  const { t } = useTranslation();
  const review = useEditReview("apply", true);
  const { apply, busy } = useApplyActions();
  return (
    <Stack>
      <Text size="sm">{t("edit.applyBody")}</Text>
      <ReviewState review={review} />
      <TrashNote />
      <Group justify="flex-end">
        <Button variant="default" onClick={close}>
          {t("common.cancel")}
        </Button>
        <Button
          loading={busy === "apply"}
          disabled={!review.view || review.blocked}
          onClick={() => {
            void apply(review.rev);
          }}
          data-testid="edit-apply-confirm"
        >
          {t("edit.apply")}
        </Button>
      </Group>
    </Stack>
  );
}

function ReviewState({
  review,
  showTimeline,
}: {
  review: ReturnType<typeof useEditReview>;
  showTimeline?: boolean;
}) {
  const { t } = useTranslation();
  if (review.error) return <Alert color="red">{review.error}</Alert>;
  if (!review.view)
    return (
      <Group gap="xs" data-testid="edit-review-loading">
        <Loader size="sm" />
        <Text size="sm" c="dimmed">
          {t("edit.review.loading")}
        </Text>
      </Group>
    );
  return <ReviewSummary review={review.view} showTimeline={showTimeline} />;
}

const BOUNCE_KINDS: readonly BounceKind[] = ["bounceVersions", "bounceTracks", "bounceSongs"];

/** Bounce… (SPEC §24.9): new versions, new tracks, or one new song per range. */
export function BounceDialog(props: { songTitle: string; trackNames: readonly string[] }) {
  const { t } = useTranslation();
  const opened = useEdit((s) => s.dialog === "bounce");
  return (
    <AppModal
      opened={opened}
      onClose={close}
      title={t("edit.bounceDialog.title")}
      centered
      size="lg"
      data-testid="edit-bounce-dialog"
    >
      <BounceBody {...props} />
    </AppModal>
  );
}

function BounceBody({
  songTitle,
  trackNames,
}: {
  songTitle: string;
  trackNames: readonly string[];
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<BounceKind>("bounceVersions");
  const [source, setSource] = useState<"sections" | "markers">("sections");
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [naming, setNaming] = useState<EditSongNaming>(DEFAULT_EDIT_SONG_NAMING);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [carryTempo, setCarryTempo] = useState(false);
  const [keepEditing, setKeepEditing] = useState(false);
  const [candidates, setCandidates] = useState<{
    sections: NamedRange[];
    markers: NamedRange[];
  } | null>(null);
  const songs = kind === "bounceSongs";
  const sections = candidates?.sections ?? [];
  const markers = candidates?.markers ?? [];
  // Sections first (SPEC §24.9); markers when the song has no sections.
  const by = source === "sections" && sections.length === 0 ? "markers" : source;
  const ranges = by === "sections" ? sections : markers;
  const chosen = useMemo(() => chosenSet(ranges, off), [ranges, off]);
  const titled = titleRanges(ranges, chosen, naming, songTitle, edits);
  const reviewOptions: ReviewOptions | undefined = songs
    ? {
        by,
        ...(candidates && { ranges: titled.map((r) => r.range.id).join(",") }),
        title: naming.title,
        numbered: String(naming.numbered) as "true" | "false",
        trackNames: naming.trackNames,
      }
    : undefined;
  const review = useEditReview(kind, true, reviewOptions);
  const { bounce, busy } = useApplyActions();
  // The candidate ranges come with the first review of the split (they do not depend on the choice).
  if (songs && review.ranges && candidates === null) setCandidates(review.ranges);
  const view = useMemo(() => {
    if (!review.view || !songs) return review.view;
    const typed = new Map(titled.map((r) => [r.range.id, r.title]));
    return {
      ...review.view,
      tracks: review.view.tracks.map((row) => ({ ...row, name: typed.get(row.key) ?? row.name })),
    };
  }, [review.view, songs, titled]);
  const ready =
    !!review.view && !review.blocked && !review.loading && (!songs || titled.length > 0);
  const submit = () => {
    if (!songs) {
      void bounce(review.rev, { kind });
      return;
    }
    void bounce(review.rev, {
      kind,
      ranges: titled.map((r) => ({
        id: r.range.id,
        name: r.range.name,
        startFrame: r.range.startFrame,
        endFrame: r.range.endFrame,
        title: r.title,
      })),
      naming,
      carryTempo,
      keepEditing,
    });
  };
  return (
    <Stack>
      <Radio.Group
        value={kind}
        onChange={(v) => {
          const k = BOUNCE_KINDS.find((x) => x === v);
          if (k) setKind(k);
        }}
        label={t("edit.bounceDialog.kind")}
      >
        <Stack gap={4} mt={4}>
          {BOUNCE_KINDS.map((k) => (
            <Radio
              key={k}
              value={k}
              py={10}
              label={t(`edit.bounceDialog.kinds.${k}`)}
              description={t(`edit.bounceDialog.kindHints.${k}`)}
              data-testid={`edit-bounce-kind-${k}`}
            />
          ))}
        </Stack>
      </Radio.Group>
      {songs && candidates && (
        <Stack gap="sm" data-testid="edit-bounce-songs">
          {sections.length > 0 && markers.length > 0 && (
            <Radio.Group
              value={by}
              onChange={(v) => {
                setSource(v === "markers" ? "markers" : "sections");
                setOff(new Set());
                setEdits({});
              }}
              label={t("edit.bounceDialog.splitAt")}
            >
              <Group gap="md" mt={4}>
                <Radio
                  value="sections"
                  py={10}
                  label={t("edit.bounceDialog.sections")}
                  data-testid="edit-bounce-by-sections"
                />
                <Radio
                  value="markers"
                  py={10}
                  label={t("edit.bounceDialog.markers")}
                  data-testid="edit-bounce-by-markers"
                />
              </Group>
            </Radio.Group>
          )}
          {ranges.length === 0 ? (
            <Alert color="gray">{t("edit.bounceDialog.noRanges")}</Alert>
          ) : (
            <Stack gap={0} mah={260} style={{ overflowY: "auto" }}>
              {ranges.map((r) => (
                <Checkbox
                  key={r.id}
                  py={12}
                  checked={chosen.has(r.id)}
                  onChange={() => {
                    setOff(toggleRange(off, r.id));
                  }}
                  label={r.name.trim() || t("edit.bounceDialog.fromStart")}
                  description={rangeTime(r)}
                  data-testid="edit-bounce-range"
                />
              ))}
            </Stack>
          )}
          <Radio.Group
            value={naming.title}
            onChange={(v) => {
              setNaming({ ...naming, title: v === "sessionAndName" ? "sessionAndName" : "name" });
            }}
            label={t("edit.bounceDialog.naming")}
          >
            <Stack gap={0} mt={4}>
              <Radio
                value="name"
                py={10}
                label={t("edit.bounceDialog.titleSection")}
                data-testid="edit-bounce-title-section"
              />
              <Radio
                value="sessionAndName"
                py={10}
                label={t("edit.bounceDialog.titleSession", { song: songTitle })}
                data-testid="edit-bounce-title-session"
              />
            </Stack>
          </Radio.Group>
          <Checkbox
            py={10}
            checked={naming.numbered}
            onChange={(e) => {
              setNaming({ ...naming, numbered: e.currentTarget.checked });
            }}
            label={t("edit.bounceDialog.numbered")}
            data-testid="edit-bounce-numbered"
          />
          <Checkbox
            py={10}
            checked={naming.trackNames === "rangePrefix"}
            onChange={(e) => {
              setNaming({
                ...naming,
                trackNames: e.currentTarget.checked ? "rangePrefix" : "keep",
              });
            }}
            label={t("edit.bounceDialog.trackNames", {
              example: editSongTrackName(
                { name: titled[0]?.range.name || t("edit.bounceDialog.exampleSection") },
                trackNames[0] ?? t("edit.bounceDialog.exampleTrack"),
                { ...naming, trackNames: "rangePrefix" },
              ),
            })}
            data-testid="edit-bounce-track-names"
          />
          {titled.length > 0 && (
            <Stack gap={6} data-testid="edit-bounce-titles">
              <Text size="sm" fw={500}>
                {t("edit.bounceDialog.titles", { count: titled.length })}
              </Text>
              {titled.map((r) => (
                <TextInput
                  key={r.range.id}
                  value={edits[r.range.id] ?? r.defaultTitle}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setEdits((prev) => ({ ...prev, [r.range.id]: value }));
                  }}
                  onBlur={() => {
                    if ((edits[r.range.id] ?? "").trim() === "")
                      setEdits((prev) =>
                        Object.fromEntries(
                          Object.entries(prev).filter(([id]) => id !== r.range.id),
                        ),
                      );
                  }}
                  aria-label={t("edit.bounceDialog.titleOf", { title: r.defaultTitle })}
                  description={
                    naming.trackNames === "rangePrefix"
                      ? trackNames
                          .slice(0, 3)
                          .map((n) => editSongTrackName(r.range, n, naming))
                          .join(", ")
                      : undefined
                  }
                  maxLength={200}
                  data-testid="edit-bounce-song-title"
                />
              ))}
            </Stack>
          )}
          <Checkbox
            py={10}
            checked={carryTempo}
            onChange={(e) => {
              setCarryTempo(e.currentTarget.checked);
            }}
            label={t("edit.bounceDialog.carryTempo")}
            data-testid="edit-bounce-carry-tempo"
          />
          <Checkbox
            py={10}
            checked={keepEditing}
            onChange={(e) => {
              setKeepEditing(e.currentTarget.checked);
            }}
            label={t("edit.bounceDialog.keepEditing")}
            description={t("edit.bounceDialog.keepEditingHint")}
            data-testid="edit-bounce-keep-editing"
          />
        </Stack>
      )}
      <ReviewState review={{ ...review, view }} showTimeline={kind === "bounceVersions"} />
      <Group justify="flex-end">
        <Button variant="default" onClick={close}>
          {t("common.cancel")}
        </Button>
        <Button
          loading={busy === "bounce"}
          disabled={!ready}
          onClick={submit}
          leftSection={<IconFileExport size={16} />}
          data-testid="edit-bounce-confirm"
        >
          {songs && candidates
            ? t("edit.bounceDialog.confirmSongs", { count: titled.length })
            : t("edit.bounceDialog.confirm")}
        </Button>
      </Group>
    </Stack>
  );
}

function rangeTime(r: NamedRange): string {
  const fmt = (frames: number) => {
    const sec = Math.round(frames / 48_000);
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  };
  return `${fmt(r.startFrame)}–${fmt(r.endFrame)}`;
}

/**
 * While the edit renders (SPEC §24.8, §24.14): progress per output, failed renders with their
 * error, "Retry failed" and "Cancel". The edit is read-only meanwhile.
 */
export function ApplyProgress() {
  const { t } = useTranslation();
  const progress = useRenderProgress();
  const { retry, busy } = useApplyActions();
  if (!progress) return null;
  const failed = progress.outputs.filter((o) => o.status === "failed").length;
  return (
    <Alert
      color={failed > 0 ? "red" : "blue"}
      variant="light"
      icon={failed > 0 ? <IconAlertTriangle size={18} /> : <Loader size={16} />}
      title={
        failed > 0
          ? t("edit.progress.failedTitle", { count: failed })
          : t(`edit.progress.title.${progress.kind}`)
      }
      data-testid="edit-progress"
      data-failed={failed > 0 || undefined}
    >
      <Stack gap="xs">
        {progress.outputs.map((o) => (
          <Stack key={o.key} gap={2} data-testid="edit-progress-output" data-status={o.status}>
            <Group justify="space-between" gap="xs" wrap="nowrap">
              <Text size="sm" truncate>
                {o.name}
              </Text>
              <Text
                size="xs"
                c={o.status === "failed" ? "red" : "dimmed"}
                style={{ flexShrink: 0 }}
              >
                {o.status === "done" ? (
                  <IconCheck size={14} />
                ) : (
                  t(`edit.progress.status.${o.status}`)
                )}
              </Text>
            </Group>
            {o.status !== "failed" && o.status !== "done" && (
              <Progress
                value={Math.round(o.progress * 100)}
                size="sm"
                animated={o.status === "running"}
              />
            )}
            {o.error && (
              <Text size="xs" c="red">
                {o.error}
              </Text>
            )}
          </Stack>
        ))}
        <Group gap="xs">
          {failed > 0 && (
            <Button
              h={44}
              leftSection={<IconRefresh size={16} />}
              loading={busy === "retry"}
              onClick={() => {
                void retry();
              }}
              data-testid="edit-retry"
            >
              {t("edit.progress.retry")}
            </Button>
          )}
          <Button
            h={44}
            variant="light"
            color="red"
            leftSection={<IconX size={16} />}
            onClick={() => {
              openEditDialog("cancel");
            }}
            data-testid="edit-apply-cancel"
          >
            {t("edit.progress.cancel")}
          </Button>
        </Group>
      </Stack>
    </Alert>
  );
}
