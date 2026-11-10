import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ClaudeCode from "../src/pages/ClaudeCode";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { fastModeChoice, fastModeFromChoice } from "../src/pages/claude-code-types";

/**
 * The management API stores `fastMode` as unset, `false`, `true` or `"ultrafast"`. The picker
 * once collapsed the last into "ON", so Ultra Fast read as plain Fast and saving the page
 * silently downgraded it. These hold every stored value distinct on screen and on the wire.
 */

test("every stored fastMode maps to its own picker choice and back", () => {
  for (const stored of [null, false, true, "ultrafast"] as const) {
    expect(fastModeFromChoice(fastModeChoice(stored))).toBe(stored);
  }
  expect(new Set([null, false, true, "ultrafast"].map(v => fastModeChoice(v as never))).size).toBe(4);
});

const originalFetch = globalThis.fetch;
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  clearClientResourceStoresForTests();
  globalThis.fetch = originalFetch;
});

const SERVER = {
  enabled: true, cliFirstParty: false, cliFirstPartyApplied: false, desktopFirstParty: false,
  interceptRunning: true, interceptEligible: true, sharedProxy: "none", authMode: "proxy",
  autoConnectSupported: false, systemEnv: false, maxContextTokens: null, autoContext: true,
  autoCompactWindow: null, injectAgents: true, smallFastModel: "", effectiveModelEnv: {},
  available: ["mock/model"], aliases: [], port: 10100, modelMap: {},
};

test("a stored Ultra Fast shows as Ultra Fast and survives a Save", async () => {
  const puts: { fastMode?: unknown }[] = [];
  let stored: unknown = "ultrafast";
  globalThis.fetch = (async (input, init) => {
    if (!String(input).endsWith("/api/claude-code")) return new Response(null, { status: 404 });
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { fastMode?: unknown };
      puts.push(body);
      stored = body.fastMode;
      return Response.json({ ok: true });
    }
    return Response.json({ ...SERVER, fastMode: stored });
  }) as typeof fetch;

  const testWindow = new Window({ url: "http://localhost/" });
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  // Later files in the same process must not inherit this window, so the previous globals are
  // put back in cleanup.
  const installed = ["document", "window", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = installed.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0)); });
    }
  };
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><ClaudeCode apiBase="http://localhost" /></LanguageProvider>);
  });
  cleanup = async () => {
    await act(async () => root.unmount());
    testWindow.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  };
  await settle();

  const picker = () => container.querySelector<HTMLButtonElement>('button[role="combobox"][aria-label="Fast Mode (OpenAI)"]')!;
  const choose = async (label: string) => {
    await act(async () => { picker().click(); });
    const option = [...testWindow.document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find(o => o.textContent?.trim() === label)!;
    await act(async () => { option.click(); });
    await settle();
  };
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(b => b.textContent?.trim() === label)!;

  expect(picker().textContent?.trim()).toBe("Ultra Fast");
  expect(picker().getAttribute("data-value")).toBe("ultrafast");

  // Fast and Ultra Fast are distinct choices: leaving and returning restores the exact tier.
  await choose("ON");
  expect(picker().textContent?.trim()).toBe("ON");
  await choose("Ultra Fast");
  expect(picker().textContent?.trim()).toBe("Ultra Fast");

  await choose("ON");
  await act(async () => { button("Save").click(); });
  await settle();
  expect(puts.at(-1)?.fastMode).toBe(true);
  expect(picker().textContent?.trim()).toBe("ON");
  await choose("Ultra Fast");
  await act(async () => { button("Save").click(); });
  await settle();
  expect(puts).toHaveLength(2);
  expect(puts.at(-1)?.fastMode).toBe("ultrafast");
  expect(picker().textContent?.trim()).toBe("Ultra Fast");
});
