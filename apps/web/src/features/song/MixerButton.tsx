import { Button } from "@mantine/core";
import { IconAdjustmentsHorizontal } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

/** The song player's Mixer toggle (DECISIONS 2026-09-29). */
export function MixerButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      h={44}
      px="sm"
      variant={open ? "filled" : "default"}
      leftSection={<IconAdjustmentsHorizontal size={18} />}
      aria-pressed={open}
      onClick={onClick}
      data-testid="mixer-toggle"
      style={{ flex: "none" }}
    >
      {t("rehearse.mixer")}
    </Button>
  );
}
