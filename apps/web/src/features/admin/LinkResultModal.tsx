import { Button, CopyButton, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useFormatters } from "../../i18n/format";

/** Shows a freshly created one-time link (invite or password reset). It is shown only once. */
export function LinkResultModal({
  link,
  title,
  explain,
  onClose,
}: {
  link: { url: string; expiresAt: number } | null;
  title: string;
  explain: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  return (
    <Modal opened={link !== null} onClose={onClose} title={title} centered size="lg">
      {link && (
        <Stack>
          <Text size="sm">{explain}</Text>
          <TextInput
            readOnly
            value={link.url}
            data-testid="one-time-link"
            onFocus={(e) => {
              e.currentTarget.select();
            }}
          />
          <Text size="xs" c="dimmed">
            {t("admin.link.expires", { when: fmt.dateTime(link.expiresAt) })}
          </Text>
          <Group justify="flex-end">
            <CopyButton value={link.url}>
              {({ copied, copy }) => (
                <Button
                  variant={copied ? "light" : "filled"}
                  leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                  onClick={copy}
                >
                  {copied ? t("common.copied") : t("common.copy")}
                </Button>
              )}
            </CopyButton>
            <Button variant="default" onClick={onClose}>
              {t("common.close")}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
