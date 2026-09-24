import { Suspense, lazy } from "react";
import { useT } from "@/i18n";

/**
 * The pairing QR (CV-7, ADR 0012 §2.2), kept in its OWN lazy chunk:
 * `qrcode.react` (~4 KB gz) loads only when a live QR actually renders —
 * the devices page's everyday work (list + revoke) never pays for it.
 * Bundle-budget note: the only new dependency of this wave, chosen over
 * the bigger `qrcode` node-package precisely for this lazy SVG path.
 *
 * The code travels in the FRAGMENT of the encoded URL — never a query
 * string (§2.2/§9: no server logs, no referrers). Colours ride the design
 * tokens via var() so the QR inherits the theme (contrast ≥3:1 to the well
 * surface — ADR §6); the svg is decorative, the aria-label lives on the
 * figure and the manual code sits right below (the no-scanner path §2).
 */
const QRCodeSVG = lazy(() =>
  import("qrcode.react").then((module) => ({ default: module.QRCodeSVG })),
);

export function PairingQr({ value }: { value: string }) {
  const t = useT();
  return (
    <figure className="flex flex-col items-center gap-1.5">
      <Suspense
        fallback={
          <div
            role="status"
            aria-label={t("pairing.qr.loading")}
            className="size-44 animate-pulse rounded-md bg-well"
          />
        }
      >
        {/* Token colours through CSS variables keep the literal-free rule;
         * SVG fill accepts var() in every evergreen browser. */}
        <QRCodeSVG
          value={value}
          size={176}
          level="M"
          marginSize={2}
          fgColor="var(--color-text-primary)"
          bgColor="var(--color-bg-base)"
          aria-hidden="true"
        />
      </Suspense>
      <figcaption className="text-center text-xs text-foreground-muted">
        {t("pairing.qr.hint")}
      </figcaption>
    </figure>
  );
}
