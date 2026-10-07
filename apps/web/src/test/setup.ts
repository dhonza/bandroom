import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// CI runners are slower than dev machines; the 1 s default is flaky with userEvent typing.
configure({ asyncUtilTimeout: 3000 });

// Node-environment tests (`@vitest-environment node`, e.g. the service worker's) have no DOM.
const hasDom = typeof window !== "undefined";

afterEach(() => {
  cleanup();
  if (hasDom) localStorage.clear();
});

// jsdom lacks these browser APIs that Mantine uses.
const mediaQueryState: { phone: boolean } = { phone: false };
export function setPhoneViewport(phone: boolean): void {
  mediaQueryState.phone = phone;
}

if (hasDom) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query.includes("max-width") ? mediaQueryState.phone : false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });

  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  window.ResizeObserver = ResizeObserverStub;
  Element.prototype.scrollIntoView = () => undefined;
  // Mantine's autosize Textarea listens for web fonts loading.
  if (!("fonts" in document)) {
    Object.defineProperty(document, "fonts", {
      value: { addEventListener: () => undefined, removeEventListener: () => undefined },
    });
  }
}
