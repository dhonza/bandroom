import { Paper, Stack, Text, Title } from "@mantine/core";
import type { ReactNode } from "react";

export function Section({
  title,
  description,
  children,
  testId,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <Paper withBorder radius="md" p={{ base: "md", sm: "lg" }} data-testid={testId}>
      <Stack gap="md">
        <Stack gap={2}>
          <Title order={3} size="h4">
            {title}
          </Title>
          {description && (
            <Text size="sm" c="dimmed">
              {description}
            </Text>
          )}
        </Stack>
        {children}
      </Stack>
    </Paper>
  );
}
