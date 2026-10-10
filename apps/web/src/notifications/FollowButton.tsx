import { ActionIcon, Box, Button, Menu, Tooltip } from "@mantine/core";
import { IconBell, IconBellOff, IconCheck } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useFollow } from "./queries";

/**
 * Follow a song (new versions) or a project (new songs) (SPEC §16). `iconOnly`: the compact song
 * header (SPEC §31.2); the tooltip keeps the full wording.
 */
export function FollowButton({
  target,
  id,
  iconOnly = false,
  size = 44,
}: {
  target: "song" | "project";
  id: string;
  iconOnly?: boolean;
  size?: number;
}) {
  const { t } = useTranslation();
  const { following, loaded, set } = useFollow(target, id);
  const hint = t(target === "song" ? "follow.songHint" : "follow.projectHint");
  const icon = following ? <IconBell size={18} /> : <IconBellOff size={18} />;
  if (iconOnly) {
    return (
      <Tooltip label={`${following ? t("follow.following") : t("follow.follow")} · ${hint}`}>
        <ActionIcon
          size={size}
          variant={following ? "light" : "subtle"}
          color={following ? undefined : "gray"}
          disabled={!loaded}
          onClick={() => {
            set(!following);
          }}
          aria-pressed={following}
          aria-label={t("follow.follow")}
          data-testid="follow-toggle"
        >
          {icon}
        </ActionIcon>
      </Tooltip>
    );
  }
  return (
    <Button
      variant={following ? "light" : "default"}
      h={44}
      disabled={!loaded}
      leftSection={following ? <IconBell size={16} /> : <IconBellOff size={16} />}
      onClick={() => {
        set(!following);
      }}
      aria-pressed={following}
      title={hint}
      data-testid="follow-toggle"
    >
      {following ? t("follow.following") : t("follow.follow")}
    </Button>
  );
}

/** Follow as a checkable item of a "⋯" menu (phones, SPEC §31.2). */
export function FollowMenuItem({ target, id }: { target: "song" | "project"; id: string }) {
  const { t } = useTranslation();
  const { following, loaded, set } = useFollow(target, id);
  return (
    <Menu.Item
      leftSection={following ? <IconCheck size={14} /> : <Box w={14} />}
      rightSection={following ? <IconBell size={14} /> : <IconBellOff size={14} />}
      disabled={!loaded}
      onClick={() => {
        set(!following);
      }}
      role="menuitemcheckbox"
      aria-checked={following}
      data-testid="follow-toggle"
    >
      {t("follow.follow")}
    </Menu.Item>
  );
}
