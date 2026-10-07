import { MantineProvider } from "@mantine/core";
import { Notifications, notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "../../../i18n/i18n";
import { mockApi } from "../../../test/mockApi";
import { ConnectCard } from "./ConnectCard";

const i18n = i18next.createInstance();
const RUN = {
  id: "r1",
  source: "samply",
  status: "connected",
  dryRun: false,
  progress: 0,
  error: null,
  selection: [],
  mapping: null,
  totals: null,
  report: null,
  hasKey: true,
  createdAt: 0,
  updatedAt: 0,
  finishedAt: null,
};

function renderCard(onConnected = vi.fn()) {
  render(
    <I18nextProvider i18n={i18n}>
      <MantineProvider>
        <Notifications />
        <QueryClientProvider client={new QueryClient()}>
          <ConnectCard onConnected={onConnected} onCancel={vi.fn()} />
        </QueryClientProvider>
      </MantineProvider>
    </I18nextProvider>,
  );
  return onConnected;
}

const bodyOf = (init: RequestInit | undefined): unknown =>
  JSON.parse(typeof init?.body === "string" ? init.body : "null");

describe("ConnectCard (SPEC §25.11)", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });
  afterEach(() => {
    notifications.clean();
    vi.unstubAllGlobals();
  });

  it("uses the saved key by default and can forget it", async () => {
    const connects: unknown[] = [];
    const fetch = mockApi({
      "GET /me/secrets/samply": () => ({ body: { saved: true, last4: "1234", updatedAt: 1 } }),
      "DELETE /me/secrets/samply": () => ({
        body: { saved: false, last4: null, updatedAt: null },
      }),
      "POST /admin/imports/samply": (init) => {
        connects.push(bodyOf(init));
        return { body: { run: RUN, projects: [] } };
      },
    });
    const onConnected = renderCard();
    expect(await screen.findByText("Use my saved key ••••1234")).toBeInTheDocument();
    expect(screen.queryByTestId("samply-key")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("samply-connect"));
    await waitFor(() => {
      expect(onConnected).toHaveBeenCalledWith("r1");
    });
    expect(connects).toEqual([{ useSavedKey: true }]);

    await userEvent.click(screen.getByTestId("samply-forget-key"));
    expect(await screen.findByTestId("samply-key")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/me/secrets/samply"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("remembers a typed key only after Samply accepted it", async () => {
    const calls: string[] = [];
    let accept = false;
    mockApi({
      "GET /me/secrets/samply": () => ({ body: { saved: false, last4: null, updatedAt: null } }),
      "PUT /me/secrets/samply": (init) => {
        calls.push(`PUT ${JSON.stringify(bodyOf(init))}`);
        return { body: { saved: true, last4: "5678", updatedAt: 2 } };
      },
      "POST /admin/imports/samply": (init) => {
        calls.push(`POST ${JSON.stringify(bodyOf(init))}`);
        return accept
          ? { body: { run: RUN, projects: [] } }
          : { status: 400, body: { code: "SAMPLY_AUTH_FAILED", message: "no" } };
      },
    });
    const onConnected = renderCard();
    await userEvent.type(await screen.findByTestId("samply-key"), "new-key-5678");
    await userEvent.click(screen.getByTestId("samply-remember"));
    await userEvent.click(screen.getByTestId("samply-connect"));
    expect(await screen.findByText(i18n.t("errors.SAMPLY_AUTH_FAILED"))).toBeInTheDocument();
    expect(calls).toEqual(['POST {"apiKey":"new-key-5678"}']);

    accept = true;
    await userEvent.click(screen.getByTestId("samply-connect"));
    await waitFor(() => {
      expect(onConnected).toHaveBeenCalledWith("r1");
    });
    expect(calls.slice(1)).toEqual([
      'POST {"apiKey":"new-key-5678"}',
      'PUT {"apiKey":"new-key-5678"}',
    ]);
  });
});
