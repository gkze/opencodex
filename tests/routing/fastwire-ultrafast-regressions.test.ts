import { describe, expect, test } from "bun:test";
import { createAdapterTierMetadata, decideTier, resolveFastPolicy, tierObservationContext, type FastPolicyAuthority, type FastWire } from "../../src/providers/fastwire";
import { ultraFastSettableFromPolicy } from "../../src/providers/service-tier";

const wire: FastWire = { kind: "service-tier", canonicalToWire: { priority: "priority", ultrafast: "ultrafast" }, foreignCallerTiers: "verbatim" };
function policy(capability: Partial<FastPolicyAuthority["capability"]> = {}, fastWireDeclaration = wire, providerAdapter = "openai-responses") {
  return resolveFastPolicy({ providerAdapter, fastWireDeclaration, modelWireOverrideAllowed: true,
    authTransport: "authorization_bearer", capability: { provider: true, providerUltraFast: true, models: {}, ...capability },
    modelAdapters: {}, hardPins: {}, registryWireDefaults: {} }, "task-model");
}

describe("Ultra Fast capability boundaries", () => {
  for (const capability of [{ providerUltraFast: false }, { modelsUltraFast: { "task-model": false } }]) {
    for (const mapping of [wire, { ...wire, canonicalToWire: { priority: "priority" } }]) {
      test(`inherited Ultra Fast respects ${JSON.stringify(capability)} with ${Object.keys(mapping.canonicalToWire)}`, () => {
        expect(decideTier(policy(capability, mapping), undefined, "ultrafast")).toEqual({ kind: "drop" });
      });
    }
  }
  test("unclassified Fast routes retain caller forwarding and ignore forced demand", () => {
    const unclassified = policy({ provider: undefined, providerUltraFast: undefined });
    expect(decideTier(unclassified, "ultrafast", "flex")).toEqual({ kind: "forward-caller" });
    expect(decideTier(unclassified, undefined, "ultrafast")).toEqual({ kind: "forward-caller" });
  });
  test("an unclassified Ultra Fast tier obeys foreign forwarding permission", () => {
    expect(decideTier(policy({ providerUltraFast: undefined }, { ...wire, foreignCallerTiers: "drop" }), undefined, "ultrafast")).toEqual({ kind: "drop" });
    expect(decideTier(policy({ providerUltraFast: undefined }), undefined, "ultrafast")).toEqual({ kind: "forward-caller" });
  });
  test("settable projection and decision both reject an incompatible wire", () => {
    const incompatible = policy({}, wire, "anthropic");
    expect(decideTier(incompatible, "ultrafast", undefined)).toEqual({ kind: "drop" });
    expect(ultraFastSettableFromPolicy(incompatible)).toBe(false);
  });
});

for (const demand of [undefined, "ultrafast"] as const) {
  test(`${demand ?? "inherited"} Ultra Fast confirms only its own authoritative echo`, () => {
    const resolved = policy();
    const decision = decideTier(resolved, demand, "ultrafast");
    const observe = () => createAdapterTierMetadata(tierObservationContext(resolved, demand, "ultrafast"), decision, "service-tier", "ultrafast")!;
    const accepted = observe();
    expect(accepted.outcome).toMatchObject({ canonical: "ultrafast", fastOutcome: "applied", confirmation: "assumed" });
    accepted.observeResponseServiceTier("ultrafast");
    expect(accepted.outcome).toMatchObject({ canonical: "ultrafast", confirmation: "confirmed" });
    const declined = observe();
    declined.observeResponseServiceTier("priority");
    expect(declined.outcome).toMatchObject({ fastOutcome: "downgraded", fastDowngradeReason: "response-declined", confirmation: "downgraded" });
    expect(declined.outcome.canonical).toBeUndefined();
  });
}
