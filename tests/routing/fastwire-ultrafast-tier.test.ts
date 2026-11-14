/**
 * Ultra Fast as a tier a route can be SET to.
 *
 * The tier used to exist only as caller intent the proxy forwarded verbatim and refused to name
 * (#3429). These cases pin the other half: a provider/model pair that DECLARES the capability and
 * publishes an `ultrafast` spelling can be set to it, and a pair that declares neither is never
 * quietly sent Fast in the tier's place.
 *
 * The honesty rule survives the feature: capability without a wire spelling is inert, an
 * unclassified route is not settable, and a Fast echo cannot confirm an Ultra Fast demand.
 */
import { describe, expect, test } from "bun:test";
import {
  createAdapterTierMetadata,
  decideTier,
  resolveFastPolicy,
  tierObservationContext,
  type FastPolicyAuthority,
  type FastWire,
} from "../../src/providers/fastwire";
import { fastPolicyForModel, ultraFastSettableFromPolicy } from "../../src/providers/service-tier";
import { applyCatalogModelMetadata } from "../../src/codex/catalog/effort";
import type { CatalogModel, RawEntry } from "../../src/codex/catalog/parsing";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { providerConfigSeed } from "../../src/providers/derive";
import { registryModelIdKeys } from "../../src/providers/registry/model-ids";

const MODEL = "openai/gpt-6-astra";

/** The composition every catalog surface uses: resolve the pair's policy, then project it. */
const canSetUltraFast = (...args: Parameters<typeof fastPolicyForModel>) =>
  ultraFastSettableFromPolicy(fastPolicyForModel(...args));

const ULTRA_WIRE: FastWire = {
  kind: "service-tier",
  canonicalToWire: { priority: "priority", ultrafast: "ultrafast" },
  foreignCallerTiers: "verbatim",
};

const FAST_ONLY_WIRE: FastWire = {
  kind: "service-tier",
  canonicalToWire: { priority: "priority" },
  foreignCallerTiers: "verbatim",
};

function authority(
  capability: Partial<FastPolicyAuthority["capability"]> = {},
  wire: FastPolicyAuthority["fastWireDeclaration"] = ULTRA_WIRE,
): FastPolicyAuthority {
  return {
    providerAdapter: "openai-responses",
    fastWireDeclaration: wire,
    modelWireOverrideAllowed: true,
    authTransport: "authorization_bearer",
    capability: { provider: true, models: {}, ...capability },
    modelAdapters: {},
    hardPins: {},
    registryWireDefaults: {},
  };
}

const declaredUltra = () => authority({ modelsUltraFast: { [MODEL]: true } });

describe("a declared Ultra Fast route can be set to the tier", () => {
  test("the demand sets the declared wire spelling", () => {
    const policy = resolveFastPolicy(declaredUltra(), MODEL);
    expect(policy.ultraFastCapability).toBe(true);
    expect(decideTier(policy, "ultrafast", undefined)).toEqual({ kind: "set", value: "ultrafast" });
  });

  test("the demand outranks a caller Fast tier on the same route", () => {
    const policy = resolveFastPolicy(declaredUltra(), MODEL);
    expect(decideTier(policy, "ultrafast", "priority")).toEqual({ kind: "set", value: "ultrafast" });
  });

  test("turning the demand off strips the field instead of sending a tier", () => {
    const policy = resolveFastPolicy(declaredUltra(), MODEL);
    expect(decideTier(policy, false, "ultrafast")).toEqual({ kind: "drop" });
  });
});

describe("Ultra Fast is not settable without evidence", () => {
  test("a route whose wire publishes no ultrafast spelling drops the demand", () => {
    const policy = resolveFastPolicy(declaredUltra(), MODEL, "responses");
    const fastOnly = resolveFastPolicy(authority({ modelsUltraFast: { [MODEL]: true } }, FAST_ONLY_WIRE), MODEL);
    expect(policy.ultraFastCapability).toBe(true);
    expect(fastOnly.ultraFastCapability).toBe(true);
    expect(decideTier(fastOnly, "ultrafast", undefined)).toEqual({ kind: "drop" });
  });

  test("an unclassified route is not settable, exactly like canonical Fast injection", () => {
    const policy = resolveFastPolicy(authority(), MODEL);
    expect(policy.ultraFastCapability).toBeUndefined();
    expect(decideTier(policy, "ultrafast", undefined)).toEqual({ kind: "drop" });
  });

  test("an explicit denial is a denial, not an unclassified pass", () => {
    const policy = resolveFastPolicy(authority({ providerUltraFast: false }), MODEL);
    expect(policy.ultraFastCapability).toBe(false);
    expect(decideTier(policy, "ultrafast", undefined)).toEqual({ kind: "drop" });
  });

  test("a Fast-capable route without the Ultra Fast declaration keeps Fast behaviour", () => {
    const policy = resolveFastPolicy(authority({ models: { [MODEL]: true } }), MODEL);
    expect(decideTier(policy, true, undefined)).toEqual({ kind: "set", value: "priority" });
    expect(decideTier(policy, "ultrafast", undefined)).toEqual({ kind: "drop" });
  });
});

describe("a dropped Ultra Fast demand reads as a downgrade, never as Fast", () => {
  const observe = (policy: FastPolicyAuthority, responseEcho?: string) => {
    const resolved = resolveFastPolicy(policy, MODEL);
    const context = tierObservationContext(resolved, "ultrafast", undefined);
    const decision = decideTier(resolved, "ultrafast", undefined);
    const wireValue = decision.kind === "set" ? decision.value : null;
    const metadata = createAdapterTierMetadata(context, decision, "service-tier", wireValue)!;
    if (responseEcho !== undefined) metadata.observeResponseServiceTier(responseEcho);
    return metadata.outcome;
  };

  test("an applied demand names the tier it sent", () => {
    const outcome = observe(declaredUltra());
    expect(outcome.canonical).toBe("ultrafast");
    expect(outcome.fastOutcome).toBe("applied");
    expect(outcome.confirmation).toBe("assumed");
    expect(outcome.wireValue).toBe("ultrafast");
  });

  test("an authoritative ultrafast echo confirms the tier", () => {
    expect(observe(declaredUltra(), "ultrafast")).toMatchObject({
      canonical: "ultrafast",
      fastOutcome: "applied",
      confirmation: "confirmed",
      responseServiceTier: "ultrafast",
    });
  });

  test("a default echo downgrades the applied demand", () => {
    expect(observe(declaredUltra(), "default")).toMatchObject({
      fastOutcome: "downgraded",
      fastDowngradeReason: "response-declined",
      confirmation: "downgraded",
    });
  });

  test("a route that cannot carry the tier records a downgrade, not a Fast request", () => {
    const outcome = observe(authority({ modelsUltraFast: { [MODEL]: true } }, FAST_ONLY_WIRE));
    expect(outcome.canonical).toBeUndefined();
    expect(outcome.fastOutcome).toBe("downgraded");
    expect(outcome.wireValue).toBeNull();
  });
});

describe("capability helpers agree with the decision", () => {
  test("the per-model tri-state honours an explicit false over a provider true", () => {
    const capability = (c: Partial<FastPolicyAuthority["capability"]>) =>
      resolveFastPolicy(authority(c), MODEL).ultraFastCapability;
    expect(capability({ providerUltraFast: true, modelsUltraFast: { [MODEL]: false } })).toBe(false);
    expect(capability({ providerUltraFast: true, modelsUltraFast: {} })).toBe(true);
    expect(capability({ modelsUltraFast: {} })).toBeUndefined();
  });

  test("settable requires the spelling, not only the declaration", () => {
    const base = {
      adapter: "openai-responses",
      supportsServiceTier: true,
      supportsUltraFast: true,
      modelSupportsUltraFast: { [MODEL]: true },
    };
    expect(canSetUltraFast({ ...base, fastWire: ULTRA_WIRE }, MODEL, "custom-gateway")).toBe(true);
    expect(canSetUltraFast({ ...base, fastWire: FAST_ONLY_WIRE }, MODEL, "custom-gateway")).toBe(false);
    expect(canSetUltraFast({
      ...base,
      supportsServiceTier: false,
      fastWire: ULTRA_WIRE,
    }, MODEL, "custom-gateway")).toBe(false);
  });

  test("the policy projection refuses an unclassified route", () => {
    expect(ultraFastSettableFromPolicy(resolveFastPolicy(authority(), MODEL))).toBe(false);
    expect(ultraFastSettableFromPolicy(resolveFastPolicy(declaredUltra(), MODEL))).toBe(true);
  });
});

describe("the catalog publishes Ultra Fast only where a pair declares it", () => {
  const entry = (): RawEntry => ({ slug: "gateway/task-model" });
  const model = (overrides: Partial<CatalogModel>): CatalogModel => ({
    id: "task-model",
    provider: "gateway",
    supportsServiceTier: true,
    ...overrides,
  });

  test("a declared pair gains the tier beside its Fast row", () => {
    const row = entry();
    applyCatalogModelMetadata(row, model({ supportsUltraFast: true }));
    expect(row.service_tiers).toEqual([
      expect.objectContaining({ id: "priority" }),
      { id: "ultrafast", name: "Ultra Fast", description: "The fastest available responses for latency-sensitive work." },
    ]);
    expect(row.additional_speed_tiers).toEqual(["fast", "ultrafast"]);
  });

  test("Ultra Fast is appended without overwriting the Flex tier", () => {
    const row = entry();
    applyCatalogModelMetadata(row, model({ supportsUltraFast: true, supportsFlexTier: true }));
    expect(row.additional_speed_tiers).toEqual(["fast", "flex", "ultrafast"]);
    expect((row.service_tiers as Array<{ id: string }>).map(tier => tier.id)).toEqual(["priority", "flex", "ultrafast"]);
  });

  test("a bare-string ultrafast row left in service_tiers is replaced, not kept beside the descriptor", () => {
    const row: RawEntry = { slug: "gateway/task-model", service_tiers: ["ultrafast"], additional_speed_tiers: ["ultrafast"] };
    applyCatalogModelMetadata(row, model({ supportsServiceTier: false, supportsUltraFast: true }));
    expect(row.service_tiers).toEqual([
      { id: "ultrafast", name: "Ultra Fast", description: "The fastest available responses for latency-sensitive work." },
    ]);
    expect(row.additional_speed_tiers).toEqual(["ultrafast"]);
  });

  test("a pair that declares nothing keeps its Fast-only row", () => {
    const row = entry();
    applyCatalogModelMetadata(row, model({}));
    expect(row.additional_speed_tiers).toEqual(["fast"]);
    expect(row.service_tiers).toEqual([expect.objectContaining({ id: "priority" })]);
  });

  test("a stale ultrafast row is replaced, not duplicated, on repeated syncs", () => {
    const row = entry();
    applyCatalogModelMetadata(row, model({ supportsUltraFast: true }));
    applyCatalogModelMetadata(row, model({ supportsUltraFast: true }));
    expect(row.additional_speed_tiers).toEqual(["fast", "ultrafast"]);
    expect((row.service_tiers as Array<{ id: string }>).filter(tier => tier.id === "ultrafast")).toHaveLength(1);
  });
});

describe("the native route declares Ultra Fast where upstream advertises it", () => {
  test("the openai entry maps the spelling and names the roster's models", () => {
    const openai = PROVIDER_REGISTRY.find(entry => entry.id === "openai")!;
    expect(openai.modelSupportsUltraFast).toEqual({ "gpt-6-astra": true, "gpt-6.1-sol": true });
    const provider = providerConfigSeed(openai);
    expect(canSetUltraFast(provider, "gpt-6-astra", "openai")).toBe(true);
    expect(canSetUltraFast(provider, "gpt-6.1-sol", "openai")).toBe(true);
    // A row upstream advertises Fast alone must not become settable by association.
    expect(canSetUltraFast(provider, "gpt-5.5", "openai")).toBe(false);
  });

  test("the Ultra Fast map is capability, not roster evidence", () => {
    // Counting these keys as known ids made `ocx models` list a two-model OpenAI roster the
    // config never declared, once the CLI started listing router-known ids.
    const openai = PROVIDER_REGISTRY.find(entry => entry.id === "openai")!;
    expect(registryModelIdKeys(openai)).not.toContain("gpt-6-astra");
    expect(registryModelIdKeys(openai)).not.toContain("gpt-6.1-sol");
    const keyAuthOnly = {
      ...openai,
      modelSupportsUltraFast: undefined,
      keyAuthServiceTier: { modelSupportsUltraFast: { "key-auth-ultra": true } },
    };
    expect(registryModelIdKeys(keyAuthOnly)).not.toContain("key-auth-ultra");
  });
});
