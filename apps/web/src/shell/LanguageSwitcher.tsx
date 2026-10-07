import { LOCALES, type Locale } from "@bandroom/shared";
import { ActionIcon, Menu } from "@mantine/core";
import { IconCheck, IconLanguage } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { usePersistPreference } from "../auth/useAccount";
import { changeLanguage } from "../i18n/i18n";

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const current = i18n.resolvedLanguage as Locale | undefined;
  const persist = usePersistPreference();

  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size={44}
          aria-label={t("language.label")}
          title={t("language.label")}
          data-testid="language-switcher"
        >
          <IconLanguage size={22} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {LOCALES.map((lng) => (
          <Menu.Item
            key={lng}
            lang={lng}
            data-testid={`language-${lng}`}
            leftSection={lng === current ? <IconCheck size={16} /> : <span style={{ width: 16 }} />}
            onClick={() => {
              void changeLanguage(lng, i18n);
              persist({ locale: lng });
            }}
          >
            {t(`language.${lng}`)}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
