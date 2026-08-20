import { createHash } from 'node:crypto';

import { ValidationError } from './errors.js';

const arrayIsArray = Array.isArray;
const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const getPrototypeOf = Object.getPrototypeOf;
const hasOwn = Object.hasOwn;
const ownKeys = Reflect.ownKeys;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EVENT_HASH_PATTERN = /^[a-f0-9]{64}$/u;

function plainDataKeys(value, name) {
  const descriptors = getOwnPropertyDescriptors(value);
  const keys = ownKeys(descriptors);
  for (const key of keys) {
    if (typeof key !== 'string') throw new ValidationError(`${name} must not contain symbol keys.`);
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new ValidationError(`${name} must contain only enumerable data properties.`);
    }
  }
  return { descriptors, keys };
}

export function assertPlainObject(value, name) {
  if (value === null || typeof value !== 'object' || arrayIsArray(value)) {
    throw new ValidationError(`${name} must be an object.`);
  }
  const prototype = getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ValidationError(`${name} must be a plain object.`);
  }
  return value;
}

export function assertExactKeys(value, { required = [], optional = [] }, name) {
  assertPlainObject(value, name);
  const allowed = new Set([...required, ...optional]);
  const { keys } = plainDataKeys(value, name);
  for (const key of keys) {
    if (!allowed.has(key)) {
      throw new ValidationError(`${name} contains unsupported field ${JSON.stringify(key)}.`);
    }
  }
  for (const key of required) {
    if (!hasOwn(value, key)) {
      throw new ValidationError(`${name}.${key} is required.`);
    }
  }
  return value;
}

export function assertIdentifier(value, name) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new ValidationError(`${name} must be a 1-128 character portable identifier.`);
  }
  return value;
}

export function assertBoundedString(value, name, { min = 1, max, allowControl = false } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new ValidationError(`${name} must be a string between ${min} and ${max} characters.`);
  }
  if (!allowControl && /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ValidationError(`${name} must not contain control characters.`);
  }
  return value;
}

export function assertBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${name} must be a boolean.`);
  }
  return value;
}

export function assertInteger(value, name, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function assertEventHash(value, sequence, name = 'lastEventHash') {
  if (sequence === 0 && value === null) return null;
  if (typeof value !== 'string' || !EVENT_HASH_PATTERN.test(value)) {
    throw new ValidationError(`${name} must be a lowercase 64-character hexadecimal digest when sequence is non-zero.`);
  }
  return value;
}

export function assertCanonicalIsoTimestamp(value, name) {
  if (typeof value !== 'string') {
    throw new ValidationError(`${name} must be an ISO-8601 timestamp.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new ValidationError(`${name} must be a canonical UTC ISO-8601 timestamp.`);
  }
  return value;
}

export function nowIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ValidationError('The configured clock returned an invalid time.');
  }
  return date.toISOString();
}

export function assertIdempotencyKey(value) {
  return assertBoundedString(value, 'idempotencyKey', { min: 16, max: 256 });
}

export function digestSecret(value, name, { min = 32, max = 1024 } = {}) {
  assertBoundedString(value, name, { min, max });
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalize(value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError('Idempotent request data must contain finite numbers.');
    return value;
  }
  if (typeof value !== 'object' || typeof value === 'bigint') {
    throw new ValidationError('Idempotent request data must be JSON-compatible.');
  }
  if (seen.has(value)) throw new ValidationError('Idempotent request data must not be cyclic.');
  seen.add(value);
  let result;
  if (arrayIsArray(value)) {
    if (!Number.isSafeInteger(value.length) || value.length > 10_000) {
      throw new ValidationError('Idempotent request arrays must contain at most 10,000 items.');
    }
    const descriptors = getOwnPropertyDescriptors(value);
    const keys = ownKeys(descriptors);
    const expectedKeys = new Set(['length']);
    result = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index);
      expectedKeys.add(key);
      if (!hasOwn(descriptors, key)) {
        throw new ValidationError('Idempotent request arrays must not be sparse.');
      }
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !hasOwn(descriptor, 'value')) {
        throw new ValidationError('Idempotent request arrays must contain only enumerable data items.');
      }
      result[index] = canonicalize(descriptor.value, seen);
    }
    for (const key of keys) {
      if (typeof key !== 'string' || !expectedKeys.has(key)) {
        throw new ValidationError('Idempotent request arrays must not contain extra properties.');
      }
    }
  } else {
    assertPlainObject(value, 'idempotent request data');
    result = {};
    const { descriptors, keys } = plainDataKeys(value, 'idempotent request data');
    for (const key of keys.sort()) {
      if (descriptors[key].value === undefined) {
        throw new ValidationError('Idempotent request data must not contain undefined values.');
      }
      result[key] = canonicalize(descriptors[key].value, seen);
    }
  }
  seen.delete(value);
  return result;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value, new Set()));
}
