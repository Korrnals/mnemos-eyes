// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { TextEngine } from "./TextEngine";
import { MarkdownView } from "./MarkdownView";
import { I18nProvider } from "@/i18n";

/**
 * UI-27 TextEngine gates: plain passthrough, markdown element rendering,
 * the untrusted-content security story (SEC-4) and the clamp affordance.
 * MarkdownView renders synchronously here (direct import); the TextEngine
 * lazy-chunk path is exercised through waitFor.
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(ui: React.ReactElement): Promise<HTMLDivElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<I18nProvider initialLang="en">{ui}</I18nProvider>);
  });
  return container;
}

async function waitFor(what: string, probe: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    if (probe()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitFor(${what}) timed out; html: ${container!.innerHTML.slice(0, 400)}`);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

async function click(target: Element): Promise<void> {
  await act(async () => {
    (target as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => {
  container = null;
  root = null;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

const MARKDOWN_DOC = [
  "## Приёмка",
  "",
  "Корпус снят: **142 задачи** зафиксировано.",
  "",
  "- первый пункт",
  "- `npm run build` зелёный",
  "",
  "| кол | знач |",
  "|-----|------|",
  "| a | 1 |",
].join("\n");

describe("TextEngine — plain path", () => {
  it("plain prose renders pre-wrap verbatim, no markdown elements, no parser", async () => {
    const el = await mount(
      <TextEngine text={"Строка первая.\nСтрока вторая — обычный текст без синтаксиса."} />,
    );
    // No markdown syntax anywhere in the source → the plain path; the text
    // renders verbatim with no invented elements.
    expect(el.querySelector("strong")).toBeNull();
    expect(el.querySelector("h1, h2, ul, table, code")).toBeNull();
    const plain = el.querySelector(".whitespace-pre-wrap");
    expect(plain, "plain pre-wrap div renders").not.toBeNull();
    expect(plain?.textContent).toContain("обычный текст");
  });

  it("empty/absent text renders nothing", async () => {
    const el = await mount(<TextEngine text="" />);
    expect(el.firstElementChild).toBeNull();
    const el2 = await mount(<TextEngine text={undefined} />);
    expect(el2.firstElementChild).toBeNull();
  });
});

describe("MarkdownView — markdown element rendering", () => {
  it("headings, strong, lists, inline code and GFM tables render as elements", async () => {
    const el = await mount(<MarkdownView source={MARKDOWN_DOC} />);
    expect(el.querySelector("h2")?.textContent).toBe("Приёмка");
    expect(el.querySelector("strong")?.textContent).toBe("142 задачи");
    expect(el.querySelectorAll("ul > li").length).toBe(2);
    expect(el.querySelector("code")?.textContent).toContain("npm run build");
    expect(el.querySelector("table > tbody > tr > td")).not.toBeNull();
  });

  it("raw HTML is escaped to inert text — no elements, no handler attributes", async () => {
    const el = await mount(
      <MarkdownView
        source={
          "<script>alert(1)</script>\n\n<iframe src=\"https://evil.example\"></iframe>\n\nТекст **после**.\n\n<img src=x onerror=\"alert(2)\">"
        }
      />,
    );
    // react-markdown's default (no rehype-raw): raw HTML never becomes
    // elements — it degrades to ESCAPED text. No execution, no injection.
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("iframe")).toBeNull();
    expect(el.querySelector("img")).toBeNull();
    const anyHandler = [...el.querySelectorAll("*")].some(
      (node) => node.getAttribute("onerror") !== null,
    );
    expect(anyHandler).toBe(false);
    // The prose around the stripped HTML still renders.
    expect(el.querySelector("strong")?.textContent).toBe("после");
  });

  it("links: http(s) opens safe in a new tab, dangerous schemes are inert", async () => {
    const el = await mount(
      <MarkdownView
        source={[
          "[ok](https://example.com/x)",
          "",
          "[bad](javascript:alert(1))",
          "",
          "[data](data:text/html;base64,PHNjcmlwdD4=)",
          "",
          "[mail](mailto:owner@example.com)",
        ].join("\n\n")}
      />,
    );
    const ok = [...el.querySelectorAll("a")].find((a) => a.textContent === "ok");
    expect(ok?.getAttribute("href")).toBe("https://example.com/x");
    expect(ok?.getAttribute("target")).toBe("_blank");
    expect(ok?.getAttribute("rel")).toContain("noopener");
    // javascript:/data: — no live link at all, inert inline text.
    expect([...el.querySelectorAll("a")].find((a) => a.textContent === "bad")).toBeUndefined();
    expect(el.innerHTML).not.toContain("javascript:");
    expect(el.innerHTML).not.toContain("data:text/html");
    const mail = [...el.querySelectorAll("a")].find((a) => a.textContent === "mail");
    expect(mail?.getAttribute("href")).toBe("mailto:owner@example.com");
    expect(mail?.getAttribute("target")).toBe("_blank");
  });

  it("images render only for http(s) srcs", async () => {
    const el = await mount(
      <MarkdownView
        source={"![ok](https://cdn.example/i.png)\n\n![bad](javascript:alert(1))\n\n![rel](../x.png)"}
      />,
    );
    const imgs = [...el.querySelectorAll("img")];
    expect(imgs.length).toBe(1);
    expect(imgs[0].getAttribute("src")).toBe("https://cdn.example/i.png");
    expect(imgs[0].getAttribute("loading")).toBe("lazy");
  });
});

describe("TextEngine — markdown path (lazy chunk)", () => {
  it("auto-detected markdown renders formatted elements after the chunk lands", async () => {
    const el = await mount(<TextEngine text={MARKDOWN_DOC} variant="full" />);
    await waitFor("h2 rendered", () => Boolean(el.querySelector("h2")));
    expect(el.querySelector("strong")?.textContent).toBe("142 задачи");
    expect(el.querySelector("table")).not.toBeNull();
  });

  it("compact variant keeps preview typography (text-sm root)", async () => {
    const el = await mount(<TextEngine text={MARKDOWN_DOC} variant="compact" />);
    await waitFor("h2 rendered", () => Boolean(el.querySelector("h2")));
    const inner = el.querySelector("h2")?.parentElement;
    expect(inner?.className).toContain("text-sm");
  });
});

describe("TextEngine — clamp", () => {
  const proto = HTMLElement.prototype as unknown as Record<string, PropertyDescriptor | undefined>;
  let savedOffset: PropertyDescriptor | undefined;
  let savedClient: PropertyDescriptor | undefined;

  function stubOverflow(contentHeight: number, boxHeight: number): void {
    savedOffset = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
    savedClient = Object.getOwnPropertyDescriptor(proto, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => contentHeight,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => boxHeight,
    });
  }

  function restoreOverflow(): void {
    delete (HTMLElement.prototype as { offsetHeight?: unknown }).offsetHeight;
    delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight;
    if (savedOffset) Object.defineProperty(HTMLElement.prototype, "offsetHeight", savedOffset);
    if (savedClient) Object.defineProperty(HTMLElement.prototype, "clientHeight", savedClient);
  }

  afterEach(() => {
    restoreOverflow();
  });

  it("overflowing clamped content shows «Show full text»; expanding removes the cut", async () => {
    stubOverflow(500, 192); // content taller than max-h-48 (12rem)
    const el = await mount(<TextEngine text={"Просто длинный plain-текст.".repeat(40)} clamp />);
    const box = el.querySelector(".max-h-48");
    expect(box, "clamp box renders").not.toBeNull();
    await waitFor("expand button", () => Boolean(el.querySelector("button")));
    const button = el.querySelector("button");
    expect(button?.textContent).toBe("Show full text");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    await click(button!);
    expect(el.querySelector(".max-h-48")).toBeNull();
    expect(el.querySelector("button")).toBeNull();
  });

  it("content that fits shows no expand button", async () => {
    const el = await mount(<TextEngine text={"Короткий текст."} clamp />);
    expect(el.querySelector("button")).toBeNull();
    expect(el.querySelector(".max-h-48")).not.toBeNull();
  });
});
