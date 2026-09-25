"""The single Kora redaction choke-point (ADR 0019 rev.2 #4, week-0 spec
x-kora-redaction: ``choke-point: server/kora/redaction.py``).

Every character of session content leaving the board — list previews AND
transcript bodies — passes through THIS module. No call-site masking
anywhere else; a field that cannot go through the choke-point does not
ship.

Pattern pack (week-0 spec): ghp_, sk-, AKIA, eyJ (JWT), mnd_, bearer.
Extended here with the credential families the board itself already knows
about (server.security mask_secrets parity: mnk_, mne_, plain:) and the
AWS secret-access-key shape — a preview cut at an arbitrary boundary must
never leak the tail of a token that starts beyond the clamp.

Previews are clamped BEFORE redaction (the contract fixes the order:
clamp ≤ 160 chars, then mask); masking can only shorten the string, so
the clamp bound survives.
"""

from __future__ import annotations

import re

# The preview clamp from the frozen contract (KoraSessionOut.
# last_line_preview maxLength: 160).
PREVIEW_MAX_CHARS = 160

# The pattern pack. Order is irrelevant (patterns are disjoint by
# prefix); each entry is (compiled regex, replacement).
# NOTE: no raw token ever lands in a replacement — only the prefix + a
# <redacted> marker.
_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    # GitHub PAT (classic + fine-grained) — ghp_/gho_/ghu_/ghs_/ghr_
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,255}"), "gh*_<redacted>"),
    # OpenAI-style API keys
    (re.compile(r"\bsk-[A-Za-z0-9_\-]{16,255}"), "sk-<redacted>"),
    # Anthropic-style API keys
    (re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{16,255}"), "sk-ant-<redacted>"),
    # AWS access key id + secret access key
    (re.compile(r"\bAKIA[0-9A-Z]{16}"), "AKIA<redacted>"),
    (re.compile(r"(?i)aws_secret_access_key\s*[=:]\s*\S+"),
     "aws_secret_access_key=<redacted>"),
    # JWT (header is always eyJ…)
    (re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"
                r"(?:\.[A-Za-z0-9_\-]{10,})?"), "eyJ<redacted>"),
    # Board/device credential families (security.py parity)
    (re.compile(r"\bmnd_[A-Za-z0-9._\-]+"), "mnd_<redacted>"),
    (re.compile(r"\bmnk_[A-Za-z0-9._\-]+"), "mnk_<redacted>"),
    (re.compile(r"\bmne_[A-Za-z0-9._\-]+"), "mne_<redacted>"),
    (re.compile(r"plain:\S+"), "plain:<redacted>"),
    # Bearer tokens — last so a quoted "Bearer <x>" in prose still masks
    (re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}"),
     "Bearer <redacted>"),
)


def redact(text: str) -> tuple[str, bool]:
    """Mask every credential-shaped substring. Returns (masked, applied).

    ``applied`` is the honest signal the contract requires
    (``redaction_applied`` / preview hygiene): True when at least one
    pattern fired.
    """
    if not text:
        return "", False
    out = text
    applied = False
    for pattern, replacement in _PATTERNS:
        masked = pattern.sub(replacement, out)
        if masked != out:
            applied = True
            out = masked
    return out, applied


def redact_preview(text: str | None, *, clamp: int = PREVIEW_MAX_CHARS,
                   max_chars: int | None = None) -> tuple[str | None, bool]:
    """List-preview choke-point: clamp BEFORE redaction (contract order).

    ``None``/empty in → ``None`` out (the contract's nullable preview).
    ``max_chars`` overrides the clamp cap for tests; production callers
    never pass it.
    """
    if not text:
        return None, False
    limit = max_chars if max_chars is not None else clamp
    clamped = text[:limit]
    masked, applied = redact(clamped)
    return masked, applied


def redact_body(text: str) -> tuple[str, bool]:
    """Transcript-body choke-point: redact IN FULL, never clamp (slice 2
    serves bodies; the signature keeps the module one serving surface)."""
    return redact(text)