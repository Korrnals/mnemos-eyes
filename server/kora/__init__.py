"""Kora feature package (ADR 0019 rev.2 — phase 1).

Slice 1 modules:
- ``redaction``  — the SINGLE content choke-point (x-kora-redaction).
- ``zcode_reader`` — read-only store reader (mode=ro + WAL fallback).

No module here writes to any harness store: Кора = view + relay, never
a fork (NO-DRIFT).
"""