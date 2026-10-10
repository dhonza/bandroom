import {
  OVERLAP_MODES,
  SNAP_MODES,
  type EditFades,
  type Marker,
  type TimelineFollow,
} from "@bandroom/shared";
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Checkbox,
  Divider,
  Group,
  Menu,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconAdjustmentsAlt,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconCheck,
  IconChevronDown,
  IconCloudUpload,
  IconCut,
  IconDots,
  IconFileExport,
  IconFlag,
  IconScissors,
  IconStack2,
  IconVolume,
  IconVolumeOff,
  IconAlertTriangle,
  IconX,
} from "@tabler/icons-react";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AppModal, PanelPopover } from "../components/ResponsivePanel";
import { setSnap } from "../markers/store";
import { formatClock } from "../player/format";
import { ContextRow } from "../rehearse/Transport";
import { useEditActions, useEditAvailability } from "./actions";
import { ApplyDialog, BounceDialog } from "./ApplyBounce";
import { splitPoints, type UnavailableReason } from "./model";
import {
  editCanRedo,
  editCanUndo,
  isEditReadOnly,
  openEditDialog,
  setEditOptions,
  setSelectedTracks,
  toggleTrackSelected,
  useEdit,
  type SaveStatus,
} from "./store";

/** A button that explains why it is disabled (SPEC §24.6: "Select a range first"). */
function Why({ reason, children }: { reason: string | null; children: ReactNode }) {
  if (!reason) return children;
  return (
    <Tooltip label={reason} events={{ hover: true, focus: true, touch: true }}>
      <span style={{ display: "inline-flex" }} data-testid="edit-disabled-hint">
        {children}
      </span>
    </Tooltip>
  );
}

interface ToolAction {
  key: string;
  label: string;
  short: string;
  icon: ReactNode;
  onClick: () => void;
  disabledReason: string | null;
  testId: string;
  color?: string;
}

function useToolActions(): ToolAction[] {
  const { t } = useTranslation();
  const actions = useEditActions();
  const avail = useEditAvailability();
  const canUndo = useEdit(editCanUndo);
  const canRedo = useEdit(editCanRedo);
  // While Apply/Bounce renders the edit is read-only (SPEC §24.8).
  const readOnly = useEdit(isEditReadOnly);
  const why = (r: UnavailableReason | null) =>
    readOnly ? t("edit.reasons.applying") : r ? t(`edit.reasons.${r}`) : null;
  const tools: ToolAction[] = [
    {
      key: "split",
      label: t("edit.split"),
      short: t("edit.split"),
      icon: <IconScissors size={18} />,
      onClick: () => {
        actions.split();
      },
      disabledReason: why(avail.split),
      testId: "edit-split",
    },
    {
      key: "splitAtMarkers",
      label: t("edit.splitAtMarkers"),
      short: t("edit.splitAtMarkersShort"),
      icon: <IconFlag size={18} />,
      onClick: () => {
        openEditDialog("splitAtMarkers");
      },
      disabledReason: why(avail.split),
      testId: "edit-split-markers",
    },
    {
      key: "cut",
      label: t("edit.cut"),
      short: t("edit.cut"),
      icon: <IconCut size={18} />,
      onClick: () => {
        actions.range("cut");
      },
      disabledReason: why(avail.cut),
      testId: "edit-cut",
    },
    {
      key: "silence",
      label: t("edit.silence"),
      short: t("edit.silence"),
      icon: <IconVolumeOff size={18} />,
      onClick: () => {
        actions.range("silence");
      },
      disabledReason: why(avail.silence),
      testId: "edit-silence",
    },
    {
      key: "gain",
      label: t("edit.gain"),
      short: t("edit.gainShort"),
      icon: <IconVolume size={18} />,
      onClick: actions.openGain,
      disabledReason: why(avail.gain),
      testId: "edit-gain",
    },
    {
      key: "undo",
      label: t("edit.undo"),
      short: t("edit.undo"),
      icon: <IconArrowBackUp size={18} />,
      onClick: () => {
        actions.undo();
      },
      disabledReason: canUndo ? null : t("edit.reasons.nothingToUndo"),
      testId: "edit-undo",
    },
    {
      key: "redo",
      label: t("edit.redo"),
      short: t("edit.redo"),
      icon: <IconArrowForwardUp size={18} />,
      onClick: () => {
        actions.redo();
      },
      disabledReason: canRedo ? null : t("edit.reasons.nothingToRedo"),
      testId: "edit-redo",
    },
  ];
  return readOnly
    ? tools.map((a) => ({ ...a, disabledReason: t("edit.reasons.applying") }))
    : tools;
}

/** Apply and Bounce… (SPEC §24.6): need an edit and not a running one. */
function useFinishActions(): ToolAction[] {
  const { t } = useTranslation();
  const readOnly = useEdit(isEditReadOnly);
  const edited = useEdit((s) => s.cursor > 0);
  const reason = readOnly ? t("edit.reasons.applying") : edited ? null : t("edit.reasons.noEdits");
  return [
    {
      key: "apply",
      label: t("edit.apply"),
      short: t("edit.apply"),
      icon: <IconCheck size={18} />,
      onClick: () => {
        openEditDialog("apply");
      },
      disabledReason: reason,
      testId: "edit-apply",
      color: "green",
    },
    {
      key: "bounce",
      label: t("edit.bounce"),
      short: t("edit.bounceShort"),
      icon: <IconFileExport size={18} />,
      onClick: () => {
        openEditDialog("bounce");
      },
      disabledReason: reason,
      testId: "edit-bounce",
    },
  ];
}

/** One edit tool as an icon with its tooltip (the reason while disabled). */
function ToolIcon({ a, size }: { a: ToolAction; size: number }) {
  const button = (
    <ActionIcon
      size={size}
      variant={a.key === "apply" && a.disabledReason === null ? "filled" : "subtle"}
      color={a.color ?? "gray"}
      onClick={a.onClick}
      disabled={a.disabledReason !== null}
      aria-label={a.label}
      data-testid={a.testId}
    >
      {a.icon}
    </ActionIcon>
  );
  if (a.disabledReason) return <Why reason={a.disabledReason}>{button}</Why>;
  return <Tooltip label={a.label}>{button}</Tooltip>;
}

/** A text button of the edit row (Cancel, Bounce…, Apply) with its disabled reason. */
function RowButton({
  a,
  coarse,
  variant,
}: {
  a: ToolAction;
  coarse: boolean;
  variant: "filled" | "default" | "subtle";
}) {
  return (
    <Why reason={a.disabledReason}>
      <Button
        size="compact-sm"
        h={coarse ? 44 : 24}
        px={coarse ? 14 : 8}
        variant={variant}
        color={a.color}
        leftSection={a.key === "apply" ? <IconCheck size={14} /> : undefined}
        onClick={a.onClick}
        disabled={a.disabledReason !== null}
        data-testid={a.testId}
      >
        {a.short}
      </Button>
    </Why>
  );
}

const PHONE_TOOLS = new Set(["split", "cut", "silence", "gain", "undo", "redo"]);
const CUT_TOOLS = new Set(["split", "splitAtMarkers", "cut", "silence", "gain"]);
const HISTORY_TOOLS = new Set(["undo", "redo"]);

/**
 * The orange edit row (SPEC §24.6, §31.2): row 2 of the control bar on every device. Desktop:
 * "Editing", the tools as icons, options, the track count, Sections, the save status, Cancel,
 * Bounce… and Apply. Phones: six tools and "⋯" (split at markers, options, tracks, bounce);
 * Apply and Cancel are in the song header. Landscape: every tool, then Bounce…, Cancel and Apply.
 */
export function EditContextRow({
  layout,
  coarse,
  markers,
  durationSec,
  trackNames,
  sections,
  onCancel,
}: {
  layout: "desktop" | "phone" | "landscape";
  coarse: boolean;
  markers: readonly Marker[];
  durationSec: number;
  trackNames: Readonly<Record<string, string>>;
  /** The Sections toggle (desktop). */
  sections?: ReactNode;
  onCancel: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const tools = useToolActions();
  const finish = useFinishActions();
  const cancel = useCancelAction(onCancel);
  const size = coarse ? 44 : 28;
  const sep = <Divider orientation="vertical" mx={5} my="auto" h={16} />;
  const icons = (keys?: Set<string>) =>
    tools
      .filter((a) => !keys || keys.has(a.key))
      .map((a) => <ToolIcon key={a.key} a={a} size={size} />);
  const [apply, bounce] = finish as [ToolAction, ToolAction];
  const dialogs = (
    <>
      <GainDialog />
      <SplitAtMarkersDialog markers={markers} durationSec={durationSec} />
    </>
  );
  let content: ReactNode;
  if (layout === "phone") {
    const more = tools.filter((a) => !PHONE_TOOLS.has(a.key));
    content = (
      <>
        {icons(PHONE_TOOLS)}
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <Tooltip label={t("edit.moreTools")}>
              <ActionIcon
                size={44}
                variant="subtle"
                color="gray"
                aria-label={t("edit.moreTools")}
                data-testid="edit-more"
              >
                <IconDots size={20} />
              </ActionIcon>
            </Tooltip>
          </Menu.Target>
          <Menu.Dropdown miw={220}>
            {more.map((a) => (
              <Menu.Item
                key={a.key}
                leftSection={a.icon}
                disabled={a.disabledReason !== null}
                onClick={a.onClick}
                data-testid={a.testId}
              >
                {a.label}
              </Menu.Item>
            ))}
            <Menu.Item
              leftSection={<IconAdjustmentsAlt size={18} />}
              onClick={() => {
                openEditDialog("options");
              }}
              data-testid="edit-options-button"
            >
              {t("edit.options")}
            </Menu.Item>
            <Menu.Item
              leftSection={<IconStack2 size={18} />}
              onClick={() => {
                openEditDialog("tracks");
              }}
              data-testid="edit-track-count"
            >
              <TrackCountText />
            </Menu.Item>
            <Menu.Item
              leftSection={bounce.icon}
              disabled={bounce.disabledReason !== null}
              onClick={bounce.onClick}
              data-testid={bounce.testId}
            >
              {bounce.label}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <EditOptionsSheet />
        <TrackSelectionSheet names={trackNames} />
      </>
    );
  } else {
    const landscape = layout === "landscape";
    content = (
      <>
        {!landscape && (
          <Text
            size="xs"
            fw={700}
            c="orange"
            mr={6}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}
          >
            <IconCut size={14} />
            {t("edit.editing_label")}
          </Text>
        )}
        {icons(CUT_TOOLS)}
        {sep}
        {icons(HISTORY_TOOLS)}
        {sep}
        <EditOptionsButton size={size} />
        {sep}
        {landscape ? (
          <>
            <Button
              size="compact-sm"
              h={32}
              variant="default"
              onClick={() => {
                openEditDialog("tracks");
              }}
              data-testid="edit-track-count"
            >
              <TrackCountText short />
            </Button>
            <TrackSelectionSheet names={trackNames} />
          </>
        ) : (
          <TrackCountMenu />
        )}
        {!landscape && sections && (
          <>
            {sep}
            {sections}
          </>
        )}
        <Box style={{ flex: "1 1 0" }} />
        {!landscape && <SaveState />}
        {landscape ? (
          <>
            <RowButton a={bounce} coarse={false} variant="default" />
            <Tooltip label={t("edit.cancel")}>
              <ActionIcon
                size={44}
                variant="outline"
                color="red"
                ml={4}
                loading={cancel.busy}
                aria-label={t("edit.cancel")}
                onClick={cancel.run}
                data-testid="edit-cancel"
              >
                <IconX size={20} />
              </ActionIcon>
            </Tooltip>
            <Box ml={4}>
              <RowButton a={apply} coarse variant="filled" />
            </Box>
          </>
        ) : (
          <>
            <Button
              size="compact-sm"
              h={coarse ? 44 : 24}
              variant="subtle"
              color="red"
              loading={cancel.busy}
              onClick={cancel.run}
              data-testid="edit-cancel"
            >
              {t("edit.cancelShort")}
            </Button>
            <RowButton a={bounce} coarse={coarse} variant="default" />
            <RowButton a={apply} coarse={coarse} variant="filled" />
          </>
        )}
      </>
    );
  }
  return (
    <Box data-testid="edit-bar">
      <ContextRow
        coarse={coarse}
        edit
        spread={layout === "phone"}
        testId="edit-toolbar"
        dataLayout="row"
        label={t("edit.toolbar")}
      >
        {content}
      </ContextRow>
      {dialogs}
    </Box>
  );
}

/** Cancel (confirmed when there are ops; SPEC §24.7). */
function useCancelAction(onCancel: () => Promise<void>) {
  const ops = useEdit((s) => s.ops.length);
  const [busy, setBusy] = useState(false);
  const run = () => {
    if (ops > 0) {
      openEditDialog("cancel");
      return;
    }
    setBusy(true);
    void onCancel().finally(() => {
      setBusy(false);
    });
  };
  return { busy, run };
}

/** "3/5 tracks" (short) or "3 of 5 tracks". */
function TrackCountText({ short = false }: { short?: boolean }) {
  const { t } = useTranslation();
  const selected = useEdit((s) => s.selectedTracks.length);
  const total = useEdit((s) => s.base?.tracks.length ?? 0);
  const text = t(short ? "edit.tracksShort" : "edit.tracksCount", { count: selected, total });
  return (
    <Text span inherit c={selected === 0 ? "red" : undefined}>
      {text}
    </Text>
  );
}

/** "3/5 tracks ▾" with All / None (desktop; the headers have the checkboxes, SPEC §24.6). */
function TrackCountMenu() {
  const { t } = useTranslation();
  const selected = useEdit((s) => s.selectedTracks.length);
  const base = useEdit((s) => s.base);
  const all = useMemo(() => base?.tracks.map((x) => x.trackId) ?? [], [base]);
  return (
    <Menu position="bottom-start" withinPortal>
      <Menu.Target>
        <Button
          size="compact-xs"
          h={24}
          variant="default"
          rightSection={<IconChevronDown size={12} />}
          data-testid="edit-track-count"
        >
          <TrackCountText short />
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item
          disabled={selected === all.length}
          onClick={() => {
            setSelectedTracks(all);
          }}
          data-testid="edit-tracks-all"
        >
          {t("edit.allTracks")}
        </Menu.Item>
        <Menu.Item
          disabled={selected === 0}
          onClick={() => {
            setSelectedTracks([]);
          }}
          data-testid="edit-tracks-none"
        >
          {t("edit.noTracks")}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

/** Phones and landscape choose the tracks in a sheet (the strips are too narrow for a box). */
function TrackSelectionSheet({ names }: { names: Readonly<Record<string, string>> }) {
  const { t } = useTranslation();
  const open = useEdit((s) => s.dialog === "tracks");
  const selectedIds = useEdit((s) => s.selectedTracks);
  const base = useEdit((s) => s.base);
  const all = useMemo(() => base?.tracks.map((x) => x.trackId) ?? [], [base]);
  const close = () => {
    openEditDialog(null);
  };
  return (
    <AppModal
      opened={open}
      onClose={close}
      title={t("edit.tracksTitle")}
      data-testid="edit-tracks-sheet"
    >
      <Stack gap={0}>
        <Group gap="xs">
          <Button
            variant="subtle"
            size="compact-sm"
            mih={44}
            onClick={() => {
              setSelectedTracks(all);
            }}
            disabled={selectedIds.length === all.length}
            data-testid="edit-tracks-all"
          >
            {t("edit.allTracks")}
          </Button>
          <Button
            variant="subtle"
            size="compact-sm"
            mih={44}
            onClick={() => {
              setSelectedTracks([]);
            }}
            disabled={selectedIds.length === 0}
            data-testid="edit-tracks-none"
          >
            {t("edit.noTracks")}
          </Button>
        </Group>
        {all.map((id) => (
          <Checkbox
            key={id}
            py={12}
            checked={selectedIds.includes(id)}
            onChange={() => {
              toggleTrackSelected(id);
            }}
            label={names[id] ?? id}
            data-testid="edit-track-select"
          />
        ))}
      </Stack>
    </AppModal>
  );
}

const STATUS_ICON: Record<SaveStatus, ReactNode> = {
  saved: <IconCheck size={14} />,
  saving: <IconCloudUpload size={14} />,
  unsaved: <IconCloudUpload size={14} />,
  error: <IconAlertTriangle size={14} />,
};

/** "Saved" / "Saving…" / "Not saved" (SPEC §24.7). */
export function SaveState() {
  const { t } = useTranslation();
  const save = useEdit((s) => s.save);
  return (
    <Group gap={4} wrap="nowrap" data-testid="edit-save-status" data-status={save}>
      <Text span c={save === "error" ? "red" : "dimmed"} style={{ display: "inline-flex" }}>
        {STATUS_ICON[save]}
      </Text>
      <Text size="sm" c={save === "error" ? "red" : "dimmed"} style={{ whiteSpace: "nowrap" }}>
        {t(`edit.save.${save}`)}
      </Text>
    </Group>
  );
}

/**
 * The song header in edit mode (SPEC §24.6, §31.2). Phones: Cancel (icon) and Apply; the header
 * row scrolls with the page. Desktop and landscape: nothing visible (the edit row has the
 * buttons). The Cancel, Apply and Bounce dialogs live here on every device.
 */
export function EditHeaderBar({
  onCancel,
  trackNames,
  songTitle,
  phone,
}: {
  onCancel: () => Promise<void>;
  trackNames: Readonly<Record<string, string>>;
  songTitle: string;
  phone: boolean;
}) {
  const { t } = useTranslation();
  const ops = useEdit((s) => s.ops.length);
  const dialog = useEdit((s) => s.dialog);
  const finish = useFinishActions();
  const apply = finish[0];
  const quick = useCancelAction(onCancel);
  const [busy, setBusy] = useState(false);
  const cancel = async () => {
    setBusy(true);
    try {
      await onCancel();
    } finally {
      setBusy(false);
      openEditDialog(null);
    }
  };
  return (
    <Group gap={6} wrap="nowrap" data-testid="edit-header">
      {phone && (
        <>
          <Tooltip label={t("edit.cancel")}>
            <ActionIcon
              size={44}
              variant="outline"
              color="red"
              loading={quick.busy}
              aria-label={t("edit.cancel")}
              onClick={quick.run}
              data-testid="edit-cancel"
            >
              <IconX size={20} />
            </ActionIcon>
          </Tooltip>
          {apply && (
            <Why reason={apply.disabledReason}>
              <Button
                h={44}
                px={14}
                color={apply.color}
                leftSection={<IconCheck size={18} />}
                onClick={apply.onClick}
                disabled={apply.disabledReason !== null}
                data-testid={apply.testId}
              >
                {apply.short}
              </Button>
            </Why>
          )}
        </>
      )}
      <AppModal
        opened={dialog === "cancel"}
        onClose={() => {
          openEditDialog(null);
        }}
        title={t("edit.cancelTitle")}
        centered
        data-testid="edit-cancel-dialog"
      >
        <Stack>
          <Text>{t("edit.cancelBody", { count: ops })}</Text>
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => {
                openEditDialog(null);
              }}
            >
              {t("edit.keepEditing")}
            </Button>
            <Button
              color="red"
              loading={busy}
              onClick={() => {
                void cancel();
              }}
              data-testid="edit-cancel-confirm"
            >
              {t("edit.cancelConfirm")}
            </Button>
          </Group>
        </Stack>
      </AppModal>
      <ApplyDialog />
      <BounceDialog songTitle={songTitle} trackNames={Object.values(trackNames)} />
    </Group>
  );
}

/** Gain… (SPEC §24.6): a dB number field; Enter applies. */
function GainDialog() {
  const { t } = useTranslation();
  const opened = useEdit((s) => s.dialog === "gain");
  const actions = useEditActions();
  const [value, setValue] = useState<number>(-6);
  const close = () => {
    openEditDialog(null);
  };
  const apply = () => {
    if (actions.gain(value)) close();
  };
  return (
    <AppModal
      opened={opened}
      onClose={close}
      title={t("edit.gainTitle")}
      centered
      size="sm"
      data-testid="edit-gain-dialog"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <Stack>
          <NumberInput
            label={t("edit.gainLabel")}
            description={t("edit.gainHint")}
            value={value}
            onChange={(v) => {
              setValue(typeof v === "number" ? v : Number(v) || 0);
            }}
            min={-60}
            max={24}
            step={0.5}
            decimalScale={1}
            data-autofocus
            data-testid="edit-gain-value"
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" data-testid="edit-gain-apply">
              {t("edit.gainApply")}
            </Button>
          </Group>
        </Stack>
      </form>
    </AppModal>
  );
}

/** Split at markers/sections… (SPEC §24.3): a checkbox list, all checked. */
function SplitAtMarkersDialog({
  markers,
  durationSec,
}: {
  markers: readonly Marker[];
  durationSec: number;
}) {
  const { t } = useTranslation();
  const opened = useEdit((s) => s.dialog === "splitAtMarkers");
  const actions = useEditActions();
  const points = splitPoints(markers, durationSec);
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const close = () => {
    openEditDialog(null);
    setOff(new Set());
  };
  const chosen = points.filter((p) => !off.has(p.key));
  const label = (p: (typeof points)[number]) =>
    p.kind === "marker"
      ? p.name
      : t(p.kind === "sectionStart" ? "edit.sectionStart" : "edit.sectionEnd", { name: p.name });
  return (
    <AppModal
      opened={opened}
      onClose={close}
      title={t("edit.splitTitle")}
      centered
      data-testid="edit-split-dialog"
    >
      <Stack>
        {points.length === 0 ? (
          <Alert color="gray">{t("edit.reasons.noMarkers")}</Alert>
        ) : (
          <>
            <Group gap="xs">
              <Button
                variant="subtle"
                size="compact-sm"
                mih={44}
                onClick={() => {
                  setOff(new Set());
                }}
              >
                {t("edit.allTracks")}
              </Button>
              <Button
                variant="subtle"
                size="compact-sm"
                mih={44}
                onClick={() => {
                  setOff(new Set(points.map((p) => p.key)));
                }}
              >
                {t("edit.noTracks")}
              </Button>
            </Group>
            <Stack gap={0} mah={360} style={{ overflowY: "auto" }}>
              {points.map((p) => (
                <Checkbox
                  key={p.key}
                  py={12}
                  checked={!off.has(p.key)}
                  onChange={(e) => {
                    const next = new Set(off);
                    if (e.currentTarget.checked) next.delete(p.key);
                    else next.add(p.key);
                    setOff(next);
                  }}
                  label={`${formatClock(p.sec, true)} · ${label(p)}`}
                  data-testid="edit-split-point"
                />
              ))}
            </Stack>
          </>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={chosen.length === 0}
            onClick={() => {
              if (actions.splitAtMarkers(chosen.map((p) => ({ id: p.markerId, sec: p.sec }))))
                close();
            }}
            data-testid="edit-split-apply"
          >
            {t("edit.splitApply", { count: chosen.length })}
          </Button>
        </Group>
      </Stack>
    </AppModal>
  );
}

const FADE_KEYS: readonly (keyof EditFades)[] = ["fadeIn", "fadeOut", "crossfade"];
const FOLLOW_KEYS: readonly (keyof TimelineFollow)[] = ["markers", "sections", "comments", "tempo"];

const msOf = (frames: number) => Math.round(frames / 48);
const framesOf = (ms: number) => Math.max(0, Math.min(480_000, Math.round(ms * 48)));

/** Edit options (SPEC §24.6): fades, overlap mode, timeline follow-up and snap. */
function EditOptionsButton({ size }: { size: number }) {
  const { t } = useTranslation();
  const opened = useEdit((s) => s.dialog === "options");
  return (
    <PanelPopover
      opened={opened}
      onChange={(o) => {
        openEditDialog(o ? "options" : null);
      }}
      title={t("edit.optionsTitle")}
      width={320}
      position="bottom-end"
      testId="edit-options"
      target={(props) => (
        <Tooltip label={t("edit.options")}>
          <ActionIcon
            size={size}
            variant="subtle"
            color="gray"
            aria-label={t("edit.options")}
            {...props}
            data-testid="edit-options-button"
          >
            <IconAdjustmentsAlt size={Math.round(size * 0.6)} />
          </ActionIcon>
        </Tooltip>
      )}
    >
      <EditOptionsPanel />
    </PanelPopover>
  );
}

/** Phones: the edit options full screen, opened from the edit row's "⋯". */
function EditOptionsSheet() {
  const { t } = useTranslation();
  const opened = useEdit((s) => s.dialog === "options");
  return (
    <AppModal
      opened={opened}
      onClose={() => {
        openEditDialog(null);
      }}
      title={t("edit.optionsTitle")}
      data-testid="edit-options"
    >
      <EditOptionsPanel />
    </AppModal>
  );
}

export function EditOptionsPanel() {
  const { t } = useTranslation();
  const options = useEdit((s) => s.options);
  const setFade = (key: keyof EditFades, ms: number | string) => {
    const v = typeof ms === "number" ? ms : Number(ms);
    if (!Number.isFinite(v)) return;
    setEditOptions({ fades: { ...options.fades, [key]: framesOf(v) } });
  };
  const setFollow = (key: keyof TimelineFollow, on: boolean) => {
    setEditOptions({ timeline: { ...options.timeline, [key]: on } });
  };
  return (
    <Stack gap="sm" data-testid="edit-options-panel">
      <Text size="xs" c="dimmed">
        {t("edit.fadesNote")}
      </Text>
      <Group grow gap="xs">
        {FADE_KEYS.map((k) => (
          <NumberInput
            key={k}
            label={t(`edit.fades.${k}`)}
            value={msOf(options.fades[k])}
            onChange={(v) => {
              setFade(k, v);
            }}
            min={0}
            max={10_000}
            step={5}
            allowDecimal={false}
            data-testid={`edit-fade-${k}`}
          />
        ))}
      </Group>
      <div>
        <Text size="sm" fw={500} mb={4}>
          {t("edit.overlap.title")}
        </Text>
        <SegmentedControl
          fullWidth
          orientation="vertical"
          value={options.overlap}
          onChange={(v) => {
            const mode = OVERLAP_MODES.find((m) => m === v);
            if (mode) setEditOptions({ overlap: mode });
          }}
          data={OVERLAP_MODES.map((m) => ({ value: m, label: t(`edit.overlap.${m}`) }))}
          data-testid="edit-overlap"
        />
      </div>
      <Stack gap={6}>
        <Text size="sm" fw={500}>
          {t("edit.follow.title")}
        </Text>
        {FOLLOW_KEYS.map((k) => (
          <Switch
            key={k}
            label={t(`edit.follow.${k}`)}
            checked={options.timeline[k]}
            onChange={(e) => {
              setFollow(k, e.currentTarget.checked);
            }}
            data-testid={`edit-follow-${k}`}
          />
        ))}
      </Stack>
      <Select
        label={t("edit.snap")}
        value={options.snap}
        allowDeselect={false}
        data={SNAP_MODES.map((m) => ({ value: m, label: t(`markers.snap.${m}`) }))}
        onChange={(v) => {
          const mode = SNAP_MODES.find((m) => m === v);
          if (!mode) return;
          setSnap(mode);
          setEditOptions({ snap: mode });
        }}
        comboboxProps={{ withinPortal: false }}
        data-testid="edit-snap"
      />
    </Stack>
  );
}

/** The out-of-sync chip on a track strip (SPEC §24.3: subset ripples). */
export function OutOfSyncChip({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <Tooltip label={t("edit.outOfSyncHint")}>
      <ActionIcon
        component="span"
        size="sm"
        variant="light"
        color="orange"
        role="img"
        aria-label={t("edit.outOfSync", { count })}
        data-testid="edit-out-of-sync"
      >
        <IconAlertTriangle size={12} />
      </ActionIcon>
    </Tooltip>
  );
}
