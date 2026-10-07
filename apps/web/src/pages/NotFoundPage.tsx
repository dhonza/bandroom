import { Button, Stack, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <Stack align="flex-start" gap="md">
      <Title order={2}>{t("pages.notFound.title")}</Title>
      <Button component={Link} to="/library" mih={44}>
        {t("pages.notFound.back")}
      </Button>
    </Stack>
  );
}
