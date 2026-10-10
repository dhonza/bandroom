import { type Song, type SongTempo } from "@bandroom/shared";
import { ActionIcon, Menu, Tabs, Text, Tooltip } from "@mantine/core";
import { IconClock } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { frozenBy, LockedHint } from "../features/song/songLock";
import { usePlayerView } from "../rehearse/controller";
import { ManualTempo } from "./ManualTempo";
import { MidiImport } from "./MidiImport";
import { tempoSummaryParams } from "./midi";
import { summarize } from "./model";
import { useSongTempo } from "./queries";
import { endTempoPreview } from "./store";
import { TempoHistory } from "./TempoHistory";
import { AppModal } from "../components/ResponsivePanel";

/** "120 BPM · 4/4" for the song header and the toolbar button. */
export function useTempoLabel(tempo: SongTempo | null): string | null {
  const { t } = useTranslation();
  if (!tempo) return null;
  return t("tempo.summary", tempoSummaryParams(summarize(tempo.map)));
}

/** Whether the tempo dialog is open: the toolbar button or the time-signature lane opens it. */
const useTempoDialog = create<{ open: boolean }>(() => ({ open: false }));

/** Opens the tempo dialog of the song page's tempo button (the time-signature lane). */
export function openTempoDialog(): void {
  useTempoDialog.setState({ open: true });
}

function closeTempoDialog(): void {
  useTempoDialog.setState({ open: false });
}

/**
 * "Tempo map" in the control bar (SPEC §7.2, §7.3, §31.1): an icon for editors, with the summary
 * (or "Set tempo") in its tooltip; frozen while the song is locked (SPEC §25.12) or edited
 * (SPEC §24.7). Others see the summary in the song header only. The dialog is `TempoDialogHost`.
 */
export function TempoButton({ song, size = 44 }: { song: Song; size?: number }) {
  const { t } = useTranslation();
  const { tempo } = useSongTempo(song.id);
  const label = useTempoLabel(tempo);
  if (!song.access.capabilities.includes("tempo.edit")) return null;
  const lockReason = frozenBy(song, "tempo.edit");
  const locked = lockReason !== null;
  const button = (
    <ActionIcon
      size={size}
      variant="subtle"
      color="gray"
      disabled={locked}
      onClick={openTempoDialog}
      aria-label={t("tempo.map")}
      data-testid="tempo-button"
    >
      <IconClock size={Math.round(size * 0.55)} />
    </ActionIcon>
  );
  if (locked)
    return (
      <LockedHint locked reason={lockReason}>
        {button}
      </LockedHint>
    );
  return <Tooltip label={`${t("tempo.map")} · ${label ?? t("tempo.set")}`}>{button}</Tooltip>;
}

/** "Tempo map" in the phone and landscape "⋯" menu. */
export function TempoMenuItem({ song }: { song: Song }) {
  const { t } = useTranslation();
  const { tempo } = useSongTempo(song.id);
  const label = useTempoLabel(tempo);
  if (!song.access.capabilities.includes("tempo.edit")) return null;
  return (
    <Menu.Item
      leftSection={<IconClock size={14} />}
      closeMenuOnClick
      disabled={frozenBy(song, "tempo.edit") !== null}
      onClick={openTempoDialog}
      data-testid="tempo-button"
    >
      {label ? `${t("tempo.map")} · ${label}` : t("tempo.set")}
    </Menu.Item>
  );
}

/** The tempo dialog of the song page, opened by the tempo button, menu item or a ruler meter. */
export function TempoDialogHost({ song }: { song: Song }) {
  const { tempo } = useSongTempo(song.id);
  const open = useTempoDialog((s) => s.open);
  // Leaving the song page closes it (the next song must not open with it).
  useEffect(() => closeTempoDialog, []);
  if (!open || frozenBy(song, "tempo.edit") !== null) return null;
  return (
    <TempoDialog
      song={song}
      tempo={tempo}
      onClose={() => {
        endTempoPreview();
        closeTempoDialog();
      }}
    />
  );
}

function TempoDialog({
  song,
  tempo,
  onClose,
}: {
  song: Song;
  tempo: SongTempo | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<string | null>("manual");
  return (
    <AppModal
      opened
      onClose={onClose}
      title={t("tempo.title")}
      size="lg"
      data-testid="tempo-dialog"
    >
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="manual" data-testid="tempo-tab-manual">
            {t("tempo.tabs.manual")}
          </Tabs.Tab>
          <Tabs.Tab value="midi" data-testid="tempo-tab-midi">
            {t("tempo.tabs.midi")}
          </Tabs.Tab>
          <Tabs.Tab value="history" data-testid="tempo-tab-history">
            {t("tempo.tabs.history")}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="manual">
          <ManualTempo song={song} tempo={tempo} onDone={onClose} />
        </Tabs.Panel>
        <Tabs.Panel value="midi">
          <MidiImport song={song} tempo={tempo} onDone={onClose} />
        </Tabs.Panel>
        <Tabs.Panel value="history">
          <TempoHistory song={song} tempo={tempo} />
        </Tabs.Panel>
      </Tabs>
    </AppModal>
  );
}

/** "120 BPM · 4/4" beside the song title (SPEC §11.3 header). */
export function SongTempoSummary({ songId, size = "sm" }: { songId: string; size?: "xs" | "sm" }) {
  const { t } = useTranslation();
  const { tempo } = useSongTempo(songId);
  const label = useTempoLabel(tempo);
  // At a practice speed the summary adds it: "120 BPM · 4/4 · 85 %" (SPEC §30.6).
  const rate = usePlayerView((s) => (s.songId === songId ? (s.mix.practice?.rate ?? 1) : 1));
  if (!label) return null;
  return (
    <Text c="dimmed" size={size} className="tabular-nums" data-testid="song-tempo" truncate="end">
      {rate === 1
        ? label
        : t("tempo.summaryPractice", { summary: label, rate: Math.round(rate * 100) })}
    </Text>
  );
}
