import { Button } from "@mantine/core";
import { IconBell, IconBellOff } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useFollow } from "./queries";

/** Follow a song (new versions) or a project (new songs) (SPEC §16). */
export function FollowButton({ target, id }: { target: "song" | "project"; id: string }) {
  const { t } = useTranslation();
  const { following, loaded, set } = useFollow(target, id);
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
      title={t(target === "song" ? "follow.songHint" : "follow.projectHint")}
      data-testid="follow-toggle"
    >
      {following ? t("follow.following") : t("follow.follow")}
    </Button>
  );
}
