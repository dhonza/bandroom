import { Alert, Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";

/** Irreversible actions require typing the name (SPEC §11.1 "undo over confirm"). */
export function ConfirmDeleteModal({
  opened,
  onClose,
  title,
  explanation,
  name,
  loading,
  error,
  onConfirm,
}: {
  opened: boolean;
  onClose: () => void;
  title: string;
  explanation: string;
  name: string;
  loading: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const close = () => {
    setTyped("");
    onClose();
  };
  return (
    <Modal opened={opened} onClose={close} title={title} centered>
      <Stack>
        <Text size="sm">{explanation}</Text>
        {error && <Alert color="red">{error}</Alert>}
        <TextInput
          label={t("common.typeToConfirm", { name })}
          value={typed}
          data-testid="confirm-name"
          onChange={(e) => {
            setTyped(e.currentTarget.value);
          }}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button
            color="red"
            disabled={typed.trim() !== name.trim()}
            loading={loading}
            onClick={onConfirm}
            data-testid="confirm-delete"
          >
            {t("common.delete")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
