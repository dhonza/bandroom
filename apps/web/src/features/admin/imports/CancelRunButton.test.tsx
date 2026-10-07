import { MantineProvider } from "@mantine/core";
import { Notifications, notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "../../../i18n/i18n";
import { mockApi } from "../../../test/mockApi";
import { CancelRunButton } from "./CancelRunButton";

const i18n = i18next.createInstance();

function renderButton() {
  render(
    <I18nextProvider i18n={i18n}>
      <MantineProvider>
        <Notifications />
        <QueryClientProvider client={new QueryClient()}>
          <CancelRunButton runId="r1" />
        </QueryClientProvider>
      </MantineProvider>
    </I18nextProvider>,
  );
}

describe("CancelRunButton", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });
  afterEach(() => {
    notifications.clean();
    vi.unstubAllGlobals();
  });

  it("asks before cancelling and reports a failure", async () => {
    const fetch = mockApi({
      "POST /admin/imports/r1/cancel": () => ({
        status: 409,
        body: { code: "IMPORT_STATE", message: "finished" },
      }),
    });
    renderButton();
    await userEvent.click(screen.getByTestId("import-cancel"));
    expect(
      await screen.findByText(i18n.t("admin.import.progress.cancelTitle")),
    ).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    // "Continue" closes without cancelling.
    await userEvent.click(
      screen.getByRole("button", { name: i18n.t("admin.import.progress.keepRunning") }),
    );
    expect(fetch).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("import-cancel"));
    await userEvent.click(await screen.findByTestId("import-cancel-confirm"));
    expect(await screen.findByText(i18n.t("errors.IMPORT_STATE"))).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
