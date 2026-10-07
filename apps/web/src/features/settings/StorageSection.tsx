import { getMyUsage } from "@bandroom/shared";
import { Alert, Group, Loader, Progress, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { Section } from "../../components/Section";
import { formatBytes } from "../../lib/media";

export const QUOTA_WARNING_RATIO = 0.8;

/** Storage used by my uploads vs. my quota (SPEC §15.1), with the 80 % warning. */
export function StorageSection() {
  const { t, i18n } = useTranslation();
  const usage = useQuery({
    queryKey: ["me", "usage"],
    queryFn: ({ signal }) => api(getMyUsage, undefined, { signal }),
  });
  const locale = i18n.resolvedLanguage ?? "en";
  if (usage.isPending) return <Loader size="sm" />;
  if (usage.isError) return null;
  const { usedBytes, quotaBytes } = usage.data;
  const ratio = quotaBytes ? usedBytes / quotaBytes : 0;
  return (
    <Section title={t("settings.storage.title")} testId="settings-storage">
      <Group justify="space-between">
        <Text size="sm">
          {quotaBytes === null
            ? t("settings.storage.usedUnlimited", { used: formatBytes(usedBytes, locale) })
            : t("settings.storage.used", {
                used: formatBytes(usedBytes, locale),
                quota: formatBytes(quotaBytes, locale),
              })}
        </Text>
      </Group>
      {quotaBytes !== null && (
        <Progress
          value={Math.min(100, ratio * 100)}
          aria-label={t("settings.storage.usage")}
          color={ratio >= 1 ? "red" : ratio >= QUOTA_WARNING_RATIO ? "yellow" : "brand"}
        />
      )}
      {quotaBytes !== null && ratio >= QUOTA_WARNING_RATIO && (
        <Alert color="yellow" variant="light">
          {t("settings.storage.warning")}
        </Alert>
      )}
    </Section>
  );
}
