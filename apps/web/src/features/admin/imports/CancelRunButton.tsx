import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useCancelImport } from "./queries";

/** Cancel a scan or import, after a confirmation. */
export function CancelRunButton({ runId }: { runId: string }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const cancel = useCancelImport(runId, () => {
    setConfirming(false);
  });
  return (
    <>
      <Button
        variant="default"
        color="gray"
        onClick={() => {
          setConfirming(true);
        }}
        data-testid="import-cancel"
      >
        {t("admin.import.progress.cancel")}
      </Button>
      <Modal
        opened={confirming}
        onClose={() => {
          setConfirming(false);
        }}
        title={t("admin.import.progress.cancelTitle")}
        centered
      >
        <Stack>
          <Text size="sm">{t("admin.import.progress.cancelExplain")}</Text>
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t("admin.import.progress.keepRunning")}
            </Button>
            <Button
              color="red"
              loading={cancel.isPending}
              onClick={() => {
                cancel.mutate();
              }}
              data-testid="import-cancel-confirm"
            >
              {t("admin.import.progress.cancelConfirm")}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
