import { PALETTE_COLORS, updateTrack, type PaletteColor, type Track } from "@bandroom/shared";
import { CheckIcon, ColorSwatch, Popover, SimpleGrid, Text, UnstyledButton } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { useApiError } from "../api/useApiError";
import { songKeys } from "../features/library/queries";

function useSetTrackColor(track: Track) {
  const qc = useQueryClient();
  const apiError = useApiError();
  return useMutation({
    mutationFn: (color: PaletteColor) =>
      api(updateTrack, { params: { id: track.id }, body: { color } }),
    onError: (err) => {
      notifications.show({ color: "red", message: apiError(err) });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: songKeys.tracks(track.songId) });
    },
  });
}

/** The palette as 44 px swatches, 4 × 4 (SPEC §25.10); picking one saves the track's colour. */
export function TrackColorPalette({ track, onPicked }: { track: Track; onPicked?: () => void }) {
  const { t } = useTranslation();
  const save = useSetTrackColor(track);
  const label = t("rehearse.trackColor", { track: track.name });
  return (
    <div>
      <Text size="xs" fw={600} mb={4}>
        {t("rehearse.colorLabel")}
      </Text>
      <SimpleGrid
        cols={4}
        spacing={4}
        verticalSpacing={4}
        w="fit-content"
        role="radiogroup"
        aria-label={label}
        data-testid="track-color-palette"
      >
        {PALETTE_COLORS.map((c) => {
          const current = (save.isPending ? save.variables : track.color) === c;
          return (
            <ColorSwatch
              key={c}
              component="button"
              type="button"
              role="radio"
              aria-checked={current}
              aria-label={t(`colors.${c}`)}
              color={`var(--mantine-color-${c}-6)`}
              size={44}
              style={{ cursor: "pointer", color: "#fff" }}
              onClick={() => {
                if (c !== track.color) save.mutate(c);
                onPicked?.();
              }}
            >
              {current && <CheckIcon style={{ width: 16, height: 16 }} />}
            </ColorSwatch>
          );
        })}
      </SimpleGrid>
    </div>
  );
}

/**
 * The colour bar at the strip's left edge. Editors of the track click it for the palette (SPEC
 * §25.10); for everyone else it is only the colour.
 */
export function TrackColorBar({ track, canEdit }: { track: Track; canEdit: boolean }) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const bar = (
    <div
      style={{
        width: 4,
        height: "100%",
        background: `var(--mantine-color-${track.color}-6)`,
      }}
    />
  );
  if (!canEdit) return <div style={{ flex: "none" }}>{bar}</div>;
  return (
    <Popover opened={opened} onChange={setOpened} position="right-start" withArrow>
      <Popover.Target>
        <UnstyledButton
          w={12}
          h="100%"
          style={{ flex: "none", display: "flex" }}
          aria-label={t("rehearse.trackColor", { track: track.name })}
          aria-haspopup="dialog"
          onClick={() => {
            setOpened((o) => !o);
          }}
          data-testid="track-color"
        >
          {bar}
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown w={220}>
        <TrackColorPalette
          track={track}
          onPicked={() => {
            setOpened(false);
          }}
        />
      </Popover.Dropdown>
    </Popover>
  );
}
