import { Button } from "@mantine/core";
import { IconAdjustmentsHorizontal } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { MixerToggle } from "./useMixerToggle";

/**
 * The Mixer button of the song header (SPEC §11.3): first in the header row, so toggling never
 * moves it; `aria-pressed` shows the state. Disabled while the song has no tracks.
 */
export function MixerButton({ mixer, disabled }: { mixer: MixerToggle; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <Button
      h={44}
      px="sm"
      variant={mixer.open ? "filled" : "default"}
      leftSection={<IconAdjustmentsHorizontal size={18} />}
      aria-pressed={mixer.open}
      disabled={disabled}
      onClick={mixer.toggle}
      data-testid="mixer-toggle"
    >
      {t("rehearse.mixer")}
    </Button>
  );
}
