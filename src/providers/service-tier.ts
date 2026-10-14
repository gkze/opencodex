import type { OcxProviderConfig } from "../types";
import { captureWireAdapterHardPinPrefixes, captureWireAdapterHardPins } from "../types";
import { isCanonicalOpenAiForwardProvider } from "./openai-tiers";
import {
  getProviderRegistryEntry,
  providerMatchesRegistryTransport,
  registryModelServiceTierCapabilityApplies,
  type InboundWire,
  type ModelWireDefault,
} from "./registry";
import {
  cloneFastWire,
  resolveFastPolicy,
  resolveProviderAuthTransport,
  type FastPolicyAuthority,
  type ResolvedFastPolicy,
} from "./fastwire";
import { providerFastSwitchOff } from "./fast-opt-in";

/** OpenAI-compatible adapters that can carry the standard `service_tier` field. */
export const SERVICE_TIER_ADAPTERS = new Set(["openai-chat", "openai-responses"]);

/** @deprecated A1 evolves this snapshot into the complete FastPolicyAuthority. */
export type CapturedServiceTierAdapterAuthority = FastPolicyAuthority;

const capturedFastPolicyAuthorities = new WeakMap<object, FastPolicyAuthority>();

type ServiceTierCapabilityProvider = Pick<
  OcxProviderConfig,
  | "adapter"
  | "supportsServiceTier"
  | "modelSupportsServiceTier"
  | "supportsUltraFast"
  | "modelSupportsUltraFast"
  | "modelAdapters"
  | "baseUrl"
  | "authMode"
  | "googleMode"
  | "apiKeyTransport"
  | "chatServiceTier"
  | "fastWire"
  | "fastEnabled"
>;

function cloneRegistryWireDefaults(
  defaults: Readonly<Record<string, ModelWireDefault>> | undefined,
): Readonly<Record<string, ModelWireDefault>> {
  if (!defaults) return Object.freeze({});
  const clone: Record<string, ModelWireDefault> = {};
  for (const [modelId, declaration] of Object.entries(defaults)) {
    clone[modelId.trim().toLowerCase()] = typeof declaration === "string"
      ? declaration
      : Object.freeze({
          wire: declaration.wire,
          inbound: Object.freeze([...declaration.inbound]),
          ...(declaration.authModes
            ? { authModes: Object.freeze([...declaration.authModes]) }
            : {}),
          ...(declaration.forwardCallerServiceTier !== undefined
            ? { forwardCallerServiceTier: declaration.forwardCallerServiceTier }
            : {}),
        });
  }
  return Object.freeze(clone);
}

/**
 * Capture every registry-owned input before an asynchronous catalog flight begins.
 * The resolver itself is pure and never reads the live provider registry.
 */
function buildFastPolicyAuthority(
  providerName: string,
  provider: ServiceTierCapabilityProvider,
  registryTransportMatch: boolean,
  capabilityProvider: ServiceTierCapabilityProvider = provider,
): FastPolicyAuthority {
  const registry = registryTransportMatch ? getProviderRegistryEntry(providerName) : undefined;
  const authTransport = resolveProviderAuthTransport(
    provider.adapter,
    provider.authMode ?? registry?.authKind ?? "key",
    provider.apiKeyTransport,
  );
  const keyAuthDefaults = registry?.allowKeyAuthOverride === true
    && (authTransport === "authorization_bearer" || authTransport === "x_api_key")
    ? registry.keyAuthServiceTier
    : undefined;
  const registryModelCapabilities = registry
    && registryModelServiceTierCapabilityApplies(registry, capabilityProvider)
    ? registry.modelSupportsServiceTier
    : undefined;
  const registryModelUltraFastCapabilities = registry
    && registryModelServiceTierCapabilityApplies(registry, capabilityProvider)
    ? registry.modelSupportsUltraFast
    : undefined;
  const fastSwitchOff = providerFastSwitchOff(providerName, {
    fastEnabled: capabilityProvider.fastEnabled ?? provider.fastEnabled,
  });
  const providerCapability = fastSwitchOff
    ? false
    : capabilityProvider.supportsServiceTier
      ?? keyAuthDefaults?.supportsServiceTier
      ?? registry?.supportsServiceTier;
  // Ultra Fast follows the same authority chain one tier up. `fastEnabled: false` denies the whole
  // fast lane, so it closes Ultra Fast as well; the wire spelling is a separate gate in decideTier.
  const providerUltraFastCapability = fastSwitchOff
    ? false
    : capabilityProvider.supportsUltraFast ?? registry?.supportsUltraFast;
  const authority: FastPolicyAuthority = Object.freeze({
    providerAdapter: provider.adapter,
    providerAuthMode: provider.authMode ?? registry?.authKind ?? "key",
    fastWireDeclaration: cloneFastWire(
      provider.fastWire !== undefined ? provider.fastWire : registry?.fastWire,
      { freeze: true },
    ),
    ...(registry?.fastTierDescription !== undefined
      ? { fastTierDescription: registry.fastTierDescription }
      : {}),
    modelWireOverrideAllowed: !isCanonicalOpenAiForwardProvider(provider as OcxProviderConfig),
    authTransport,
    capability: Object.freeze({
      ...(providerCapability !== undefined ? { provider: providerCapability } : {}),
      ...(providerUltraFastCapability !== undefined
        ? { providerUltraFast: providerUltraFastCapability }
        : {}),
      models: Object.freeze({
        ...(registryModelCapabilities ?? {}),
        ...(keyAuthDefaults?.modelSupportsServiceTier ?? {}),
        ...(capabilityProvider.modelSupportsServiceTier ?? {}),
      }),
      modelsUltraFast: Object.freeze({
        ...(registryModelUltraFastCapabilities ?? {}),
        ...(keyAuthDefaults?.modelSupportsUltraFast ?? {}),
        ...(capabilityProvider.modelSupportsUltraFast ?? {}),
      }),
      ...(provider.chatServiceTier !== undefined
        ? { chatServiceTier: provider.chatServiceTier }
        : keyAuthDefaults?.chatServiceTier !== undefined
          ? { chatServiceTier: keyAuthDefaults.chatServiceTier }
          : {}),
    }),
    modelAdapters: Object.freeze({ ...(provider.modelAdapters ?? {}) }),
    hardPins: captureWireAdapterHardPins(providerName, provider),
    hardPinPrefixes: captureWireAdapterHardPinPrefixes(providerName, provider),
    registryWireDefaults: cloneRegistryWireDefaults(registry?.modelWireDefaults),
  });
  return authority;
}

export function captureFastPolicyAuthority(
  providerName: string,
  provider: ServiceTierCapabilityProvider,
  registryTransportMatch: boolean,
  capabilityProvider: ServiceTierCapabilityProvider = provider,
): FastPolicyAuthority {
  const authority = buildFastPolicyAuthority(
    providerName,
    provider,
    registryTransportMatch,
    capabilityProvider,
  );
  if (Object.isFrozen(provider)) capturedFastPolicyAuthorities.set(provider, authority);
  return authority;
}

/** @deprecated Use captureFastPolicyAuthority. The legacy inbound argument is now snapshot data. */
export function captureServiceTierAdapterAuthority(
  providerName: string,
  provider: ServiceTierCapabilityProvider,
  registryTransportMatch: boolean,
  _inbound: InboundWire = "responses",
): FastPolicyAuthority {
  return captureFastPolicyAuthority(providerName, provider, registryTransportMatch);
}

function authorityForProvider(
  provider: ServiceTierCapabilityProvider,
  providerName?: string,
  capabilityProvider?: ServiceTierCapabilityProvider,
): FastPolicyAuthority {
  // Preserve the legacy no-name short circuit: serviceTierSupportForModel() used the
  // provider adapter directly when no provider identity was available, so no configured
  // override, hard pin, or registry default may participate on this path in A1.
  if (providerName === undefined) {
    const authority = buildFastPolicyAuthority("", provider, false, capabilityProvider ?? provider);
    return Object.freeze({
      ...authority,
      modelAdapters: Object.freeze({}),
      hardPins: Object.freeze({}),
      hardPinPrefixes: Object.freeze({}),
      registryWireDefaults: Object.freeze({}),
    });
  }
  const captured = capabilityProvider === undefined && Object.isFrozen(provider)
    ? capturedFastPolicyAuthorities.get(provider)
    : undefined;
  if (captured) return captured;
  const registryTransportMatch = providerMatchesRegistryTransport(providerName, provider);
  const authority = buildFastPolicyAuthority(
    providerName,
    provider,
    registryTransportMatch,
    capabilityProvider ?? provider,
  );
  // Frozen provider snapshots cannot drift, so repeated catalog/runtime projections may safely
  // reuse the registry lookup and detached declaration maps. Mutable configs still rebuild.
  if (Object.isFrozen(provider)) capturedFastPolicyAuthorities.set(provider, authority);
  return authority;
}

/** Resolve the pure Fast policy for a provider/model pair. */
export function fastPolicyForModel(
  provider: ServiceTierCapabilityProvider,
  modelId: string,
  providerName?: string,
  inbound: InboundWire = "responses",
  capabilityProvider?: ServiceTierCapabilityProvider,
): ResolvedFastPolicy {
  return resolveFastPolicy(
    authorityForProvider(provider, providerName, capabilityProvider),
    modelId,
    inbound,
  );
}

/**
 * Resolve the declared provider/model capability without applying wire availability.
 * Kept as a public compatibility helper for callers that need the pure tri-state.
 */
export function supportsServiceTierForModel(
  provider: Pick<OcxProviderConfig, "supportsServiceTier" | "modelSupportsServiceTier">,
  modelId: string,
): boolean | undefined {
  const authority: FastPolicyAuthority = {
    providerAdapter: "openai-responses",
    fastWireDeclaration: undefined,
    modelWireOverrideAllowed: true,
    authTransport: "authorization_bearer",
    capability: {
      ...(provider.supportsServiceTier !== undefined ? { provider: provider.supportsServiceTier } : {}),
      models: provider.modelSupportsServiceTier ?? {},
    },
    modelAdapters: {},
    hardPins: {},
    registryWireDefaults: {},
  };
  return resolveFastPolicy(authority, modelId).capability;
}

/** Ultra Fast counterpart of `supportsServiceTierForModel`; wire availability is checked separately. */
export function supportsUltraFastForModel(
  provider: Pick<OcxProviderConfig, "supportsUltraFast" | "modelSupportsUltraFast">,
  modelId: string,
): boolean | undefined {
  const authority: FastPolicyAuthority = {
    providerAdapter: "openai-responses",
    fastWireDeclaration: undefined,
    modelWireOverrideAllowed: true,
    authTransport: "authorization_bearer",
    capability: {
      ...(provider.supportsUltraFast !== undefined
        ? { providerUltraFast: provider.supportsUltraFast }
        : {}),
      models: {},
      modelsUltraFast: provider.modelSupportsUltraFast ?? {},
    },
    modelAdapters: {},
    hardPins: {},
    registryWireDefaults: {},
  };
  return resolveFastPolicy(authority, modelId).ultraFastCapability;
}

/**
 * Whether a provider/model pair can be SET to Ultra Fast — the capability is not denied and the
 * resolved wire publishes a spelling for it. Declared capability without a wire value is inert
 * config, so every surface that offers or publishes the tier goes through this instead of the
 * capability tri-state alone.
 */
export function canSetUltraFastForModel(
  providerName: string,
  provider: ServiceTierCapabilityProvider,
  modelId: string,
  inbound: InboundWire = "responses",
): boolean {
  const policy = fastPolicyForModel(provider, modelId, providerName, inbound);
  return ultraFastSettableFromPolicy(policy);
}

/** Whether a Chat route may forward an arbitrary caller tier rather than canonical Fast. */
export function canForwardForeignServiceTierForChatModel(
  provider: Pick<OcxProviderConfig, "supportsServiceTier" | "modelSupportsServiceTier" | "chatServiceTier">,
  modelId: string,
): boolean {
  const capability = supportsServiceTierForModel(provider, modelId);
  return capability !== false && provider.chatServiceTier === true;
}

/** Final adapter selected by the Fast policy's four-level wire resolver. */
export function serviceTierAdapterForModel(
  providerName: string,
  provider: ServiceTierCapabilityProvider,
  modelId: string,
  inbound: InboundWire = "responses",
): string {
  return fastPolicyForModel(provider, modelId, providerName, inbound).adapter;
}

/** Whether the final provider/model pair can publish/send OpenAI service tiers. */
export function canForwardServiceTierForModel(
  provider: ServiceTierCapabilityProvider,
  modelId: string,
  providerName?: string,
  inbound: InboundWire = "responses",
): boolean {
  return serviceTierSupportForModel(provider, modelId, providerName, inbound) === true;
}

/**
 * Compatibility projection for catalog, routing, and fingerprint consumers. The new
 * resolver carries richer eligibility internally while preserving the old tri-state bytes.
 */
export function serviceTierSupportForModel(
  provider: ServiceTierCapabilityProvider,
  modelId: string,
  providerName?: string,
  inbound: InboundWire = "responses",
): boolean | undefined {
  const policy = fastPolicyForModel(provider, modelId, providerName, inbound);
  return serviceTierSupportFromPolicy(policy);
}

/**
 * Compatibility projection for catalog publication and the settings surfaces: Ultra Fast is
 * settable only when the route DECLARES the capability (`true`, not merely unclassified, exactly
 * like canonical Fast injection) and the resolved wire publishes a spelling for it. Capability
 * without a spelling has nothing to send, and a spelling without capability is not evidence.
 */
export function ultraFastSettableFromPolicy(
  policy: Pick<ResolvedFastPolicy, "capability" | "ultraFastCapability" | "fastWire">,
): boolean {
  // Fast capability first: `decideTier` refuses every tier on a route whose Fast capability is
  // false, so an Ultra Fast declaration on such a route is inert and must not be offered.
  if (policy.capability !== true || policy.ultraFastCapability !== true) return false;
  const wireValue = policy.fastWire?.canonicalToWire.ultrafast;
  return typeof wireValue === "string" && wireValue.length > 0;
}

/**
 * Compatibility projection shared by catalog, routing, and request logging.
 */
export function serviceTierSupportFromPolicy(
  policy: Pick<ResolvedFastPolicy, "eligibility" | "adapter" | "forwardCallerTier">,
): boolean | undefined {
  if (policy.eligibility === "eligible") return true;
  if (policy.eligibility === "unclassified") {
    // An unclassified route that cannot forward a caller tier has definitive negative
    // evidence even when its adapter can normally serialize service_tier. This covers both
    // Chat routes without chatServiceTier and a registry default that explicitly closes a
    // subscription gateway. Generic unclassified Responses routes still project unknown.
    if (!policy.forwardCallerTier) return false;
    return undefined;
  }
  return false;
}
