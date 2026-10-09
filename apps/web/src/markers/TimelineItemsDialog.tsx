import {
  formatBarBeat,
  secToBarBeat,
  type Comment,
  type Marker,
  type PaletteColor,
  type Song,
  type TempoGrid,
} from "@bandroom/shared";
import {
  ActionIcon,
  Box,
  Button,
  Checkbox,
  ColorSwatch,
  Group,
  Popover,
  Stack,
  Tabs,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  IconArrowsHorizontal,
  IconFlag,
  IconPlayerPlay,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useCommentActions, useCommentPermissions, useSongComments } from "../comments/queries";
import { ColorSwatchPicker } from "../components/ColorSwatchPicker";
import { AppModal } from "../components/ResponsivePanel";
import { formatClock, parseClock } from "../player/format";
import { COARSE_POINTER_QUERY } from "../shell/mediaQueries";
import { useTempoUi } from "../tempo/store";
import { useMarkerActions, useMarkerPermissions } from "./queries";
import { seekTo, setItemsOpen, useTimelineUi } from "./store";

/**
 * The timeline items editor (SPEC §7.4, §8): markers, sections and comments as compact lists —
 * rename, move, recolor, delete, and convert markers to sections and back.
 */
export function TimelineItemsDialog({ song }: { song: Song }) {
  const opened = useTimelineUi((s) => s.itemsOpen);
  if (!opened) return null;
  return <ItemsModal song={song} />;
}

const MEDIA = { getInitialValueInEffect: false } as const;

function useCoarse(): boolean {
  return useMediaQuery(COARSE_POINTER_QUERY, false, MEDIA);
}

function ItemsModal({ song }: { song: Song }) {
  const { t } = useTranslation();
  const coarse = useCoarse();
  const [tab, setTab] = useState<string | null>("items");
  const tabStyle = coarse ? { minHeight: 44 } : undefined;
  return (
    <AppModal
      opened
      onClose={() => {
        setItemsOpen(false);
      }}
      title={t("timelineItems.title")}
      size="xl"
      data-testid="timeline-items"
    >
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="items" style={tabStyle} data-testid="items-tab-markers">
            {t("timelineItems.tabItems")}
          </Tabs.Tab>
          <Tabs.Tab value="comments" style={tabStyle} data-testid="items-tab-comments">
            {t("timelineItems.tabComments")}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="items" pt="sm">
          <MarkersTab song={song} coarse={coarse} />
        </Tabs.Panel>
        <Tabs.Panel value="comments" pt="sm">
          <CommentsTab song={song} coarse={coarse} />
        </Tabs.Panel>
      </Tabs>
    </AppModal>
  );
}

/** Control sizes: 44 px touch targets on coarse pointers, compact rows with a mouse. */
function sizes(coarse: boolean) {
  return {
    input: coarse ? "md" : "xs",
    icon: coarse ? 44 : 28,
    inputStyles: coarse ? { input: { minHeight: 44 } } : undefined,
  } as const;
}

function LockedNote({ locked }: { locked: boolean }) {
  const { t } = useTranslation();
  if (!locked) return null;
  return (
    <Text size="sm" c="dimmed" data-testid="items-locked">
      {t("songs.lock.locked")}
    </Text>
  );
}

// --- Markers and sections -----------------------------------------------------------------------

function MarkersTab({ song, coarse }: { song: Song; coarse: boolean }) {
  const { t } = useTranslation();
  const markers = useTimelineUi((s) => s.markers);
  const grid = useTempoUi((s) => s.grid);
  const { canEdit, locked } = useMarkerPermissions(song);
  const actions = useMarkerActions(song.id);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [colorOpen, setColorOpen] = useState(false);
  const sz = sizes(coarse);
  const editable = useMemo(() => markers.filter(canEdit), [markers, canEdit]);
  // Selection of items that are still there (another user may delete one meanwhile).
  const selected = useMemo(() => editable.filter((m) => picked.has(m.id)), [editable, picked]);
  const allPicked = editable.length > 0 && selected.length === editable.length;

  const toggle = (id: string, on: boolean) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const clear = () => {
    setPicked(new Set());
  };

  if (markers.length === 0)
    return (
      <Text size="sm" c="dimmed" data-testid="items-empty">
        {t("timelineItems.empty")}
      </Text>
    );

  return (
    <Stack gap="xs">
      <LockedNote locked={locked} />
      <Group gap="xs" wrap="wrap" mih={sz.icon} data-testid="items-bulk">
        <Checkbox
          aria-label={t("timelineItems.selectAll")}
          checked={allPicked}
          indeterminate={selected.length > 0 && !allPicked}
          disabled={editable.length === 0}
          onChange={(e) => {
            setPicked(new Set(e.currentTarget.checked ? editable.map((m) => m.id) : []));
          }}
          size={coarse ? "md" : "sm"}
          data-testid="items-select-all"
        />
        {selected.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t("timelineItems.selectHint")}
          </Text>
        ) : (
          <>
            <Text size="sm" data-testid="items-selected-count">
              {t("timelineItems.selected", { count: selected.length })}
            </Text>
            <Button
              size={sz.input}
              variant="light"
              disabled={!selected.some((m) => m.type === "marker")}
              onClick={() => {
                clear();
                void actions.convert(selected, "section");
              }}
              data-testid="items-to-sections"
            >
              {t("timelineItems.toSections")}
            </Button>
            <Button
              size={sz.input}
              variant="light"
              disabled={!selected.some((m) => m.type === "section")}
              onClick={() => {
                clear();
                void actions.convert(selected, "marker");
              }}
              data-testid="items-to-markers"
            >
              {t("timelineItems.toMarkers")}
            </Button>
            <Popover opened={colorOpen} onChange={setColorOpen} withinPortal trapFocus>
              <Popover.Target>
                <Button
                  size={sz.input}
                  variant="light"
                  onClick={() => {
                    setColorOpen((o) => !o);
                  }}
                  data-testid="items-bulk-color"
                >
                  {t("timelineItems.setColor")}
                </Button>
              </Popover.Target>
              <Popover.Dropdown>
                <ColorSwatchPicker
                  label={t("markers.color")}
                  value={selected[0]?.color ?? "blue"}
                  onChange={(color) => {
                    setColorOpen(false);
                    for (const m of selected)
                      if (m.color !== color) void actions.update(m, { color });
                  }}
                />
              </Popover.Dropdown>
            </Popover>
            <Button
              size={sz.input}
              variant="light"
              color="red"
              onClick={() => {
                const items = selected;
                clear();
                void actions.removeMany(items);
              }}
              data-testid="items-bulk-delete"
            >
              {t("common.delete")}
            </Button>
            <ActionIcon
              size={sz.icon}
              variant="subtle"
              color="gray"
              aria-label={t("timelineItems.clearSelection")}
              onClick={clear}
            >
              <IconX size={16} />
            </ActionIcon>
          </>
        )}
      </Group>
      <Stack gap={coarse ? "xs" : 4} data-testid="items-list">
        {markers.map((m) => (
          <MarkerRow
            key={m.id}
            m={m}
            grid={grid}
            coarse={coarse}
            editable={canEdit(m)}
            picked={picked.has(m.id)}
            onPick={(on) => {
              toggle(m.id, on);
            }}
            actions={actions}
          />
        ))}
      </Stack>
    </Stack>
  );
}

function MarkerRow({
  m,
  grid,
  coarse,
  editable,
  picked,
  onPick,
  actions,
}: {
  m: Marker;
  grid: TempoGrid | null;
  coarse: boolean;
  editable: boolean;
  picked: boolean;
  onPick: (on: boolean) => void;
  actions: ReturnType<typeof useMarkerActions>;
}) {
  const { t } = useTranslation();
  const sz = sizes(coarse);
  const [colorOpen, setColorOpen] = useState(false);
  const section = m.type === "section";
  const typeLabel = t(section ? "timelineItems.typeSection" : "timelineItems.typeMarker");
  return (
    <Group
      gap={6}
      wrap="wrap"
      align="flex-start"
      py={2}
      style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
      data-testid="items-row"
      data-type={m.type}
    >
      <Group gap={6} wrap="nowrap" style={{ flex: "1 1 200px", minWidth: 0 }}>
        <Box w={sz.icon} style={{ display: "flex", justifyContent: "center", flexShrink: 0 }}>
          <Checkbox
            aria-label={t("timelineItems.select", { name: m.name })}
            checked={picked}
            disabled={!editable}
            onChange={(e) => {
              onPick(e.currentTarget.checked);
            }}
            size={coarse ? "md" : "sm"}
            mt={coarse ? 10 : 6}
          />
        </Box>
        <Box
          title={typeLabel}
          aria-label={typeLabel}
          role="img"
          c="dimmed"
          style={{ display: "flex", flexShrink: 0 }}
          mt={coarse ? 12 : 6}
        >
          {section ? <IconArrowsHorizontal size={16} /> : <IconFlag size={16} />}
        </Box>
        <Popover opened={colorOpen} onChange={setColorOpen} withinPortal trapFocus>
          <Popover.Target>
            <ActionIcon
              size={sz.icon}
              variant="subtle"
              color="gray"
              disabled={!editable}
              aria-label={t("timelineItems.colorOf", { name: m.name })}
              onClick={() => {
                setColorOpen((o) => !o);
              }}
              data-testid="items-color"
            >
              <ColorSwatch color={`var(--mantine-color-${m.color}-6)`} size={coarse ? 24 : 16} />
            </ActionIcon>
          </Popover.Target>
          <Popover.Dropdown>
            <ColorSwatchPicker
              label={t("markers.color")}
              value={m.color}
              onChange={(color: PaletteColor) => {
                setColorOpen(false);
                if (color !== m.color) void actions.update(m, { color });
              }}
            />
          </Popover.Dropdown>
        </Popover>
        <NameInput m={m} coarse={coarse} disabled={!editable} actions={actions} />
      </Group>
      <Group gap={6} wrap="nowrap" ml={coarse ? 0 : "auto"}>
        <ClockInput
          label={t(section ? "timelineItems.startOf" : "timelineItems.positionOf", {
            name: m.name,
          })}
          value={m.startSec}
          grid={grid}
          coarse={coarse}
          disabled={!editable}
          onCommit={(sec) => {
            if (sec === null || (m.endSec !== null && sec >= m.endSec)) return false;
            void actions.update(m, { startSec: sec });
            return true;
          }}
          testId="items-start"
        />
        {section ? (
          <ClockInput
            label={t("timelineItems.endOf", { name: m.name })}
            value={m.endSec}
            grid={grid}
            coarse={coarse}
            disabled={!editable}
            onCommit={(sec) => {
              if (sec === null || sec <= m.startSec) return false;
              void actions.update(m, { endSec: sec });
              return true;
            }}
            testId="items-end"
          />
        ) : (
          <Box w={clockW(coarse)} />
        )}
        <ActionIcon
          size={sz.icon}
          variant="subtle"
          color="red"
          disabled={!editable}
          aria-label={t("timelineItems.deleteItem", { name: m.name })}
          onClick={() => {
            void actions.remove(m);
          }}
          data-testid="items-delete"
        >
          <IconTrash size={16} />
        </ActionIcon>
      </Group>
    </Group>
  );
}

function NameInput({
  m,
  coarse,
  disabled,
  actions,
}: {
  m: Marker;
  coarse: boolean;
  disabled: boolean;
  actions: ReturnType<typeof useMarkerActions>;
}) {
  const { t } = useTranslation();
  const sz = sizes(coarse);
  const [draft, setDraft] = useState(m.name);
  const [base, setBase] = useState(m.name);
  // Follow changes from elsewhere (another tab, undo) while not being edited.
  if (base !== m.name) {
    setBase(m.name);
    setDraft(m.name);
  }
  const commit = () => {
    const name = draft.trim();
    if (!name) {
      setDraft(m.name);
      return;
    }
    if (name !== m.name) void actions.update(m, { name });
  };
  return (
    <TextInput
      aria-label={t("timelineItems.nameOf", { name: m.name })}
      value={draft}
      maxLength={60}
      disabled={disabled}
      size={sz.input}
      styles={sz.inputStyles}
      style={{ flex: 1, minWidth: 80 }}
      onChange={(e) => {
        setDraft(e.currentTarget.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setDraft(m.name);
      }}
      data-testid="items-name"
    />
  );
}

/** Fits "12:34.567" in the input. */
const clockW = (coarse: boolean) => (coarse ? 108 : 92);

/**
 * A clock-text time input (m:ss.mmm) that commits on blur or Enter. `onCommit` returns false for
 * a time it refuses (the input shows an error and keeps the text). Bar.beat shows dimmed below
 * it when the song has a tempo map.
 */
function ClockInput({
  label,
  value,
  grid,
  coarse,
  disabled,
  allowEmpty = false,
  placeholder,
  onCommit,
  testId,
}: {
  label: string;
  value: number | null;
  grid: TempoGrid | null;
  coarse: boolean;
  disabled: boolean;
  allowEmpty?: boolean;
  placeholder?: string;
  onCommit: (sec: number | null) => boolean;
  testId: string;
}) {
  const { t } = useTranslation();
  const sz = sizes(coarse);
  const text = value === null ? "" : formatClock(value);
  const [draft, setDraft] = useState(text);
  const [base, setBase] = useState(text);
  const [bad, setBad] = useState(false);
  if (base !== text) {
    setBase(text);
    setDraft(text);
    setBad(false);
  }
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === text) {
      setBad(false);
      return;
    }
    const sec = trimmed === "" ? null : parseClock(trimmed);
    if ((sec === null && (trimmed !== "" || !allowEmpty)) || !onCommit(sec)) {
      setBad(true);
      return;
    }
    setBad(false);
  };
  let musical: ReactNode = null;
  if (grid && value !== null)
    musical = (
      <Text size="xs" c="dimmed" className="tabular-nums" lh={1.2} data-testid={`${testId}-bar`}>
        {formatBarBeat(secToBarBeat(grid, value))}
      </Text>
    );
  return (
    <Stack gap={0} w={clockW(coarse)}>
      <TextInput
        aria-label={label}
        title={bad ? t("markers.badTimes") : undefined}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        error={bad}
        size={sz.input}
        styles={sz.inputStyles}
        className="tabular-nums"
        onChange={(e) => {
          setDraft(e.currentTarget.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(text);
            setBad(false);
          }
        }}
        data-testid={testId}
      />
      {musical}
    </Stack>
  );
}

// --- Comments -------------------------------------------------------------------------------------

/** Whole-song comments first, then by time, then by creation. */
function byTime(a: Comment, b: Comment): number {
  const as = a.startSec ?? -1;
  const bs = b.startSec ?? -1;
  return as - bs || a.createdAt - b.createdAt;
}

function CommentsTab({ song, coarse }: { song: Song; coarse: boolean }) {
  const { t } = useTranslation();
  const { comments } = useSongComments(song.id);
  const { canModify, locked } = useCommentPermissions(song);
  const actions = useCommentActions(song.id);
  const grid = useTempoUi((s) => s.grid);
  const list = useMemo(() => comments.filter((c) => !c.deleted).sort(byTime), [comments]);
  if (list.length === 0)
    return (
      <Text size="sm" c="dimmed" data-testid="items-comments-empty">
        {t("timelineItems.emptyComments")}
      </Text>
    );
  return (
    <Stack gap={coarse ? "xs" : 4} data-testid="items-comments">
      <LockedNote locked={locked} />
      {list.map((c) => (
        <CommentRow
          key={c.id}
          c={c}
          grid={grid}
          coarse={coarse}
          editable={canModify(c)}
          actions={actions}
        />
      ))}
    </Stack>
  );
}

function CommentRow({
  c,
  grid,
  coarse,
  editable,
  actions,
}: {
  c: Comment;
  grid: TempoGrid | null;
  coarse: boolean;
  editable: boolean;
  actions: ReturnType<typeof useCommentActions>;
}) {
  const { t } = useTranslation();
  const sz = sizes(coarse);
  const [draft, setDraft] = useState(c.body);
  const [base, setBase] = useState(c.body);
  if (base !== c.body) {
    setBase(c.body);
    setDraft(c.body);
  }
  const commitBody = () => {
    const text = draft.trim();
    if (!text) {
      setDraft(c.body);
      return;
    }
    if (text !== c.body) void actions.edit(c, text);
  };
  const startSec = c.startSec;
  return (
    <Group
      gap={6}
      wrap="wrap"
      align="flex-start"
      py={2}
      style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
      data-testid="items-comment-row"
    >
      <Group gap={6} wrap="nowrap">
        <ClockInput
          label={t("timelineItems.commentStart")}
          value={c.startSec}
          grid={grid}
          coarse={coarse}
          disabled={!editable}
          allowEmpty
          placeholder={t("comments.general")}
          onCommit={(sec) => {
            // Moving the start keeps the length of a range comment.
            const end =
              sec === null || c.endSec === null || c.startSec === null
                ? null
                : sec + (c.endSec - c.startSec);
            void actions.move(c, sec, end);
            return true;
          }}
          testId="items-comment-start"
        />
        <ClockInput
          label={t("timelineItems.commentEnd")}
          value={c.endSec}
          grid={grid}
          coarse={coarse}
          disabled={!editable || startSec === null}
          allowEmpty
          onCommit={(sec) => {
            if (startSec === null || (sec !== null && sec <= startSec)) return false;
            void actions.move(c, startSec, sec);
            return true;
          }}
          testId="items-comment-end"
        />
      </Group>
      <Stack gap={0} style={{ flex: "1 1 180px", minWidth: 0 }}>
        <Text size="xs" c="dimmed" truncate>
          {c.author.name}
        </Text>
        <Textarea
          aria-label={t("comments.text")}
          value={draft}
          readOnly={!editable}
          autosize
          minRows={1}
          maxRows={4}
          size={sz.input}
          onChange={(e) => {
            setDraft(e.currentTarget.value);
          }}
          onBlur={() => {
            if (editable) commitBody();
          }}
          data-testid="items-comment-body"
        />
      </Stack>
      <Group gap={2} wrap="nowrap">
        <ActionIcon
          size={sz.icon}
          variant="subtle"
          color="gray"
          disabled={startSec === null}
          aria-label={t("comments.seekTo", { time: formatClock(startSec ?? 0, false) })}
          onClick={() => {
            if (startSec !== null) seekTo(startSec);
          }}
          data-testid="items-comment-seek"
        >
          <IconPlayerPlay size={16} />
        </ActionIcon>
        <ActionIcon
          size={sz.icon}
          variant="subtle"
          color="red"
          disabled={!editable}
          aria-label={t("timelineItems.deleteComment")}
          onClick={() => {
            void actions.remove(c);
          }}
          data-testid="items-comment-delete"
        >
          <IconTrash size={16} />
        </ActionIcon>
      </Group>
    </Group>
  );
}
