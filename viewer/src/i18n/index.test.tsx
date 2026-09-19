import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

/**
 * i18n layer tests (owner feedback 1.40 pass 1). The project runs vitest in
 * the node environment (no DOM) — storage and document are stubbed globals,
 * and React pieces are asserted via renderToString, per the project pattern.
 */

/** Minimal Storage stand-in (node env has none). */
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("language detection and persistence", () => {
  it("defaults to ru with no stored choice (no navigator sniffing)", async () => {
    const { detectLang, DEFAULT_LANG } = await import("./index");
    expect(DEFAULT_LANG).toBe("ru");
    expect(detectLang()).toBe("ru");
  });

  it("restores a persisted valid choice and ignores garbage", async () => {
    const { readStoredLang, detectLang, LANG_STORAGE_KEY } = await import("./index");
    localStorage.setItem(LANG_STORAGE_KEY, "en");
    expect(readStoredLang()).toBe("en");
    expect(detectLang()).toBe("en");

    localStorage.setItem(LANG_STORAGE_KEY, "klingon");
    expect(readStoredLang()).toBeNull();
    expect(detectLang()).toBe("ru");
  });

  it("persists the choice under vesmaro.lang and reads it back", async () => {
    const { persistLang, readStoredLang, LANG_STORAGE_KEY } = await import("./index");
    persistLang("en");
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe("en");
    expect(readStoredLang()).toBe("en");
  });

  it("survives a storage that throws (private mode)", async () => {
    const throwing: Storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      get length() {
        return 0;
      },
    };
    const { readStoredLang, persistLang, detectLang } = await import("./index");
    expect(readStoredLang(throwing)).toBeNull();
    expect(() => persistLang("en", throwing)).not.toThrow();
    expect(detectLang()).toBe("ru");
  });
});

describe("document.lang mirroring", () => {
  it("sets documentElement.lang for the active language", async () => {
    const { applyDocumentLang } = await import("./index");
    const documentElement = { lang: "" };
    vi.stubGlobal("document", { documentElement });
    applyDocumentLang("en");
    expect(documentElement.lang).toBe("en");
    applyDocumentLang("ru");
    expect(documentElement.lang).toBe("ru");
  });

  it("is a no-op without a document (SSR/test env)", async () => {
    const { applyDocumentLang } = await import("./index");
    expect(() => applyDocumentLang("en")).not.toThrow();
  });
});

describe("translation", () => {
  it("translates a key in both languages and interpolates {{vars}}", async () => {
    const { translate } = await import("./index");
    expect(translate("ru", "nav.memories")).toBe("Воспоминания");
    expect(translate("en", "nav.memories")).toBe("Memories");
    expect(
      translate("en", "auth.connected", { backend: "board", endpoint: "/api" }),
    ).toBe("connected to board: /api");
    expect(translate("ru", "memories.showing", { from: 1, to: 20 })).toBe(
      "Показано 1–20",
    );
  });

  it("keeps unknown placeholders visible verbatim", async () => {
    const { interpolate } = await import("./index");
    expect(interpolate("{{a}} + {{missing}}", { a: 1 })).toBe("1 + {{missing}}");
  });

  it("en.ts implements every ru.ts key (dictionary parity)", async () => {
    const { ru } = await import("./ru");
    const { en } = await import("./en");
    expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort());
  });
});

describe("React wiring (useT / useI18n / I18nProvider)", () => {
  it("useT falls back to ru without a provider (deterministic default)", async () => {
    const { useT } = await import("./index");
    function Probe() {
      const t = useT();
      return <p>{t("nav.memories")}</p>;
    }
    expect(renderToString(<Probe />)).toContain("Воспоминания");
  });

  it("the provider switches the rendered copy (ru vs en render)", async () => {
    const { I18nProvider, useI18n } = await import("./index");
    function Probe() {
      const { lang, t } = useI18n();
      return (
        <p data-lang={lang}>
          {t("topbar.langLabel")} · {t("search.placeholder")}
        </p>
      );
    }
    const ru = renderToString(
      <I18nProvider initialLang="ru">
        <Probe />
      </I18nProvider>,
    );
    const en = renderToString(
      <I18nProvider initialLang="en">
        <Probe />
      </I18nProvider>,
    );
    expect(ru).toContain("Язык интерфейса");
    expect(ru).toContain("Поиск по колодцу…");
    expect(ru).toContain('data-lang="ru"');
    expect(en).toContain("Interface language");
    expect(en).toContain("Search the well…");
    expect(en).toContain('data-lang="en"');
  });

  it("setLang persists the choice for the next session", async () => {
    const { I18nProvider, useI18n, LANG_STORAGE_KEY } = await import("./index");
    // Array capture (TS does not narrow a let through nested closures).
    const captured: ReturnType<typeof useI18n>[] = [];
    function Probe() {
      captured.push(useI18n()); // capture the live context value, no effects
      return <p>probe</p>;
    }
    renderToString(
      <I18nProvider initialLang="ru">
        <Probe />
      </I18nProvider>,
    );
    const handle = captured[0];
    expect(handle).toBeDefined();
    expect(handle?.lang).toBe("ru");
    // The same call the LanguageToggle onClick makes.
    handle?.setLang("en");
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe("en");
  });
});
