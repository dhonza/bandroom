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
  Group,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  Tooltip,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  IconAdjustmentsAlt,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconCheck,
  IconCloudUpload,
  IconCut,
  IconFlag,
  IconScissors,
  IconVolume,
  IconVolumeOff,
  IconAlertTriangle,
  IconX,
} from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AppModal, CaptionButton, PanelPopover } from "../components/ResponsivePanel";
import { setSnap } from "../markers/store";
import { formatClock } from "../player/format";
import { PHONE_QUERY } from "../shell/mediaQueries";
import { useEditActions, useEditAvailability } from "./actions";
import { splitPoints, type UnavailableReason } from "./model";
import {
  editCanRedo,
  editCanUndo,
  openEditDialog,
  setEditOptions,
  setSelectedTracks,
  useEdit,
  type SaveStatus,
} from "./store";

/** Height of the phone's edit sheet (two rows of 44 px buttons and padding). */
export const EDIT_SHEET_H = 112;

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
  const why = (r: UnavailableReason | null) => (r ? t(`edit.reasons.${r}`) : null);
  return [
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
}

/**
 * The edit toolbar (SPEC §24.6): under the song header on desktop; on phones a sheet at the
 * bottom of the screen (above the tab bar; the transport stays pinned at the top), so every
 * operation is one tap away.
 */
export function EditToolbar({
  markers,
  durationSec,
}: {
  markers: readonly Marker[];
  durationSec: number;
}) {
  const { t } = useTranslation();
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const tools = useToolActions();
  const options = <EditOptionsButton phone={phone} />;
  const dialogs = (
    <>
      <GainDialog />
      <SplitAtMarkersDialog markers={markers} durationSec={durationSec} />
    </>
  );
  if (phone) {
    return (
      <>
        {/* Keeps the page's end clear of the sheet. */}
        <Box h={EDIT_SHEET_H} aria-hidden />
        <Paper
          shadow="md"
          withBorder
          radius={0}
          px={4}
          py={4}
          data-testid="edit-toolbar"
          data-layout="sheet"
          style={{
            position: "fixed",
            insetInline: 0,
            bottom: "var(--app-shell-footer-offset, 0px)",
            zIndex: 150,
            paddingBottom: "calc(4px + env(safe-area-inset-bottom))",
          }}
          role="toolbar"
          aria-label={t("edit.toolbar")}
        >
          <Group gap={2} justify="space-around" wrap="wrap">
            {tools.map((a) => (
              <Why key={a.key} reason={a.disabledReason}>
                <CaptionButton
                  icon={a.icon}
                  caption={a.short}
                  onClick={a.onClick}
                  disabled={a.disabledReason !== null}
                  aria-label={a.label}
                  data-testid={a.testId}
                />
              </Why>
            ))}
            {options}
          </Group>
        </Paper>
        {dialogs}
      </>
    );
  }
  return (
    <Paper
      withBorder
      p={6}
      data-testid="edit-toolbar"
      data-layout="bar"
      role="toolbar"
      aria-label={t("edit.toolbar")}
    >
      <Group gap={4} wrap="wrap">
        {tools.map((a) => (
          <Why key={a.key} reason={a.disabledReason}>
            <Button
              variant="default"
              h={44}
              px="sm"
              leftSection={a.icon}
              onClick={a.onClick}
              disabled={a.disabledReason !== null}
              data-testid={a.testId}
            >
              {a.label}
            </Button>
          </Why>
        ))}
        {options}
        <Box ml="auto">
          <TrackSelectionSummary />
        </Box>
      </Group>
      {dialogs}
    </Paper>
  );
}

/** "3 of 5 tracks" with All / None (SPEC §24.6). */
export function TrackSelectionSummary() {
  const { t } = useTranslation();
  const selected = useEdit((s) => s.selectedTracks.length);
  const all = useEdit((s) => s.base?.tracks.map((x) => x.trackId) ?? []);
  return (
    <Group gap={4} wrap="nowrap" data-testid="edit-track-count">
      <Text size="sm" c={selected === 0 ? "red" : "dimmed"} style={{ whiteSpace: "nowrap" }}>
        {t("edit.tracksCount", { count: selected, total: all.length })}
      </Text>
      <Button
        variant="subtle"
        size="compact-sm"
        mih={44}
        onClick={() => {
          setSelectedTracks(all);
        }}
        disabled={selected === all.length}
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
        disabled={selected === 0}
        data-testid="edit-tracks-none"
      >
        {t("edit.noTracks")}
      </Button>
    </Group>
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
 * Replaces the song header's actions in edit mode (SPEC §24.6): the mode, the save status, the
 * track selection (phones) and Cancel (confirmed when there are ops).
 */
export function EditHeaderBar({ onCancel }: { onCancel: () => Promise<void> }) {
  const { t } = useTranslation();
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const ops = useEdit((s) => s.ops.length);
  const dialog = useEdit((s) => s.dialog);
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
    <Group gap="xs" wrap="wrap" justify="flex-end" data-testid="edit-bar">
      <Text fw={700} c="orange" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <IconCut size={18} />
        {t("edit.mode")}
      </Text>
      <SaveState />
      {phone && <TrackSelectionSummary />}
      <Button
        variant="light"
        color="red"
        h={44}
        leftSection={<IconX size={16} />}
        loading={busy && dialog !== "cancel"}
        onClick={() => {
          if (ops > 0) openEditDialog("cancel");
          else void cancel();
        }}
        data-testid="edit-cancel"
      >
        {t("edit.cancel")}
      </Button>
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
function EditOptionsButton({ phone }: { phone: boolean }) {
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
      target={(props) =>
        phone ? (
          <CaptionButton
            icon={<IconAdjustmentsAlt size={18} />}
            caption={t("edit.options")}
            aria-label={t("edit.options")}
            onClick={() => {
              props.onClick({} as never);
            }}
            data-testid="edit-options-button"
          />
        ) : (
          <Button
            variant="default"
            h={44}
            px="sm"
            leftSection={<IconAdjustmentsAlt size={18} />}
            {...props}
            data-testid="edit-options-button"
          >
            {t("edit.options")}
          </Button>
        )
      }
    >
      <EditOptionsPanel />
    </PanelPopover>
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
