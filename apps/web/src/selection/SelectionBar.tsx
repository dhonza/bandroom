import { ActionIcon, Button, Group, Menu, Paper, Stack, Text } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useOnline } from "../offline/online";

/** One batch action of the bar (SPEC §26.1). */
export interface SelectionAction {
  key: string;
  label: string;
  icon: ReactNode;
  color?: string;
  /** How many of the selected items it applies to; 0 disables it. */
  allowed: number;
  /** Why the other selected items are left out ("2 are not yours"). */
  reason?: string;
  loading?: boolean;
  onClick: () => void;
  /** Turns the button into a menu of these entries (e.g. "Copy to…", "Move to…"). */
  menu?: readonly SelectionMenuItem[];
}

/** An entry of an action's menu; entries with `allowed` 0 are disabled. */
export interface SelectionMenuItem {
  key: string;
  label: string;
  allowed: number;
  onClick: () => void;
}

/**
 * The sticky action bar of a selection (SPEC §26.1): the count, "Select all", the actions and a
 * close button; `Esc` leaves selection mode too. It sticks to the bottom of the viewport above
 * the phone tab bar and mini-player (or to the bottom of a modal with `inModal`).
 */
export function SelectionBar({
  count,
  total,
  onSelectAll,
  onExit,
  actions,
  inModal = false,
  testId = "selection-bar",
}: {
  count: number;
  total: number;
  onSelectAll: () => void;
  onExit: () => void;
  actions: readonly SelectionAction[];
  inModal?: boolean;
  testId?: string;
}) {
  const { t } = useTranslation();
  // Batch actions work online only (SPEC §26.1).
  const online = useOnline();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // A dialog above a page's bar handles its own Esc.
      const target = e.target instanceof Element ? e.target : null;
      if (!inModal && target?.closest("[role=dialog]")) return;
      // Esc in an action's open menu closes only the menu.
      if (target?.closest("[role=menu]")) return;
      onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onExit, inModal]);
  const partial = actions.filter((a) => a.allowed > 0 && a.allowed < count && a.reason);
  return (
    <Paper
      withBorder
      shadow="md"
      radius="md"
      p="xs"
      data-testid={testId}
      role="toolbar"
      aria-label={t("selection.toolbar")}
      style={{
        position: "sticky",
        bottom: inModal
          ? 0
          : "calc(var(--app-shell-footer-offset, 0px) + var(--mantine-spacing-xs))",
        zIndex: 20,
      }}
    >
      <Stack gap={4}>
        <Group gap="xs" wrap="wrap" justify="space-between">
          <Group gap={4} wrap="nowrap">
            <ActionIcon
              variant="subtle"
              color="gray"
              size={44}
              onClick={onExit}
              aria-label={t("selection.exit")}
              data-testid="selection-exit"
            >
              <IconX size={18} />
            </ActionIcon>
            <Text fw={600} size="sm" data-testid="selection-count">
              {t("selection.count", { count })}
            </Text>
            {count < total && (
              <Button
                variant="subtle"
                size="compact-sm"
                h={44}
                onClick={onSelectAll}
                data-testid="selection-all"
              >
                {t("selection.selectAll")}
              </Button>
            )}
          </Group>
          <Group gap="xs" wrap="wrap">
            {actions.map((a) => {
              const button = (
                <Button
                  key={a.key}
                  h={44}
                  variant="light"
                  color={a.color}
                  leftSection={a.icon}
                  disabled={a.allowed === 0 || !online}
                  loading={a.loading}
                  onClick={a.menu ? undefined : a.onClick}
                  data-testid={`selection-${a.key}`}
                >
                  {a.allowed < count && a.allowed > 0
                    ? t("selection.actionCount", { label: a.label, count: a.allowed })
                    : a.label}
                </Button>
              );
              if (!a.menu) return button;
              return (
                <Menu key={a.key} position="top-end" withinPortal>
                  <Menu.Target>{button}</Menu.Target>
                  <Menu.Dropdown>
                    {a.menu.map((m) => (
                      <Menu.Item
                        key={m.key}
                        disabled={m.allowed === 0}
                        onClick={m.onClick}
                        mih={44}
                        data-testid={`selection-${m.key}`}
                      >
                        {m.label}
                      </Menu.Item>
                    ))}
                  </Menu.Dropdown>
                </Menu>
              );
            })}
          </Group>
        </Group>
        {!online && (
          <Text size="xs" c="dimmed" data-testid="selection-offline">
            {t("offline.needsNetwork")}
          </Text>
        )}
        {partial.map((a) => (
          <Text key={a.key} size="xs" c="dimmed" data-testid={`selection-reason-${a.key}`}>
            {a.reason}
          </Text>
        ))}
        {count > 0 && actions.length > 0 && actions.every((a) => a.allowed === 0) && (
          <Text size="xs" c="dimmed" data-testid="selection-reason-none">
            {actions.find((a) => a.reason)?.reason}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
