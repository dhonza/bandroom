import { lockedOut, type Song, type SongTempo } from "@bandroom/shared";
import { Badge, Button, Modal, Tabs, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconMetronome } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LockedHint } from "../features/song/songLock";
import { usePlayerView } from "../rehearse/controller";
import { PHONE_QUERY } from "../shell/mediaQueries";
import { ManualTempo } from "./ManualTempo";
import { MidiImport } from "./MidiImport";
import { tempoSummaryParams } from "./midi";
import { summarize } from "./model";
import { useSongTempo } from "./queries";
import { endTempoPreview } from "./store";
import { BTN } from "./styles";
import { TempoHistory } from "./TempoHistory";

/** "120 BPM · 4/4" for the song header and the toolbar button. */
export function useTempoLabel(tempo: SongTempo | null): string | null {
  const { t } = useTranslation();
  if (!tempo) return null;
  return t("tempo.summary", tempoSummaryParams(summarize(tempo.map)));
}

/**
 * Toolbar button: the tempo summary (or "Set tempo") that opens the tempo dialog for editors
 * (SPEC §7.2, §7.3); others see the summary only.
 */
export function TempoButton({ song }: { song: Song }) {
  const { t } = useTranslation();
  const { tempo } = useSongTempo(song.id);
  const label = useTempoLabel(tempo);
  const [open, setOpen] = useState(false);
  const canEdit = song.access.capabilities.includes("tempo.edit");
  if (!canEdit) {
    return label ? (
      <Badge variant="light" color="gray" size="lg" data-testid="tempo-summary">
        {label}
      </Badge>
    ) : null;
  }
  // The tempo map is frozen while the song is locked (SPEC §25.12).
  const locked = lockedOut(song.locked !== null, "tempo.edit");
  return (
    <>
      <LockedHint locked={locked}>
        <Button
          {...BTN}
          size="sm"
          variant="default"
          leftSection={<IconMetronome size={16} />}
          disabled={locked}
          onClick={() => {
            setOpen(true);
          }}
          data-testid="tempo-button"
        >
          {label ?? t("tempo.set")}
        </Button>
      </LockedHint>
      {open && !locked && (
        <TempoDialog
          song={song}
          tempo={tempo}
          onClose={() => {
            endTempoPreview();
            setOpen(false);
          }}
        />
      )}
    </>
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
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const [tab, setTab] = useState<string | null>("manual");
  return (
    <Modal
      opened
      onClose={onClose}
      title={t("tempo.title")}
      size="lg"
      fullScreen={phone}
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
    </Modal>
  );
}

/** "120 BPM · 4/4" beside the song title (SPEC §11.3 header). */
export function SongTempoSummary({ songId }: { songId: string }) {
  const { t } = useTranslation();
  const { tempo } = useSongTempo(songId);
  const label = useTempoLabel(tempo);
  // At a practice speed the summary adds it: "120 BPM · 4/4 · 85 %" (SPEC §30.6).
  const rate = usePlayerView((s) => (s.songId === songId ? (s.mix.practice?.rate ?? 1) : 1));
  if (!label) return null;
  return (
    <Text c="dimmed" size="sm" className="tabular-nums" data-testid="song-tempo">
      {rate === 1
        ? label
        : t("tempo.summaryPractice", { summary: label, rate: Math.round(rate * 100) })}
    </Text>
  );
}
