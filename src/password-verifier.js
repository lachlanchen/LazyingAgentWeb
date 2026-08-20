import { scrypt, timingSafeEqual } from 'node:crypto';

const PREFIX = 'scrypt$v=1$n=131072,r=8,p=1$';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const SCRYPT_PARAMETERS = Object.freeze({
  N: 131_072,
  r: 8,
  p: 1,
  keyLength: 64,
  maxmem: 256 * 1024 * 1024
});
const COMPATIBLE_KEY_LENGTHS = Object.freeze([32, SCRYPT_PARAMETERS.keyLength]);

function canonicalBase64Url(value, name, { minimumBytes, maximumBytes }) {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value) || value.includes('=')) {
    throw new TypeError(`${name} must be canonical unpadded base64url`);
  }
  let decoded;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch (error) {
    throw new TypeError(`${name} is not valid base64url`, { cause: error });
  }
  if (decoded.toString('base64url') !== value
      || decoded.byteLength < minimumBytes || decoded.byteLength > maximumBytes) {
    decoded.fill(0);
    throw new TypeError(`${name} has an invalid canonical length`);
  }
  return decoded;
}

function parseRecord(record) {
  if (typeof record !== 'string' || record.length < PREFIX.length + 2
      || record.length > 1_024 || /[\s\u0000-\u001f\u007f]/u.test(record)
      || !record.startsWith(PREFIX)) {
    throw new TypeError('password credential is not the required fixed scrypt record');
  }
  const fields = record.slice(PREFIX.length).split('$');
  if (fields.length !== 2) throw new TypeError('password credential has an invalid field count');
  const salt = canonicalBase64Url(fields[0], 'scrypt salt', {
    minimumBytes: 16,
    maximumBytes: 64
  });
  let digest;
  try {
    digest = canonicalBase64Url(fields[1], 'scrypt digest', {
      minimumBytes: COMPATIBLE_KEY_LENGTHS[0],
      maximumBytes: SCRYPT_PARAMETERS.keyLength
    });
    if (!COMPATIBLE_KEY_LENGTHS.includes(digest.byteLength)) {
      digest.fill(0);
      throw new TypeError('scrypt digest has an unsupported canonical length');
    }
  } catch (error) {
    salt.fill(0);
    throw error;
  }
  return { salt, digest, keyLength: digest.byteLength };
}

function passwordInput(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4_096) {
    throw new TypeError('password must be a bounded string');
  }
  return value;
}

function derive(password, salt, keyLength) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, {
      N: SCRYPT_PARAMETERS.N,
      r: SCRYPT_PARAMETERS.r,
      p: SCRYPT_PARAMETERS.p,
      maxmem: SCRYPT_PARAMETERS.maxmem
    }, (error, result) => error ? reject(error) : resolve(result));
  });
}

function abortReason(signal) {
  return signal?.reason ?? new DOMException('password verification aborted', 'AbortError');
}

export function createScryptPasswordVerifier(encodedHash) {
  const parsed = parseRecord(encodedHash);
  const salt = Buffer.from(parsed.salt);
  const expected = Buffer.from(parsed.digest);
  const keyLength = parsed.keyLength;
  parsed.salt.fill(0);
  parsed.digest.fill(0);

  return Object.freeze({
    algorithm: 'scrypt',
    parameters: Object.freeze({
      version: 1,
      n: SCRYPT_PARAMETERS.N,
      r: SCRYPT_PARAMETERS.r,
      p: SCRYPT_PARAMETERS.p,
      keyLength
    }),
    async verify(candidate, { signal } = {}) {
      const password = passwordInput(candidate);
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw new TypeError('signal must be an AbortSignal');
      }
      if (signal?.aborted) throw abortReason(signal);
      const actual = await derive(password, salt, keyLength);
      try {
        if (signal?.aborted) throw abortReason(signal);
        return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
      } finally {
        actual.fill(0);
      }
    }
  });
}

export function validateScryptPasswordHash(encodedHash) {
  const parsed = parseRecord(encodedHash);
  parsed.salt.fill(0);
  parsed.digest.fill(0);
  return true;
}

export const PASSWORD_SCRYPT_FORMAT = Object.freeze({
  prefix: PREFIX,
  version: 1,
  n: SCRYPT_PARAMETERS.N,
  r: SCRYPT_PARAMETERS.r,
  p: SCRYPT_PARAMETERS.p,
  keyLength: SCRYPT_PARAMETERS.keyLength
});
