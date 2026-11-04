---
title: Ultra Fast tier
description: Declaring, routing, and confirming the Ultra Fast service tier above canonical Fast.
---

Ultra Fast is the tier above Fast: upstream advertises it as a second `service_tiers` entry
(`{"id":"ultrafast"}`) with `additional_speed_tiers: ["fast","ultrafast"]`. OpenCodex treats it as a
canonical tier a route can be SET to, not only a value it forwards when a caller supplies one.

## Declarations

Two declarations are required, and neither substitutes for the other:

- **capability** — `supportsUltraFast`, or an exact-model `modelSupportsUltraFast: true` when only
  some rows carry the tier. The shipped `openai` entry declares the latter for the two models its
  live roster advertises the tier on;
- **a wire spelling** — `fastWire.canonicalToWire.ultrafast`, for example
  `{"kind":"service-tier","canonicalToWire":{"priority":"priority","ultrafast":"ultrafast"}}`.

Both are provider-entry fields, defined with the rest of the
[provider field contract](/reference/configuration/providers/#provider-entries-ocxproviderconfig).

## Setting the tier

Set the tier with `fastMode: "ultrafast"`, or let the client ask for it directly through
`service_tier`. A route that declares the capability but publishes no spelling is not settable, and
neither is an unclassified route — the same rule that keeps canonical Fast injection off
unclassified routes.

`fastMode: "ultrafast"` is a tier demand rather than a Fast-lane switch, so the
[Cursor Fast](/reference/configuration/providers/#cursor-fast-cursor-variant) rewrite does not
follow it: Cursor keeps its umbrella ids, and because the cursor variant wire publishes no
`ultrafast` spelling the demand is dropped and recorded as a downgrade.

## Unfulfillable demands

A demand that cannot be honored is dropped rather than quietly downgraded to Fast: the attempt
records `fastOutcome: "downgraded"` with `wire-unavailable`, so the log says the tier was requested
and not delivered. Where the destination's echo is authoritative, an `ultrafast` echo confirms the
tier and any other echo records `response-declined`.

## Catalog rows

Catalog rows follow the same evidence. A routed model whose provider/model pair declares both halves
publishes the Ultra Fast row beside Fast, and the Codex picker then offers it. Nothing is
synthesized: a pair that declares nothing keeps its Fast-only row, and native rows still take their
tiers from upstream data — the pinned snapshot or the live roster — rather than from this
declaration. The separate `ultraFastTier` opt-in still governs only whether an operator's hand-added
Ultra Fast row survives catalog regeneration.
