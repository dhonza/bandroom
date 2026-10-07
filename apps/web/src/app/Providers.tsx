import type { ClientConfig } from "@bandroom/shared";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { i18n as I18n } from "i18next";
import { useMemo, useState, type ReactNode } from "react";
import { I18nextProvider, useTranslation } from "react-i18next";
import { ApiError } from "../api/client";
import { SESSION_QUERY_KEY, setSessionUser } from "../auth/session";
import { ClientConfigContext } from "../config/ClientConfigContext";
import { isOnline } from "../offline/online";
import { createAppTheme, cssVariablesResolver } from "../theme/theme";

/**
 * Queries run even when the browser says it is offline: the service worker answers them from the
 * offline cache (SPEC §13). Failed requests are not retried while offline.
 *
 * Any request failing with `UNAUTHENTICATED` while online means the session expired or was revoked
 * (no login-form request returns that code: they are public routes with their own codes), so the
 * session is dropped and `RequireAuth` sends the user to the login page with `?next=`.
 */
/**
 * One retry, and only for failures a retry can fix: a network error while the browser is online,
 * or a server error (5xx). Client errors (4xx, e.g. not found or forbidden) fail at once.
 */
export function shouldRetry(failureCount: number, err: unknown): boolean {
  if (failureCount >= 1 || !(err instanceof ApiError)) return false;
  if (err.code === "NETWORK") return isOnline();
  return err.status >= 500;
}

export function createQueryClient(): QueryClient {
  const onError = (err: unknown): void => {
    if (!(err instanceof ApiError) || err.code !== "UNAUTHENTICATED" || !isOnline()) return;
    const session = client.getQueryData<{ user: unknown }>(SESSION_QUERY_KEY);
    if (session?.user === null) return;
    setSessionUser(client, null);
  };
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        networkMode: "always",
        retry: shouldRetry,
      },
      mutations: { networkMode: "always" },
    },
  });
  return client;
}

export function Providers({
  config,
  i18n,
  children,
}: {
  config: ClientConfig;
  i18n: I18n;
  children: ReactNode;
}) {
  const [queryClient] = useState(() => createQueryClient());
  return (
    <ClientConfigContext.Provider value={config}>
      <I18nextProvider i18n={i18n}>
        <ThemedMantine>
          <Notifications />
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </ThemedMantine>
      </I18nextProvider>
    </ClientConfigContext.Provider>
  );
}

function ThemedMantine({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild on language change
  const theme = useMemo(() => createAppTheme({ close: t("common.close") }), [language]);
  return (
    <MantineProvider
      theme={theme}
      defaultColorScheme="dark"
      cssVariablesResolver={cssVariablesResolver}
    >
      {children}
    </MantineProvider>
  );
}
