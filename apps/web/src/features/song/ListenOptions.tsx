import { ActionIcon, Button, Group, Menu, Tooltip } from "@mantine/core";
import {
  IconCheck,
  IconChevronDown,
  IconRepeat,
  IconRepeatOff,
  IconRepeatOnce,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { setQuality, setRepeat } from "../../player/listenEngine";
import { useListen, type ListenQuality, type RepeatMode } from "../../player/listenStore";

const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = { off: "all", all: "one", one: "off" };
const REPEAT_ICON = { off: IconRepeatOff, all: IconRepeat, one: IconRepeatOnce } as const;

/** Repeat mode and stream quality for Listen mode (SPEC §6.9, §6.10). Both apply app-wide. */
export function ListenOptions() {
  const { t } = useTranslation();
  const repeat = useListen((s) => s.repeat);
  const quality = useListen((s) => s.quality);
  const RepeatIcon = REPEAT_ICON[repeat];
  const repeatLabel = t(`listen.repeat.${repeat}`);
  const qualities: ListenQuality[] = ["high", "low"];

  return (
    <Group gap={4} wrap="nowrap">
      <Tooltip label={repeatLabel}>
        <ActionIcon
          size={44}
          variant={repeat === "off" ? "subtle" : "light"}
          color={repeat === "off" ? "gray" : undefined}
          aria-label={repeatLabel}
          aria-pressed={repeat !== "off"}
          data-testid="listen-repeat"
          onClick={() => {
            setRepeat(NEXT_REPEAT[repeat]);
          }}
        >
          <RepeatIcon size={20} />
        </ActionIcon>
      </Tooltip>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Button
            h={44}
            variant="subtle"
            color="gray"
            size="compact-sm"
            rightSection={<IconChevronDown size={14} />}
            aria-label={t("listen.quality.label", { quality: t(`listen.quality.${quality}`) })}
            data-testid="listen-quality"
          >
            {t(`listen.quality.${quality}`)}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>{t("listen.quality.title")}</Menu.Label>
          {qualities.map((q) => (
            <Menu.Item
              key={q}
              leftSection={q === quality ? <IconCheck size={14} /> : <span style={{ width: 14 }} />}
              onClick={() => {
                setQuality(q);
              }}
            >
              {t(`listen.quality.${q}Long`)}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}
