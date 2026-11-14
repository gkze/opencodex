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

Both are provider-entry fields. The capability fields are defined here; the wire spelling and the
rest of the [provider field contract](/reference/configuration/providers/#provider-entries-ocxproviderconfig)
are defined there.

| Field | Type | Meaning |
| --- | --- | --- |
| `supportsUltraFast?` | `boolean` | Tri-state Ultra Fast capability, one tier above canonical Fast. `true` lets `fastMode: "ultrafast"` set this provider's `ultrafast` wire spelling and lets its models publish the tier in the catalog; `false` denies the tier outright. Capability alone is not enough: the route also needs a `fastWire.canonicalToWire.ultrafast` spelling, because a tier with no wire value has nothing to send. Absent leaves the route unclassified, so a caller-supplied `ultrafast` still passes only under the final wire's forwarding permission. See [Ultra Fast tier](/reference/configuration/ultra-fast/) for the drop-instead-of-downgrade rule and catalog rows. |
| `modelSupportsUltraFast?` | `Record<string, boolean>` | Exact upstream model overrides for Ultra Fast, resolved exactly like `modelSupportsServiceTier`: exact `true` enables the tier for that model, exact `false` narrows a provider-wide `true`. Prefer this over `supportsUltraFast` when only some rows advertise the tier — a provider-wide `true` offers Ultra Fast on every model, including rows upstream serves at Fast alone. |

## Setting the tier

Set the tier with `fastMode: "ultrafast"`, or let the client ask for it directly through
`service_tier`. A route that declares the capability but publishes no spelling is not settable, and
neither is an unclassified route — the same rule that keeps canonical Fast injection off
unclassified routes. The dashboard's Claude Code **Fast Mode** picker offers Ultra Fast as its own
choice beside ON, OFF and Auto, so a stored `"ultrafast"` is shown and saved as Ultra Fast.

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
publishes the Ultra Fast row after its existing tiers (Fast, and Flex where the route forwards it),
and the Codex picker then offers it. Nothing is
synthesized: a pair that declares nothing keeps its Fast-only row, and native rows still take their
tiers from upstream data — the pinned snapshot or the live roster — rather than from this
declaration. The separate `ultraFastTier` opt-in still governs only whether an operator's hand-added
Ultra Fast row survives catalog regeneration.
