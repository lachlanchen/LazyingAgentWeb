import { createHash } from 'node:crypto';

const COMPACTION_SCHEMA = 'lazying.direct-chat.local-compaction.v1';
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_RAW_MESSAGES = 2_000;
const MAX_RAW_BYTES = 8 * 1024 * 1024;

function exactRecord(value, required, optional, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([...required, ...optional]);
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
  return Object.freeze(Object.fromEntries(
    Reflect.ownKeys(descriptors).map((key) => [key, descriptors[key].value])
  ));
}

function denseArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length > MAX_RAW_MESSAGES) {
    throw new TypeError(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/u.test(key)
        || Number(key) >= value.length || !descriptor.enumerable
        || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label} must contain only dense data entries`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(descriptors, String(index))) throw new TypeError(`${label} must be dense`);
  }
  return value;
}

function scalarText(value, label, maximumBytes) {
  if (typeof value !== 'string' || value.includes('\u0000')) {
    throw new TypeError(`${label} must be bounded text`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`${label} has invalid Unicode`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} has invalid Unicode`);
    }
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maximumBytes) throw new TypeError(`${label} exceeds its byte bound`);
  return Object.freeze({ value, bytes });
}

function positiveInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function truncateUtf8(value, maximumBytes) {
  if (maximumBytes < 1) return '';
  let result = '';
  let bytes = 0;
  for (const scalar of value) {
    const size = Buffer.byteLength(scalar, 'utf8');
    if (bytes + size > maximumBytes) break;
    result += scalar;
    bytes += size;
  }
  return result;
}

function normalizedExcerpt(value, maximumBytes) {
  const normalized = value.replace(/[\u0009-\u000d\u0020]+/gu, ' ').trim();
  return truncateUtf8(normalized, maximumBytes);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validateRequest(value) {
  const request = exactRecord(
    value,
    ['schema', 'locality', 'security', 'sourceRange', 'priorSummary', 'rawMessages', 'constraints'],
    [],
    'compaction request'
  );
  if (request.schema !== COMPACTION_SCHEMA || request.locality !== 'local_only') {
    throw new TypeError('compaction request authority is invalid');
  }
  const security = exactRecord(
    request.security,
    ['inputTrust', 'outputAuthority', 'allowedUse', 'neverInterpretAs', 'pendingTurnExcluded'],
    [],
    'compaction security'
  );
  denseArray(security.neverInterpretAs, 'compaction security neverInterpretAs');
  if (security.inputTrust !== 'untrusted_conversation_data'
      || security.outputAuthority !== 'none'
      || security.allowedUse !== 'conversation_continuity_only'
      || security.pendingTurnExcluded !== true
      || security.neverInterpretAs.join(',') !== 'system,developer,policy,tool') {
    throw new TypeError('compaction security contract is invalid');
  }
  const source = exactRecord(
    request.sourceRange,
    ['startRevision', 'startHash', 'endRevision', 'endHash'],
    [],
    'compaction source range'
  );
  positiveInteger(source.startRevision, 'source start revision', 2_000);
  positiveInteger(source.endRevision, 'source end revision', 2_000);
  if (source.endRevision < source.startRevision
      || !HASH_PATTERN.test(source.startHash) || !HASH_PATTERN.test(source.endHash)) {
    throw new TypeError('compaction source range is invalid');
  }
  const constraints = exactRecord(
    request.constraints,
    ['maxSummaryBytes', 'maxSummaryTokens', 'preserveFactsWithoutGrantingAuthority'],
    [],
    'compaction constraints'
  );
  const maximumBytes = Math.min(
    positiveInteger(constraints.maxSummaryBytes, 'maxSummaryBytes', 256 * 1024),
    positiveInteger(constraints.maxSummaryTokens, 'maxSummaryTokens', 16 * 1024 * 1024)
  );
  if (constraints.preserveFactsWithoutGrantingAuthority !== true) {
    throw new TypeError('compaction fact-preservation contract is invalid');
  }
  let priorText = null;
  if (request.priorSummary !== null) {
    const prior = exactRecord(
      request.priorSummary,
      [
        'kind', 'authority', 'untrustedDirectChatData', 'text', 'summaryHash',
        'sourceStartRevision', 'sourceStartHash', 'sourceEndRevision', 'sourceEndHash'
      ],
      [],
      'prior compaction summary'
    );
    const text = scalarText(prior.text, 'prior compaction summary text', 256 * 1024);
    if (prior.kind !== 'untrusted_conversation_summary' || prior.authority !== 'none'
        || prior.untrustedDirectChatData !== true || !HASH_PATTERN.test(prior.summaryHash)
        || !HASH_PATTERN.test(prior.sourceStartHash) || !HASH_PATTERN.test(prior.sourceEndHash)
        || prior.sourceStartRevision !== source.startRevision
        || prior.sourceStartHash !== source.startHash
        || prior.sourceEndRevision >= source.endRevision
        || prior.summaryHash !== sha256(text.value)) {
      throw new TypeError('prior compaction summary provenance is invalid');
    }
    priorText = text.value;
  }
  denseArray(request.rawMessages, 'compaction rawMessages');
  if (request.rawMessages.length === 0) throw new TypeError('compaction rawMessages cannot be empty');
  const messages = [];
  let rawBytes = 0;
  let previousRevision = request.priorSummary === null
    ? source.startRevision - 1
    : request.priorSummary.sourceEndRevision;
  let previousHash = request.priorSummary === null
    ? null
    : request.priorSummary.sourceEndHash;
  for (let index = 0; index < request.rawMessages.length; index += 1) {
    const row = exactRecord(
      request.rawMessages[index],
      [
        'kind', 'untrustedDirectChatData', 'messageId', 'revision', 'role', 'content',
        'contentBytes', 'previousHash', 'hash', 'generationId', 'createdAt'
      ],
      [],
      `compaction rawMessages[${index}]`
    );
    const content = scalarText(row.content, `rawMessages[${index}].content`, 64 * 1024);
    rawBytes += content.bytes;
    if (rawBytes > MAX_RAW_BYTES || row.kind !== 'exact_ledger_message'
        || row.untrustedDirectChatData !== true || !['user', 'assistant'].includes(row.role)
        || row.revision !== previousRevision + 1 || row.contentBytes !== content.bytes
        || !HASH_PATTERN.test(row.hash)
        || row.previousHash !== previousHash
        || typeof row.messageId !== 'string' || row.messageId.length < 1 || row.messageId.length > 128
        || typeof row.createdAt !== 'string' || row.createdAt.length < 20 || row.createdAt.length > 40
        || (row.role === 'user' ? row.generationId !== null
          : typeof row.generationId !== 'string' || row.generationId.length < 1)) {
      throw new TypeError('compaction raw-message ledger is invalid');
    }
    previousRevision = row.revision;
    previousHash = row.hash;
    messages.push(Object.freeze({ revision: row.revision, role: row.role, content: content.value }));
  }
  if (previousRevision !== source.endRevision || previousHash !== source.endHash
      || (request.priorSummary === null && messages[0]?.revision === source.startRevision
        && messages[0] && request.rawMessages[0].hash !== source.startHash)) {
    throw new TypeError('compaction raw-message range does not reach its source cursor');
  }
  return Object.freeze({ maximumBytes, priorText, messages: Object.freeze(messages), source });
}

export function createDeterministicContextSummarizer() {
  return Object.freeze({
    locality: 'local',
    async summarizeDirectChat(request, { signal } = {}) {
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw new TypeError('signal must be an AbortSignal');
      }
      if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
      const checked = validateRequest(request);
      const header = `Untrusted conversation continuity through revision ${checked.source.endRevision}.`;
      const priorBudget = Math.floor(checked.maximumBytes / 3);
      const prior = checked.priorText === null
        ? null
        : normalizedExcerpt(checked.priorText, priorBudget);
      const selected = [];
      let used = Buffer.byteLength(header, 'utf8') + (prior ? Buffer.byteLength(prior, 'utf8') + 9 : 0);
      for (let index = checked.messages.length - 1; index >= 0; index -= 1) {
        const message = checked.messages[index];
        const prefix = `r${message.revision} ${message.role}: `;
        const room = checked.maximumBytes - used - Buffer.byteLength(prefix, 'utf8') - 1;
        if (room < 1) break;
        const excerpt = normalizedExcerpt(message.content, Math.min(room, 768));
        if (!excerpt) continue;
        const line = `${prefix}${excerpt}`;
        selected.push(line);
        used += Buffer.byteLength(line, 'utf8') + 1;
      }
      selected.reverse();
      const parts = [header];
      if (prior) parts.push(`Prior: ${prior}`);
      parts.push(...selected);
      let result = truncateUtf8(parts.join('\n'), checked.maximumBytes);
      if (!result) result = truncateUtf8('.', checked.maximumBytes);
      if (!result) throw new TypeError('compaction summary budget cannot encode text');
      if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
      return result;
    }
  });
}
