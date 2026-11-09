/**
 * Fast-lane demand for OpenAI-routed requests, the type of `OcxConfig.fastMode`. `true` sends
 * the canonical Fast tier (`service_tier: "priority"`), `"ultrafast"` sends the canonical Ultra Fast tier
 * (`service_tier: "ultrafast"`) and is honored only on routes that declare both Ultra Fast
 * capability and an `ultrafast` wire spelling — elsewhere the tier is dropped and recorded as a
 * downgrade rather than silently downgraded to Fast. `false` strips the field so requests use
 * default speed. Undefined = passthrough (don't modify what the client sends).
 */
export type FastModeDemand = boolean | "ultrafast";
