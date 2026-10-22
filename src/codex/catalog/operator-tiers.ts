import type { RawEntry } from "./parsing";

/** Match the opt-in tier spelling without coercing malformed catalog values to strings. */
function isUltraFast(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "ultrafast";
}

/** Recognize an explicitly supplied Ultra Fast descriptor by its string-valued id. */
function isUltraFastDescriptor(value: unknown): boolean {
  return value !== null && typeof value === "object" && "id" in value && isUltraFast(value.id);
}

/**
 * Whether THIS build derived the row's Ultra Fast declaration from provider/model evidence.
 *
 * The stamp is written by `applyCatalogModelMetadata` and travels with the row, so a preserved row
 * keeps its origin while a row that merely inherited tier metadata from a native template never
 * gains one. That distinction is what lets the retention flag govern hand edits without erasing
 * evidence.
 */
function declaresUltraFastFromEvidence(entry: RawEntry): boolean {
  const provenance = entry.opencodex_capability_provenance;
  return provenance !== null && typeof provenance === "object"
    && (provenance as { ultra_fast?: unknown }).ultra_fast === true;
}

/**
 * Restore only exact-row operator metadata, after fresh provider capabilities are applied.
 *
 * Two origins of an `ultrafast` declaration are treated differently, because only one of them is
 * the operator's:
 *
 * - evidence-derived (stamped by the build) survives with the flag off, since turning the opt-in
 *   off must not erase a tier the provider/model declaration justifies;
 * - a declaration carried over from the persisted row is a hand edit, and the opt-in decides
 *   whether regeneration keeps it.
 *
 * When both exist and the opt-in is on, the persisted row wins — the precedence this flag has
 * always had.
 */
export function preserveOperatorUltraFastTiers(entry: RawEntry, previous: RawEntry | undefined, enabled: boolean): void {
  // A native template or stale row is not authority for this opt-in. Keep all other fresh
  // tier policy, including Fast, while replacing only Ultra Fast from the exact persisted row.
  const derived = declaresUltraFastFromEvidence(entry);
  for (const [field, matches] of [
    ["service_tiers", isUltraFastDescriptor],
    ["additional_speed_tiers", isUltraFast],
  ] as const) {
    const current = entry[field];
    const declared = derived && Array.isArray(current) ? current.filter(matches) : [];
    const fresh = Array.isArray(current) ? current.filter(value => !matches(value)) : [];
    const old = previous?.[field];
    const supplied = enabled && Array.isArray(old) ? old.find(matches) : undefined;
    const kept = supplied !== undefined
      ? structuredClone(supplied)
      : declared.length > 0 ? declared[0] : undefined;
    if (kept !== undefined) {
      entry[field] = [...fresh, kept];
    } else if (Array.isArray(current) && fresh.length !== current.length) {
      if (fresh.length > 0) entry[field] = fresh;
      else delete entry[field];
    }
  }
  const hasDeclaration = (Array.isArray(entry.service_tiers) && entry.service_tiers.some(isUltraFastDescriptor))
    || (Array.isArray(entry.additional_speed_tiers) && entry.additional_speed_tiers.some(isUltraFast));
  for (const field of ["service_tier", "default_service_tier"] as const) {
    // A derived row never sets these two itself, so the historical rule stands unchanged: only the
    // operator's own persisted spelling is restored or removed here.
    if (enabled && hasDeclaration && previous && isUltraFast(previous[field])) entry[field] = previous[field];
    else if (isUltraFast(entry[field])) delete entry[field];
  }
}
