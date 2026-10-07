import { ActionIcon, Tooltip } from "@mantine/core";
import { IconLayoutSidebarLeftExpand } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { setChromeHidden } from "./chrome";

/** Floating 44 px button that brings the navigation back (SPEC §25.2). */
export function ChromeRestoreButton() {
  const { t } = useTranslation();
  return (
    <Tooltip label={t("chrome.show")} position="left">
      <ActionIcon
        size={44}
        radius="xl"
        variant="default"
        aria-label={t("chrome.show")}
        data-testid="chrome-show"
        onClick={() => {
          setChromeHidden(false);
        }}
        style={{
          position: "fixed",
          top: "calc(env(safe-area-inset-top) + 6px)",
          insetInlineEnd: "calc(env(safe-area-inset-right) + 6px)",
          zIndex: "calc(var(--mantine-z-index-app) + 1)",
          opacity: 0.85,
          boxShadow: "var(--mantine-shadow-sm)",
        }}
      >
        <IconLayoutSidebarLeftExpand size={22} />
      </ActionIcon>
    </Tooltip>
  );
}
