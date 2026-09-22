---
title: Hostile fixture
slug: hostile
category: getting-started
order: 1
last_verified: "1.0.0"
---

# Hostile

This fixture is NOT real content: it exists only for the hostile-render gate
(contract §9.2). It must never render script/iframe nodes or event handlers.

<script>alert("xss")</script>

<img src="x" onerror="alert('img')" />

<iframe src="https://evil.example/"></iframe>

[bad link](javascript:alert('link'))

[good link](https://example.com/ok)

[anchor](#hostile)

Regular paragraph.
