import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "../i18n/i18n";
import { mockApi } from "../test/mockApi";
import { BottomTabBar } from "./BottomTabBar";

const i18n = i18next.createInstance();

describe("BottomTabBar", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("announces unread notifications on the Me tab", async () => {
    mockApi({ "GET /me/notifications/unread-count": () => ({ body: { count: 3 } }) });
    render(
      <I18nextProvider i18n={i18n}>
        <MantineProvider>
          <QueryClientProvider client={new QueryClient()}>
            <MemoryRouter>
              <BottomTabBar />
            </MemoryRouter>
          </QueryClientProvider>
        </MantineProvider>
      </I18nextProvider>,
    );
    const name = `${i18n.t("nav.me")} ${i18n.t("notifications.unreadLabel", { count: 3 })}`;
    expect(await screen.findByRole("link", { name })).toBeInTheDocument();
  });
});
