import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// ^ useMemo retained for the default-name derivation; initial hash read is
// a lazy useState (read ONCE — later hash edits must not resurrect a code).
import { Check, Copy, Smartphone } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { IrisLogo } from "@/components/IrisLogo/IrisLogo";
import { isApiError } from "@/lib/errors";
import { useT } from "@/i18n";
import type { TranslationKey } from "@/i18n";
import { useGateway } from "@/gateway/GatewayContext";
import { isPairingExchangeSource } from "@/gateway/capabilities";
import { saveDeviceIdentity } from "@/gateway/deviceToken";
import type {
  PairingExchangeAwaiting,
  PairingIssuedResult,
} from "@/gateway/boardTypes";
import { formatTaskDate } from "@/features/tasks/taskStatus";
import { useI18n } from "@/i18n";
import {
  locationWithoutHash,
  platformFromUserAgent,
  readPairingCodeFromHash,
  verifyDigits,
} from "./pairingModel";
import { useCopyWithFallback } from "./usePairing";

/**
 * `/pair` — the DEVICE leg of the QR pairing (CV-7, ADR 0012 §2.3; a
 * top-level route OUTSIDE the Shell: no sidebar, no session, minimal
 * chrome — the unauthenticated page IS the threat model's public surface).
 *
 * Flow: the code arrives in the URL FRAGMENT (`/pair#t=<code>`, §2.2 —
 * fragments never reach server logs or referrers) and prefills the form;
 * manual entry is the equal path (ADR §2 a11y — no scanner required). The
 * first exchange PRESENTS the code — at that exact moment the hash is
 * stripped from history (back-button never re-offers a spent code).
 *
 * Poll posture (§10.2 RUNBOOK budget: 5 exchange attempts / 10 min per
 * pairing): while awaiting_confirmation the page retries ONCE after 60 s
 * and otherwise waits for the manual «Проверить» — a device has no session
 * and no SSE, so burning attempts on a tight poll would only feed the rate
 * limiter. 200 = the one-shot mnd_ token, SAVED TO THIS DEVICE on the spot
 * (ADR 0012 §5 — localStorage `vesmaro.deviceToken`; the owner never
 * copies anything by hand) with «Начать работу» as the one way forward;
 * 403/404/410/429/503 = honest verdicts, never a silent hang.
 */

type PairPagePhase = "form" | "awaiting" | "issued" | "error";

interface PairPageState {
  readonly phase: PairPagePhase;
  readonly verify?: string;
  readonly issued?: PairingIssuedResult;
  /** Mapped verdict for the error phase (server detail rides along). */
  readonly errorTitleKey?: TranslationKey;
  readonly errorDetail?: string;
}

const AWAITING_AUTO_RETRY_MS = 60_000;

/** The 202 awaiting shape vs the 200 issued shape (wire discriminator). */
function isAwaiting(
  result: PairingExchangeAwaiting | PairingIssuedResult,
): result is PairingExchangeAwaiting {
  return (
    "status" in result &&
    (result as { status?: unknown }).status === "awaiting_confirmation"
  );
}

export function PairPage() {
  const t = useT();
  const { lang } = useI18n();
  const gateway = useGateway();
  const capable = isPairingExchangeSource(gateway);
  const location = useLocation();
  const navigate = useNavigate();

  // The fragment code prefills the form (and never lingers in history once
  // it has been presented — the strip happens on the first submit). Read
  // ONCE at mount: a later hash edit must not resurrect a spent code.
  const [initialCode] = useState(() => readPairingCodeFromHash(location.hash));
  const hashStripped = useRef(false);

  const defaultName = useMemo(() => {
    const platform =
      typeof navigator === "undefined" ? "" : platformFromUserAgent(navigator.userAgent);
    return t("pair.defaultName", {
      platform: platform || t("pair.platformUnknown"),
    });
  }, [t]);

  const [code, setCode] = useState(initialCode ?? "");
  const [deviceName, setDeviceName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<PairPageState>({ phase: "form" });
  const [codeTouched, setCodeTouched] = useState(false);

  const runExchange = useCallback(
    (rawCode: string, name: string) => {
      if (!isPairingExchangeSource(gateway)) return;
      const trimmed = rawCode.trim();
      if (trimmed.length === 0) {
        setCodeTouched(true);
        return;
      }
      // §2.2: the moment the code is PRESENTED it leaves the history.
      if (!hashStripped.current) {
        hashStripped.current = true;
        void navigate(locationWithoutHash(location.pathname, location.search), {
          replace: true,
        });
      }
      setBusy(true);
      gateway
        .exchangePairing({ code: trimmed, device_name: name.trim() })
        .then((result) => {
          // The wire union carries an index signature, so `in`-narrowing is
          // useless — discriminate on the awaiting status word instead.
          if (isAwaiting(result)) {
            setState({ phase: "awaiting", verify: result.verify });
          } else {
            // ADR 0012 §5 + Amendment (scope v1): the token's home is THIS
            // device — the identity is persisted the moment the exchange
            // answers (scope included — new pairings default to `control`),
            // so «Начать работу» lands on a working board with zero
            // copy/paste. The on-screen copy button stays as the
            // explicit-transfer path (another app/PWA on the same device).
            saveDeviceIdentity({
              token: result.device_token,
              deviceId: result.device_id,
              deviceName: name.trim(),
              scope: result.scope === "read" ? "read" : "control",
            });
            setState({ phase: "issued", issued: result });
          }
        })
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : undefined;
          const status = isApiError(error) ? error.status : 0;
          setState({
            phase: "error",
            errorTitleKey: errorTitleKeyFor(status),
            errorDetail: detail,
          });
        })
        .finally(() => setBusy(false));
    },
    [gateway, navigate, location.pathname, location.search],
  );

  // The one 60 s auto-retry of the awaiting phase (§10.2: 5/10 min budget —
  // a session-less device must not spray the limiter; «Проверить» covers
  // the impatient case).
  const autoRetried = useRef(false);
  useEffect(() => {
    if (state.phase !== "awaiting" || autoRetried.current) return;
    autoRetried.current = true;
    const timer = window.setTimeout(() => {
      runExchange(code, deviceName);
    }, AWAITING_AUTO_RETRY_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one retry per awaiting episode, on purpose
  }, [state.phase]);

  if (!capable) {
    return (
      <PairShell>
        <EmptyState
          variant="error"
          title={t("pairing.unsupportedTitle")}
          message={t("pairing.unsupportedMessage")}
        />
      </PairShell>
    );
  }

  return (
    <PairShell>
      <h1 className="flex items-center gap-2 text-lg font-semibold">
        <Smartphone className="size-5 text-iris" aria-hidden="true" />
        {t("pair.title")}
      </h1>

      {state.phase === "form" || state.phase === "error" ? (
        <ExchangeForm
          code={code}
          onCodeChange={(value) => {
            setCode(value);
            setCodeTouched(false);
          }}
          codeInvalid={codeTouched && code.trim().length === 0}
          deviceName={deviceName}
          onDeviceNameChange={setDeviceName}
          busy={busy}
          onSubmit={() => runExchange(code, deviceName)}
          errorTitleKey={state.errorTitleKey}
          errorDetail={state.errorDetail}
          onErrorRetry={
            state.phase === "error" ? () => setState({ phase: "form" }) : undefined
          }
        />
      ) : state.phase === "awaiting" ? (
        <AwaitingScreen
          verify={state.verify ?? ""}
          busy={busy}
          onCheck={() => runExchange(code, deviceName)}
        />
      ) : state.issued ? (
        <IssuedScreen
          issued={state.issued}
          lang={lang}
          onStart={() => navigate("/")}
        />
      ) : null}
    </PairShell>
  );
}

/** Minimal chrome: centered column, the iris mark, no Shell furniture. */
function PairShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-4 px-4 py-8">
      <IrisLogo size={48} decorative />
      {children}
    </main>
  );
}

/** The code + device-name form; the hash-prefilled code is editable (the
 * manual path lands here too). Errors return here with the verdict. */
function ExchangeForm({
  code,
  onCodeChange,
  codeInvalid,
  deviceName,
  onDeviceNameChange,
  busy,
  onSubmit,
  errorTitleKey,
  errorDetail,
  onErrorRetry,
}: {
  code: string;
  onCodeChange: (value: string) => void;
  codeInvalid: boolean;
  deviceName: string;
  onDeviceNameChange: (value: string) => void;
  busy: boolean;
  onSubmit: () => void;
  errorTitleKey?: TranslationKey;
  errorDetail?: string;
  onErrorRetry?: () => void;
}) {
  const t = useT();
  return (
    <form
      className="flex w-full flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <p className="text-sm text-foreground-secondary">{t("pair.intro")}</p>

      {errorTitleKey ? (
        <div role="alert" className="rounded-md border border-border-subtle bg-well px-3 py-2">
          <p className="text-sm font-medium text-error">{t(errorTitleKey)}</p>
          {errorDetail ? (
            <p className="mt-0.5 text-xs text-foreground-secondary">{errorDetail}</p>
          ) : null}
          {onErrorRetry ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={onErrorRetry}
            >
              {t("pair.enterAnother")}
            </Button>
          ) : null}
        </div>
      ) : null}

      <label className="flex flex-col gap-1 text-sm font-medium">
        {t("pair.codeLabel")}
        <input
          value={code}
          onChange={(event) => onCodeChange(event.target.value)}
          maxLength={64}
          required
          autoComplete="off"
          spellCheck={false}
          aria-invalid={codeInvalid}
          className="h-9 rounded-md border border-border bg-background px-2 font-mono text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
        />
        {codeInvalid ? (
          <span role="alert" className="text-xs text-error">
            {t("pair.codeInvalid")}
          </span>
        ) : null}
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium">
        {t("pair.nameLabel")}
        <input
          value={deviceName}
          onChange={(event) => onDeviceNameChange(event.target.value)}
          maxLength={64}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
        />
      </label>

      <Button type="submit" size="sm" disabled={busy}>
        {busy ? t("pair.connecting") : t("pair.connect")}
      </Button>
    </form>
  );
}

/** 202 — the code is accepted; the owner must now confirm. The four verify
 * digits BIG (the same digits the owner sees — the §3.5 anti-error beat). */
function AwaitingScreen({
  verify,
  busy,
  onCheck,
}: {
  verify: string;
  busy: boolean;
  onCheck: () => void;
}) {
  const t = useT();
  const digits = verifyDigits(verify);
  return (
    <div className="flex w-full flex-col items-center gap-3 text-center">
      <p role="status" className="text-base font-semibold">
        {t("pair.verifyingTitle")}
      </p>
      <p
        className="flex items-center gap-2"
        role="img"
        aria-label={`${t("pairing.verifyLabel")}: ${digits.join(" ")}`}
      >
        {digits.map((digit, index) => (
          <span
            key={`${digit}-${index}`}
            aria-hidden="true"
            className="flex size-14 items-center justify-center rounded-md border border-border bg-background font-mono text-3xl font-semibold"
          >
            {digit}
          </span>
        ))}
      </p>
      <p className="max-w-prose text-sm text-foreground-secondary">
        {t("pair.verifyHint")}
      </p>
      <p className="text-xs text-foreground-muted">{t("pair.waitHint")}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={onCheck}
      >
        {busy ? t("pair.checking") : t("pair.checkNow")}
      </Button>
    </div>
  );
}

/** 200 — the pairing is DONE: the identity was saved to this device (§5),
 * «Начать работу» is the forward path into the read-only board. The copy
 * button demotes to the explicit-transfer affordance (move the token into
 * another app/PWA on this device) with three honest copy verdicts. */
function IssuedScreen({
  issued,
  lang,
  onStart,
}: {
  issued: PairingIssuedResult;
  lang: "ru" | "en";
  onStart: () => void;
}) {
  const t = useT();
  const { outcome, copy } = useCopyWithFallback();
  const tokenRef = useRef<HTMLElement | null>(null);
  const copied = outcome === "copied" || outcome === "copied-fallback";
  return (
    <div className="flex w-full flex-col items-center gap-3 text-center">
      <p role="status" className="text-base font-semibold">
        {t("pair.linkedTitle")}
      </p>
      <p className="max-w-prose text-sm text-foreground-secondary">
        {t("pair.boundNote")}
      </p>

      <div className="w-full rounded-md border border-border-subtle bg-well px-2 py-1.5">
        <div className="flex items-center gap-2">
          <span className="sr-only">{t("pair.tokenLabel")}</span>
          <code
            ref={tokenRef}
            className="min-w-0 flex-1 truncate text-left font-mono text-sm"
          >
            {issued.device_token}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={() => copy(issued.device_token, tokenRef.current)}
          >
            {copied ? (
              <Check className="size-3.5" aria-hidden="true" />
            ) : (
              <Copy className="size-3.5" aria-hidden="true" />
            )}
            {copied ? t("pairing.copied") : t("pair.copyToken")}
          </Button>
        </div>
        {outcome === "copied-fallback" ? (
          <p
            role="status"
            className="mt-1 text-left text-xs text-foreground-secondary"
          >
            {t("pair.copyFallback")}
          </p>
        ) : null}
        {outcome === "manual" ? (
          <p role="alert" className="mt-1 text-left text-xs text-error">
            {t("pair.copyManual")}
          </p>
        ) : null}
      </div>

      <Button type="button" size="sm" className="w-full" onClick={onStart}>
        {t("pair.startWork")}
      </Button>

      <p className="font-mono text-xs text-foreground-secondary">
        {t("pair.deviceId")}: {issued.device_id}
      </p>
      <p className="flex items-center gap-2 text-xs text-foreground-secondary">
        <Badge variant="outline" className="font-normal">
          {t("pair.scope")}: {issued.scope}
        </Badge>
        {t("pair.expires")}: {formatTaskDate(issued.expires_at, lang)}
      </p>
    </div>
  );
}

/** Wire status → the honest verdict key (the server's text rides as detail). */
function errorTitleKeyFor(status: number): TranslationKey {
  switch (status) {
    case 403:
      return "pair.err403";
    case 404:
      return "pair.err404";
    case 410:
      return "pair.err410";
    case 429:
      return "pair.err429";
    case 503:
      return "pair.err503";
    default:
      return "pair.errGeneric";
  }
}
