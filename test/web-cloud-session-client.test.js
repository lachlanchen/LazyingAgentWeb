import assert from "node:assert/strict";
import test from "node:test";

import {
  CLOUD_CSRF_COOKIE_NAME,
  CloudBrowserProtocolError,
  CloudBrowserTransportError,
  CloudSessionClient,
  readCloudCsrfCookie,
} from "../src/web/cloud-session-client.js";

const CSRF = "csrf_token_abcdefghijklmnopqrstuvwxyz0123456789";

function jsonResponse(value, { status = 200, contentType = "application/json; charset=utf-8", cacheControl = "no-store" } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": contentType, "cache-control": cacheControl },
  });
}

test("reads only one exact non-HttpOnly CSRF cookie and fails closed on ambiguity", () => {
  assert.equal(readCloudCsrfCookie(`theme=bright; ${CLOUD_CSRF_COOKIE_NAME}=${CSRF}; unrelated=x=y`), CSRF);
  assert.equal(readCloudCsrfCookie("theme=bright"), undefined);
  assert.throws(
    () => readCloudCsrfCookie(`${CLOUD_CSRF_COOKIE_NAME}=${CSRF}; ${CLOUD_CSRF_COOKIE_NAME}=${CSRF}`),
    /duplicated/u,
  );
  assert.throws(() => readCloudCsrfCookie(`${CLOUD_CSRF_COOKIE_NAME}=short`), /invalid/u);
  assert.throws(() => readCloudCsrfCookie(`x=${"a".repeat(4_097)}`), /cookies are invalid/u);
  assert.throws(() => readCloudCsrfCookie(`${CLOUD_CSRF_COOKIE_NAME}=${CSRF}\nattack=x`), /cookies are invalid/u);
});

test("login, restore, and logout use exact same-origin POST envelopes and browser credentials", async () => {
  let cookies = "theme=bright";
  const calls = [];
  const client = new CloudSessionClient({
    baseUrl: "https://llm.lazying.art/app/?ignored=base",
    cookieSource: () => cookies,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/api/login")) {
        cookies = `${CLOUD_CSRF_COOKIE_NAME}=${CSRF}; theme=bright`;
        return jsonResponse({ authenticated: true, username: "lachlanchen", csrfToken: CSRF });
      }
      if (url.endsWith("/api/session")) {
        return jsonResponse({ authenticated: true, username: "lachlanchen", csrfToken: CSRF });
      }
      cookies = "theme=bright";
      return jsonResponse({ signedOut: true, agentCancellationPending: true });
    },
  });

  assert.deepEqual(await client.login({ username: "lachlanchen", password: "secret", remember: true }), {
    authenticated: true,
    username: "lachlanchen",
    csrfToken: CSRF,
  });
  assert.deepEqual(await client.restore(), {
    authenticated: true,
    username: "lachlanchen",
    csrfToken: CSRF,
  });
  assert.deepEqual(await client.logout(), { signedOut: true, agentCancellationPending: true });

  assert.deepEqual(calls.map((call) => call.url), [
    "https://llm.lazying.art/api/login",
    "https://llm.lazying.art/api/session",
    "https://llm.lazying.art/api/logout",
  ]);
  for (const { options } of calls) {
    assert.equal(options.method, "POST");
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    assert.equal(options.referrerPolicy, "same-origin");
    assert.equal(options.headers.get("authorization"), null);
    assert.equal(options.headers.get("x-api-key"), null);
    assert.equal(options.headers.get("idempotency-key"), null);
  }
  assert.equal(calls[0].options.headers.get("x-csrf-token"), null);
  assert.equal(calls[1].options.headers.get("x-csrf-token"), CSRF);
  assert.equal(calls[2].options.headers.get("x-csrf-token"), CSRF);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    username: "lachlanchen",
    password: "secret",
    remember: true,
  });
  assert.deepEqual(JSON.parse(calls[1].options.body), {});
  assert.deepEqual(JSON.parse(calls[2].options.body), {});
});

test("signed-out restore works without a readable CSRF cookie but authenticated restore cannot", async () => {
  let value = { authenticated: false };
  const client = new CloudSessionClient({
    baseUrl: "https://llm.lazying.art/",
    cookieSource: "",
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.get("x-csrf-token"), null);
      return jsonResponse(value);
    },
  });
  assert.deepEqual(await client.restore(), { authenticated: false });
  value = { authenticated: true, username: "lachlanchen", csrfToken: CSRF };
  await assert.rejects(() => client.restore(), /not bound to the browser CSRF cookie/u);
});

test("session response validation rejects principal leakage, unknown fields, cookie mismatch, and wrong success status", async () => {
  let response = jsonResponse({ authenticated: true, username: "lachlanchen", csrfToken: CSRF, principalId: "private" });
  const client = new CloudSessionClient({
    baseUrl: "https://llm.lazying.art/",
    cookieSource: `${CLOUD_CSRF_COOKIE_NAME}=${CSRF}`,
    fetchImpl: async () => response,
  });
  await assert.rejects(() => client.restore(), CloudBrowserProtocolError);

  response = jsonResponse({ authenticated: true, username: "lachlanchen", csrfToken: "x".repeat(43) });
  await assert.rejects(() => client.restore(), /not bound/u);

  response = jsonResponse({ authenticated: true, username: "lachlanchen", csrfToken: CSRF }, { status: 201 });
  await assert.rejects(
    () => client.restore(),
    (error) => error instanceof CloudBrowserTransportError
      && error.status === 201
      && error.message === "Session restore request was not accepted.",
  );

  response = jsonResponse({ authenticated: true, username: "lachlanchen", csrfToken: CSRF }, { contentType: "text/html" });
  await assert.rejects(() => client.restore(), /content type/u);

  response = jsonResponse({ authenticated: true, username: "lachlanchen", csrfToken: CSRF }, { cacheControl: "private" });
  await assert.rejects(() => client.restore(), /no-store/u);
});

test("login input and logout response stay closed and expose stable status wording", async () => {
  let cookies = "";
  let response = jsonResponse({
    error: { code: "invalid_credentials", message: "The username or password was not accepted." },
  }, { status: 401 });
  const client = new CloudSessionClient({
    baseUrl: "https://llm.lazying.art/",
    cookieSource: () => cookies,
    fetchImpl: async () => response,
  });
  await assert.rejects(
    () => client.login({ username: "lachlanchen", password: "wrong", remember: true }),
    (error) => error instanceof CloudBrowserTransportError
      && error.code === "invalid_credentials"
      && error.status === 401
      && error.retryable === false
      && error.message === "Sign-in request was not accepted.",
  );
  await assert.rejects(
    () => client.login({ username: "lachlanchen", password: "secret", remember: true, account: "private" }),
    /unsupported field/u,
  );
  await assert.rejects(() => client.logout(), (error) => error.code === "authentication_required" && error.status === 401);

  cookies = `${CLOUD_CSRF_COOKIE_NAME}=${CSRF}`;
  response = jsonResponse({ signedOut: true, agentCancellationPending: false, sessionToken: "private" });
  await assert.rejects(() => client.logout(), /unsupported field/u);
});

test("session transport rejects malformed response objects, route changes, and dishonest size headers", async () => {
  let response = { status: 200, headers: {} };
  const client = new CloudSessionClient({
    baseUrl: "https://llm.lazying.art/",
    cookieSource: "",
    fetchImpl: async () => response,
  });
  await assert.rejects(() => client.restore(), /invalid response/u);

  response = jsonResponse({ authenticated: false });
  Object.defineProperty(response, "url", { value: "https://evil.test/api/session" });
  await assert.rejects(() => client.restore(), /unexpected URL/u);

  response = new Response("{", {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "content-length": String(33 * 1024),
    },
  });
  await assert.rejects(() => client.restore(), /size limit/u);
  await assert.rejects(() => client.restore({ provider: "browser-choice" }), /unsupported field/u);
});
