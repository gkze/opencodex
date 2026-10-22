/** DeepSeek's DSH authorization protocol; all grant destinations are fixed. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { platform, arch, release } from "node:os";
import { readFileSync } from "node:fs";
import { withConfigMutationLockSync } from "../config/mutation-lock";
import { atomicWriteFile } from "../config/atomic-write";
import { join } from "node:path";
import { z } from "zod";
import { getConfigDir } from "../config/paths";
import { version } from "../../package.json";
import type { OAuthController, OAuthCredentials } from "./types";

/** Only locally authored messages may cross the authentication error boundary. */
class DshAuthError extends Error {}

export const DSH_PLATFORM_ORIGIN = "https://platform.deepseek.com";
export const dshTokenSchema = z.string().regex(/^[\x21-\x7e]+$/);
const identitySchema = z.object({
  id: z.string().trim().min(1),
  email: z.string().optional(),
  id_profile: z.object({ name: z.string().nullable().optional() }).nullish(),
});
const initSchema = z.object({ authorize_url: z.string(), authorize_id: z.string().min(1), expires_in: z.number().positive() });
const exchangeSchema = z.object({ token: dshTokenSchema, authorized_url: z.string(), user: z.unknown().optional() });
const envelopeSchema = z.object({ code: z.literal(0), data: z.object({ biz_code: z.literal(0), biz_data: z.unknown() }) });

export function dshIdentity(value: unknown) {
  const parsed = identitySchema.safeParse(value);
  return parsed.success ? {
    accountId: parsed.data.id,
    email: parsed.data.email?.trim() || undefined,
    name: parsed.data.id_profile?.name?.trim() || undefined,
  } : undefined;
}

export function dshClientHeaders(): Record<string, string> {
  return {
    "x-client-bundle-id": "",
    "x-client-platform": platform() === "darwin" ? "desktop-mac" : platform() === "win32" ? "desktop-win" : "web",
    "x-client-version": version,
    "x-client-locale": "en_US",
    "x-client-timezone-offset": String(-new Date().getTimezoneOffset() * 60),
  };
}

/** Bounded body and fixed errors keep provider responses and secrets out of logs. */
export async function dshResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new DshAuthError(`DeepSeek platform HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new DshAuthError("DeepSeek platform response missing");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65_536) throw new DshAuthError("DeepSeek platform response too large");
      chunks.push(part.value);
    }
    const result = envelopeSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!result.success) throw new DshAuthError("DeepSeek platform response invalid");
    return result.data.data.biz_data;
  } catch (error) {
    if (error instanceof DshAuthError) throw error;
    throw new DshAuthError("DeepSeek platform response invalid");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function browserUrl(value: string, path: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new DshAuthError("DeepSeek authorization destination invalid"); }
  if (url.origin !== DSH_PLATFORM_ORIGIN || url.pathname !== path || url.username || url.password || url.hash) {
    throw new DshAuthError("DeepSeek authorization destination invalid");
  }
  return url.href;
}

async function request(method: "auth_init" | "auth_exchange" | "auth_cancel", body: object, signal: AbortSignal) {
  try {
    return await dshResponse(await fetch(`${DSH_PLATFORM_ORIGIN}/auth-api/v0/dsh/${method}`, {
      method: "POST", redirect: "error",
      headers: { ...dshClientHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    }));
  } catch (error) {
    if (signal.aborted) throw new DshAuthError("DeepSeek sign-in cancelled or expired");
    const detail = error instanceof DshAuthError ? `: ${error.message}` : "";
    throw new DshAuthError(`DeepSeek ${method} failed${detail}`);
  }
}

/** Non-secret device identity belongs to OpenCodex, never to Harness's credential file. */
function deviceId(): string {
  return withConfigMutationLockSync(() => {
    const path = join(getConfigDir(), "dsh-device-id");
    let value: string;
    try { value = readFileSync(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new DshAuthError("DeepSeek device identity storage failed");
      value = crypto.randomUUID();
      atomicWriteFile(path, value);
    }
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw new DshAuthError("DeepSeek device identity invalid");
    return parsed.data;
  });
}

/** Own the callback through exchange: a received code is not yet a successful login. */
export async function loginDshBrowser(
  ctrl: OAuthController,
  validate: (token: string, signal: AbortSignal) => Promise<{ valid: boolean; accountId?: string; email?: string }>,
): Promise<OAuthCredentials> {
  if (!ctrl.onAuth) throw new DshAuthError("DeepSeek browser sign-in requires an authorization URL handler");
  const deadline = new AbortController();
  const signal = ctrl.signal ? AbortSignal.any([ctrl.signal, deadline.signal]) : deadline.signal;
  signal.throwIfAborted();
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  let phase: "initializing" | "waiting" | "exchanging" | "done" = "initializing";
  let authorizeId: string | undefined;
  let finishCallback: ((response: Response) => void) | undefined;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // Cancellation can occur before auth_init finishes, before the code promise is awaited.
  void codePromise.catch(() => {});
  const abort = () => rejectCode(new Error("DeepSeek sign-in cancelled or expired"));
  signal.addEventListener("abort", abort, { once: true });
  let expiresAt = Date.now() + 600_000;
  const assertActive = () => {
    if (Date.now() >= expiresAt) deadline.abort();
    signal.throwIfAborted();
  };
  let timer = setTimeout(() => deadline.abort(), 600_000);
  const response = (text: string, status: number) => new Response(text, {
    status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "connection": "close" },
  });
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, fetch(req) {
      const url = new URL(req.url);
      const returnedState = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code");
      if (req.method !== "GET" || url.pathname !== "/oauth/callback" ||
          url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("code").length !== 1 || !code ||
          Buffer.byteLength(returnedState) !== Buffer.byteLength(state) ||
          !timingSafeEqual(Buffer.from(returnedState), Buffer.from(state))) return response("Invalid authorization callback", 400);
      if (signal.aborted || phase !== "waiting") return response("Authorization attempt no longer available", 410);
      phase = "exchanging";
      const result = new Promise<Response>(resolve => { finishCallback = resolve; });
      resolveCode(code);
      return result;
    } });
    const redirectUri = `http://127.0.0.1:${server.port}/oauth/callback`;
    const init = initSchema.safeParse(await request("auth_init", {
      code_challenge: challenge, code_challenge_method: "S256", state, redirect_uri: redirectUri,
      locale: "en_US", login_source: "desktop",
    }, signal));
    if (!init.success) throw new DshAuthError("DeepSeek authorization response invalid");
    authorizeId = init.data.authorize_id;
    const url = browserUrl(init.data.authorize_url, "/dsh/authorize");
    clearTimeout(timer);
    expiresAt = Math.min(expiresAt, Date.now() + init.data.expires_in * 1000);
    assertActive();
    timer = setTimeout(() => deadline.abort(), expiresAt - Date.now());
    phase = "waiting";
    ctrl.onAuth({ url, instructions: "Sign in to DeepSeek and authorize this OpenCodex session." });
    const code = await codePromise;
    assertActive();
    const exchanged = exchangeSchema.safeParse(await request("auth_exchange", {
      code, code_verifier: verifier, redirect_uri: redirectUri, device_id: deviceId(),
      device_model: `${platform()}-${arch()}`, os_version: `${platform()} ${release()}`,
    }, signal));
    if (!exchanged.success) throw new DshAuthError("DeepSeek token exchange response invalid");
    browserUrl(exchanged.data.authorized_url, "/dsh/authorized");
    const exchangedIdentity = dshIdentity(exchanged.data.user);
    const checked = exchangedIdentity ? undefined : await validate(exchanged.data.token, signal);
    const identity = exchangedIdentity ?? (checked?.valid ? checked : undefined);
    if (!identity?.accountId) throw new DshAuthError("DeepSeek account identity unverified");
    assertActive();
    phase = "done";
    finishCallback?.(response("DeepSeek authorization complete. Return to OpenCodex to check that the account was saved.", 200));
    return { access: exchanged.data.token, refresh: exchanged.data.token, expires: Number.MAX_SAFE_INTEGER,
      accountId: identity.accountId, email: identity.email, source: "oauth" };
  } catch (error) {
    finishCallback?.(response("DeepSeek sign-in failed. Return to OpenCodex and try again.", 400));
    const detail = error instanceof DshAuthError ? `: ${error.message}` : "";
    throw new DshAuthError(signal.aborted ? "DeepSeek sign-in cancelled or expired" : `DeepSeek browser sign-in failed${detail}`);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    server?.stop();
    if (phase !== "done" && authorizeId) {
      await request("auth_cancel", { authorize_id: authorizeId, code_verifier: verifier }, AbortSignal.timeout(5_000)).catch(() => {});
    }
  }
}
