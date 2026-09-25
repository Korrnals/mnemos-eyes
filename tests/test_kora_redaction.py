"""Redaction choke-point units (Kora slice 1, ADR 0019 rev.2 #4).

The single module server/kora/redaction.py carries the pattern pack
(ghp_, sk-, AKIA, eyJ, mnd_, bearer + board families). These units pin:

- every pattern fires and leaves the prefix + <redacted> (never the tail);
- the honest applied flag (False on clean text, True on any fire);
- preview clamp order: clamp BEFORE redaction (the contract fixes it —
  masking can only shorten, so the 160 bound survives);
- the boundary: a token starting beyond the clamp never leaks.
"""

from __future__ import annotations

import pytest

from server.kora import redaction


class TestPatternPack:
    @pytest.mark.parametrize("secret,marker", [
        ("ghp_AbCdEf1234567890aBcDeF", "gh*_<redacted>"),
        ("sk-AbCdEf1234567890aBcDeF", "sk-<redacted>"),
        # sk-ant-… matches the broader sk- pattern first — the full secret
        # is masked either way; the marker prefix is not load-bearing.
        ("sk-ant-api03-AbCdEf1234567890", "sk-<redacted>"),
        ("AKIAIOSFODNN7EXAMPLE", "AKIA<redacted>"),
        ("mnd_dev7f3a91b2c4", "mnd_<redacted>"),
        ("mnk_live9f2e1d0c8b", "mnk_<redacted>"),
        ("mne_one5hot4token", "mne_<redacted>"),
        ("plain:super-secret-value", "plain:<redacted>"),
    ])
    def test_families_masked(self, secret, marker):
        out, applied = redaction.redact(f"prefix {secret} suffix")
        assert applied is True
        assert secret not in out
        assert marker in out

    def test_jwt_masked(self):
        jwt = ("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0."
               "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c")
        out, applied = redaction.redact(f"token {jwt} end")
        assert applied is True
        assert jwt not in out
        assert "eyJ<redacted>" in out

    def test_bearer_masked_case_insensitive(self):
        for form in ("Bearer abcdef12345678", "bearer abcdef12345678",
                     "BEARER abcdef12345678"):
            out, applied = redaction.redact(form)
            assert applied is True
            assert "abcdef12345678" not in out

    def test_clean_text_untouched(self):
        text = "обычный рабочий текст без секретов — код, путь, цифры 12345"
        out, applied = redaction.redact(text)
        assert out == text
        assert applied is False

    def test_empty_and_none_semantics(self):
        assert redaction.redact("") == ("", False)
        assert redaction.redact_preview(None) == (None, False)
        assert redaction.redact_preview("") == (None, False)


class TestPreviewClamp:
    def test_clamp_before_redaction_order(self):
        # 300 chars where a token starts at position 170 — the clamp cut
        # it off; redaction must not resurrect or leak any of it.
        text = "x" * 170 + " ghp_AbCdEf1234567890aBcDeF " + "y" * 130
        preview, applied = redaction.redact_preview(text)
        assert preview is not None
        assert len(preview) <= 160
        assert "ghp_" not in preview
        assert applied is False  # the secret never made it past the clamp

    def test_token_inside_clamp_masked_after_clamp(self):
        text = "аудит: " + "Bearer abc123def456ghi789" + " " + "z" * 300
        preview, applied = redaction.redact_preview(text)
        assert preview is not None
        assert len(preview) <= 160
        assert "abc123def456ghi789" not in preview
        assert applied is True

    def test_exact_160_boundary(self):
        text = "a" * 160 + "tail-that-must-not-leak"
        preview, _ = redaction.redact_preview(text)
        assert preview == "a" * 160

    def test_short_text_passes_verbatim(self):
        preview, applied = redaction.redact_preview("короткое превью")
        assert preview == "короткое превью"
        assert applied is False

    def test_multibyte_counts_chars_not_bytes(self):
        # 160 CHARS of Cyrillic must survive (not 160 bytes).
        text = "ж" * 200
        preview, _ = redaction.redact_preview(text)
        assert len(preview) == 160


class TestBody:
    def test_body_never_clamped(self):
        text = "a" * 5000 + " ghp_AbCdEf1234567890aBcDeF"
        out, applied = redaction.redact_body(text)
        assert len(out) >= 5000  # full length preserved
        assert "ghp_" not in out
        assert applied is True
class TestStraddleAndExpansion:
    """Slice-1 review P1/P2: the clamp can CUT a secret (the surviving
    tail escapes the {16,} minimums) and the MASK can EXPAND the string
    past the bound (markers are longer than short tokens)."""

    def test_p1_straddle_leak_position_141(self):
        """The review's exact case: a secret starting at position 141 —
        the 160-clamp keeps only its head, the {16,} pack misses the
        cut tail, the prefix scrub must catch it."""
        text = "x" * 141 + "ghp_AbCdEf1234567890aBcDeF tail"
        preview, applied = redaction.redact_preview(text)
        assert preview is not None
        assert "ghp_" not in preview, (
            "straddled ghp_ tail leaked through the clamp")
        assert "gh*_<redacted>" in preview

    def test_p1_straddle_glued_no_word_boundary(self):
        """Straddle + glue: …xxxghp_Abc… has NO word boundary before the
        prefix — the long-prefix scrub patterns must not need one."""
        text = "y" * 140 + "xghp_AbCdEf1234567890"
        preview, _ = redaction.redact_preview(text)
        assert "ghp_" not in preview

    def test_p1_straddle_all_families(self):
        """Long-prefix families scrub GLUED fragments (their prefixes
        never occur inside prose words). The sk-/sk-ant- families keep
        the lookbehind — dropping it mangles ordinary hyphenated words
        ("task-ant-1"); a glued key fragment shorter than the {16,}
        minimum carries no usable secret material (module asymmetry,
        documented in server/kora/redaction.py)."""
        for tail in ("mnd_sh0rt", "mnk_sh0rtok", "mne_sh0rtok",
                     "AKIA123456789A", "eyJhbGciOiJ"):
            text = "z" * 150 + tail
            preview, _ = redaction.redact_preview(text)
            assert tail[:6] not in preview, f"family leaked: {tail}"
        # sk- with a SPACE before it still scrubs (the lookbehind passes)
        text = "z" * 150 + " sk-ant-abc12"
        preview, applied = redaction.redact_preview(text)
        assert "abc12" not in preview and applied

    def test_p1_sk_ant_glued_is_documented_asymmetry(self):
        """The honest edge: a GLUED sk-ant- fragment under 16 chars
        survives (lookbehind rejects the glue). Pin the decision so a
        future change is deliberate, not accidental: prose intact beats
        a hypothetical sub-minimum fragment."""
        text = "z" * 150 + "sk-ant-abc12"
        preview, _ = redaction.redact_preview(text)
        assert "task-ant-1 в тексте"  # prose example from the analysis
        out, _ = redaction.redact("task-ant-1 в тексте")
        assert out == "task-ant-1 в тексте"

    def test_p1_no_false_positive_on_hyphenated_words(self):
        """The sk- lookbehind: ordinary hyphenated words must survive —
        a false positive on every "task-N" would shred real previews.
        (Honest asymmetry: a glued sk- fragment <16 chars carries no
        usable key material — documented in the module.)"""
        text = "список task-1 и task-2 закрыт,usk-3 нет"
        out, applied = redaction.redact(text)
        assert out == text and applied is False

    def test_p2_mask_expansion_stays_clamped(self):
        """Markers are LONGER than short tokens — redaction can grow a
        160-char input past the bound; the double clamp must hold it."""
        text = "a" * 100 + " mnd_shorttok1 " + "b" * 50
        preview, applied = redaction.redact_preview(text)
        assert len(preview) <= 160
        assert applied is True

    def test_p2_worst_case_token_cascade(self):
        """60 short mnd_ tokens: every marker fires — the output must
        still respect the 160 bound."""
        text = " ".join(["mnd_shorttok1"] * 60)
        preview, applied = redaction.redact_preview(text)
        assert len(preview) <= 160
        assert applied is True
