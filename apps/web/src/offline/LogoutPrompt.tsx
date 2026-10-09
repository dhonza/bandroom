import { Button, Group, List, Modal, Stack, Text } from "@mantine/core";
import { IconLogout } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { useLogout } from "../auth/useAccount";
import { formatBytes } from "../lib/media";
import { unsentTakeCount, useTakes } from "../record/takes";
import { useOffline } from "./controller";

const usePrompt = create<{ open: boolean }>(() => ({ open: false }));

/**
 * "Log out": with offline data on this device, first a warning listing what will be removed
 * (SPEC §13), then the logout, which clears it.
 */
export function useRequestLogout(): { request: () => void; pending: boolean } {
  const logout = useLogout();
  return {
    pending: logout.isPending,
    request: () => {
      const { items, outbox } = useOffline.getState();
      if (items.length > 0 || outbox.length > 0 || unsentTakeCount() > 0)
        usePrompt.setState({ open: true });
      else logout.mutate();
    },
  };
}

export function LogoutPrompt() {
  const { t, i18n } = useTranslation();
  const open = usePrompt((s) => s.open);
  const items = useOffline((s) => s.items);
  const outbox = useOffline((s) => s.outbox);
  const takes = useTakes(unsentTakeCount);
  const logout = useLogout();
  const locale = i18n.resolvedLanguage ?? "en";
  const close = () => {
    usePrompt.setState({ open: false });
  };
  return (
    <Modal opened={open} onClose={close} title={t("offline.logout.title")} centered>
      <Stack gap="md" data-testid="logout-prompt">
        <Text size="sm">{t("offline.logout.explain")}</Text>
        {items.length > 0 && (
          <List size="sm" spacing={2}>
            {items.map((i) => (
              <List.Item key={i.key}>
                {t("offline.logout.item", { title: i.title, size: formatBytes(i.bytes, locale) })}
              </List.Item>
            ))}
          </List>
        )}
        {takes > 0 && (
          <Text size="sm" c="red" data-testid="logout-unsent-takes">
            {t("record.logoutUnsent", { count: takes })}
          </Text>
        )}
        {outbox.length > 0 && (
          <Text size="sm" c="red">
            {t("offline.logout.unsent", { count: outbox.length })}
          </Text>
        )}
        <Group justify="flex-end">
          <Button variant="default" h={44} onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button
            color="red"
            h={44}
            leftSection={<IconLogout size={16} />}
            loading={logout.isPending}
            onClick={() => {
              logout.mutate(undefined, { onSettled: close });
            }}
            data-testid="logout-confirm"
          >
            {t("offline.logout.confirm")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
