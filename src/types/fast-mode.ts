/**
 * Fast-lane demand for OpenAI-routed requests, the type of `OcxConfig.fastMode`. `true` sends
 * the canonical Fast tier (`service_tier: "priority"`), `"ultrafast"` sends the canonical Ultra Fast tier
 * (`service_tier: "ultrafast"`) and is honored only on routes that declare both Ultra Fast
 * capability and an `ultrafast` wire spelling — elsewhere the tier is dropped and recorded as a
 * downgrade rather than silently downgraded to Fast. `false` strips the field so requests use
 * default speed. Undefined = passthrough (don't modify what the client sends).
 */
export type FastModeDemand = boolean | "ultrafast";

/**
 * Codex's `[features] fast_mode` is a boolean toggle, so an Ultra Fast demand still writes `true`:
 * the flag says "the fast lane is on", while WHICH tier is sent is the proxy's decision, not this
 * key's. `false` and `undefined` keep their existing meanings.
 */
export function fastModeFeatureFlag(fastMode: FastModeDemand | undefined): boolean | undefined {
  return fastMode === undefined ? undefined : fastMode !== false;
}
