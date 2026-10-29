import { afterEach, expect, test } from "bun:test";
import { loginDshAccount } from "../../src/oauth/dsh";
import { dshResponse, loginDshBrowser } from "../../src/oauth/dsh-browser";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
const previousDsh = process.env.DSH_HOME;
let homes: string[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (previousDsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousDsh;
  for (const home of homes) removeTreeWithRetry(home);
  homes = [];
});
function home() {
  const dir = mkdtempSync(join(tmpdir(), "ocx-dsh-browser-")); homes.push(dir);
  process.env.OPENCODEX_HOME = dir; process.env.DSH_HOME = join(dir, "absent");
}
const envelope = (data: unknown) => Response.json({code:0,data:{biz_code:0,biz_data:data}});

test("browser exchange establishes identity without requiring the blocked profile endpoint", async () => {
  home();
  let callback = "";
  let state = "";
  let challenge = "";
  let calls = 0;
  let callbackResponse: Promise<Response> | undefined;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:")) return originalFetch(input, init);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).has("x-dsh-auth-token")).toBe(false);
    const body = JSON.parse(String(init?.body));
    calls++;
    if (url.endsWith("auth_init")) {
      callback = body.redirect_uri; state = body.state; challenge = body.code_challenge;
      expect(body.code_challenge_method).toBe("S256");
      expect(body.login_source).toBe("desktop");
      return envelope({authorize_id:"attempt",expires_in:600,authorize_url:"https://platform.deepseek.com/dsh/authorize?test=1"});
    }
    expect(url).toEndWith("/auth_exchange");
    expect(body.redirect_uri).toBe(callback);
    expect(body.code).toBe("test-code");
    expect(body.device_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Buffer.from(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(body.code_verifier))).toString("base64url")).toBe(challenge);
    return envelope({token:"fixture-grant",authorized_url:"https://platform.deepseek.com/dsh/authorized",user:{id:"stable-account",email:"test@example.com"}});
  };
  const credential = await loginDshAccount({onAuth() {
    callbackResponse = (async () => {
      // Invalid callbacks do not consume the pending attempt.
      expect((await originalFetch(`${callback}?state=wrong&code=x`)).status).toBe(400);
      expect((await originalFetch(`${callback}?state=${state}&state=${state}&code=x`)).status).toBe(400);
      expect((await originalFetch(`${callback}?state=${state}&code=x`,{method:"POST"})).status).toBe(400);
      return originalFetch(`${callback}?state=${state}&code=test-code`);
    })();
  }});
  expect(credential).toMatchObject({access:"fixture-grant",accountId:"stable-account",source:"oauth"});
  expect(calls).toBe(2);
  expect((await callbackResponse)?.status).toBe(200);
});

test("cancelled browser attempt sends auth_cancel and never exchanges", async () => {
  home(); const controller = new AbortController(); const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input); calls.push(url);
    return url.endsWith("auth_init") ? envelope({authorize_id:"attempt",expires_in:600,authorize_url:"https://platform.deepseek.com/dsh/authorize"}) : envelope({});
  };
  await expect(loginDshAccount({signal:controller.signal,onAuth(){controller.abort();}}, {forceLogin:true})).rejects.toThrow("cancelled");
  expect(calls.map(url => url.split("/").at(-1))).toEqual(["auth_init","auth_cancel"]);
});

test("unexpected authorization destination is never opened and gets cancelled", async () => {
  home(); let opened = false; let cancelled = false;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("auth_cancel")) {cancelled=true;return envelope({});}
    return envelope({authorize_id:"attempt",expires_in:600,authorize_url:"https://other.example/dsh/authorize"});
  };
  await expect(loginDshAccount({onAuth(){opened=true;}},{forceLogin:true})).rejects.toThrow("sign-in failed");
  expect(opened).toBe(false); expect(cancelled).toBe(true);
});

test("exchange without authoritative identity fails closed and callback reports failure", async () => {
  home(); let callback = ""; let state = ""; let result: Promise<Response> | undefined;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("auth_init")) {
      const body=JSON.parse(String(init?.body)); callback=body.redirect_uri; state=body.state;
      return envelope({authorize_id:"attempt",expires_in:600,authorize_url:"https://platform.deepseek.com/dsh/authorize"});
    }
    return envelope({token:"fixture-grant",authorized_url:"https://platform.deepseek.com/dsh/authorized",user:{email:"same@example.com"}});
  };
  await expect(loginDshBrowser({onAuth(){result=originalFetch(`${callback}?state=${state}&code=test`);}},async()=>({valid:false}))).rejects.toThrow("sign-in failed");
  expect((await result)?.status).toBe(400);
});

test("bounded platform decoder rejects oversized and failed business responses", async () => {
  await expect(dshResponse(new Response("x".repeat(65_537)))).rejects.toThrow("response too large");
  await expect(dshResponse(Response.json({code:0,data:{biz_code:2,biz_data:{id:"untrusted"}}}))).rejects.toThrow("response invalid");
});

test("expired attempt cancels without publishing credentials", async () => {
  home(); let cancelled = false;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("auth_cancel")) {cancelled=true;return envelope({});}
    return envelope({authorize_id:"attempt",expires_in:0.01,authorize_url:"https://platform.deepseek.com/dsh/authorize"});
  };
  await expect(loginDshAccount({onAuth(){}},{forceLogin:true})).rejects.toThrow("expired");
  expect(cancelled).toBe(true);
});

test("duplicate callback cannot exchange twice; unsafe completion URL fails closed", async () => {
  home(); let callback = ""; let state = ""; let exchanges = 0;
  let first: Promise<Response> | undefined; let second: Promise<Response> | undefined;
  let releaseExchange!: () => void;
  const exchangeReady = new Promise<void>(resolve => { releaseExchange = resolve; });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("auth_init")) {
      const body=JSON.parse(String(init?.body)); callback=body.redirect_uri; state=body.state;
      return envelope({authorize_id:"attempt",expires_in:600,authorize_url:"https://platform.deepseek.com/dsh/authorize"});
    }
    if (url.endsWith("auth_exchange")) {
      exchanges++;
      second=originalFetch(`${callback}?state=${state}&code=duplicate`);
      releaseExchange();
      await second;
      return envelope({token:"fixture-grant",authorized_url:"https://other.example/dsh/authorized",user:{id:"stable-account"}});
    }
    return envelope({});
  };
  const login = loginDshAccount({onAuth(){first=originalFetch(`${callback}?state=${state}&code=first`);}},{forceLogin:true});
  await exchangeReady;
  await expect(login).rejects.toThrow("sign-in failed");
  expect(exchanges).toBe(1);
  expect((await first)?.status).toBe(400);
  expect((await second)?.status).toBe(410);
});


test("a blocked imported profile starts browser authorization without modifying Harness credentials", async () => {
  home();
  const dir = process.env.DSH_HOME!;
  mkdirSync(dir);
  const path = join(dir, ".credentials.yaml");
  const original = "records:\n  deepseek-account-platform/default:\n    kind: grant\n    payload:\n      token: fixture-imported-grant\n";
  writeFileSync(path, original);
  const controller = new AbortController();
  const methods: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input); methods.push(url.split("/").at(-1)!);
    if (url.endsWith("current")) return new Response("Blocked", {status:403});
    expect(new Headers(init?.headers).has("x-dsh-auth-token")).toBe(false);
    return url.endsWith("auth_init") ? envelope({authorize_id:"attempt",expires_in:600,authorize_url:"https://platform.deepseek.com/dsh/authorize"}) : envelope({});
  };
  await expect(loginDshAccount({signal:controller.signal,onAuth(){controller.abort();}})).rejects.toThrow("cancelled");
  expect(methods).toEqual(["current","auth_init","auth_cancel"]);
  expect(readFileSync(path,"utf8")).toBe(original);
});

test("safe HTTP diagnostics survive while arbitrary transport details stay private", async () => {
  home();
  globalThis.fetch = async () => new Response("private provider body", {status:403});
  await expect(loginDshAccount({onAuth(){}}, {forceLogin:true})).rejects.toThrow("auth_init failed: DeepSeek platform HTTP 403");
  globalThis.fetch = async () => { throw new Error("private transport detail"); };
  await expect(loginDshAccount({onAuth(){}}, {forceLogin:true})).rejects.toThrow(/^DeepSeek browser sign-in failed: DeepSeek auth_init failed$/);
});

test("cancellation during exchange closes the callback and cancels the attempt", async () => {
  home();
  const controller = new AbortController();
  let callback = ""; let state = ""; let cancelled = false;
  let result: Promise<Response> | undefined;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("auth_init")) {
      const body = JSON.parse(String(init?.body)); callback = body.redirect_uri; state = body.state;
      return envelope({authorize_id:"attempt",expires_in:600,authorize_url:"https://platform.deepseek.com/dsh/authorize"});
    }
    if (url.endsWith("auth_cancel")) { cancelled = true; return envelope({}); }
    controller.abort();
    // Even a transport that resolves after cancellation cannot publish its result.
    return envelope({token:"fixture-grant",authorized_url:"https://platform.deepseek.com/dsh/authorized",user:{id:"stable-account"}});
  };
  await expect(loginDshAccount({signal:controller.signal,onAuth(){result=originalFetch(`${callback}?state=${state}&code=test`);}},{forceLogin:true})).rejects.toThrow("cancelled");
  expect((await result)?.status).toBe(400);
  expect(cancelled).toBe(true);
  await expect(originalFetch(callback)).rejects.toThrow();
});

test("exchange cannot publish after its deadline before the timer has run", async () => {
  home();
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  let callback = ""; let state = "";
  let result: Promise<Response> | undefined;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("auth_init")) {
      const body = JSON.parse(String(init?.body)); callback = body.redirect_uri; state = body.state;
      return envelope({authorize_id:"attempt",expires_in:600,authorize_url:"https://platform.deepseek.com/dsh/authorize"});
    }
    now += 600_001;
    return envelope({token:"fixture-grant",authorized_url:"https://platform.deepseek.com/dsh/authorized",user:{id:"stable-account"}});
  };
  try {
    await expect(loginDshAccount({onAuth(){result=originalFetch(`${callback}?state=${state}&code=test`);}},{forceLogin:true})).rejects.toThrow("expired");
    expect((await result)?.status).toBe(400);
  } finally { Date.now = realNow; }
});

test("shared login publishes browser credentials and rejects reauth to another account", async () => {
  home();
  const { runLogin } = await import("../../src/oauth/index");
  const { getAccountSet } = await import("../../src/oauth/store");
  let callback = ""; let state = ""; let identity = "account-a";
  let result: Promise<Response> | undefined;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("auth_init")) {
      const body = JSON.parse(String(init?.body)); callback = body.redirect_uri; state = body.state;
      return envelope({authorize_id:"attempt",expires_in:600,authorize_url:"https://platform.deepseek.com/dsh/authorize"});
    }
    expect(String(input)).toEndWith("auth_exchange");
    return envelope({token:`fixture-${identity}`,authorized_url:"https://platform.deepseek.com/dsh/authorized",user:{id:identity,email:"same@example.com"}});
  };
  const ctrl = {onAuth(){result=originalFetch(`${callback}?state=${state}&code=test`);}};
  await runLogin("dsh-account", ctrl, {forceLogin:true});
  expect((await result)?.status).toBe(200);
  const saved = getAccountSet("dsh-account")!.accounts[0]!;
  expect(saved.credential).toMatchObject({accountId:"account-a",access:"fixture-account-a",source:"oauth"});
  const originalStore = readFileSync(join(process.env.OPENCODEX_HOME!, "auth.json"), "utf8");
  identity = "account-b";
  await expect(runLogin("dsh-account", ctrl, {forceLogin:true,reauthAccountId:saved.id})).rejects.toThrow("Signed-in account does not match");
  expect((await result)?.status).toBe(200); // Authorization succeeded; publication is owned by runLogin.
  expect(readFileSync(join(process.env.OPENCODEX_HOME!, "auth.json"), "utf8")).toBe(originalStore);
  expect(getAccountSet("dsh-account")!.accounts).toHaveLength(1);
});
