// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import { PairPage } from "./PairPage";
import { GatewayContext } from "@/gateway/GatewayContext";
import type { MemoryGateway } from "@/gateway/MemoryGateway";
import { ApiError } from "@/lib/errors";
import { I18nProvider } from "@/i18n";
import type {
  PairingExchangeAwaiting,
  PairingIssuedResult,
} from "@/gateway/boardTypes";

/**
 * The /pair device-leg flow (CV-7, ADR 0012 §2.3): the deep link
 * `/pair#t=<code>` PREFILLS the form and the first exchange STRIPS the
 * fragment from history (§2.2); the 202 shows the four verify digits with
 * exactly ONE 60 s auto-retry (the 5/10-min wire budget) plus the manual
 * «Проверить»; the 200 shows the one-shot mnd_ token; 403/410 answer with
 * their honest verdicts; a gateway without the exchange capability renders
 * the unsupported state.
 */

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

const AWAITING: PairingExchangeAwaiting = {
  ok: true,
  status: "awaiting_confirmation",
  pairing_id: "pr-1",
  state: "scanned",
  verify: "2468",
};

const ISSUED: PairingIssuedResult = {
  ok: true,
  device_id: "dev-9",
  device_token: "mnd_secret-token-value",
  scope: "read",
  expires_at: "2026-10-23T10:00:00Z",
  hard_expires_at: "2026-12-22T10:00:00Z",
};

interface ExchangeScript {
  results: Array<PairingExchangeAwaiting | PairingIssuedResult | Error>;
}

function mountExchange(script: ExchangeScript, initialEntry = "/pair") {
  const exchanges: Array<{ code: string; device_name: string }> = [];
  const gateway = {
    exchangePairing: (payload: { code: string; device_name?: string }) => {
      exchanges.push({ code: payload.code, device_name: payload.device_name ?? "" });
      const next = script.results.shift() ?? AWAITING;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  } as unknown as MemoryGateway;

  let lastHash: string | null = null;
  function HashProbe() {
    const location = useLocation();
    lastHash = location.hash;
    return null;
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <GatewayContext.Provider value={gateway}>
        <I18nProvider initialLang="en">
          <MemoryRouter initialEntries={[initialEntry]}>
            <Routes>
              <Route path="/pair" element={<PairPage />} />
            </Routes>
            <HashProbe />
          </MemoryRouter>
        </I18nProvider>
      </GatewayContext.Provider>,
    );
  });
  return {
    exchanges,
    get lastHash() {
      return lastHash;
    },
    root,
    container,
  };
}

const input = (label: string): HTMLInputElement => {
  const element = [...document.querySelectorAll("label")]
    .find((candidate) => candidate.textContent?.includes(label))
    ?.querySelector("input");
  if (!element) throw new Error(`no input under label: ${label}`);
  return element;
};

const button = (text: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes(text),
  )!;

async function submitForm(): Promise<void> {
  const form = input("Pairing code").form;
  if (!form) throw new Error("the exchange form is not mounted");
  await act(async () => {
    form.requestSubmit();
    await Promise.resolve();
  });
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("PairPage — deep link", () => {
  it("prefills the code from #t= and strips the hash after the first exchange", async () => {
    const page = mountExchange({ results: [AWAITING] }, "/pair#t=CODE-9");
    await flush();
    expect(input("Pairing code").value).toBe("CODE-9");
    // The default device name is populated (UA-derived, honest).
    expect(input("Device name").value.length).toBeGreaterThan(0);

    await submitForm();
    expect(page.exchanges).toHaveLength(1);
    expect(page.exchanges[0].code).toBe("CODE-9");
    // §2.2: the code leaves the history the moment it is presented.
    expect(page.lastHash).toBe("");
    // 202 → the verify digits screen.
    expect(document.body.textContent).toContain("confirm on the trusted side");
    expect(document.body.textContent).toContain("2468");
  });

  it("works without any hash (manual entry is the equal path)", async () => {
    const page = mountExchange({ results: [AWAITING] });
    await flush();
    expect(input("Pairing code").value).toBe("");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input("Pairing code"), "TYPED-1");
      input("Pairing code").dispatchEvent(new Event("input", { bubbles: true }));
    });
    await submitForm();
    expect(page.exchanges[0].code).toBe("TYPED-1");
  });
});

describe("PairPage — awaiting → issued", () => {
  it("the manual «Check now» after a confirm lands on the one-shot token", async () => {
    vi.useFakeTimers();
    try {
      const page = mountExchange({ results: [AWAITING, ISSUED] }, "/pair#t=C1");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        const form = input("Pairing code").form;
        if (!form) throw new Error("the exchange form is not mounted");
        form.requestSubmit();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(document.body.textContent).toContain("2468");

      await act(async () => {
        button("Check now").click();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(page.exchanges).toHaveLength(2);
      const body = document.body.textContent ?? "";
      expect(body).toContain("Device connected");
      expect(body).toContain("mnd_secret-token-value");
      expect(body).toContain("dev-9");
      expect(body).toContain("save it now");
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-retries the exchange ONCE after 60 s, never twice", async () => {
    vi.useFakeTimers();
    try {
      const page = mountExchange({ results: [AWAITING, AWAITING, ISSUED] }, "/pair#t=C2");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        const form = input("Pairing code").form;
        if (!form) throw new Error("the exchange form is not mounted");
        form.requestSubmit();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(page.exchanges).toHaveLength(1);
      // The single 60 s auto-retry (§10.2: 5 attempts / 10 min — no spray).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(page.exchanges).toHaveLength(2);
      // ...and then silence: the budget belongs to the manual button.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(page.exchanges).toHaveLength(2);
      expect(document.body.textContent).toContain("2468");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PairPage — honest verdicts", () => {
  it("403: the code is bound to another address", async () => {
    const page = mountExchange(
      { results: [new ApiError(403, "bound to another client IP")] },
      "/pair#t=X",
    );
    await flush();
    await submitForm();
    const body = document.body.textContent ?? "";
    expect(body).toContain("bound to another address");
    expect(body).toContain("bound to another client IP");
    // «Ввести другой код» returns to the form.
    await act(async () => {
      button("Enter another code").click();
    });
    expect(input("Pairing code").value).toBe("X"); // the draft stays editable
    void page;
  });

  it("410: expired or already used", async () => {
    mountExchange(
      { results: [new ApiError(410, "pairing expired — start a new one")] },
      "/pair#t=Y",
    );
    await flush();
    await submitForm();
    expect(document.body.textContent).toContain("expired or was already used");
  });

  it("a gateway without the exchange capability renders the unsupported state", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <GatewayContext.Provider value={{} as unknown as MemoryGateway}>
          <I18nProvider initialLang="en">
            <MemoryRouter initialEntries={["/pair"]}>
              <Routes>
                <Route path="/pair" element={<PairPage />} />
              </Routes>
            </MemoryRouter>
          </I18nProvider>
        </GatewayContext.Provider>,
      );
    });
    expect(document.body.textContent).toContain("Pairing is unavailable in this mode");
  });
});
