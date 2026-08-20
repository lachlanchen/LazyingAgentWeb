import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

const SERVICE_SCHEMA = 'lazying-agent-service/v1';
const CREDENTIAL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MODEL_ALIAS_PATTERN = /^localllm-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const VERSION_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,23}$/u;
const loadedConfigBrand = new WeakSet();
const utf8 = new TextDecoder('utf-8', { fatal: true });

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function assertOwnerOnly(stat, label) {
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) throw new TypeError(`${label} must be owned by the service user`);
  if ((stat.mode & 0o077) !== 0) throw new TypeError(`${label} must be owner-only`);
}

function secureDirectory(pathname, label) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname) || resolve(pathname) !== pathname) {
    throw new TypeError(`${label} must be an absolute normalized path`);
  }
  const stat = lstatSync(pathname);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(pathname) !== pathname) {
    throw new TypeError(`${label} must be a real directory without symlink indirection`);
  }
  assertOwnerOnly(stat, label);
  return pathname;
}

function secureRegularFile(pathname, label, maximumBytes) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname) || resolve(pathname) !== pathname) {
    throw new TypeError(`${label} must be an absolute normalized path`);
  }
  const before = lstatSync(pathname);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.size < 1 || before.size > maximumBytes || realpathSync(pathname) !== pathname) {
    throw new TypeError(`${label} must be one bounded regular file without links`);
  }
  assertOwnerOnly(before, label);
  const descriptor = openSync(pathname, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.size > maximumBytes) {
      throw new TypeError(`${label} changed while it was being opened`);
    }
    assertOwnerOnly(opened, label);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
        || bytes.byteLength !== opened.size) {
      throw new TypeError(`${label} changed while it was being read`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function decodedText(bytes, label, { trailingNewline = false } = {}) {
  let value;
  try {
    value = utf8.decode(bytes);
  } catch (error) {
    throw new TypeError(`${label} must contain canonical UTF-8 text`, { cause: error });
  }
  if (trailingNewline && value.endsWith('\n')) value = value.slice(0, -1);
  if (!value || value.includes('\u0000')) throw new TypeError(`${label} is empty or contains NUL bytes`);
  return value;
}

function rejectDuplicateJsonKeys(source) {
  let index = 0;

  function whitespace() {
    while (index < source.length && /[\u0009\u000a\u000d\u0020]/u.test(source[index])) index += 1;
  }

  function stringToken() {
    if (source[index] !== '"') throw new SyntaxError('expected JSON string');
    const start = index;
    index += 1;
    while (index < source.length) {
      const character = source[index];
      if (character === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index));
      }
      if (character === '\\') {
        index += 2;
      } else {
        index += 1;
      }
    }
    throw new SyntaxError('unterminated JSON string');
  }

  function value(depth) {
    if (depth > 64) throw new SyntaxError('JSON nesting is too deep');
    whitespace();
    if (source[index] === '{') {
      index += 1;
      whitespace();
      const keys = new Set();
      if (source[index] === '}') {
        index += 1;
        return;
      }
      while (true) {
        whitespace();
        const key = stringToken();
        if (keys.has(key)) throw new SyntaxError(`duplicate JSON key ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        if (source[index] !== ':') throw new SyntaxError('expected JSON colon');
        index += 1;
        value(depth + 1);
        whitespace();
        if (source[index] === '}') {
          index += 1;
          return;
        }
        if (source[index] !== ',') throw new SyntaxError('expected JSON object separator');
        index += 1;
      }
    }
    if (source[index] === '[') {
      index += 1;
      whitespace();
      if (source[index] === ']') {
        index += 1;
        return;
      }
      while (true) {
        value(depth + 1);
        whitespace();
        if (source[index] === ']') {
          index += 1;
          return;
        }
        if (source[index] !== ',') throw new SyntaxError('expected JSON array separator');
        index += 1;
      }
    }
    if (source[index] === '"') {
      stringToken();
      return;
    }
    const start = index;
    while (index < source.length && !/[\u0009\u000a\u000d\u0020,\]}]/u.test(source[index])) index += 1;
    if (start === index) throw new SyntaxError('expected JSON value');
    JSON.parse(source.slice(start, index));
  }

  whitespace();
  value(0);
  whitespace();
  if (index !== source.length) throw new SyntaxError('unexpected trailing JSON data');
}

function plainObject(value, required, optional, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const allowed = new Set([...required, ...optional]);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !allowed.has(key) || !descriptor.enumerable
        || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label} contains an unsupported field or accessor`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(descriptors, key)) throw new TypeError(`${label}.${key} is required`);
  }
  return value;
}

function boundedText(value, name, { minimum = 1, maximum, pattern, controls = false } = {}) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum
      || (!controls && /[\u0000-\u001f\u007f]/u.test(value))
      || (pattern && !pattern.test(value))) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function identifier(value, name) {
  return boundedText(value, name, { maximum: 128, pattern: IDENTIFIER_PATTERN });
}

function absoluteDatabasePath(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value
      || value === '/' || value.includes('\u0000')) {
    throw new TypeError(`${name} must be an absolute normalized database file path`);
  }
  return value;
}

function publicOrigin(value) {
  if (typeof value !== 'string') throw new TypeError('publicOrigin is invalid');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
      || url.search || url.hash || url.origin !== value) {
    throw new TypeError('publicOrigin must be an exact HTTPS origin');
  }
  return value;
}

function localLlmBaseUrl(value) {
  if (typeof value !== 'string') throw new TypeError('localLlm.baseUrl is invalid');
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || !/^[1-9]\d{3,4}$/u.test(url.port) || Number(url.port) < 1_024
      || Number(url.port) > 65_535 || url.pathname !== '/v1'
      || url.username || url.password || url.search || url.hash
      || url.toString().replace(/\/$/u, '') !== value) {
    throw new TypeError('localLlm.baseUrl must be an exact private 127.0.0.1 HTTP /v1 endpoint');
  }
  return value;
}

function modelAliases(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length < 1 || value.length > 32) {
    throw new TypeError('localLlm.allowedModelAliases must be a bounded array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('localLlm.allowedModelAliases must be a dense data array');
    }
  }
  if (Reflect.ownKeys(descriptors).some((key) => key !== 'length'
      && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/u.test(key)
        || Number(key) >= value.length))) {
    throw new TypeError('localLlm.allowedModelAliases contains an unsupported property');
  }
  const seen = new Set();
  return Object.freeze(value.map((alias) => {
    boundedText(alias, 'localLlm model alias', { maximum: 64, pattern: MODEL_ALIAS_PATTERN });
    if (seen.has(alias)) throw new TypeError('localLlm model aliases must be unique');
    seen.add(alias);
    return alias;
  }));
}

function credentialName(value, name) {
  return boundedText(value, name, { maximum: 64, pattern: CREDENTIAL_NAME_PATTERN });
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateConfig(value) {
  const root = plainObject(
    value,
    ['schema', 'listen', 'publicOrigin', 'account', 'state', 'pwa', 'localLlm', 'credentials'],
    [],
    'service config'
  );
  if (root.schema !== SERVICE_SCHEMA) throw new TypeError('service config schema is unsupported');

  const listen = plainObject(root.listen, ['host', 'port'], [], 'listen');
  if (listen.host !== '127.0.0.1' || !Number.isSafeInteger(listen.port)
      || listen.port < 1_024 || listen.port > 65_535) {
    throw new TypeError('listen must be an exact unprivileged 127.0.0.1 endpoint');
  }

  const account = plainObject(
    root.account,
    ['username', 'principalId', 'displayName'],
    [],
    'account'
  );
  const username = boundedText(account.username, 'account.username', { maximum: 128 });
  if (/[<>]/u.test(username)) throw new TypeError('account.username is invalid');
  const principalId = identifier(account.principalId, 'account.principalId');
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(principalId)) {
    throw new TypeError('account.principalId must be an opaque 16-128 character principal');
  }

  const state = plainObject(
    root.state,
    ['cloudIndexDatabase', 'directChatDatabase'],
    [],
    'state'
  );
  const cloudIndexDatabase = absoluteDatabasePath(state.cloudIndexDatabase, 'state.cloudIndexDatabase');
  const directChatDatabase = absoluteDatabasePath(state.directChatDatabase, 'state.directChatDatabase');
  if (cloudIndexDatabase === directChatDatabase) {
    throw new TypeError('Cloud Index and Direct Chat require separate database paths');
  }

  const pwa = plainObject(
    root.pwa,
    ['versionLabel', 'title', 'name', 'shortName'],
    [],
    'pwa'
  );
  const localLlm = plainObject(
    root.localLlm,
    ['baseUrl', 'allowedModelAliases', 'defaultModelAlias'],
    [],
    'localLlm'
  );
  const aliases = modelAliases(localLlm.allowedModelAliases);
  const defaultModelAlias = boundedText(localLlm.defaultModelAlias, 'localLlm.defaultModelAlias', {
    maximum: 64,
    pattern: MODEL_ALIAS_PATTERN
  });
  if (!aliases.includes(defaultModelAlias)) {
    throw new TypeError('localLlm.defaultModelAlias must be in allowedModelAliases');
  }

  const credentials = plainObject(
    root.credentials,
    ['passwordHash', 'localLlmToken'],
    [],
    'credentials'
  );
  const passwordHash = credentialName(credentials.passwordHash, 'credentials.passwordHash');
  const localLlmToken = credentialName(credentials.localLlmToken, 'credentials.localLlmToken');
  if (passwordHash === localLlmToken) throw new TypeError('credential purposes must use separate files');

  return deepFreeze({
    schema: SERVICE_SCHEMA,
    listen: { host: '127.0.0.1', port: listen.port },
    publicOrigin: publicOrigin(root.publicOrigin),
    account: {
      username,
      principalId,
      displayName: boundedText(account.displayName, 'account.displayName', { maximum: 256 })
    },
    state: { cloudIndexDatabase, directChatDatabase },
    pwa: {
      versionLabel: boundedText(pwa.versionLabel, 'pwa.versionLabel', {
        maximum: 24,
        pattern: VERSION_LABEL_PATTERN
      }),
      title: boundedText(pwa.title, 'pwa.title', { maximum: 80 }),
      name: boundedText(pwa.name, 'pwa.name', { maximum: 80 }),
      shortName: boundedText(pwa.shortName, 'pwa.shortName', { maximum: 24 })
    },
    localLlm: {
      baseUrl: localLlmBaseUrl(localLlm.baseUrl),
      allowedModelAliases: aliases,
      defaultModelAlias
    },
    credentials: { passwordHash, localLlmToken }
  });
}

class LoadedServiceConfig {
  #credentialsDirectory;

  constructor(config, credentialsDirectory) {
    this.config = config;
    this.#credentialsDirectory = credentialsDirectory;
    loadedConfigBrand.add(this);
    Object.freeze(this);
  }

  readCredential(purpose) {
    if (purpose !== 'passwordHash' && purpose !== 'localLlmToken') {
      throw new TypeError('credential purpose is unsupported');
    }
    const name = this.config.credentials[purpose];
    const pathname = join(this.#credentialsDirectory, name);
    if (resolve(pathname) !== pathname) throw new TypeError('credential name escaped its directory');
    const maximum = purpose === 'passwordHash' ? 1_024 : 4_096;
    const bytes = secureRegularFile(pathname, `${purpose} credential`, maximum + 1);
    try {
      return decodedText(bytes, `${purpose} credential`, { trailingNewline: true });
    } finally {
      bytes.fill(0);
    }
  }

  createCredentialProvider(purpose) {
    if (purpose !== 'localLlmToken') {
      throw new TypeError('only the LocalLLM token supports a rotating credential provider');
    }
    const provider = async () => this.readCredential(purpose);
    return Object.freeze(provider);
  }
}

Object.freeze(LoadedServiceConfig.prototype);

export function loadServiceConfig({ configPath, credentialsDirectory } = {}) {
  if (credentialsDirectory === undefined || credentialsDirectory === null || credentialsDirectory === '') {
    throw new TypeError('credentialsDirectory is required (normally CREDENTIALS_DIRECTORY)');
  }
  const directory = secureDirectory(credentialsDirectory, 'credentialsDirectory');
  const bytes = secureRegularFile(configPath, 'service config', 64 * 1024);
  let parsed;
  try {
    const text = decodedText(bytes, 'service config');
    rejectDuplicateJsonKeys(text);
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new TypeError('service config is not valid JSON', { cause: error });
    throw error;
  } finally {
    bytes.fill(0);
  }
  return new LoadedServiceConfig(validateConfig(parsed), directory);
}

export function assertLoadedServiceConfig(value) {
  if (!(value instanceof LoadedServiceConfig) || !loadedConfigBrand.has(value)) {
    throw new TypeError('loadedConfig must come from loadServiceConfig()');
  }
  return value;
}

export const STANDALONE_SERVICE_CONFIG_SCHEMA = SERVICE_SCHEMA;
