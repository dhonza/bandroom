import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { AppModal } from "../components/ResponsivePanel";
import { RecorderPanel, type RecordScope } from "./RecorderPanel";

/**
 * The song page's record sheet (SPEC §9): full screen on phones, a modal on desktop. It closes
 * when the take ends; closing it while recording ends the take (it is kept).
 */
export function RecordSheet({
  opened,
  onClose,
  scope,
}: {
  opened: boolean;
  onClose: () => void;
  scope: RecordScope;
}) {
  const { t } = useTranslation();
  const ended = useCallback(() => {
    onClose();
  }, [onClose]);
  return (
    <AppModal
      opened={opened}
      onClose={onClose}
      title={t("record.title")}
      centered
      closeOnClickOutside={false}
      data-testid="record-sheet"
    >
      {opened && <RecorderPanel scope={scope} onTakeEnded={ended} />}
    </AppModal>
  );
}
