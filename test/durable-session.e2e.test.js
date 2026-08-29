import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { createServer as createProbeServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { LATEST_SCHEMA_VERSION } from '../src/index.js';

const CLI_PATH = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const REPOSITORY_ROOT = dirname(dirname(CLI_PATH));
const PASSWORD = 'correct horse battery staple';
const PASSWORD_RECORD = 'scrypt$v=1$n=131072,r=8,p=1$ABEiM0RVZneImaq7zN3u_w$ODwJaN-PM0aUzMtLvhFdDx1N8hFXxjq516BA_8qqt8ZvPCFPrAO-5S8bx0vVTiFV-6f3T9LPL5YPBEUJ6yTR2Q';
const LOCAL_TOKEN = 'durable-e2e-local-token-0000000000001';
const USERNAME = 'durable-e2e-user';
const PRINCIPAL_ID = 'durable_e2e_principal_0001';
const CLIENT_ADDRESS = '203.0.113.40';
const THREAD_ID = 'durable-thread-e2e-0001';

async function reserveLoopbackPort() {
  const probe = createProbeServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  await new Promise((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

function fixture(root, servicePort, localLlmPort) {
  const credentialsDirectory = join(root, 'credentials');
  const runtimeDirectory = join(root, 'run');
  const configPath = join(root, 'service.json');
  const cloudIndexDatabase = join(root, 'state', 'cloud', 'index.sqlite');
  const directChatDatabase = join(root, 'state', 'chat', 'chat.sqlite');
  mkdirSync(credentialsDirectory, { mode: 0o700 });
  mkdirSync(runtimeDirectory, { mode: 0o700 });
  writeFileSync(join(credentialsDirectory, 'login-password-hash'), PASSWORD_RECORD, { mode: 0o400 });
  writeFileSync(join(credentialsDirectory, 'localllm-token'), LOCAL_TOKEN, { mode: 0o400 });
  const publicOrigin = `https://127.0.0.1:${servicePort}`;
  const config = {
    schema: 'lazying-agent-service/v1',
    listen: { host: '127.0.0.1', port: servicePort },
    publicOrigin,
    account: {
      username: USERNAME,
      principalId: PRINCIPAL_ID,
      displayName: 'Durable E2E User'
    },
    state: { cloudIndexDatabase, directChatDatabase },
    pwa: {
      versionLabel: 'durable-e2e',
      title: 'Durable E2E',
      name: 'Durable E2E',
      shortName: 'Durable E2E'
    },
    localLlm: {
      baseUrl: `http://127.0.0.1:${localLlmPort}/v1`,
      allowedModelAliases: ['localllm-test'],
      defaultModelAlias: 'localllm-test'
    },
    aginti: { enabled: false },
    credentials: {
      passwordHash: 'login-password-hash',
      localLlmToken: 'localllm-token'
    }
  };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  chmodSync(configPath, 0o600);
  return {
    configPath,
    credentialsDirectory,
    runtimeDirectory,
    cloudIndexDatabase,
    directChatDatabase,
    publicOrigin,
    baseUrl: `http://127.0.0.1:${servicePort}`,
    servicePort
  };
}

function startCli(state) {
  const child = spawn(process.execPath, [CLI_PATH, 'serve', '--config', state.configPath], {
    cwd: REPOSITORY_ROOT,
    env: {
      CREDENTIALS_DIRECTORY: state.credentialsDirectory,
      RUNTIME_DIRECTORY: state.runtimeDirectory,
      LANG: 'C',
      LC_ALL: 'C'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.length > 64 * 1024) child.kill('SIGKILL');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > 64 * 1024) child.kill('SIGKILL');
  });
  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('CLI did not report its listening identity in time'));
    }, 5_000);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (code, signal) => finish(() => {
      reject(new Error(`CLI exited before listening (code=${code}, signal=${signal}, stderr=${stderr})`));
    }));
    child.stdout.on('data', () => {
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      finish(() => {
        try {
          resolve(JSON.parse(stdout.slice(0, newline)));
        } catch (error) {
          reject(error);
        }
      });
    });
  });
  return {
    child,
    ready,
    output() { return { stdout, stderr }; }
  };
}

async function stopCli(instance) {
  const { child } = instance;
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CLI did not stop gracefully in time')), 5_000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.equal(child.kill('SIGTERM'), true);
  return exited;
}

function publicHeaders(state, extra = {}) {
  return {
    'x-lazying-public-authority': new URL(state.publicOrigin).host,
    'x-lazying-client-address': CLIENT_ADDRESS,
    origin: state.publicOrigin,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'content-type': 'application/json',
    ...extra
  };
}

async function post(state, pathname, body, { cookie, csrf, idempotency } = {}) {
  return fetch(`${state.baseUrl}${pathname}`, {
    method: 'POST',
    redirect: 'error',
    headers: publicHeaders(state, {
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...(idempotency ? { 'idempotency-key': idempotency } : {})
    }),
    body: JSON.stringify(body)
  });
}

function responseCookies(response) {
  const values = response.headers.getSetCookie?.() ?? [];
  return values.length > 0 ? values : [response.headers.get('set-cookie')].filter(Boolean);
}

function cookiePair(value) {
  return value.split(';', 1)[0];
}

function rawCookieValue(cookie, name) {
  const pair = cookie.split('; ').find((value) => value.startsWith(`${name}=`));
  assert.ok(pair, `missing ${name} cookie`);
  return pair.slice(name.length + 1);
}

function assertPrivateRegularFile(pathname) {
  const stat = lstatSync(pathname);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.nlink, 1);
  assert.equal(stat.mode & 0o077, 0);
  assert.equal(realpathSync(pathname), pathname);
}

function verifyDatabase(pathname, expectedVersion, checks) {
  assertPrivateRegularFile(pathname);
  const database = new DatabaseSync(pathname, { readOnly: true });
  try {
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(Number(database.prepare('PRAGMA user_version').get().user_version), expectedVersion);
    checks(database);
  } finally {
    database.close();
  }
}

test('real CLI preserves one authenticated browser session and Direct Chat thread across graceful process restart', {
  timeout: 20_000
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'lazying-durable-session-e2e-'));
  const children = new Set();
  t.after(async () => {
    for (const instance of children) {
      if (instance.child.exitCode === null && instance.child.signalCode === null) {
        instance.child.kill('SIGKILL');
        await new Promise((resolve) => instance.child.once('exit', resolve));
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  const servicePort = await reserveLoopbackPort();
  const localLlmPort = await reserveLoopbackPort();
  assert.notEqual(servicePort, localLlmPort);
  const state = fixture(root, servicePort, localLlmPort);

  const first = startCli(state);
  children.add(first);
  const firstReady = await first.ready;
  assert.deepEqual({
    ok: firstReady.ok,
    command: firstReady.command,
    status: firstReady.status,
    address: firstReady.address,
    port: firstReady.port,
    publicOrigin: firstReady.publicOrigin,
    agentEnabled: firstReady.agentEnabled
  }, {
    ok: true,
    command: 'serve',
    status: 'listening',
    address: '127.0.0.1',
    port: servicePort,
    publicOrigin: state.publicOrigin,
    agentEnabled: false
  });
  assert.match(firstReady.releaseId, /^durable-e2e-[a-f0-9]{64}$/u);

  const login = await post(state, '/api/login', {
    username: USERNAME,
    password: PASSWORD,
    remember: true
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(loginBody.authenticated, true);
  assert.equal(loginBody.username, USERNAME);
  assert.match(loginBody.csrfToken, /^[A-Za-z0-9_-]{43}$/u);
  const setCookies = responseCookies(login);
  assert.equal(setCookies.length, 2);
  const cookie = setCookies.map(cookiePair).join('; ');
  const sessionToken = rawCookieValue(cookie, '__Host-lazying_session');
  const csrfCookie = rawCookieValue(cookie, '__Host-lazying_csrf');
  assert.equal(csrfCookie, loginBody.csrfToken);

  const created = await post(state, '/api/chat/threads/create', {
    threadId: THREAD_ID,
    title: 'Survives a native restart'
  }, {
    cookie,
    csrf: loginBody.csrfToken,
    idempotency: 'durable-thread-create-0001'
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.thread.threadId, THREAD_ID);
  assert.equal(createdBody.thread.title, 'Survives a native restart');
  assert.equal(Object.hasOwn(createdBody.thread, 'accountId'), false);

  assert.deepEqual(await stopCli(first), { code: 0, signal: null });
  children.delete(first);
  const firstOutput = first.output();
  for (const secret of [PASSWORD, PASSWORD_RECORD, LOCAL_TOKEN, sessionToken, loginBody.csrfToken]) {
    assert.equal(firstOutput.stdout.includes(secret), false);
    assert.equal(firstOutput.stderr.includes(secret), false);
  }

  const second = startCli(state);
  children.add(second);
  const secondReady = await second.ready;
  assert.equal(secondReady.releaseId, firstReady.releaseId);
  assert.equal(secondReady.port, servicePort);

  const restored = await post(state, '/api/session', {}, {
    cookie,
    csrf: loginBody.csrfToken
  });
  assert.equal(restored.status, 200);
  assert.deepEqual(await restored.json(), loginBody);

  const listed = await post(state, '/api/chat/threads/list', {}, {
    cookie,
    csrf: loginBody.csrfToken
  });
  assert.equal(listed.status, 200);
  const listedBody = await listed.json();
  assert.deepEqual(listedBody.threads.map((thread) => thread.threadId), [THREAD_ID]);
  assert.equal(listedBody.threads[0].title, 'Survives a native restart');
  assert.equal(Object.hasOwn(listedBody.threads[0], 'accountId'), false);

  assert.deepEqual(await stopCli(second), { code: 0, signal: null });
  children.delete(second);
  const secondOutput = second.output();
  for (const secret of [PASSWORD, PASSWORD_RECORD, LOCAL_TOKEN, sessionToken, loginBody.csrfToken]) {
    assert.equal(secondOutput.stdout.includes(secret), false);
    assert.equal(secondOutput.stderr.includes(secret), false);
  }

  verifyDatabase(state.cloudIndexDatabase, LATEST_SCHEMA_VERSION, (database) => {
    assert.equal(Number(database.prepare('SELECT count(*) AS count FROM browser_sessions').get().count), 1);
    const row = database.prepare('SELECT session_digest, csrf_digest, revoked_at FROM browser_sessions').get();
    assert.match(row.session_digest, /^[a-f0-9]{64}$/u);
    assert.match(row.csrf_digest, /^[a-f0-9]{64}$/u);
    assert.equal(row.revoked_at, null);
  });
  verifyDatabase(state.directChatDatabase, 5, (database) => {
    const row = database.prepare(`
      SELECT thread_id, title, ledger_revision, message_count, generation_count
      FROM direct_chat_threads
    `).get();
    assert.equal(row.thread_id, THREAD_ID);
    assert.equal(row.title, 'Survives a native restart');
    assert.equal(Number(row.ledger_revision), 0);
    assert.equal(Number(row.message_count), 0);
    assert.equal(Number(row.generation_count), 0);
  });

  for (const pathname of [state.cloudIndexDatabase, state.directChatDatabase]) {
    const bytes = readFileSync(pathname);
    for (const secret of [PASSWORD, PASSWORD_RECORD, LOCAL_TOKEN, sessionToken, loginBody.csrfToken]) {
      assert.equal(bytes.includes(Buffer.from(secret, 'utf8')), false);
    }
    assert.equal(existsSync(`${pathname}-wal`), false);
    assert.equal(existsSync(`${pathname}-shm`), false);
  }
});
