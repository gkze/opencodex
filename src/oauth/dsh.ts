/**
 * DeepSeek Harness Account authentication (validated import, then browser authorization).
 *
 * Imports existing authenticated account from DeepSeek Harness Desktop
 * (`$DSH_HOME/.credentials.yaml`, default `~/.dsh/.credentials.yaml`).
 *
 * Invariant: The DSH credential store is strictly READ-ONLY to OpenCodeX.
 * OpenCodeX NEVER mutates, overwrites, deletes, or changes permissions of `~/.dsh/.credentials.yaml`.
 */

import type { OAuthController, OAuthCredentials } from "./types";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { DSH_PLATFORM_ORIGIN, dshTokenSchema, dshClientHeaders, dshIdentity, dshResponse, loginDshBrowser } from "./dsh-browser";
export { DSH_PLATFORM_ORIGIN } from "./dsh-browser";
export const DSH_INFERENCE_ORIGIN = "https://api.deepseek.com/anthropic";

export interface DshAccountDetectionResult {
  detected: boolean;
  token?: string;
  issuer?: string;
  error?: string;
}

export interface DshValidatedAccountIdentity {
  valid: boolean;
  accountId?: string;
  email?: string;
  name?: string;
  error?: string;
}

export function resolveDshCredentialsPath(): string {
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
  return join(dshHome, ".credentials.yaml");
}

/**
 * Pure read-only probe to detect whether DeepSeek Harness Desktop is installed
 * and signed in on this machine.
 * NEVER writes, creates, mutates, or deletes any file.
 */
export function detectDshAccount(): DshAccountDetectionResult {
  const filePath = resolveDshCredentialsPath();
  if (!existsSync(filePath)) {
    return { detected: false };
  }
  try {
    const content = readFileSync(filePath, "utf8");
    const data = Bun.YAML.parse(content) as Record<string, unknown> | null;
    if (!data || typeof data !== "object") {
      return { detected: false };
    }
    const records = data.records as Record<string, unknown> | undefined;
    const accountRecord = records?.["deepseek-account-platform/default"] as {
      kind?: string;
      payload?: { version?: number; token?: string; issuer?: string };
    } | undefined;

    if (accountRecord?.kind === "grant" && typeof accountRecord.payload?.token === "string" && accountRecord.payload.token.length > 0) {
      return {
        detected: true,
        token: accountRecord.payload.token,
        issuer: accountRecord.payload.issuer ?? DSH_PLATFORM_ORIGIN,
      };
    }
    return { detected: false };
  } catch {
    return { detected: false, error: "CREDENTIAL_FILE_READ_FAILED" };
  }
}

/**
 * Validate token against DeepSeek's authoritative profile endpoint:
 * GET https://platform.deepseek.com/auth-api/v0/users/current
 */
export async function validateDshAccountToken(
  token: string,
  signal?: AbortSignal,
): Promise<DshValidatedAccountIdentity> {
  try {
    if (!dshTokenSchema.safeParse(token).success) return { valid: false, error: "ACCOUNT_TOKEN_INVALID" };
    const timeoutSignal = AbortSignal.timeout(30_000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(`${DSH_PLATFORM_ORIGIN}/auth-api/v0/users/current`, {
      method: "GET",
      headers: {
        ...dshClientHeaders(),
        "x-dsh-auth-token": token,
        "accept": "application/json",
      },
      redirect: "manual",
      signal: combinedSignal,
    });

    if (!response.ok) {
      await response.body?.cancel();
      return { valid: false, error: response.status === 401 ? "ACCOUNT_TOKEN_INVALID" : `Platform returned HTTP ${response.status}` };
    }

    const identity = dshIdentity(await dshResponse(response));
    if (!identity) return { valid: false, error: "ACCOUNT_IDENTITY_UNVERIFIED" };
    return { valid: true, ...identity };
  } catch {
    if (signal?.aborted) throw signal.reason ?? new DOMException("DSH login aborted", "AbortError");
    // Parser and transport errors may contain profile data or credential-file contents.
    return { valid: false, error: "PROFILE_VALIDATION_FAILED" };
  }
}

export interface DshLoginOptions {
  forceLogin?: boolean;
}

/**
 * Explicit user login action for DSH Account.
 * Reuses a verified local grant; otherwise starts an explicit browser sign-in.
 * forceLogin skips import. Neither path writes to the Harness credential store.
 */
export async function loginDshAccount(
  ctrl: OAuthController,
  opts: DshLoginOptions = {},
): Promise<OAuthCredentials> {
  if (ctrl.signal?.aborted) {
    throw ctrl.signal.reason ?? new DOMException("DSH login aborted", "AbortError");
  }

  if (opts.forceLogin) return loginDshBrowser(ctrl, validateDshAccountToken);
  const detection = detectDshAccount();
  if (!detection.detected || !detection.token || detection.issuer !== DSH_PLATFORM_ORIGIN) {
    if (ctrl.onAuth) return loginDshBrowser(ctrl, validateDshAccountToken);
    throw new Error(
      "DeepSeek Harness account not found in ~/.dsh/.credentials.yaml. " +
      "Please sign in to DeepSeek Harness Desktop first, then import your account.",
    );
  }

  const validation = await validateDshAccountToken(detection.token, ctrl.signal);
  if (!validation.valid || !validation.accountId) {
    if (ctrl.onAuth) {
      ctrl.onProgress?.("Imported session could not establish identity; starting DeepSeek browser sign-in.");
      return loginDshBrowser(ctrl, validateDshAccountToken);
    }
    throw new Error(
      `DeepSeek Harness account token in ~/.dsh/.credentials.yaml is invalid or expired (${validation.error ?? "unknown"}). ` +
      "Please re-login in DeepSeek Harness Desktop, then try again.",
    );
  }

  return {
    access: detection.token,
    refresh: detection.token,
    expires: Number.MAX_SAFE_INTEGER,
    accountId: validation.accountId,
    email: validation.email,
    source: "credential-file",
  };
}

/**
 * Token refresh for DSH Account.
 * DSH accounts use long-lived session grant tokens without an automatic rotation endpoint.
 * In accordance with the explicit-import contract, background or automatic refresh MUST NOT
 * automatically re-read or adopt new credentials from ~/.dsh/.credentials.yaml.
 * If the grant is rejected or expires, this throws a terminal error so the account transitions
 * to needsReauth, requiring explicit user sign-in.
 */
export async function refreshDshAccountToken(
  _refreshToken: string,
  _signal?: AbortSignal,
  _credential?: OAuthCredentials,
  _accountId?: string,
): Promise<OAuthCredentials> {
  throw new Error("DeepSeek Harness account session expired or revoked. Please sign in again with ocx login dsh-account.");
}

/** Provider-owned auth hooks keep the shared OAuth registry within its line budget. */
export const DSH_ACCOUNT_AUTH = {
  login: loginDshAccount,
  refresh: refreshDshAccountToken,
  defaultRefreshPolicy: "disabled" as const,
};
