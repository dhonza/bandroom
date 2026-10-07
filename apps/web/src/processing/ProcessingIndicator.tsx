import {
  ActionIcon,
  Anchor,
  Group,
  Indicator,
  Popover,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { IconLoader2 } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { RunProgress } from "../features/admin/imports/RunProgress";
import { ProcessingBadge } from "./ProcessingBadge";
import { isActive, useProcessing } from "./queries";

/**
 * Header button shown while files are being processed (SPEC §25.3): a count of songs with queued
 * or running work (and, for admins, running imports), opening a list of them. Songs whose files
 * failed are listed too, but failures alone do not show the button.
 */
export function ProcessingIndicator() {
  const { t } = useTranslation();
  const { data } = useProcessing();
  const [opened, setOpened] = useState(false);
  const active = (data?.songs ?? []).filter((s) => isActive(s.processing));
  const imports = data?.imports ?? [];
  const count = active.length + imports.length;
  if (count === 0 && !opened) return null;
  const label = t("processing.indicator", { count });
  const close = () => {
    setOpened(false);
  };
  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-end" withinPortal shadow="md">
      <Popover.Target>
        <Tooltip label={label} disabled={opened}>
          <Indicator
            label={count > 99 ? "99+" : count}
            size={18}
            offset={6}
            color="blue"
            disabled={count === 0}
            data-testid="processing-indicator"
            data-count={count}
          >
            <ActionIcon
              size={44}
              variant="subtle"
              color="gray"
              aria-label={label}
              aria-expanded={opened}
              onClick={() => {
                setOpened((o) => !o);
              }}
              data-testid="processing-button"
            >
              <IconLoader2 size={22} className="br-spin" />
            </ActionIcon>
          </Indicator>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown
        p="xs"
        maw="min(360px, calc(100vw - 16px))"
        data-testid="processing-popover"
      >
        <Stack gap="xs">
          <Text fw={600} size="sm" px={4}>
            {t("processing.title")}
          </Text>
          {/* Only admins get imports from the server. */}
          {imports.map((run) => (
            <Stack key={run.id} gap={4}>
              <RunProgress run={run} compact />
              <Anchor component={Link} to="/admin?tab=import" size="sm" onClick={close} px={4}>
                {t("processing.openImport")}
              </Anchor>
            </Stack>
          ))}
          {(data?.songs.length ?? 0) === 0 && imports.length === 0 && (
            <Text size="sm" c="dimmed" px={4}>
              {t("processing.none")}
            </Text>
          )}
          <ScrollArea.Autosize mah={320} type="auto">
            <Stack gap={0}>
              {data?.songs.map((s) => (
                <UnstyledButton
                  key={s.songId}
                  component={Link}
                  to={`/songs/${s.songId}`}
                  onClick={close}
                  px={4}
                  py={6}
                  mih={44}
                  data-testid="processing-song"
                  style={{ borderRadius: "var(--mantine-radius-sm)" }}
                >
                  <Group gap="sm" wrap="nowrap" justify="space-between">
                    <Stack gap={0} style={{ minWidth: 0 }}>
                      <Text size="sm" fw={500} truncate>
                        {s.title}
                      </Text>
                      <Text size="xs" c="dimmed" truncate>
                        {s.projectName}
                      </Text>
                    </Stack>
                    <ProcessingBadge processing={s.processing} />
                  </Group>
                </UnstyledButton>
              ))}
            </Stack>
          </ScrollArea.Autosize>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
