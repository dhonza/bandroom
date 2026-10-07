import { ActionIcon, useComputedColorScheme, useMantineColorScheme } from "@mantine/core";
import { IconMoon, IconSun } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { usePersistPreference } from "../auth/useAccount";

export function ColorSchemeToggle() {
  const { t } = useTranslation();
  const { setColorScheme } = useMantineColorScheme();
  const computed = useComputedColorScheme("dark", { getInitialValueInEffect: false });
  const next = computed === "dark" ? "light" : "dark";
  const persist = usePersistPreference();

  return (
    <ActionIcon
      variant="subtle"
      color="gray"
      size={44}
      aria-label={t("appearance.toggleColorScheme")}
      title={t("appearance.toggleColorScheme")}
      data-testid="color-scheme-toggle"
      onClick={() => {
        setColorScheme(next);
        persist({ theme: next });
      }}
    >
      {computed === "dark" ? <IconSun size={22} /> : <IconMoon size={22} />}
    </ActionIcon>
  );
}
