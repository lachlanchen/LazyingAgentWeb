import { AgintiBrowserClient, selectDefaultMode } from "./aginti-client.js";
import {
  AgintiProtocolError,
  FAIL_CLOSED_AGENT_CAPABILITIES,
  validateAgentCapabilities,
  validateAgentSearch,
  validateThreadRunAncestry,
} from "./aginti-protocol.js";
import { CloudSessionClient } from "./cloud-session-client.js";
import {
  createBrowserOpaqueId,
  DirectChatBrowserClient,
  DirectChatProtocolError,
  DirectChatTransportError,
} from "./direct-chat-client.js";
import { createRunPresentation } from "./presentation-state.js";
import {
  applyTheme,
  offerPasswordManagerSave,
  rememberWorkspaceMode,
  restoreTheme,
  restoreWorkspaceMode,
} from "./pwa-assets.js";
import { createBrowserUpdateHandoffStore } from "./pwa-update-handoff-store.js";
import {
  BROWSER_VISION_IMAGE_LIMITS,
  canonicalizeVisionImage,
  inspectVisionImageBytes,
  VisionImageInputError,
} from "./vision-image-client.js";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const UNSAFE_MESSAGE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const AUTHENTICATION_FAILURE_CODES = new Set(["authentication_required", "invalid_session"]);
const BODY_REJECTION_CODES = new Set([
  "invalid_attachment", "invalid_json", "request_aborted", "request_error", "request_too_large",
]);
const SAFE_CHAT_FAILURE_OPERATIONS = new Set([
  "local_thread", "local_run", "thread_dispatch", "snapshot", "run_dispatch", "before_run_dispatch",
]);
const UPDATE_HANDOFF_PAYLOAD_SCHEMA_VERSION = "3";
// The encrypted payload gained Agent mode ownership in v3, but the outer
// IndexedDB envelope did not change. Keeping its schema at v2 prevents an
// older tab on the same origin from pruning a successor tab's protected row.
const UPDATE_HANDOFF_ENVELOPE_SCHEMA_VERSION = "2";
const UPDATE_HANDOFF_PRIOR_PAYLOAD_SCHEMA_VERSION = "2";
const UPDATE_HANDOFF_LEGACY_SCHEMA_VERSION = "1";
const UPDATE_HANDOFF_MAX_AGE_MS = 5 * 60 * 1_000;
const UPDATE_HANDOFF_FUTURE_SKEW_MS = 30_000;
const UPDATE_HANDOFF_METADATA_LIMIT = 160 * 1024;
const UPDATE_HANDOFF_IMAGE_COUNT_LIMIT = 4;
const UPDATE_HANDOFF_IMAGE_BYTES_LIMIT = 16 * 1024 * 1024;
const UPDATE_HANDOFF_PAYLOAD_LIMIT = UPDATE_HANDOFF_IMAGE_BYTES_LIMIT + UPDATE_HANDOFF_METADATA_LIMIT + 4;
const UPDATE_HANDOFF_DIGEST = /^[a-f0-9]{64}$/u;
const UPDATE_HANDOFF_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UPDATE_HANDOFF_ID = /^[a-f0-9]{64}$/u;
const UPDATE_HANDOFF_KEY = /^[A-Za-z0-9_-]{43}$/u;
const DEFAULT_ATTACHMENT_MEMORY_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_ATTACHMENT_DECODED_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const ATTACHMENT_RENDERED_PREVIEW_LIMIT = 4;
const ATTACHMENT_RESTORE_CONCURRENCY = 1;
const COMPOSER_IMAGE_COUNT_LIMIT = 4;
const COMPOSER_IMAGE_BYTES_LIMIT = 16 * 1024 * 1024;
const COMPOSER_MESSAGE_BYTES_LIMIT = 32 * 1024;
const updateHandoffEncoder = new TextEncoder();
const updateHandoffDecoder = new TextDecoder("utf-8", { fatal: true });

class LocalChatNotSentError extends Error {
  constructor(stage, cause) {
    super("The LocalLLM request stopped before its durable run was dispatched.", { cause });
    this.name = "LocalChatNotSentError";
    this.stage = stage;
  }
}

class LocalChatPreparationError extends LocalChatNotSentError {
  constructor(stage, cause) {
    super(stage, cause);
    this.name = "LocalChatPreparationError";
  }
}

function exactObject(value, allowed, required, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw new TypeError(`${label} contains an unsupported field`);
    if (!descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value")) throw new TypeError(`${label} contains an accessor`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) throw new TypeError(`${label}.${key} is required`);
  return value;
}

function sessionEnvelope(value) {
  const session = exactObject(value, ["authenticated", "username", "csrfToken"], ["authenticated"], "session");
  if (typeof session.authenticated !== "boolean") throw new TypeError("session.authenticated must be boolean");
  if (!session.authenticated) {
    if (Object.keys(session).length !== 1) throw new TypeError("signed-out session contains private state");
    return Object.freeze({ authenticated: false });
  }
  if (typeof session.username !== "string" || session.username.length < 1 || session.username.length > 128
      || /[<>\u0000-\u001f\u007f]/u.test(session.username)) throw new TypeError("session username is invalid");
  if (typeof session.csrfToken !== "string" || session.csrfToken.length < 16 || session.csrfToken.length > 1_024
      || /[\u0000-\u001f\u007f]/u.test(session.csrfToken)) throw new TypeError("session CSRF token is invalid");
  return Object.freeze({ authenticated: true, username: session.username, csrfToken: session.csrfToken });
}

function normalizedSessionUsername(value) {
  return String(value).normalize("NFC");
}

function logoutEnvelope(value) {
  const result = exactObject(value, ["signedOut", "agentCancellationPending"], ["signedOut", "agentCancellationPending"], "logout response");
  if (result.signedOut !== true || typeof result.agentCancellationPending !== "boolean") throw new TypeError("logout response is invalid");
  return Object.freeze({ signedOut: true, agentCancellationPending: result.agentCancellationPending });
}

function chatCapabilityEnvelope(value) {
  const result = exactObject(value, ["visionInput", "visionMediaTypes", "maximumImageBytes"], [
    "visionInput", "visionMediaTypes", "maximumImageBytes",
  ], "chat capabilities");
  if (typeof result.visionInput !== "boolean" || !Array.isArray(result.visionMediaTypes)
      || !Number.isSafeInteger(result.maximumImageBytes)
      || (result.visionInput
        ? result.maximumImageBytes !== 4 * 1024 * 1024
          || result.visionMediaTypes.join(",") !== "image/jpeg,image/png"
        : result.maximumImageBytes !== 0 || result.visionMediaTypes.length !== 0)) {
    throw new TypeError("chat capabilities are invalid");
  }
  return Object.freeze({
    visionInput: result.visionInput,
    visionMediaTypes: Object.freeze([...result.visionMediaTypes]),
    maximumImageBytes: result.maximumImageBytes,
  });
}

function requiredMethod(value, name, owner) {
  if (!value || typeof value[name] !== "function") throw new TypeError(`${owner} must provide ${name}()`);
}

function isUnicodeScalarText(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function boundedMessage(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 32_000
      || !isUnicodeScalarText(value) || updateHandoffEncoder.encode(value).byteLength > COMPOSER_MESSAGE_BYTES_LIMIT
      || UNSAFE_MESSAGE_CONTROL.test(value)) {
    throw new TypeError("message is invalid");
  }
  const text = value.trim();
  if (!text) throw new TypeError("message must contain non-whitespace text");
  return text;
}

function normalizedExecutionAction(value) {
  let text = String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  text = text.replace(/^(?:please|kindly)[ \t]*,?[ \t]+/iu, "");
  text = text.replace(
    /^(?:can|could|would|will)\s+you\s+(?:(?:please|kindly)[ \t]*,?[ \t]+)?/iu,
    ""
  );
  text = text.replace(
    /^i(?:['’]d|\s+would)?\s+(?:like|want|need)\s+(?:you\s+)?to\s+/iu,
    ""
  );
  text = text.replace(/^let(?:['’]s|\s+us)\s+/iu, "");
  text = text.replace(/^(?:请你?|請你?|麻烦你?|麻煩你?|劳驾|勞駕)[ \t]*/u, "");
  return text;
}

function requestsExplicitPythonHandoff(value) {
  const fenceLines = value.match(/^ {0,3}(?:`{3,}|~{3,})/gmu) ?? [];
  if (fenceLines.length === 0) return null;
  const matches = [...value.matchAll(/(^|\n)```python[ \t]*\r?\n[\s\S]*?\r?\n```[ \t]*(?=\n|$)/giu)];
  if (matches.length !== 1 || fenceLines.length !== 2) return false;
  const match = matches[0];
  const outside = `${value.slice(0, match.index)}\n${value.slice(match.index + match[0].length)}`;
  const action = normalizedExecutionAction(outside);
  return /^(?:run|execute)(?:(?:\s+|:)(?:this|that|my|the|following|below|above|python|code|script|program|snippet|block|it)\b|\s*:)/iu.test(action)
    || /^(?:run|execute)\b[ \t]*(?:[,;][ \t]*)?(?:(?:and(?:[ \t]+then)?|then|to)[ \t]+)?(?:show|display|return|give|print|output|produce|create|generate|draw|render|include|plot|chart|graph|visuali[sz]e)\b/iu.test(action)
    || /^(?:run|execute)\b[ \t]*[;,][ \t]*i[ \t]+(?:need|want|would[ \t]+like)[ \t]+(?:a[ \t]+|the[ \t]+)?(?:plot|chart|graph)\b/iu.test(action)
    || /^(?:运行|運行|执行|執行)(?:一下)?(?:(?:以下|下面|上述|上面|这段|這段|这个|這個|该|該|python|代码|代碼|程式碼|脚本|腳本|程序|程式)|[ \t]*[:：])/iu.test(action);
}

function requestsAgentExecution(value) {
  const explicitPythonHandoff = requestsExplicitPythonHandoff(value);
  if (explicitPythonHandoff !== null) return explicitPythonHandoff;
  const text = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const lower = text.toLocaleLowerCase("en-US");
  if (/^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:do\s+not|don['’]?t|dont|can['’]?t|cannot|not|never|no\s+need\s+to)\b/iu.test(lower)
      || /\bhow\s+(?:to|do|can|could|would|should)\b/iu.test(lower)
      || /^(?:please\s+)?(?:how\b|what(?:['’]s|\s+is)\s+the\s+(?:best\s+)?way\b)/iu.test(lower)
      || /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:explain|describe|interpret|analy[sz]e|review|discuss)\b/iu.test(lower)
      || /\b(?:this|that|my|existing|attached|above|below|current|provided)\s+(?:existing\s+)?(?:plot|graph|chart)\b/iu.test(lower)
      || /\b(?:javascript|typescript|node(?:\.js)?|deno|bun|bash|shell|powershell|ruby|java|kotlin|swift|rust|golang|c\+\+|cpp|c#|csharp|\.net|php|perl|matlab|octave|julia|sql)\b/iu.test(lower)
      || /\b(?:using|with|in|run|execute)\s+(?:r|go|c)(?:\s+(?:code|script|runtime|language))?\b/iu.test(lower)) {
    return false;
  }
  const command = normalizedExecutionAction(lower);
  return /^(?:plot|graph|chart)\b/iu.test(command)
    || /^(?:run|execute)\b.{0,160}\b(?:code|script|python|plot|graph|chart)\b/iu.test(command)
    || /^(?:make|draw|create|generate|render|display|show|calculate|compute)\b.{0,160}\b(?:plot|graph|chart)\b/iu.test(command);
}

function requestsAgentDocumentCreation(value) {
  const text = String(value || "").normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!text || /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:do\s+not|don['’]?t|dont|never|avoid|without|no\s+need\s+to)\b/iu.test(text)
      || /^(?:please\s+)?(?:how\b|why\b|what\b|explain\b|describe\b|compare\b|review\b|discuss\b)/iu.test(text)) {
    return false;
  }
  const action = normalizedExecutionAction(text);
  const creationExcluded = /\b(?:do\s+not|don't|dont|never|avoid)\b[^.!?;\r\n]{0,160}\b(?:make|create|generate|write|compile|typeset|render|export|build|deliver|provide|send|give|return|output|share|save|download|files?|artifacts?|outputs?|deliverables?)\b|\bwithout\b[^.!?;\r\n]{0,100}\b(?:making|creating|generating|writing|compiling|rendering|exporting|saving|downloading|files?|artifacts?)\b|\bneither\b[^.!?;\r\n]{0,160}\b(?:latex|tex)\b[^.!?;\r\n]{0,160}\b(?:nor|or|and)\b[^.!?;\r\n]{0,100}\bpdf\b|\b(?:just|only)\s+(?:explain|describe|discuss|compare|review)\b|(?:不要|不用|无需|無需|不需要|禁止|避免)[^。！？；\r\n]{0,120}(?:创建|建立|生成|撰写|撰寫|编译|編譯|导出|導出|制作|製作|文件|文档|文檔|输出|輸出)/iu.test(text);
  const discussionTarget = /^(?:make|create|generate|write|produce|prepare|provide|give|return|output|share|deliver)\s+(?:me\s+)?(?:an?\s+|the\s+)?(?:tutorial|explanation|advice|comparison|overview|discussion|review|article|essay|prose|example|guide)\b|^(?:make|create|generate|write|produce|prepare)\s+(?:something\s+)?(?:about|on)\b|^(?:make|create|generate|write|produce|prepare|provide)\b[^.!?;\r\n]{0,120}\b(?:latex|tex)\s+source[- ]code\s+example\b/iu.test(action);
  if (creationExcluded || discussionTarget) return false;
  const needDeliverable = /(?:\.tex\b|\.pdf\b|\b(?:source(?:\s+files?)?|compiled\s+pdf|files?|documents?|reports?|papers?|manuscripts?|artifacts?|outputs?|deliverables?|versions?|formats?)\b|(?:源文件|源檔案|源檔|文件|文档|文檔|报告|報告|论文|論文|输出|輸出|格式|版本|编译后|編譯後))/iu.test(action);
  const createsDocument = /^(?:make|create|generate|write|rewrite|revise|update|edit|modify|correct|fix|regenerate|recompile|produce|prepare|compile|typeset|render|export|build|deliver|provide|send|give|return|output|share|save)\b/iu.test(action)
    || /^(?:(?:i|we)\s+)?(?:need|want|require|would\s+like)\b/iu.test(action) && needDeliverable
    || /^(?:(?:我|我们|我們)\s*)?(?:需要|想要|要)(?:\s|$)/u.test(action) && needDeliverable
    || /^(?:use|using)\s+(?:latex|tex)\b/iu.test(action)
    || /^(?:创建|建立|生成|撰写|撰寫|重写|重寫|修改|修订|修訂|更新|重新生成|重新编译|重新編譯|编译|編譯|导出|導出|准备|準備|制作|製作|交付|提供|给我|給我|输出|輸出|返回|排版)/u.test(action);
  const hasTex = /(?:\.tex\b|\b(?:latex|tex)(?:\s+(?:source|file|document|format))?\b)/iu.test(text);
  const hasPdf = /(?:\.pdf\b|\b(?:compiled\s+)?pdf\b)/iu.test(text);
  const topicComparison = /\b(?:about|compare|comparing|comparison|differences?\s+between|explain|explaining|explanation|discussion|overview|tutorial|advice|prose|source[- ]code\s+example)\b[^.!?\r\n]{0,180}\b(?:latex|tex)\b[^.!?\r\n]{0,120}\bpdf\b/iu.test(text);
  const artifactFraming = /\b(?:both|source|files?|documents?|reports?|papers?|manuscripts?|artifacts?|outputs?|versions?|formats?|deliverables?|compiled)\b|(?:源文件|源码|源碼|文件|文档|文檔|报告|報告|论文|論文|输出|輸出|格式|编译后|編譯後)/iu.test(text);
  const coordinated = /\b(?:both\s+)?(?:latex|tex)(?:\s+(?:source|file|document|format|manuscript))?\b[^.!?\r\n]{0,100}\b(?:and|plus|along\s+with|together\s+with|as\s+well\s+as|with)\b[^.!?\r\n]{0,100}\b(?:compiled\s+)?pdf\b|\bpdf\b[^.!?\r\n]{0,100}\b(?:and|plus|along\s+with|together\s+with|as\s+well\s+as)\b[^.!?\r\n]{0,100}\b(?:latex|tex)\s+(?:source|file|document|format|manuscript)\b/iu.test(text);
  const explicitExtensions = /\.tex\b[\s\S]{0,240}\.pdf\b|\.pdf\b[\s\S]{0,240}\.tex\b/iu.test(text);
  const production = /\b(?:compile|typeset|render|export|build|convert)\b[^.!?\r\n]{0,180}\b(?:latex|tex|\.tex)\b[^.!?\r\n]{0,120}\b(?:to|into|as)\b[^.!?\r\n]{0,60}\bpdf\b|\b(?:make|create|generate|produce|prepare|render|export)\b[^.!?\r\n]{0,160}\bpdf\b[^.!?\r\n]{0,100}\b(?:using|with|from)\b[^.!?\r\n]{0,60}\b(?:latex|tex)\b|\buse\s+(?:latex|tex)\b[^.!?\r\n]{0,120}\b(?:make|create|generate|produce|prepare|render|export)\b[^.!?\r\n]{0,80}\bpdf\b|\b(?:latex|tex)\b[^.!?\r\n]{0,160}\b(?:compile|typeset|render|export|build|give|return|send|provide)\b[^.!?\r\n]{0,100}\bpdf\b/iu.test(text);
  const chinesePair = /(?:latex|tex|\.tex)[^。！？\r\n]{0,100}(?:和|及|与|與|以及|连同|連同|并(?:编译成)?|並(?:編譯成)?)[^。！？\r\n]{0,100}(?:pdf|\.pdf)|(?:pdf|\.pdf)[^。！？\r\n]{0,100}(?:和|及|与|與|以及|连同|連同)[^。！？\r\n]{0,100}(?:latex|tex|\.tex)/iu.test(text);
  return createsDocument && hasTex && hasPdf
    && (explicitExtensions || (coordinated && artifactFraming && !topicComparison) || production || chinesePair);
}

function requestedAvailableAgentTool(value, capabilities) {
  if (requestsAgentExecution(value)) return "analysis";
  if (capabilities?.artifacts?.kinds?.includes?.("file") === true
      && requestsAgentDocumentCreation(value)) return "document";
  return null;
}

function agentHandoffNeedsChatContext(value) {
  const text = String(value || "").normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!text) return false;
  if (/\b(?:above|previous|prior|earlier|preceding|last|same|existing)\s+(?:article|text|code|plot|chart|graph|document|report|paper|data|result|answer|response|content|file|source)\b|\b(?:article|text|code|plot|chart|graph|document|report|paper|data|result|answer|response|content|file|source)\s+(?:above|previous|prior|earlier)\b|\b(?:from|using|based\s+on)\s+(?:the\s+)?(?:above|previous|prior|earlier|preceding|last|same|existing)\b/iu.test(text)) {
    return true;
  }
  const action = normalizedExecutionAction(text);
  if (/^(?:continue|redo|revise|modify|update|change|fix|regenerate|recompile|plot|chart|graph|compile|render|export|rewrite|summari[sz]e|use|run|execute)\s+(?:it|that|this)\b/iu.test(action)
      || /\b(?:from|using|based\s+on)\s+(?:it|this|that)\b/iu.test(text)) {
    return !/(?:```|~~~)[^\r\n]*[\s\S]+(?:```|~~~)/u.test(String(value || ""));
  }
  return false;
}

function updateHandoffDraft(value) {
  if (typeof value !== "string" || value.length > 32_000 || !isUnicodeScalarText(value)
      || UNSAFE_MESSAGE_CONTROL.test(value)) {
    throw new TypeError("update handoff draft is invalid");
  }
  return value;
}

async function updateHandoffDigest(bytes) {
  if (!(bytes instanceof Uint8Array) || typeof globalThis.crypto?.subtle?.digest !== "function") {
    throw new TypeError("browser update handoff hashing is unavailable");
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function updateHandoffImageDescriptor(image) {
  return Object.freeze({
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    byteLength: image.byteLength,
    width: image.width,
    height: image.height,
  });
}

function updateHandoffBinary(images) {
  const total = images.reduce((sum, image) => sum + image.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const image of images) {
    bytes.set(image.bytes, offset);
    offset += image.byteLength;
  }
  return bytes;
}

function updateHandoffMetadata(record, { digest = false } = {}) {
  const common = {
    schemaVersion: record.schemaVersion,
    scope: record.scope,
    sourceRelease: record.sourceRelease,
    targetRelease: record.targetRelease,
    createdAt: record.createdAt,
    accountDigest: record.accountDigest,
    threadId: record.threadId,
    draft: record.draft,
    ...(record.schemaVersion === UPDATE_HANDOFF_PAYLOAD_SCHEMA_VERSION
      ? { mode: record.mode, search: record.search }
      : {}),
  };
  const imageField = record.schemaVersion === UPDATE_HANDOFF_LEGACY_SCHEMA_VERSION
    ? { image: record.image === null ? null : updateHandoffImageDescriptor(record.image) }
    : { images: record.images.map(updateHandoffImageDescriptor) };
  return { ...common, ...imageField, ...(digest ? { digest: record.digest } : {}) };
}

function updateHandoffDigestInput(record) {
  const metadata = updateHandoffEncoder.encode(JSON.stringify(updateHandoffMetadata(record)));
  const images = record.schemaVersion === UPDATE_HANDOFF_LEGACY_SCHEMA_VERSION
    ? (record.image === null ? [] : [record.image])
    : record.images;
  const imageBytes = updateHandoffBinary(images);
  const payload = new Uint8Array(4 + metadata.byteLength + imageBytes.byteLength);
  new DataView(payload.buffer).setUint32(0, metadata.byteLength);
  payload.set(metadata, 4);
  payload.set(imageBytes, 4 + metadata.byteLength);
  return payload;
}

function updateHandoffImage(value) {
  if (value === null) return null;
  const image = exactObject(value, [
    "attachmentId", "mediaType", "byteLength", "width", "height", "bytes",
  ], [
    "attachmentId", "mediaType", "byteLength", "width", "height", "bytes",
  ], "update handoff image");
  if (typeof image.attachmentId !== "string" || image.attachmentId.length < 16
      || !UPDATE_HANDOFF_IDENTIFIER.test(image.attachmentId)
      || !["image/jpeg", "image/png"].includes(image.mediaType)
      || !Number.isSafeInteger(image.byteLength) || image.byteLength < 1
      || image.byteLength > BROWSER_VISION_IMAGE_LIMITS.canonicalBytes
      || !(image.bytes instanceof Uint8Array) || image.bytes.byteLength !== image.byteLength
      || !Number.isSafeInteger(image.width) || image.width < 1
      || image.width > BROWSER_VISION_IMAGE_LIMITS.maximumEdge
      || !Number.isSafeInteger(image.height) || image.height < 1
      || image.height > BROWSER_VISION_IMAGE_LIMITS.maximumEdge
      || image.width * image.height > BROWSER_VISION_IMAGE_LIMITS.pixels) {
    throw new TypeError("update handoff image is invalid");
  }
  const inspected = inspectVisionImageBytes(image.bytes, image.mediaType);
  if (inspected.width !== image.width || inspected.height !== image.height) {
    throw new TypeError("update handoff image dimensions are inconsistent");
  }
  return Object.freeze({
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    byteLength: image.byteLength,
    width: image.width,
    height: image.height,
    bytes: image.bytes.slice(),
  });
}

function updateHandoffImages(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length > UPDATE_HANDOFF_IMAGE_COUNT_LIMIT) {
    throw new TypeError("update handoff images are invalid");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const images = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("update handoff images are invalid");
    }
    images.push(updateHandoffImage(descriptor.value));
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length) {
      throw new TypeError("update handoff images are invalid");
    }
  }
  if (images.reduce((sum, image) => sum + image.byteLength, 0) > UPDATE_HANDOFF_IMAGE_BYTES_LIMIT
      || new Set(images.map((image) => image.attachmentId)).size !== images.length) {
    throw new TypeError("update handoff images are invalid");
  }
  return Object.freeze(images);
}

async function validateUpdateHandoff(value, {
  scope,
  currentRelease,
  username,
  now,
  allowChainedTargetRelease = false,
}) {
  const legacy = value?.schemaVersion === UPDATE_HANDOFF_LEGACY_SCHEMA_VERSION;
  const current = value?.schemaVersion === UPDATE_HANDOFF_PAYLOAD_SCHEMA_VERSION;
  const imageField = legacy ? "image" : "images";
  const record = exactObject(value, [
    "schemaVersion", "scope", "sourceRelease", "targetRelease", "createdAt", "accountDigest",
    "threadId", "draft", ...(current ? ["mode", "search"] : []), imageField, "digest",
  ], [
    "schemaVersion", "scope", "sourceRelease", "targetRelease", "createdAt", "accountDigest",
    "threadId", "draft", ...(current ? ["mode", "search"] : []), imageField, "digest",
  ], "update handoff");
  const instant = Number(now());
  if (![UPDATE_HANDOFF_PAYLOAD_SCHEMA_VERSION, UPDATE_HANDOFF_PRIOR_PAYLOAD_SCHEMA_VERSION,
    UPDATE_HANDOFF_LEGACY_SCHEMA_VERSION].includes(record.schemaVersion)
      || record.scope !== scope
      || !validAgentRelease(record.sourceRelease)
      || (!allowChainedTargetRelease && record.targetRelease !== currentRelease)
      || !validAgentRelease(record.targetRelease)
      || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
      || !Number.isSafeInteger(instant) || instant < 0
      || record.createdAt > instant + UPDATE_HANDOFF_FUTURE_SKEW_MS
      || instant - record.createdAt > UPDATE_HANDOFF_MAX_AGE_MS
      || typeof record.accountDigest !== "string" || !UPDATE_HANDOFF_DIGEST.test(record.accountDigest)
      || typeof record.digest !== "string" || !UPDATE_HANDOFF_DIGEST.test(record.digest)
      || (record.threadId !== null && (typeof record.threadId !== "string"
        || !UPDATE_HANDOFF_IDENTIFIER.test(record.threadId)))) {
    throw new TypeError("update handoff ownership is invalid");
  }
  const draft = updateHandoffDraft(record.draft);
  const images = legacy
    ? Object.freeze(record.image === null ? [] : [updateHandoffImage(record.image)])
    : updateHandoffImages(record.images);
  const legacyModeAmbiguous = record.schemaVersion === UPDATE_HANDOFF_PRIOR_PAYLOAD_SCHEMA_VERSION
    && record.threadId === null && draft.length > 0 && images.length === 0;
  const mode = current ? record.mode : legacyModeAmbiguous ? null : "chat";
  if (mode !== null && !["chat", "agent"].includes(mode)) {
    throw new TypeError("update handoff mode is invalid");
  }
  // A current payload may also carry only an exact owned thread selection.
  // This is needed when a release fence interrupts authenticated read recovery
  // after the server already owns the work; it never represents a mutation.
  if (!draft && images.length === 0 && !(current && record.threadId !== null)) {
    throw new TypeError("update handoff is empty");
  }
  if (mode === "agent" && images.length !== 0) throw new TypeError("Agent update handoff cannot contain images");
  const search = current && record.search !== null ? validateAgentSearch(record.search) : null;
  if (search !== null && mode !== "agent") throw new TypeError("update handoff search mode is invalid");
  const accountDigest = await updateHandoffDigest(updateHandoffEncoder.encode(
    `lazying-agent-update-account\u0000${normalizedSessionUsername(username)}`,
  ));
  if (accountDigest !== record.accountDigest) throw new TypeError("update handoff account is invalid");
  const common = {
    schemaVersion: record.schemaVersion,
    scope: record.scope,
    sourceRelease: record.sourceRelease,
    targetRelease: record.targetRelease,
    createdAt: record.createdAt,
    accountDigest: record.accountDigest,
    threadId: record.threadId,
    draft,
    ...(current ? { mode, search } : {}),
  };
  const signed = Object.freeze(legacy
    ? { ...common, image: images[0] ?? null }
    : { ...common, images });
  if (await updateHandoffDigest(updateHandoffDigestInput(signed)) !== record.digest) {
    throw new TypeError("update handoff digest is invalid");
  }
  return Object.freeze({ ...common, mode, search, images, legacyModeAmbiguous });
}

function encodeUpdateHandoffPayload(record) {
  const metadata = updateHandoffEncoder.encode(JSON.stringify(updateHandoffMetadata(record, { digest: true })));
  const images = record.schemaVersion === UPDATE_HANDOFF_LEGACY_SCHEMA_VERSION
    ? (record.image === null ? [] : [record.image])
    : record.images;
  const imageBytes = updateHandoffBinary(images);
  if (metadata.byteLength > UPDATE_HANDOFF_METADATA_LIMIT
      || 4 + metadata.byteLength + imageBytes.byteLength > UPDATE_HANDOFF_PAYLOAD_LIMIT) {
    throw new TypeError("update handoff payload is too large");
  }
  const payload = new Uint8Array(4 + metadata.byteLength + imageBytes.byteLength);
  new DataView(payload.buffer).setUint32(0, metadata.byteLength);
  payload.set(metadata, 4);
  payload.set(imageBytes, 4 + metadata.byteLength);
  return payload;
}

function decodeUpdateHandoffPayload(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 6 || bytes.byteLength > UPDATE_HANDOFF_PAYLOAD_LIMIT) {
    throw new TypeError("update handoff payload is invalid");
  }
  const metadataLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (metadataLength < 2 || metadataLength > UPDATE_HANDOFF_METADATA_LIMIT
      || 4 + metadataLength > bytes.byteLength) throw new TypeError("update handoff metadata is invalid");
  const metadata = JSON.parse(updateHandoffDecoder.decode(bytes.subarray(4, 4 + metadataLength)));
  const legacy = metadata?.schemaVersion === UPDATE_HANDOFF_LEGACY_SCHEMA_VERSION;
  const current = metadata?.schemaVersion === UPDATE_HANDOFF_PAYLOAD_SCHEMA_VERSION;
  const imageField = legacy ? "image" : "images";
  const envelope = exactObject(metadata, [
    "schemaVersion", "scope", "sourceRelease", "targetRelease", "createdAt", "accountDigest",
    "threadId", "draft", ...(current ? ["mode", "search"] : []), imageField, "digest",
  ], [
    "schemaVersion", "scope", "sourceRelease", "targetRelease", "createdAt", "accountDigest",
    "threadId", "draft", ...(current ? ["mode", "search"] : []), imageField, "digest",
  ], "update handoff payload");
  const rawDescriptors = legacy
    ? (envelope.image === null ? [] : [envelope.image])
    : envelope.images;
  if (!Array.isArray(rawDescriptors) || rawDescriptors.length > UPDATE_HANDOFF_IMAGE_COUNT_LIMIT) {
    throw new TypeError("update handoff image descriptors are invalid");
  }
  let offset = 4 + metadataLength;
  const images = rawDescriptors.map((rawDescriptor) => {
    const descriptor = exactObject(rawDescriptor, [
      "attachmentId", "mediaType", "byteLength", "width", "height",
    ], [
      "attachmentId", "mediaType", "byteLength", "width", "height",
    ], "update handoff image descriptor");
    if (!Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength < 1
        || offset + descriptor.byteLength > bytes.byteLength) {
      throw new TypeError("update handoff image descriptor is invalid");
    }
    const image = { ...descriptor, bytes: bytes.slice(offset, offset + descriptor.byteLength) };
    offset += descriptor.byteLength;
    return image;
  });
  if (offset !== bytes.byteLength) {
    throw new TypeError("update handoff contains unexpected binary data");
  }
  return legacy
    ? { ...envelope, image: images[0] ?? null }
    : { ...envelope, images };
}

function updateHandoffBase64Url(bytes) {
  if (typeof bytes?.toBase64 === "function") {
    return bytes.toBase64({ alphabet: "base64url", omitPadding: true });
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeUpdateHandoffKey(value) {
  if (typeof value !== "string" || !UPDATE_HANDOFF_KEY.test(value) || typeof globalThis.atob !== "function") {
    throw new TypeError("update handoff key is invalid");
  }
  const binary = globalThis.atob(`${value.replaceAll("-", "+").replaceAll("_", "/")}=`);
  if (binary.length !== 32) throw new TypeError("update handoff key is invalid");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function updateHandoffChainProofInput(handoffId, newTargetRelease) {
  return updateHandoffEncoder.encode(
    `lazying-update-chain\u0000${handoffId}\u0000${newTargetRelease}`,
  );
}

async function createChainedUpdateHandoffClaim(claim, oldTargetRelease, newTargetRelease) {
  if (!claim || !UPDATE_HANDOFF_ID.test(claim.handoffId) || !UPDATE_HANDOFF_KEY.test(claim.key)
      || !validAgentRelease(oldTargetRelease) || !validAgentRelease(newTargetRelease)
      || oldTargetRelease === newTargetRelease) {
    throw new TypeError("chained update handoff ownership is invalid");
  }
  const subtle = globalThis.crypto?.subtle;
  if (typeof subtle?.importKey !== "function" || typeof subtle?.sign !== "function") {
    throw new TypeError("chained update handoff authentication is unavailable");
  }
  const key = await subtle.importKey(
    "raw",
    decodeUpdateHandoffKey(claim.key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const proof = new Uint8Array(await subtle.sign(
    "HMAC",
    key,
    updateHandoffChainProofInput(claim.handoffId, newTargetRelease),
  ));
  return Object.freeze({
    handoffId: claim.handoffId,
    key: claim.key,
    chainProof: updateHandoffBase64Url(proof),
  });
}

async function verifyChainedUpdateHandoffClaim(claim, oldTargetRelease, newTargetRelease) {
  if (!claim || !UPDATE_HANDOFF_ID.test(claim.handoffId) || !UPDATE_HANDOFF_KEY.test(claim.key)
      || !UPDATE_HANDOFF_KEY.test(claim.chainProof)
      || !validAgentRelease(oldTargetRelease) || !validAgentRelease(newTargetRelease)
      || oldTargetRelease === newTargetRelease) return false;
  const subtle = globalThis.crypto?.subtle;
  if (typeof subtle?.importKey !== "function" || typeof subtle?.verify !== "function") return false;
  try {
    const key = await subtle.importKey(
      "raw",
      decodeUpdateHandoffKey(claim.key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await subtle.verify(
      "HMAC",
      key,
      decodeUpdateHandoffKey(claim.chainProof),
      updateHandoffChainProofInput(claim.handoffId, newTargetRelease),
    );
  } catch { return false; }
}

function createUpdateHandoffClaim() {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new TypeError("secure update handoff randomness is unavailable");
  }
  const identifierBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const keyBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return Object.freeze({
    handoffId: [...identifierBytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    key: updateHandoffBase64Url(keyBytes),
  });
}

function updateHandoffFragment(claim) {
  return `#lazying-update-handoff=${claim.handoffId}.${claim.key}${claim.chainProof ? `.${claim.chainProof}` : ""}`;
}

function scrubCapturedUpdateHandoffClaim(window) {
  let url;
  try { url = new URL(window?.location?.href); }
  catch { return false; }
  try {
    window.history.replaceState(window.history.state ?? null, "", `${url.pathname}${url.search}`);
    return true;
  } catch { return false; }
}

function captureUpdateHandoffClaim(window) {
  let url;
  try { url = new URL(window?.location?.href); }
  catch { return null; }
  const match = /^#lazying-update-handoff=([a-f0-9]{64})\.([A-Za-z0-9_-]{43})(?:\.([A-Za-z0-9_-]{43}))?$/u.exec(url.hash);
  if (!match) return null;
  // Keep the fragment until authenticated decryption succeeds. URL fragments
  // are not sent in HTTP requests, and retaining this one-time key prevents a
  // reload, expired-session landing, or pre-consumption capability failure
  // from orphaning the encrypted IndexedDB row.
  return Object.freeze({
    handoffId: match[1],
    key: match[2],
    ...(match[3] === undefined ? {} : { chainProof: match[3] }),
  });
}

function retainCapturedUpdateHandoffClaim(window, claim) {
  if (!claim || !UPDATE_HANDOFF_ID.test(claim.handoffId) || !UPDATE_HANDOFF_KEY.test(claim.key)
      || (claim.chainProof !== undefined && !UPDATE_HANDOFF_KEY.test(claim.chainProof))) return false;
  let url;
  try { url = new URL(window?.location?.href); }
  catch { return false; }
  if (url.hash === updateHandoffFragment(claim)) return true;
  try {
    window.history.replaceState(
      window.history.state ?? null,
      "",
      `${url.pathname}${url.search}${updateHandoffFragment(claim)}`,
    );
    return true;
  } catch { return false; }
}

function updateHandoffAdditionalData(envelope) {
  return updateHandoffEncoder.encode(JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    scope: envelope.scope,
    handoffId: envelope.handoffId,
    sourceRelease: envelope.sourceRelease,
    targetRelease: envelope.targetRelease,
    createdAt: envelope.createdAt,
    expiresAt: envelope.expiresAt,
  }));
}

async function encryptUpdateHandoff(record, claim) {
  const subtle = globalThis.crypto?.subtle;
  if (typeof subtle?.importKey !== "function" || typeof subtle?.encrypt !== "function"
      || !UPDATE_HANDOFF_ID.test(claim.handoffId)) throw new TypeError("update handoff encryption is unavailable");
  const keyBytes = decodeUpdateHandoffKey(claim.key);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const envelope = Object.freeze({
    schemaVersion: UPDATE_HANDOFF_ENVELOPE_SCHEMA_VERSION,
    scope: record.scope,
    handoffId: claim.handoffId,
    sourceRelease: record.sourceRelease,
    targetRelease: record.targetRelease,
    createdAt: record.createdAt,
    expiresAt: record.createdAt + UPDATE_HANDOFF_MAX_AGE_MS,
  });
  const key = await subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await subtle.encrypt({
    name: "AES-GCM",
    iv,
    additionalData: updateHandoffAdditionalData(envelope),
    tagLength: 128,
  }, key, encodeUpdateHandoffPayload(record)));
  return Object.freeze({ ...envelope, iv, ciphertext });
}

async function decryptUpdateHandoff(value, claim, {
  scope,
  currentRelease,
  username,
  now,
}) {
  const envelope = exactObject(value, [
    "schemaVersion", "scope", "handoffId", "sourceRelease", "targetRelease", "createdAt", "expiresAt", "iv", "ciphertext",
  ], [
    "schemaVersion", "scope", "handoffId", "sourceRelease", "targetRelease", "createdAt", "expiresAt", "iv", "ciphertext",
  ], "encrypted update handoff");
  const instant = Number(now());
  const chainedTargetRelease = envelope.targetRelease !== currentRelease;
  if (![UPDATE_HANDOFF_ENVELOPE_SCHEMA_VERSION,
    UPDATE_HANDOFF_LEGACY_SCHEMA_VERSION].includes(envelope.schemaVersion)
      || envelope.scope !== scope
      || envelope.handoffId !== claim.handoffId || !UPDATE_HANDOFF_ID.test(envelope.handoffId)
      || !validAgentRelease(envelope.sourceRelease)
      || !validAgentRelease(envelope.targetRelease)
      || (chainedTargetRelease && !UPDATE_HANDOFF_KEY.test(claim.chainProof))
      || !Number.isSafeInteger(envelope.createdAt) || envelope.createdAt < 0
      || envelope.expiresAt !== envelope.createdAt + UPDATE_HANDOFF_MAX_AGE_MS
      || !Number.isSafeInteger(instant) || instant < 0 || instant > envelope.expiresAt
      || envelope.createdAt > instant + UPDATE_HANDOFF_FUTURE_SKEW_MS
      || !(envelope.iv instanceof Uint8Array) || envelope.iv.byteLength !== 12
      || !(envelope.ciphertext instanceof Uint8Array) || envelope.ciphertext.byteLength < 17
      || envelope.ciphertext.byteLength > UPDATE_HANDOFF_PAYLOAD_LIMIT + 16) {
    throw new TypeError("encrypted update handoff is invalid");
  }
  const chainedTargetVerified = chainedTargetRelease
    && await verifyChainedUpdateHandoffClaim(
      claim,
      envelope.targetRelease,
      currentRelease,
    );
  if (chainedTargetRelease && !chainedTargetVerified) {
    throw new TypeError("encrypted update handoff target is invalid");
  }
  const subtle = globalThis.crypto?.subtle;
  if (typeof subtle?.importKey !== "function" || typeof subtle?.decrypt !== "function") {
    throw new TypeError("update handoff decryption is unavailable");
  }
  const key = await subtle.importKey("raw", decodeUpdateHandoffKey(claim.key), "AES-GCM", false, ["decrypt"]);
  const plaintext = new Uint8Array(await subtle.decrypt({
    name: "AES-GCM",
    iv: envelope.iv,
    additionalData: updateHandoffAdditionalData(envelope),
    tagLength: 128,
  }, key, envelope.ciphertext));
  const record = await validateUpdateHandoff(decodeUpdateHandoffPayload(plaintext), {
    scope,
    currentRelease,
    username,
    now,
    allowChainedTargetRelease: chainedTargetVerified,
  });
  if (record.sourceRelease !== envelope.sourceRelease || record.targetRelease !== envelope.targetRelease
      || record.createdAt !== envelope.createdAt) throw new TypeError("update handoff envelope is inconsistent");
  return record;
}

function conversationTitle(value) {
  let title = "";
  let pendingSpace = false;
  let scalars = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      pendingSpace = title.length > 0;
      continue;
    }
    const scalar = codePoint >= 0xd800 && codePoint <= 0xdfff ? "\ufffd" : character;
    if (pendingSpace && scalars < 80) {
      title += " ";
      scalars += 1;
    }
    pendingSpace = false;
    if (scalars >= 80) break;
    title += scalar;
    scalars += 1;
  }
  return title.trim();
}

function prepareLocalChat(stage, operation) {
  try { return operation(); }
  catch (error) { throw new LocalChatPreparationError(stage, error); }
}

function chatFailureCause(error) {
  return error instanceof LocalChatNotSentError && error.cause !== undefined ? error.cause : error;
}

function clientReleaseMismatch(error) {
  let current = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth += 1) {
    if (current.code === "client_release_mismatch" && validAgentRelease(current.serverRelease)) {
      return current.serverRelease;
    }
    current = current.cause;
  }
  return null;
}

function isChatAuthenticationRejection(error) {
  const cause = chatFailureCause(error);
  return AUTHENTICATION_FAILURE_CODES.has(cause?.code)
    || cause?.code === "csrf_rejected"
    || cause?.status === 401;
}

function isChatAuthenticationAfterAmbiguousDispatch(error) {
  const cause = chatFailureCause(error);
  return isChatAuthenticationRejection(error) || cause?.status === 403;
}

function chatFailureDiagnostic(error) {
  const cause = chatFailureCause(error);
  const operation = SAFE_CHAT_FAILURE_OPERATIONS.has(error?.stage) ? error.stage : "before_run_dispatch";
  const sourceCode = typeof cause?.code === "string" ? cause.code : "request_failed";
  const status = Number.isSafeInteger(cause?.status) ? cause.status : 0;
  if (error instanceof LocalChatPreparationError) {
    return Object.freeze({
      stage: "local_preparation",
      code: operation === "local_thread" ? "thread_ticket_invalid" : "run_ticket_invalid",
      operation,
      label: "Local preparation",
      reauthenticate: false,
    });
  }
  if (AUTHENTICATION_FAILURE_CODES.has(sourceCode) || status === 401) {
    return Object.freeze({
      stage: "authentication",
      code: sourceCode === "invalid_session" ? "invalid_session" : "authentication_required",
      operation,
      label: "Sign-in required",
      reauthenticate: true,
    });
  }
  if (sourceCode === "csrf_rejected") {
    return Object.freeze({
      stage: "csrf",
      code: "csrf_rejected",
      operation,
      label: "Security token expired",
      reauthenticate: true,
    });
  }
  if (["request_timeout", "dependency_timeout"].includes(sourceCode) || [408, 504].includes(status)) {
    return Object.freeze({
      stage: "network_timeout",
      code: sourceCode === "dependency_timeout" ? "dependency_timeout" : "request_timeout",
      operation,
      label: "Network timeout",
      reauthenticate: false,
    });
  }
  if (["conflict", "idempotency_conflict"].includes(sourceCode) || status === 409) {
    return Object.freeze({
      stage: "authoritative_conflict",
      code: sourceCode === "idempotency_conflict" ? "idempotency_conflict" : "conflict",
      operation,
      label: "Conversation changed",
      reauthenticate: false,
    });
  }
  if (BODY_REJECTION_CODES.has(sourceCode) || status === 413) {
    return Object.freeze({
      stage: "body_rejection",
      code: BODY_REJECTION_CODES.has(sourceCode) ? sourceCode : "request_too_large",
      operation,
      label: "Image upload rejected",
      reauthenticate: false,
    });
  }
  if (operation === "snapshot") {
    return Object.freeze({
      stage: "snapshot",
      code: cause instanceof DirectChatProtocolError ? "snapshot_protocol" : "snapshot_unavailable",
      operation,
      label: "Conversation refresh",
      reauthenticate: false,
    });
  }
  if (cause?.retryable === true) {
    return Object.freeze({
      stage: "network",
      code: "network_unavailable",
      operation,
      label: "Network unavailable",
      reauthenticate: false,
    });
  }
  return Object.freeze({
    stage: "authoritative_rejection",
    code: "request_rejected",
    operation,
    label: "Request rejected",
    reauthenticate: false,
  });
}

function normalizedBrowserPath(value, name, { trailingSlash = false } = {}) {
  if (typeof value !== "string" || value.length > 160 || !/^\/[A-Za-z0-9._~/-]*$/u.test(value) || value.includes("//")
      || value.split("/").some((part) => part === "." || part === "..")) {
    throw new TypeError(`${name} must be a normalized absolute path`);
  }
  if (trailingSlash) return value.endsWith("/") ? value : `${value}/`;
  return value.length > 1 ? value.replace(/\/$/u, "") : value;
}

function metaContent(document, name) {
  try {
    const node = document?.querySelector?.(`meta[name="${name}"]`);
    const value = node?.getAttribute?.("content") ?? node?.content;
    return typeof value === "string" && value ? value : undefined;
  } catch { return undefined; }
}

function validAgentRelease(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,23}-[a-f0-9]{64}$/u.test(value);
}

function agentReleaseMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "releaseId,type"
      || value.type !== "LAZYING_AGENT_RELEASE" || !validAgentRelease(value.releaseId)) return null;
  return value.releaseId;
}

function safeRunStatus(value) {
  return ["starting", "running", "completed", "failed", "cancelled"].includes(value) ? value : "running";
}

function eventAwaitingRunStatus(value) {
  const status = safeRunStatus(value);
  return TERMINAL.has(status) ? "running" : status;
}

function correlatedAgentRun(value, { runId, threadId }) {
  if (!value || typeof value !== "object" || value.id !== runId || value.threadId !== threadId) {
    throw new AgintiProtocolError("Agent run ownership does not match the requested thread", {
      code: "LEDGER_OWNERSHIP_MISMATCH",
    });
  }
  return value;
}

function correlatedResumedAgentRun(value, { previousRunId, threadId }) {
  if (!value || typeof value !== "object" || value.threadId !== threadId
      || value.previousRunId !== previousRunId || value.id === previousRunId) {
    throw new AgintiProtocolError("Resumed Agent run does not extend the requested run", {
      code: "LEDGER_OWNERSHIP_MISMATCH",
    });
  }
  return value;
}

function assertTerminalAgentReplay(run, snapshot) {
  const cursor = run?.eventCursor;
  if (!TERMINAL.has(run?.status)
      || snapshot?.terminalStatus !== run.status
      || snapshot.status !== run.status
      || !cursor || typeof cursor !== "object"
      || cursor.firstSeq !== 1 || cursor.prunedThroughSeq !== 0
      || snapshot.cursor.seq !== cursor.lastSeq
      || snapshot.cursor.hash !== cursor.lastHash) {
    throw new AgintiProtocolError("Agent terminal history does not match its authoritative cursor", {
      code: "LEDGER_TERMINAL_MISMATCH",
    });
  }
  return snapshot;
}

function persistedThreadRunIds(thread) {
  const result = [];
  const seen = new Set();
  for (const message of Array.isArray(thread?.messages) ? thread.messages : []) {
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    if (message.runId === thread?.lastRunId || seen.has(message.runId)) continue;
    seen.add(message.runId);
    result.push(message.runId);
  }
  if (thread?.lastRunId) result.push(thread.lastRunId);
  return Object.freeze(result);
}

function loginFailureMessage(error) {
  const status = Number(error?.status ?? error?.statusCode ?? 0);
  if (status === 401 || status === 403) return "Sign-in failed. Check the account and try again.";
  if (status === 429) return "Sign-in is temporarily busy. Wait a moment and try again.";
  return "The sign-in service is unavailable. Please try again shortly.";
}

function elementMap(document) {
  if (!document || typeof document.getElementById !== "function" || typeof document.createElement !== "function") {
    throw new TypeError("browser app requires a DOM document");
  }
  const ids = [
    "login-view", "app-view", "login-form", "login-submit", "login-error", "username", "password", "remember-session",
    "signed-in-user", "logout", "new-thread", "thread-list", "workspace", "conversation-title",
    "connection-state", "mode-switch", "agent-mode", "chat-mode", "theme-picker", "offline-banner",
    "update-banner", "apply-update", "defer-update", "context-indicator", "context-indicator-text", "welcome",
    "welcome-eyebrow", "welcome-copy", "messages", "activity-panel", "run-state", "agent-plan",
    "agent-timeline", "agent-artifacts", "composer", "message-input", "send-message", "resume-run",
    "stop-run", "image-input", "add-image", "image-preview", "image-preview-thumbnail",
    "image-preview-label", "remove-image", "install-app", "toast", "sidebar", "sidebar-scrim", "open-sidebar",
    "search-controls", "search-toggle", "search-options", "search-mode", "search-limit", "capability-note",
  ];
  return Object.freeze(Object.fromEntries(ids.map((id) => {
    const value = document.getElementById(id);
    if (!value) throw new TypeError(`app shell is missing #${id}`);
    return [id.replaceAll("-", "_"), value];
  })));
}

function makeButton(document, label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function statusLabel(status) {
  return status.slice(0, 1).toUpperCase() + status.slice(1).replaceAll("_", " ");
}

export function createBrowserApp({
  document = globalThis.document,
  window = globalThis.window,
  navigator = globalThis.navigator,
  sessionClient: suppliedSessionClient,
  createAgentClient: suppliedAgentClientFactory,
  createChatClient: suppliedChatClientFactory,
  renderer,
  cursorStore,
  credentialSaver = offerPasswordManagerSave,
  confirmThreadDeletion = (message) => window?.confirm?.(message) === true,
  canonicalizeImage = canonicalizeVisionImage,
  createObjectUrl = (blob) => globalThis.URL.createObjectURL(blob),
  revokeObjectUrl = (url) => globalThis.URL.revokeObjectURL(url),
  updateHandoffStore: suppliedUpdateHandoffStore,
  serviceWorkerPath,
  serviceWorkerScope,
  updateCheckIntervalMs = 15 * 60 * 1_000,
  updateDeferralMs = 60 * 60 * 1_000,
  activationTimeoutMs = 30_000,
  attachmentDecodeTimeoutMs = 15_000,
  attachmentMemoryLimitBytes = DEFAULT_ATTACHMENT_MEMORY_LIMIT_BYTES,
  attachmentDecodedMemoryLimitBytes = DEFAULT_ATTACHMENT_DECODED_MEMORY_LIMIT_BYTES,
  now = Date.now,
  maxStreamBackoffSteps = 5,
  wait = (milliseconds, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    }, { once: true });
  }),
} = {}) {
  const browserBaseUrl = window?.location?.href ?? globalThis.location?.href;
  const declaredRelease = metaContent(document, "lazying-agent-release");
  const currentRelease = validAgentRelease(declaredRelease) ? declaredRelease : null;
  const sessionClient = suppliedSessionClient ?? new CloudSessionClient({
    baseUrl: browserBaseUrl,
    releaseId: currentRelease,
  });
  const createAgentClient = suppliedAgentClientFactory ?? ((session) => new AgintiBrowserClient({
    transportEndpoint: "/api/transport",
    baseUrl: browserBaseUrl,
    csrfToken: () => sessionClient.csrfToken?.() ?? session.csrfToken,
    releaseId: currentRelease,
  }));
  const createChatClient = suppliedChatClientFactory ?? ((session) => new DirectChatBrowserClient({
    baseUrl: browserBaseUrl,
    csrfToken: () => sessionClient.csrfToken?.() ?? session.csrfToken,
    releaseId: currentRelease,
  }));
  requiredMethod(sessionClient, "restore", "sessionClient");
  requiredMethod(sessionClient, "login", "sessionClient");
  requiredMethod(sessionClient, "logout", "sessionClient");
  if (typeof createAgentClient !== "function" || typeof createChatClient !== "function") {
    throw new TypeError("client factories are required");
  }
  requiredMethod(renderer, "renderMarkdown", "renderer");
  requiredMethod(renderer, "renderArtifact", "renderer");
  if (cursorStore !== undefined) requiredMethod(cursorStore, "save", "cursorStore");
  if (typeof credentialSaver !== "function") throw new TypeError("credentialSaver must be a function");
  if (typeof confirmThreadDeletion !== "function") {
    throw new TypeError("confirmThreadDeletion must be a function");
  }
  if (typeof canonicalizeImage !== "function" || typeof createObjectUrl !== "function"
      || typeof revokeObjectUrl !== "function") {
    throw new TypeError("browser image handlers must be functions");
  }
  const updateHandoffStore = suppliedUpdateHandoffStore
    ?? createBrowserUpdateHandoffStore();
  for (const method of ["save", "take", "discard"]) {
    requiredMethod(updateHandoffStore, method, "updateHandoffStore");
  }
  const workerScope = normalizedBrowserPath(
    serviceWorkerScope ?? metaContent(document, "lazying-agent-base-path") ?? "/",
    "serviceWorkerScope",
    { trailingSlash: true },
  );
  const expectedWorkerPath = workerScope === "/" ? "/sw.js" : `${workerScope.slice(0, -1)}/sw.js`;
  const workerPath = normalizedBrowserPath(
    serviceWorkerPath ?? metaContent(document, "lazying-agent-service-worker") ?? expectedWorkerPath,
    "serviceWorkerPath",
  );
  if (workerPath !== expectedWorkerPath) throw new TypeError("serviceWorkerPath must be bound to serviceWorkerScope");
  const claimedUpdateHandoff = captureUpdateHandoffClaim(window);
  if (!Number.isSafeInteger(updateCheckIntervalMs) || updateCheckIntervalMs < 60_000 || updateCheckIntervalMs > 86_400_000) {
    throw new TypeError("updateCheckIntervalMs must be from one minute through one day");
  }
  if (!Number.isSafeInteger(updateDeferralMs) || updateDeferralMs < 60_000 || updateDeferralMs > 86_400_000) {
    throw new TypeError("updateDeferralMs must be from one minute through one day");
  }
  if (!Number.isSafeInteger(activationTimeoutMs) || activationTimeoutMs < 5_000 || activationTimeoutMs > 300_000) {
    throw new TypeError("activationTimeoutMs must be from five seconds through five minutes");
  }
  if (!Number.isSafeInteger(attachmentDecodeTimeoutMs) || attachmentDecodeTimeoutMs < 1
      || attachmentDecodeTimeoutMs > 60_000) {
    throw new TypeError("attachmentDecodeTimeoutMs must be from one millisecond through one minute");
  }
  if (!Number.isSafeInteger(attachmentMemoryLimitBytes) || attachmentMemoryLimitBytes < 1
      || attachmentMemoryLimitBytes > 32 * 1024 * 1024) {
    throw new TypeError("attachmentMemoryLimitBytes must be from one byte through 32 MiB");
  }
  if (!Number.isSafeInteger(attachmentDecodedMemoryLimitBytes) || attachmentDecodedMemoryLimitBytes < 1
      || attachmentDecodedMemoryLimitBytes > 64 * 1024 * 1024) {
    throw new TypeError("attachmentDecodedMemoryLimitBytes must be from one byte through 64 MiB");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (!Number.isSafeInteger(maxStreamBackoffSteps) || maxStreamBackoffSteps < 0 || maxStreamBackoffSteps > 20) {
    throw new TypeError("maxStreamBackoffSteps must be an integer from 0 through 20");
  }
  if (typeof wait !== "function") throw new TypeError("wait must be a function");
  const elements = elementMap(document);
  const state = {
    initialized: false,
    bound: false,
    loginReady: false,
    loginPending: false,
    logoutPending: false,
    session: Object.freeze({ authenticated: false }),
    capabilities: FAIL_CLOSED_AGENT_CAPABILITIES,
    chatCapabilities: Object.freeze({ visionInput: false, visionMediaTypes: Object.freeze([]), maximumImageBytes: 0 }),
    agent: null,
    chat: null,
    mode: "chat",
    agentThreads: [],
    chatThreads: [],
    chatThreadListEpoch: 0,
    agentThreadId: null,
    chatThreadId: null,
    chatThread: null,
    chatGeneration: null,
    chatAfterSequence: 0,
    chatOutput: "",
    chatPendingSend: null,
    chatPendingDeletion: null,
    chatFinalization: null,
    chatHistoryRestoration: null,
    chatFailureDiagnostic: null,
    authRecoveryPending: false,
    authRecoveryUsername: null,
    authRecoveryWorkflow: null,
    authRecoveryGeneration: null,
    authRecoveryAgent: null,
    authRecoveryLegacyUpdatePending: false,
    authRecoveryLegacyMode: null,
    authRecoveryLegacyDestinationChosen: false,
    authRecoveryLegacyDestinationThreadId: null,
    selectedImages: Object.freeze([]),
    selectedImageUrls: Object.freeze([]),
    imagePreparing: false,
    imagePreparationAbort: null,
    imageSelectionEpoch: 0,
    imageRenderEpoch: 0,
    messageImageUrls: new Set(),
    localMessageImageUrls: new Set(),
    attachmentBlobCache: new Map(),
    attachmentBlobCacheBytes: 0,
    renderedAttachmentPreviews: new Map(),
    renderedAttachmentPreviewBytes: 0,
    attachmentRestoreObserver: undefined,
    attachmentRestoreObserved: new Map(),
    attachmentRestoreQueue: [],
    attachmentRestoreActive: 0,
    attachmentRestoreControllers: new Set(),
    runId: null,
    agentRunStatus: null,
    presentation: null,
    assistantNode: null,
    agentRunMessages: new Map(),
    agentHistoryRestoring: false,
    agentReplayValidating: false,
    agentReplayFailed: false,
    agentReplayOfferResume: true,
    agentCancelPending: false,
    agentPendingResume: null,
    agentPendingThreadCreate: null,
    agentSearchSelected: false,
    agentSearchRecoveryChoicePending: false,
    legacyUpdateRecoveryPending: false,
    legacyUpdateRecoveryDestinationChosen: false,
    legacyUpdateRecoveryDestinationThreadId: null,
    unavailableAgentUpdateRecovery: false,
    retainedUpdateRecoveryPending: false,
    retainedUpdateRecoveryDurable: false,
    retainedUpdateRecoveryThreadId: null,
    retainedUpdateRecoveryRecord: null,
    retainedUpdateRecoveryInstalled: false,
    retainedUpdateRecoveryInstallation: null,
    protectedComposerReplacementConfirmation: null,
    agentAuthenticationRecoveryPending: false,
    agentAuthenticationRecoveryThreadId: null,
    agentAuthenticationRecoveryVerified: false,
    streamAbort: null,
    streamKind: null,
    viewEpoch: 0,
    busy: false,
    installPrompt: null,
    updateRegistration: null,
    updateDeferredUntil: Number.NEGATIVE_INFINITY,
    updateDeferredWorker: null,
    updateDeferralTimer: null,
    updateActivationTimer: null,
    showUpdatePrompt: null,
    updateConfirmed: false,
    updateConfirmedWorker: null,
    updateOfferedWorker: null,
    updateControllerChanged: false,
    updateController: null,
    updateTargetRelease: null,
    updateKnownWorkerReleases: new WeakMap(),
    updateObservedWaitingWorkers: new WeakSet(),
    updateActiveControllerRelease: null,
    retryUpdateControllerRelease: null,
    updateReleaseQueries: new Map(),
    updateReleaseTimer: null,
    updateSafetyTimer: null,
    updatePollTimer: null,
    updateReloaded: false,
    updateHandoffConsumed: false,
    updateHandoffEpoch: 0,
    updateHandoffInFlight: false,
    updateHandoffStagingClaim: null,
    updatePreparedHandoff: null,
    updateCheckAt: Number.NEGATIVE_INFINITY,
    updateFailureAt: Number.NEGATIVE_INFINITY,
    updateCheckInFlight: false,
    updateCheckPending: false,
    updateCheckPendingOnlineTransition: false,
    sessionRevalidationInFlight: false,
    sessionRevalidationPending: false,
  };

  function showToast(message) {
    elements.toast.textContent = String(message).slice(0, 400);
    elements.toast.hidden = false;
    window?.setTimeout?.(() => { elements.toast.hidden = true; }, 4_000);
  }

  function connection(label, online = true) {
    elements.connection_state.textContent = label;
    elements.connection_state.dataset.online = online ? "true" : "false";
  }

  function clearChatFailureDiagnostic() {
    state.chatFailureDiagnostic = null;
    for (const key of ["failureStage", "failureCode", "failureOperation"]) {
      delete elements.connection_state.dataset[key];
      delete elements.workspace.dataset[key];
    }
  }

  function applyChatFailureDiagnostic(error) {
    const diagnostic = chatFailureDiagnostic(error);
    state.chatFailureDiagnostic = diagnostic;
    for (const target of [elements.connection_state, elements.workspace]) {
      target.dataset.failureStage = diagnostic.stage;
      target.dataset.failureCode = diagnostic.code;
      target.dataset.failureOperation = diagnostic.operation;
    }
    connection(`Request not sent · ${diagnostic.label}`, false);
    return diagnostic;
  }

  function loginControl({ ready, label }) {
    state.loginReady = ready === true;
    elements.login_submit.disabled = !state.loginReady;
    elements.login_submit.textContent = String(label);
    elements.login_form.setAttribute("aria-busy", state.loginReady ? "false" : "true");
  }

  function showLogin(message = "", { preservePassword = false } = {}) {
    elements.login_view.hidden = false;
    elements.app_view.hidden = true;
    elements.logout.disabled = true;
    elements.login_error.textContent = message;
    elements.login_error.hidden = !message;
    if (!preservePassword) elements.password.value = "";
  }

  function showApp() {
    elements.login_view.hidden = true;
    elements.app_view.hidden = false;
    elements.signed_in_user.textContent = state.session.username;
    elements.login_error.hidden = true;
  }

  function captureChatReadRecovery({
    threadId = state.chatThreadId ?? state.chatGeneration?.threadId ?? null,
    generationId = state.chatGeneration?.generationId ?? null,
  } = {}) {
    if (typeof threadId !== "string" || threadId.length < 1) return null;
    const generation = state.chatGeneration?.generationId === generationId ? state.chatGeneration : null;
    return Object.freeze({
      threadId,
      thread: state.chatThread?.threadId === threadId ? state.chatThread : null,
      generationId: typeof generationId === "string" && generationId.length > 0 ? generationId : null,
      generation,
      afterSequence: Number.isSafeInteger(state.chatAfterSequence) && state.chatAfterSequence >= 0
        ? state.chatAfterSequence
        : 0,
      output: typeof state.chatOutput === "string" ? state.chatOutput : "",
    });
  }

  function captureAgentAuthenticationRecovery() {
    if (state.mode !== "agent") return null;
    const retained = state.retainedUpdateRecoveryPending
      && state.retainedUpdateRecoveryRecord?.mode === "agent"
      ? state.retainedUpdateRecoveryRecord
      : null;
    if (retained !== null) {
      return Object.freeze({
        threadId: retained.threadId,
        draft: retained.draft,
        search: retained.search,
        searchInvalid: false,
      });
    }
    let search = null;
    // An unresolved capability downgrade is not equivalent to the user
    // choosing No Search. Preserve that ambiguity across another auth expiry.
    let searchInvalid = state.agentSearchRecoveryChoicePending;
    try { search = updateHandoffSearch(); }
    catch { searchInvalid = state.agentSearchSelected; }
    return Object.freeze({
      threadId: typeof state.agentThreadId === "string" ? state.agentThreadId : null,
      draft: String(elements.message_input.value ?? ""),
      search,
      searchInvalid,
    });
  }

  function requireFreshAuthentication({
    workflow = null,
    generationRecovery = null,
    agentRecovery = captureAgentAuthenticationRecovery(),
  } = {}) {
    if (!state.session.authenticated) return false;
    const recoveryUsername = normalizedSessionUsername(state.session.username);
    const legacyUpdateRecovery = state.legacyUpdateRecoveryPending;
    const legacyRecoveryMode = legacyUpdateRecovery ? state.mode : null;
    const legacyDestinationChosen = legacyUpdateRecovery
      && state.legacyUpdateRecoveryDestinationChosen;
    const legacyDestinationThreadId = legacyDestinationChosen
      ? state.legacyUpdateRecoveryDestinationThreadId
      : null;
    let legacySearch = null;
    let legacySearchInvalid = false;
    if (legacyDestinationChosen && legacyRecoveryMode === "agent") {
      try { legacySearch = updateHandoffSearch(); }
      catch { legacySearchInvalid = state.agentSearchSelected; }
    }
    const legacyAgentRecovery = legacyDestinationChosen && legacyRecoveryMode === "agent"
      ? Object.freeze({
          threadId: legacyDestinationThreadId,
          draft: state.retainedUpdateRecoveryRecord?.draft
            ?? String(elements.message_input.value ?? ""),
          search: legacySearch,
          searchInvalid: legacySearchInvalid,
        })
      : null;
    const exactAgentRecovery = legacyUpdateRecovery ? legacyAgentRecovery : agentRecovery;
    if (state.imagePreparing) cancelImagePreparation();
    state.viewEpoch += 1;
    state.streamAbort?.abort();
    clearConversation();
    purgeAttachmentBlobCache();
    state.streamAbort = null;
    state.streamKind = null;
    state.session = Object.freeze({ authenticated: false });
    state.agent = null;
    state.chat = null;
    state.capabilities = FAIL_CLOSED_AGENT_CAPABILITIES;
    state.chatCapabilities = Object.freeze({ visionInput: false, visionMediaTypes: Object.freeze([]), maximumImageBytes: 0 });
    state.agentThreads = [];
    state.chatThreadListEpoch += 1;
    state.chatThreads = [];
    state.agentThreadId = null;
    state.chatThreadId = null;
    state.chatThread = null;
    state.chatGeneration = null;
    state.chatPendingSend = workflow;
    state.chatPendingDeletion = null;
    state.chatFinalization = null;
    state.runId = null;
    state.agentRunStatus = null;
    state.agentSearchSelected = false;
    state.agentAuthenticationRecoveryVerified = false;
    state.mode = "chat";
    state.authRecoveryPending = true;
    state.authRecoveryUsername = recoveryUsername;
    state.authRecoveryWorkflow = workflow;
    state.authRecoveryGeneration = generationRecovery;
    state.authRecoveryAgent = exactAgentRecovery;
    state.authRecoveryLegacyUpdatePending = legacyUpdateRecovery;
    state.authRecoveryLegacyMode = legacyRecoveryMode;
    state.authRecoveryLegacyDestinationChosen = legacyDestinationChosen;
    state.authRecoveryLegacyDestinationThreadId = legacyDestinationThreadId;
    elements.resume_run.hidden = workflow === null;
    elements.logout.disabled = true;
    showLogin(legacyUpdateRecovery
      ? "Your session expired. Sign in again, then choose the exact destination for the protected prompt from the previous app version."
      : exactAgentRecovery !== null
      ? "Your session expired. Sign in again to verify the exact Agent conversation; your prompt remains preserved."
      : generationRecovery !== null
      ? "Your session expired. Sign in again to reconnect to the server-owned generation; your draft and image are preserved."
      : "Your session expired. Sign in again; your unsent draft and image are preserved.");
    loginControl({ ready: true, label: "Sign in" });
    return true;
  }

  function agentMutationBlocksSessionRevalidation() {
    return state.mode === "agent" && (state.busy
      || state.agentHistoryRestoring || state.agentReplayValidating
      || state.agentCancelPending
      || state.agentPendingThreadCreate !== null || state.agentPendingResume !== null);
  }

  function flushDeferredSessionRevalidation() {
    if (!state.sessionRevalidationPending || state.sessionRevalidationInFlight
        || agentMutationBlocksSessionRevalidation()) return;
    state.sessionRevalidationPending = false;
    void revalidateSessionOnResume();
  }

  async function revalidateSessionOnResume() {
    if (!state.initialized || !state.session.authenticated
        || document?.visibilityState === "hidden" || state.updateReloaded) return false;
    if (agentMutationBlocksSessionRevalidation()) {
      state.sessionRevalidationPending = true;
      return false;
    }
    if (state.sessionRevalidationInFlight) {
      state.sessionRevalidationPending = true;
      return false;
    }
    state.sessionRevalidationInFlight = true;
    const ownedSession = state.session;
    try {
      const restored = sessionEnvelope(await sessionClient.restore());
      if (state.session !== ownedSession || !state.session.authenticated) return false;
      if (!restored.authenticated
          || normalizedSessionUsername(restored.username) !== normalizedSessionUsername(ownedSession.username)
          || restored.csrfToken !== ownedSession.csrfToken) {
        if (agentMutationBlocksSessionRevalidation()) {
          state.sessionRevalidationPending = true;
          return false;
        }
        requireFreshAuthentication({
          workflow: state.mode === "chat" ? state.chatPendingSend : null,
          generationRecovery: state.mode === "chat" ? captureChatReadRecovery() : null,
        });
        return false;
      }
      return true;
    } catch (error) {
      const targetRelease = clientReleaseMismatch(error);
      if (targetRelease !== null) {
        await refreshForReleaseMismatch(targetRelease);
      } else if (state.session === ownedSession && (isChatAuthenticationRejection(error)
          || error?.code === "csrf_rejected" || error?.status === 403)) {
        if (agentMutationBlocksSessionRevalidation()) {
          state.sessionRevalidationPending = true;
          return false;
        }
        requireFreshAuthentication({
          workflow: state.mode === "chat" ? state.chatPendingSend : null,
          generationRecovery: state.mode === "chat" ? captureChatReadRecovery() : null,
        });
      }
      return false;
    } finally {
      state.sessionRevalidationInFlight = false;
      flushDeferredSessionRevalidation();
    }
  }

  function recoverChatReadAuthentication(error, recovery) {
    return isChatAuthenticationRejection(error)
      && requireFreshAuthentication({ workflow: null, generationRecovery: recovery });
  }

  function renderSelectedImages() {
    const first = state.selectedImages[0];
    elements.image_preview_thumbnail.src = state.selectedImageUrls[0] ?? "";
    if (first === undefined) {
      elements.image_preview_label.textContent = "";
      elements.image_preview.hidden = true;
      return;
    }
    const bytes = state.selectedImages.reduce((total, image) => total + image.byteLength, 0);
    elements.image_preview_label.textContent = state.selectedImages.length === 1
      ? `${first.width}×${first.height} · ${Math.ceil(bytes / 1024)} KiB`
      : `${state.selectedImages.length} images · ${Math.ceil(bytes / 1024)} KiB total`;
    elements.image_preview.hidden = false;
  }

  function cancelImagePreparation() {
    state.imageSelectionEpoch += 1;
    state.imagePreparationAbort?.abort();
    state.imagePreparationAbort = null;
    state.imagePreparing = false;
    elements.image_input.value = "";
    renderSelectedImages();
  }

  function detachSelectedImage() {
    invalidatePreparedUpdateHandoff();
    cancelImagePreparation();
    const detached = state.selectedImages.length === 0 ? null : Object.freeze({
      selected: state.selectedImages,
      previewUrls: state.selectedImageUrls,
    });
    state.selectedImages = Object.freeze([]);
    state.selectedImageUrls = Object.freeze([]);
    elements.image_input.value = "";
    elements.image_preview_thumbnail.src = "";
    elements.image_preview_label.textContent = "";
    elements.image_preview.hidden = true;
    return detached;
  }

  function disposeDetachedImage(detached) {
    for (const previewUrl of detached?.previewUrls ?? []) revokeObjectUrl(previewUrl);
  }

  function clearSelectedImage() {
    disposeDetachedImage(detachSelectedImage());
  }

  function restoreDetachedImage(detached) {
    if (!detached || state.selectedImages.length !== 0 || !state.session.authenticated
        || state.mode !== "chat" || state.chatCapabilities.visionInput !== true) {
      disposeDetachedImage(detached);
      return false;
    }
    state.selectedImages = detached.selected;
    state.selectedImageUrls = detached.previewUrls;
    renderSelectedImages();
    return true;
  }

  function interactionLocked() {
    return state.busy || state.logoutPending || state.chatFinalization !== null
      || (claimedUpdateHandoff !== null && !state.updateHandoffConsumed)
      || state.chatHistoryRestoration !== null
      || state.authRecoveryGeneration !== null
      || state.agentHistoryRestoring || state.agentReplayValidating || state.agentCancelPending
      || state.agentPendingResume !== null;
  }

  function updateSearchControl() {
    const capability = state.capabilities.search;
    const available = state.session.authenticated && state.mode === "agent"
      && state.capabilities.enabled === true && capability?.enabled === true;
    if (!available) state.agentSearchSelected = false;
    const maximum = available ? capability.maximumSources : 0;
    if (available && !capability.modes.includes(elements.search_mode.value)) elements.search_mode.value = capability.modes[0];
    if (available) {
      const selectedLimit = Number(elements.search_limit.value);
      if (!Number.isSafeInteger(selectedLimit) || selectedLimit < 1 || selectedLimit > maximum) {
        elements.search_limit.value = String(Math.min(8, maximum));
      }
    }
    elements.search_controls.hidden = !available;
    elements.search_toggle.setAttribute("aria-pressed", state.agentSearchSelected ? "true" : "false");
    elements.search_options.hidden = !available || !state.agentSearchSelected;
    elements.search_limit.max = String(maximum);
    const disabled = !available || interactionLocked();
    elements.search_toggle.disabled = disabled;
    elements.search_mode.disabled = disabled || !state.agentSearchSelected;
    elements.search_limit.disabled = disabled || !state.agentSearchSelected;
  }

  function updateCapabilityNote() {
    if (state.mode === "agent" && state.capabilities.enabled === true) {
      const fileCreation = state.capabilities.artifacts.kinds.includes("file");
      const search = state.capabilities.search?.enabled === true;
      const additions = [
        ...(fileCreation ? ["TeX/PDF files"] : []),
        ...(search ? ["optional web/paper Search"] : []),
      ];
      const unavailable = [
        "image input",
        ...(!fileCreation ? ["file creation"] : []),
        ...(!search ? ["web search"] : []),
      ];
      elements.capability_note.textContent = [
        "Agent · bounded Python 3.12 standard library · plots/tables/Markdown",
        ...additions,
        `no ${unavailable.join(", ")}`,
      ].join(" · ") + ".";
      return;
    }
    const input = state.chatCapabilities.visionInput === true ? "text + up to four images" : "text only";
    const availability = state.capabilities.enabled === true ? "switch to Agent for tools" : "Agent unavailable";
    elements.capability_note.textContent =
      `Chat · LocalLLM ${input} · no tools, file creation, or web search · ${availability}.`;
  }

  function selectedAgentSearch() {
    if (!state.agentSearchSelected) return undefined;
    const capability = state.capabilities.search;
    if (state.mode !== "agent" || state.capabilities.enabled !== true || capability?.enabled !== true) {
      throw new TypeError("Agent search is not available");
    }
    const search = validateAgentSearch({
      mode: elements.search_mode.value,
      limit: Number(elements.search_limit.value),
    });
    if (!capability.modes.includes(search.mode) || search.limit > capability.maximumSources) {
      throw new TypeError("Agent search selection exceeds the negotiated capability");
    }
    return search;
  }

  function updateHandoffSearch() {
    return state.mode === "agent" && state.agentSearchSelected ? selectedAgentSearch() : null;
  }

  function sameUpdateHandoffSearch(left, right) {
    return left === null || right === null
      ? left === right
      : left.mode === right.mode && left.limit === right.limit;
  }

  function updateImageControl() {
    const available = state.session.authenticated && state.mode === "chat"
      && state.chatCapabilities.visionInput === true;
    const pendingChatSend = state.mode === "chat" && state.chatPendingSend !== null;
    const pendingChatDeletion = state.mode === "chat" && state.chatPendingDeletion !== null;
    const locked = interactionLocked();
    const pendingAgentResume = state.mode === "agent" && state.agentPendingResume !== null;
    const agentDispatchFenced = state.mode === "agent" && state.agentReplayFailed;
    const searchChoiceReady = agentSearchRecoveryChoiceReady();
    const preservingAuthenticationDraft = state.authRecoveryPending && state.selectedImages.length > 0;
    const preservingAmbiguousImage = state.chatPendingSend?.ambiguousMutation !== null
      && state.chatPendingSend?.ambiguousMutation !== undefined
      && state.selectedImages.length > 0;
    const fencedImage = preservingAuthenticationDraft || preservingAmbiguousImage;
    if (!available && !fencedImage && (state.imagePreparing || state.selectedImages.length > 0)) clearSelectedImage();
    elements.add_image.hidden = !available;
    elements.add_image.textContent = state.imagePreparing ? "Preparing images…" : "Images";
    elements.add_image.setAttribute(
      "aria-label",
      state.imagePreparing ? "Preparing images…" : "Add images",
    );
    elements.add_image.disabled = !available || locked || state.imagePreparing || pendingChatSend || pendingChatDeletion
      || state.selectedImages.length >= COMPOSER_IMAGE_COUNT_LIMIT;
    elements.remove_image.disabled = (!available && !preservingAuthenticationDraft) || locked || pendingChatSend
      || pendingChatDeletion
      || (state.selectedImages.length === 0 && !state.imagePreparing);
    elements.message_input.disabled = !state.session.authenticated || (locked && !pendingAgentResume)
      || state.imagePreparing || pendingChatSend
      || pendingChatDeletion
      || preservingAuthenticationDraft || state.retainedUpdateRecoveryPending
      || state.agentAuthenticationRecoveryPending;
    elements.send_message.disabled = !state.session.authenticated || locked || state.imagePreparing || pendingChatSend
      || pendingChatDeletion
      || preservingAuthenticationDraft || agentDispatchFenced
      || (state.legacyUpdateRecoveryPending && !searchChoiceReady)
      || (state.retainedUpdateRecoveryPending && !searchChoiceReady)
      || (state.agentAuthenticationRecoveryPending && !searchChoiceReady);
    elements.new_thread.disabled = !state.session.authenticated || locked || pendingChatSend || pendingChatDeletion
      || preservingAuthenticationDraft;
    elements.agent_mode.disabled = !state.session.authenticated || !state.capabilities.enabled || locked
      || pendingChatDeletion || preservingAuthenticationDraft;
    elements.chat_mode.disabled = !state.session.authenticated || locked || pendingChatDeletion
      || preservingAuthenticationDraft;
    elements.composer.setAttribute("aria-busy", locked || state.imagePreparing || pendingChatSend || pendingChatDeletion
      ? "true" : "false");
    elements.workspace.setAttribute("aria-busy", state.chatFinalization === null ? "false" : "true");
    for (const row of elements.thread_list.children ?? []) {
      const buttons = row.className === "thread-row" ? row.children : [row];
      for (const button of buttons) {
        button.disabled = locked || pendingChatSend || button.dataset.threadBlocked === "true"
          || (state.agentSearchRecoveryChoicePending
            && !agentRecoveryThreadRetryAllowed(button.dataset.threadId))
          || (pendingChatDeletion && button.dataset.threadDeleteRetry !== "true");
      }
    }
    updateSearchControl();
    scheduleSafeUpdateReload();
  }

  function currentThreads() {
    return state.mode === "agent" ? state.agentThreads : state.chatThreads;
  }

  function currentThreadId() {
    return state.mode === "agent" ? state.agentThreadId : state.chatThreadId;
  }

  function agentRecoveryThreadRetryAllowed(threadId) {
    if (state.mode !== "agent" || !state.agentSearchRecoveryChoicePending
        || !state.agentReplayFailed) return false;
    const recoveryThreadId = state.retainedUpdateRecoveryThreadId
      ?? state.agentAuthenticationRecoveryThreadId;
    return recoveryThreadId !== null && threadId === recoveryThreadId;
  }

  function setMode(mode, {
    restoreView = true,
    remember = true,
    allowUnavailableAgentRecovery = false,
    allowRetainedUpdateRecovery = false,
    allowAgentAuthenticationRecovery = false,
  } = {}) {
    const agentAvailable = state.capabilities.enabled === true;
    const nextMode = mode === "agent" && (agentAvailable || allowUnavailableAgentRecovery) ? "agent" : "chat";
    const changed = nextMode !== state.mode;
    if (changed && interactionLocked()) return;
    if (changed && state.agentSearchRecoveryChoicePending
        && !allowRetainedUpdateRecovery && !allowAgentAuthenticationRecovery) {
      showToast("Confirm Search or No Search for the recovered Agent prompt before changing modes.");
      return;
    }
    if (changed && state.agentAuthenticationRecoveryPending && !allowAgentAuthenticationRecovery) {
      showToast("Verify the recovered Agent conversation, or choose New conversation, before changing modes.");
      return;
    }
    if (changed && state.retainedUpdateRecoveryPending && !state.legacyUpdateRecoveryPending
        && !allowRetainedUpdateRecovery) {
      showToast("Resume verification of the exact Agent conversation, or choose New conversation after Agent is available to detach the recovered prompt.");
      return;
    }
    if (changed && state.mode === "agent" && state.agentPendingThreadCreate !== null) {
      showToast("Retry the ready prompt to confirm its exact Agent conversation before changing modes.");
      return;
    }
    if (changed && state.mode === "chat" && state.chatPendingDeletion) {
      showToast("Confirm the pending conversation deletion before changing modes.");
      return;
    }
    if (changed && state.mode === "chat" && state.chatPendingSend) {
      showToast("Confirm the pending durable send with Resume before changing modes.");
      return;
    }
    if (changed) {
      state.viewEpoch += 1;
      state.streamAbort?.abort();
      state.agentSearchSelected = false;
    }
    state.mode = nextMode;
    if (remember && state.session.authenticated) rememberWorkspaceMode(state.mode);
    elements.workspace.dataset.mode = state.mode;
    elements.mode_switch.hidden = !agentAvailable;
    elements.agent_mode.setAttribute("aria-pressed", state.mode === "agent" ? "true" : "false");
    elements.chat_mode.setAttribute("aria-pressed", state.mode === "chat" ? "true" : "false");
    elements.activity_panel.hidden = state.mode !== "agent";
    const sendLabel = state.mode === "agent" ? "Run Agent" : "Send Chat";
    elements.send_message.textContent = sendLabel;
    elements.send_message.setAttribute("aria-label", sendLabel);
    elements.welcome_eyebrow.textContent = state.mode === "agent" ? "AgInTi Agent" : "Direct LocalLLM chat";
    elements.welcome_copy.textContent = state.mode === "agent"
      ? "AgInTi owns planning, tools, context, compaction, runs, and artifacts."
      : "Durable server-owned conversations with LocalLLM, without Agent tools or browser-owned history.";
    elements.message_input.placeholder = state.mode === "agent" ? "Ask AgInTi Agent" : "Message LocalLLM";
    updateCapabilityNote();
    updateImageControl();
    renderThreads();
    if (changed && restoreView && state.session.authenticated) {
      void restoreModeView({ autoOpen: !state.legacyUpdateRecoveryPending }).catch(async (error) => {
        const targetRelease = clientReleaseMismatch(error);
        if (targetRelease !== null) {
          try { await refreshForReleaseMismatch(targetRelease); }
          catch { showToast("The required app update could not be opened yet; protected work remains on this page."); }
        } else {
          connection(state.mode === "agent" ? "Agent unavailable" : "Chat unavailable", false);
          showToast(state.mode === "agent"
            ? "Agent conversations could not be loaded safely."
            : "LocalLLM conversations could not be loaded safely.");
        }
      });
    }
  }

  function resetAttachmentRestorations({ deferQueued = false } = {}) {
    state.attachmentRestoreObserver?.disconnect?.();
    state.attachmentRestoreObserver = undefined;
    state.attachmentRestoreObserved.clear();
    const queued = deferQueued ? [...state.attachmentRestoreQueue] : [];
    state.attachmentRestoreQueue.length = 0;
    for (const controller of state.attachmentRestoreControllers) controller.abort();
    for (const job of queued) deferAttachmentRestorationJob(job);
  }

  function purgeAttachmentBlobCache() {
    for (const key of [...state.attachmentBlobCache.keys()]) forgetAttachmentBlob(key);
  }

  function purgeAttachmentBlobCacheForThread(threadId) {
    for (const [key, entry] of [...state.attachmentBlobCache.entries()]) {
      if (entry.threadId === threadId) forgetAttachmentBlob(key);
    }
  }

  function deferAttachmentRestorationJob(job) {
    job.image.src = "";
    job.image.hidden = true;
    job.image.alt = "Attached image preview not loaded";
    job.image.dataset.previewState = "deferred";
    job.status.textContent = "Load attached image preview again";
    job.status.hidden = false;
    job.status.disabled = false;
    job.article.dataset.attachmentState = "deferred";
    job.started = false;
  }

  function deferRenderedAttachmentPreview(entry) {
    deferAttachmentRestorationJob(entry.job);
  }

  function forgetRenderedAttachmentPreview(key, { defer = true, expectedUrl } = {}) {
    const entry = state.renderedAttachmentPreviews.get(key);
    if (entry === undefined || (expectedUrl !== undefined && entry.url !== expectedUrl)) return false;
    state.renderedAttachmentPreviews.delete(key);
    state.renderedAttachmentPreviewBytes -= entry.decodedBytes;
    if (state.messageImageUrls.delete(entry.url)) revokeObjectUrl(entry.url);
    if (defer) deferRenderedAttachmentPreview(entry);
    return true;
  }

  function installRenderedAttachmentPreview(key, { url, image, article, status, job, attachment }) {
    const decodedBytes = attachment.width * attachment.height * 4;
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes < 1
        || decodedBytes > attachmentDecodedMemoryLimitBytes) return false;
    forgetRenderedAttachmentPreview(key);
    while (state.renderedAttachmentPreviews.size >= ATTACHMENT_RENDERED_PREVIEW_LIMIT
        || state.renderedAttachmentPreviewBytes + decodedBytes > attachmentDecodedMemoryLimitBytes) {
      const oldestKey = state.renderedAttachmentPreviews.keys().next().value;
      if (oldestKey === undefined) break;
      forgetRenderedAttachmentPreview(oldestKey);
    }
    state.renderedAttachmentPreviews.set(key, {
      url, image, article, status, job, decodedBytes,
    });
    state.renderedAttachmentPreviewBytes += decodedBytes;
    state.messageImageUrls.add(url);
    return true;
  }

  function revokeRenderedAttachmentUrls() {
    for (const key of [...state.renderedAttachmentPreviews.keys()]) {
      forgetRenderedAttachmentPreview(key, { defer: false });
    }
    for (const url of state.messageImageUrls) revokeObjectUrl(url);
    state.messageImageUrls.clear();
    state.localMessageImageUrls.clear();
  }

  function purgeAttachmentMemory() {
    resetAttachmentRestorations();
    state.imageRenderEpoch += 1;
    revokeRenderedAttachmentUrls();
    purgeAttachmentBlobCache();
  }

  function attachmentBlobCacheKey(threadId, attachment) {
    return JSON.stringify([threadId, attachment.attachmentId, attachment.sha256]);
  }

  function cachedAttachmentBlob(key, threadId, attachment) {
    const entry = state.attachmentBlobCache.get(key);
    if (entry === undefined) return null;
    if (entry.threadId !== threadId || entry.mediaType !== attachment.mediaType || entry.byteLength !== attachment.byteLength
        || entry.width !== attachment.width || entry.height !== attachment.height) {
      forgetAttachmentBlob(key);
      return null;
    }
    state.attachmentBlobCache.delete(key);
    state.attachmentBlobCache.set(key, entry);
    return entry.blob;
  }

  function forgetAttachmentBlob(key) {
    const entry = state.attachmentBlobCache.get(key);
    if (entry === undefined) return;
    state.attachmentBlobCache.delete(key);
    state.attachmentBlobCacheBytes -= entry.byteLength;
    forgetRenderedAttachmentPreview(key);
  }

  function rememberAttachmentBlob(key, threadId, blob, attachment) {
    if (!(blob instanceof Blob) || blob.size < 1 || blob.size > attachmentMemoryLimitBytes) return false;
    forgetAttachmentBlob(key);
    while (state.attachmentBlobCacheBytes + blob.size > attachmentMemoryLimitBytes) {
      const oldestKey = state.attachmentBlobCache.keys().next().value;
      if (oldestKey === undefined) break;
      forgetAttachmentBlob(oldestKey);
    }
    state.attachmentBlobCache.set(key, Object.freeze({
      threadId,
      blob,
      byteLength: blob.size,
      mediaType: attachment.mediaType,
      width: attachment.width,
      height: attachment.height,
    }));
    state.attachmentBlobCacheBytes += blob.size;
    return true;
  }

  function drainAttachmentRestorations() {
    while (state.attachmentRestoreActive < ATTACHMENT_RESTORE_CONCURRENCY
        && state.attachmentRestoreQueue.length > 0) {
      const job = state.attachmentRestoreQueue.shift();
      const controller = new AbortController();
      state.attachmentRestoreActive += 1;
      state.attachmentRestoreControllers.add(controller);
      void Promise.resolve()
        .then(() => job.restore(controller.signal))
        .catch(() => { /* restoreMessageAttachment owns its visible failure state. */ })
        .finally(() => {
          state.attachmentRestoreControllers.delete(controller);
          state.attachmentRestoreActive -= 1;
          if (job.image.dataset.previewState === "loading") deferAttachmentRestorationJob(job);
          drainAttachmentRestorations();
        });
    }
  }

  function startAttachmentRestoration(job) {
    if (job.started || state.chatPendingSend !== null) return;
    job.started = true;
    state.attachmentRestoreObserver?.unobserve?.(job.observedTarget);
    state.attachmentRestoreObserved.delete(job.observedTarget);
    job.image.dataset.previewState = "loading";
    job.article.dataset.attachmentState = "loading";
    job.status.textContent = "Loading attached image…";
    job.status.disabled = true;
    state.attachmentRestoreQueue.push(job);
    drainAttachmentRestorations();
  }

  function attachmentObserver() {
    if (state.attachmentRestoreObserver !== undefined) return state.attachmentRestoreObserver;
    const Observer = window?.IntersectionObserver;
    if (typeof Observer !== "function") {
      state.attachmentRestoreObserver = null;
      return null;
    }
    try {
      state.attachmentRestoreObserver = new Observer((entries) => {
        for (const entry of entries ?? []) {
          if (entry?.isIntersecting !== true && !(Number(entry?.intersectionRatio) > 0)) continue;
          const job = state.attachmentRestoreObserved.get(entry.target);
          if (job) startAttachmentRestoration(job);
        }
      }, { root: null, rootMargin: "480px 0px", threshold: 0.01 });
    } catch {
      state.attachmentRestoreObserver = null;
    }
    return state.attachmentRestoreObserver;
  }

  function scheduleAttachmentRestoration(job, { observe = true } = {}) {
    job.status.addEventListener("click", () => startAttachmentRestoration(job));
    if (!observe) return;
    const observer = attachmentObserver();
    if (observer === null) {
      startAttachmentRestoration(job);
      return;
    }
    state.attachmentRestoreObserved.set(job.observedTarget, job);
    try { observer.observe(job.observedTarget); }
    catch { startAttachmentRestoration(job); }
  }

  function clearConversation() {
    resetAttachmentRestorations();
    state.imageRenderEpoch += 1;
    revokeRenderedAttachmentUrls();
    elements.messages.replaceChildren();
    elements.agent_plan.replaceChildren();
    elements.agent_timeline.replaceChildren();
    elements.agent_artifacts.replaceChildren();
    elements.agent_artifacts.hidden = true;
    elements.context_indicator.hidden = true;
    elements.welcome.hidden = false;
    elements.run_state.textContent = "Idle";
    elements.workspace.dataset.status = "idle";
    elements.stop_run.hidden = true;
    elements.resume_run.hidden = true;
    state.presentation = null;
    state.assistantNode = null;
    state.agentRunMessages.clear();
    state.agentHistoryRestoring = false;
    state.agentReplayValidating = false;
    state.agentReplayOfferResume = true;
    state.agentCancelPending = false;
  }

  function beginAgentSubmissionActivity() {
    elements.agent_plan.replaceChildren();
    elements.agent_timeline.replaceChildren();
    elements.agent_artifacts.replaceChildren();
    elements.agent_artifacts.hidden = true;
    elements.run_state.textContent = "Starting";
    elements.workspace.dataset.status = "running";
    elements.stop_run.hidden = true;
    elements.resume_run.hidden = true;
  }

  function fenceAttachmentRestorationsForSend() {
    state.imageRenderEpoch += 1;
    resetAttachmentRestorations({ deferQueued: true });
  }

  function restoredImageIsCurrent({ chat, expectedEpoch, expectedImageEpoch }) {
    return state.chat === chat && state.viewEpoch === expectedEpoch
      && state.imageRenderEpoch === expectedImageEpoch;
  }

  function waitForImageDecode(image, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    let readiness;
    if (typeof image.decode === "function") readiness = Promise.resolve().then(() => image.decode());
    else if (image.complete === true) {
      readiness = Number(image.naturalWidth) > 0
        ? Promise.resolve()
        : Promise.reject(new TypeError("restored image did not decode"));
    } else {
      readiness = new Promise((resolve, reject) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", () => reject(new TypeError("restored image did not load")), { once: true });
      });
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        signal?.removeEventListener?.("abort", aborted);
        handler(value);
      };
      const aborted = () => finish(reject, signal.reason ?? new DOMException("aborted", "AbortError"));
      const timer = globalThis.setTimeout(() => {
        finish(reject, new TypeError("restored image decode timed out"));
      }, attachmentDecodeTimeoutMs);
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
      readiness.then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
    });
  }

  async function restoreMessageAttachment({
    article, image, status, job, threadId, attachment,
    readyAlt = "Attached image",
    expectedEpoch = state.viewEpoch,
    expectedImageEpoch = state.imageRenderEpoch,
    chat = state.chat,
    signal,
  }) {
    const current = () => restoredImageIsCurrent({ chat, expectedEpoch, expectedImageEpoch });
    const cacheKey = attachmentBlobCacheKey(threadId, attachment);
    const unavailable = () => {
      image.src = "";
      image.hidden = true;
      image.alt = "Attached image preview unavailable";
      image.dataset.previewState = "unavailable";
      status.textContent = "Attached image preview unavailable";
      status.hidden = false;
      status.disabled = true;
      article.dataset.attachmentState = "unavailable";
    };
    let url = null;
    try {
      if (!current()) return "stale";
      let blob = cachedAttachmentBlob(cacheKey, threadId, attachment);
      if (blob === null) {
        const { bytes, descriptor } = await chat.getAttachment({ threadId, attachment, signal });
        if (!current()) return "stale";
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== attachment.byteLength
            || descriptor.attachmentId !== attachment.attachmentId
            || descriptor.mediaType !== attachment.mediaType
            || descriptor.byteLength !== attachment.byteLength
            || descriptor.width !== attachment.width || descriptor.height !== attachment.height
            || descriptor.sha256 !== attachment.sha256) {
          throw new DirectChatProtocolError("Direct Chat attachment verification result is inconsistent");
        }
        blob = new Blob([bytes], { type: descriptor.mediaType });
        if (!rememberAttachmentBlob(cacheKey, threadId, blob, attachment)) {
          throw new TypeError("attached image exceeds the compressed preview memory limit");
        }
      }
      if (!current()) return "stale";
      url = createObjectUrl(blob);
      if (!installRenderedAttachmentPreview(cacheKey, {
        url, image, article, status, job, attachment,
      })) {
        revokeObjectUrl(url);
        url = null;
        throw new TypeError("attached image exceeds the decoded preview memory limit");
      }
      // Viewport admission and the one-at-a-time restoration queue already
      // provide the lazy-loading bound. Chrome can indefinitely defer decode()
      // for a hidden loading="lazy" image, especially in iOS-sized PWA views,
      // so make the admitted private Blob eager before waiting for its decode.
      image.loading = "eager";
      image.src = url;
      await waitForImageDecode(image, signal);
      if (!current()) {
        forgetRenderedAttachmentPreview(cacheKey, { defer: false, expectedUrl: url });
        return "stale";
      }
      image.alt = readyAlt;
      image.hidden = false;
      image.dataset.previewState = "ready";
      status.hidden = true;
      status.disabled = true;
      article.dataset.attachmentState = "ready";
      return "ready";
    } catch (error) {
      if (url !== null) forgetRenderedAttachmentPreview(cacheKey, { defer: false, expectedUrl: url });
      if (!current()) return "stale";
      if (recoverChatReadAuthentication(error, captureChatReadRecovery({ threadId }))) return "stale";
      forgetAttachmentBlob(cacheKey);
      unavailable();
      return "unavailable";
    }
  }

  function messageNode(role, content, {
    runId, attachment, attachments, threadId, localAttachment, localAttachments, attachmentReadyTasks,
  } = {}) {
    const article = document.createElement("article");
    article.className = "message";
    article.dataset.role = role;
    if (runId) article.dataset.runId = runId;
    const localImages = localAttachments ?? (localAttachment === undefined ? [] : [localAttachment]);
    const storedImages = attachments ?? (attachment === undefined ? [] : [attachment]);
    const displayImages = localImages.length > 0 ? localImages : storedImages;
    if (role === "user" && displayImages.length > 0
        && (localImages.length > 0 || (threadId && state.chat))) {
      const gallery = displayImages.length > 1 ? document.createElement("div") : null;
      if (gallery !== null) {
        gallery.className = "message-attachments";
        article.appendChild(gallery);
      }
      for (const [index, displayedAttachment] of displayImages.entries()) {
        const imageParent = gallery === null ? article : document.createElement("div");
        if (gallery !== null) {
          imageParent.className = "message-attachment-item";
          gallery.appendChild(imageParent);
        }
        const image = document.createElement("img");
        image.className = "message-attachment";
        const readyAlt = displayImages.length === 1 ? "Attached image" : `Attached image ${index + 1}`;
        image.alt = readyAlt;
        image.loading = "lazy";
        image.decoding = "async";
        imageParent.appendChild(image);
        if (localImages.length > 0) {
          const previewBlob = displayedAttachment.previewBlob instanceof Blob
            ? displayedAttachment.previewBlob
            : new Blob([displayedAttachment.bytes], { type: displayedAttachment.mediaType });
          const url = createObjectUrl(previewBlob);
          state.messageImageUrls.add(url);
          state.localMessageImageUrls.add(url);
          image.src = url;
          image.dataset.previewState = "local";
          article.dataset.attachmentState = "local";
        } else {
          image.hidden = true;
          image.alt = "Attached image preview not loaded";
          image.dataset.previewState = "deferred";
          article.dataset.attachmentState = "deferred";
          const status = document.createElement("button");
          status.type = "button";
          status.className = "message-attachment-status muted";
          status.textContent = "Load attached image preview";
          status.setAttribute("aria-label", "Load attached image preview");
          imageParent.appendChild(status);
          const restorationOwner = Object.freeze({
            expectedEpoch: state.viewEpoch,
            chat: state.chat,
          });
          const job = {
            article,
            observedTarget: imageParent,
            image,
            status,
            started: false,
            restore: (signal) => restoreMessageAttachment({
              article,
              image,
              status,
              job,
              threadId,
              attachment: displayedAttachment,
              readyAlt,
              signal,
              expectedImageEpoch: state.imageRenderEpoch,
              ...restorationOwner,
            }),
          };
          const restoration = (options) => scheduleAttachmentRestoration(job, options);
          if (Array.isArray(attachmentReadyTasks)) attachmentReadyTasks.push(restoration);
          else void restoration();
        }
      }
    }
    const body = document.createElement("div");
    body.className = "message-content";
    renderer.renderMarkdown(body, content);
    article.appendChild(body);
    if (role === "assistant" && runId && state.mode === "agent") {
      const artifacts = document.createElement("div");
      artifacts.className = "message-artifacts";
      artifacts.hidden = true;
      article.appendChild(artifacts);
      state.agentRunMessages.set(runId, Object.freeze({ body, artifacts, persistedContent: content }));
    }
    elements.messages.appendChild(article);
    elements.welcome.hidden = true;
    return body;
  }

  function renderThreads() {
    elements.thread_list.replaceChildren();
    const mode = state.mode;
    const selected = currentThreadId();
    const pendingDeletion = mode === "chat" ? state.chatPendingDeletion : null;
    currentThreads().forEach((thread) => {
      const threadId = mode === "agent" ? thread.id : thread.threadId;
      const title = thread.title || "New conversation";
      const open = makeButton(document, title, () => { void openThread(threadId, { mode }); });
      open.className = "thread-open";
      open.disabled = interactionLocked() || (mode === "chat"
        && (state.chatPendingSend !== null || pendingDeletion !== null))
        || (mode === "agent" && state.agentSearchRecoveryChoicePending
          && !agentRecoveryThreadRetryAllowed(threadId));
      open.dataset.threadId = threadId;
      open.dataset.mode = mode;
      open.setAttribute("aria-current", threadId === selected ? "true" : "false");
      if (mode === "agent") {
        elements.thread_list.appendChild(open);
        return;
      }
      const row = document.createElement("div");
      row.className = "thread-row";
      row.dataset.threadId = threadId;
      row.dataset.mode = "chat";
      const retryingDeletion = pendingDeletion?.threadId === threadId
        && pendingDeletion.session === state.session && pendingDeletion.chat === state.chat;
      const remove = makeButton(document, retryingDeletion ? "Retry" : "Delete", () => {
        void deleteChatThread(threadId);
      });
      remove.className = "thread-delete";
      remove.setAttribute("aria-label", `${retryingDeletion ? "Retry deleting" : "Delete"} ${title}`);
      remove.setAttribute("title", `${retryingDeletion ? "Retry deleting" : "Delete"} ${title}`);
      remove.dataset.threadDeleteRetry = retryingDeletion ? "true" : "false";
      remove.dataset.threadBlocked = thread.currentGenerationId !== null
        || (pendingDeletion !== null && !retryingDeletion) ? "true" : "false";
      remove.disabled = interactionLocked() || state.chatPendingSend !== null
        || thread.currentGenerationId !== null || (pendingDeletion !== null && !retryingDeletion);
      row.appendChild(open);
      row.appendChild(remove);
      elements.thread_list.appendChild(row);
    });
  }

  function focusThreadDeleteControl(threadId) {
    const row = [...(elements.thread_list.children ?? [])]
      .find((entry) => entry.dataset?.threadId === threadId);
    row?.children?.[1]?.focus?.();
  }

  function focusAfterThreadDeletion(previousIndex) {
    const rows = [...(elements.thread_list.children ?? [])];
    if (rows.length === 0) {
      elements.new_thread.focus?.();
      return;
    }
    const row = rows[Math.min(Math.max(previousIndex, 0), rows.length - 1)];
    const open = row.className === "thread-row" ? row.children?.[0] : row;
    open?.focus?.();
  }

  function focusSoon(operation) {
    Promise.resolve().then(operation);
  }

  async function loadAgentThreads() {
    if (!state.capabilities.enabled) {
      state.agentThreads = [];
      if (state.mode === "agent") renderThreads();
      return;
    }
    const session = state.session;
    const agent = state.agent;
    const response = await agent.listThreads({ limit: 100, before: "" });
    if (state.session !== session || state.agent !== agent) return;
    state.agentThreads = [...response.threads];
    if (state.mode === "agent") renderThreads();
  }

  async function loadChatThreads({ prefetched = null } = {}) {
    const session = state.session;
    const chat = state.chat;
    const listEpoch = ++state.chatThreadListEpoch;
    let response;
    if (prefetched?.session === session && prefetched.chat === chat) {
      const result = await prefetched.result;
      if (!result.succeeded) throw result.error;
      response = result.response;
    } else {
      response = await chat.listThreads({ limit: 100 });
    }
    if (state.session !== session || state.chat !== chat || state.chatThreadListEpoch !== listEpoch) return;
    state.chatThreads = [...response.threads];
    if (state.mode === "chat") renderThreads();
  }

  function renderAgentArtifacts(target, artifacts) {
    target.replaceChildren();
    target.hidden = artifacts.length === 0;
    artifacts.forEach((artifact) => {
      const section = document.createElement("section");
      section.className = "artifact";
      const heading = document.createElement("h3");
      heading.textContent = artifact.title;
      section.appendChild(heading);
      const body = document.createElement("div");
      renderer.renderArtifact(body, artifact);
      section.appendChild(body);
      target.appendChild(section);
    });
  }

  function resetAgentRunPresentation(runId) {
    const runMessage = state.agentRunMessages.get(runId);
    if (!runMessage) return;
    renderer.renderMarkdown(runMessage.body, runMessage.persistedContent);
    runMessage.artifacts.replaceChildren();
    runMessage.artifacts.hidden = true;
  }

  function renderPresentation(snapshot) {
    const releaseCancellationFence = snapshot.terminalStatus !== null && state.agentCancelPending;
    if (releaseCancellationFence) state.agentCancelPending = false;
    const projectedStatus = safeRunStatus(snapshot.status);
    const visibleStatus = state.agentReplayValidating && TERMINAL.has(projectedStatus)
      ? "running"
      : projectedStatus;
    state.agentRunStatus = visibleStatus;
    elements.workspace.dataset.status = visibleStatus;
    elements.run_state.textContent = statusLabel(visibleStatus);
    let runMessage = state.agentRunMessages.get(snapshot.runId);
    if (!runMessage) {
      messageNode("assistant", "", { runId: snapshot.runId });
      runMessage = state.agentRunMessages.get(snapshot.runId);
    }
    if (!runMessage) throw new TypeError("Agent assistant message presentation is unavailable");
    state.assistantNode = runMessage.body;
    renderer.renderMarkdown(runMessage.body, snapshot.output);
    renderAgentArtifacts(runMessage.artifacts, snapshot.artifacts);
    elements.agent_plan.replaceChildren();
    snapshot.plan.forEach((step) => {
      const item = document.createElement("li");
      item.dataset.status = step.status;
      item.textContent = `${step.label} — ${statusLabel(step.status)}`;
      elements.agent_plan.appendChild(item);
    });
    elements.agent_timeline.replaceChildren();
    snapshot.tools.forEach((tool) => {
      const item = document.createElement("li");
      item.dataset.status = tool.state;
      item.textContent = `${tool.label}: ${tool.summary}`;
      elements.agent_timeline.appendChild(item);
    });
    elements.context_indicator.hidden = snapshot.compaction === null;
    if (snapshot.compaction) {
      elements.context_indicator_text.textContent = `${snapshot.compaction.compactedMessages} earlier messages were compacted by AgInTi (${snapshot.compaction.tokensBefore} → ${snapshot.compaction.tokensAfter} tokens).`;
    }
    elements.agent_artifacts.replaceChildren();
    elements.agent_artifacts.hidden = true;
    const isTerminal = TERMINAL.has(visibleStatus);
    elements.stop_run.hidden = isTerminal || state.agentCancelPending || !state.capabilities.actions.cancel;
    elements.resume_run.hidden = state.agentReplayValidating
      || state.agentReplayFailed
      || !state.agentReplayOfferResume
      || !state.capabilities.actions.resume
      || (visibleStatus !== "failed" && visibleStatus !== "cancelled");
    if (releaseCancellationFence) {
      updateImageControl();
      flushDeferredSessionRevalidation();
    }
  }

  function renderAgentFailure(runId, value) {
    const runMessage = state.agentRunMessages.get(runId);
    if (!runMessage) return;
    const candidate = typeof value === "string" && value.length <= 600
      && isUnicodeScalarText(value) && !UNSAFE_MESSAGE_CONTROL.test(value)
      ? value.trim()
      : "";
    const message = document.createElement("p");
    message.className = "agent-run-failure";
    message.textContent = candidate || "Agent execution failed. Resume this run to try again.";
    runMessage.body.replaceChildren(message);
  }

  async function streamAgentRun(run, {
    cursor,
    expectedRunId = run?.id,
    expectedThreadId = run?.threadId,
    replayTerminal = false,
    offerResume = true,
    cancelPending = false,
  } = {}) {
    correlatedAgentRun(run, { runId: expectedRunId, threadId: expectedThreadId });
    if (replayTerminal && cursor !== undefined) throw new TypeError("terminal Agent replay must start from cursor zero");
    state.agentReplayValidating = replayTerminal;
    state.agentReplayFailed = false;
    state.agentReplayOfferResume = offerResume;
    state.agentCancelPending = cancelPending;
    state.runId = run.id;
    // RPC response statuses can help project progress, but terminal authority
    // belongs only to a verified hash-chained terminal event.
    const initialStatus = replayTerminal ? "running" : eventAwaitingRunStatus(run.status);
    state.agentRunStatus = initialStatus;
    const agent = state.agent;
    const streamEpoch = state.viewEpoch;
    const presentation = createRunPresentation({ runId: run.id, threadId: run.threadId, cursor });
    state.presentation = presentation;
    state.assistantNode = state.agentRunMessages.get(run.id)?.body ?? null;
    state.streamAbort?.abort();
    const controller = new AbortController();
    state.streamAbort = controller;
    state.streamKind = "agent";
    const ownsStream = () => !controller.signal.aborted
      && state.streamAbort === controller
      && state.presentation === presentation
      && state.agent === agent
      && state.viewEpoch === streamEpoch;
    elements.workspace.dataset.status = initialStatus;
    elements.run_state.textContent = replayTerminal ? "Restoring" : cancelPending ? "Cancelling" : statusLabel(initialStatus);
    elements.stop_run.hidden = replayTerminal || cancelPending || !state.capabilities.actions.cancel;
    elements.resume_run.hidden = true;
    if (replayTerminal) connection("Restoring verified Agent history", false);
    let recoveries = 0;
    try {
      while (ownsStream()) {
        let failure = null;
        try {
          for await (const { event } of agent.streamRunEvents({
            runId: run.id,
            threadId: run.threadId,
            cursor: presentation.snapshot().cursor,
            maxReconnects: 0,
            signal: controller.signal,
            onCursor: cursorStore && !replayTerminal && !cancelPending
              ? async (next) => cursorStore.save({ runId: run.id, threadId: run.threadId, cursor: next })
              : undefined,
          })) {
            if (!ownsStream()) return;
            renderPresentation(presentation.apply(event));
          }
        } catch (error) {
          if (!ownsStream()) return;
          failure = error;
        }
        if (!ownsStream()) return;
        const snapshot = presentation.snapshot();
        if (replayTerminal) {
          if (failure) throw failure;
          assertTerminalAgentReplay(run, snapshot);
          state.agentReplayValidating = false;
          renderPresentation(snapshot);
          if (snapshot.status === "failed") renderAgentFailure(run.id, run.error?.message);
          connection("Connected");
          return;
        }
        if (snapshot.terminalStatus !== null) {
          if (snapshot.status === "failed") {
            let failureMessage = "";
            try {
              const response = await agent.runStatus(run.id, { signal: controller.signal });
              if (!ownsStream()) return;
              const finalRun = correlatedAgentRun(response.run, { runId: run.id, threadId: run.threadId });
              assertTerminalAgentReplay(finalRun, snapshot);
              failureMessage = finalRun.error?.message || "";
            } catch {
              // The verified terminal event still proves failure. Error detail
              // is optional presentation data and falls back to fixed text.
            }
            renderAgentFailure(run.id, failureMessage);
          }
          connection("Connected");
          return;
        }
        if (failure instanceof AgintiProtocolError || (failure && failure.retryable !== true)) throw failure;
        let authoritativeRun = null;
        try {
          const response = await agent.runStatus(run.id, { signal: controller.signal });
          if (!ownsStream()) return;
          authoritativeRun = correlatedAgentRun(response.run, { runId: run.id, threadId: run.threadId });
        } catch (error) {
          if (!ownsStream()) return;
          if (error instanceof AgintiProtocolError || error?.retryable === false) throw error;
        }
        recoveries += 1;
        connection(authoritativeRun && TERMINAL.has(authoritativeRun.status)
          ? "Waiting for verified Agent completion"
          : "Reconnecting to AgInTi", false);
        const backoffStep = Math.min(recoveries - 1, maxStreamBackoffSteps);
        await wait(Math.min(4_000, 250 * (2 ** backoffStep)), controller.signal);
      }
    } catch (error) {
      if (!ownsStream()) return;
      if (replayTerminal) {
        state.agentReplayValidating = false;
        state.agentReplayFailed = true;
        state.agentReplayOfferResume = false;
        resetAgentRunPresentation(run.id);
        elements.agent_plan.replaceChildren();
        elements.agent_timeline.replaceChildren();
        elements.resume_run.hidden = true;
        connection("Agent history unavailable", false);
        throw error;
      }
      if (cancelPending) {
        state.agentCancelPending = false;
        state.agentReplayFailed = true;
        state.agentReplayOfferResume = false;
        resetAgentRunPresentation(run.id);
        elements.agent_plan.replaceChildren();
        elements.agent_timeline.replaceChildren();
        elements.stop_run.hidden = true;
        elements.resume_run.hidden = true;
        updateImageControl();
        connection("Agent cancellation history unavailable", false);
        showToast("Verified cancellation history could not be restored safely. Reopen this conversation to retry; no run was resumed.");
        flushDeferredSessionRevalidation();
        return;
      }
      elements.resume_run.hidden = state.agentCancelPending || !state.capabilities.actions.resume;
      connection(state.agentCancelPending ? "Confirming Agent cancellation" : "Agent stream interrupted", false);
      showToast(state.agentCancelPending
        ? "Cancellation is being confirmed. Its verified history will reconnect automatically."
        : "The Agent run is still owned by AgInTi. Resume reconnects without restarting it.");
    } finally {
      if (state.streamAbort === controller) {
        state.streamAbort = null;
        state.streamKind = null;
        elements.stop_run.hidden = true;
      }
    }
  }

  async function openAgentThread(threadId, { expectedEpoch = state.viewEpoch } = {}) {
    if (!state.capabilities.enabled || state.mode !== "agent" || state.viewEpoch !== expectedEpoch) return false;
    const session = state.session;
    const agent = state.agent;
    const current = () => state.session === session
      && state.agent === agent
      && state.mode === "agent"
      && state.viewEpoch === expectedEpoch;
    state.agentHistoryRestoring = true;
    updateImageControl();
    try {
      let { thread } = await agent.getThread(threadId);
      if (!current()) return;
      if (thread.id !== threadId) {
        throw new AgintiProtocolError("Agent thread ownership does not match the requested thread", {
          code: "LEDGER_OWNERSHIP_MISMATCH",
        });
      }
      let ancestry = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (thread.status === "deleting") {
          throw new AgintiProtocolError("A deleting Agent thread cannot accept more work", {
            code: "AGENT_THREAD_DELETING",
          });
        }
        const runValues = [];
        for (const requestedRunId of persistedThreadRunIds(thread)) {
          const { run } = await agent.runStatus(requestedRunId);
          if (!current()) return;
          runValues.push(run);
        }
        ancestry = validateThreadRunAncestry(thread, runValues);
        if (!ancestry.requiresThreadRefresh) break;
        if (attempt > 0) {
          throw new AgintiProtocolError("Agent thread completion changed during verification", {
            code: "LEDGER_SNAPSHOT_RACE",
          });
        }
        const priorThread = thread;
        const refreshed = await agent.getThread(threadId);
        if (!current()) return;
        thread = refreshed.thread;
        if (thread.id !== threadId || thread.lastRunId !== priorThread.lastRunId
            || thread.createdAt !== priorThread.createdAt
            || thread.revision < priorThread.revision
            || thread.updatedAt < priorThread.updatedAt) {
          throw new AgintiProtocolError("Agent thread head changed during completion verification", {
            code: "LEDGER_OWNERSHIP_MISMATCH",
          });
        }
      }
      if (ancestry === null) {
        throw new AgintiProtocolError("Agent thread ancestry could not be verified", {
          code: "LEDGER_ANCESTRY_UNAVAILABLE",
        });
      }
      const listedIndex = state.agentThreads.findIndex((listed) => listed.id === thread.id);
      if (listedIndex < 0) state.agentThreads.unshift(thread);
      else state.agentThreads[listedIndex] = thread;
      clearConversation();
      state.agentHistoryRestoring = true;
      state.agentThreadId = thread.id;
      state.runId = null;
      state.agentRunStatus = null;
      elements.conversation_title.textContent = thread.title;
      const persistedAssistantRuns = new Set(
        thread.messages.filter((message) => message.role === "assistant").map((message) => message.runId),
      );
      const runs = ancestry.runs.map((run) => Object.freeze({
        run,
        runId: run.id,
        persisted: persistedAssistantRuns.has(run.id),
      }));
      const missingAssistantRuns = new Set(
        runs.filter((requested) => !requested.persisted).map((requested) => requested.runId)
      );
      thread.messages.forEach((message, index) => {
        messageNode(message.role, message.content, { runId: message.runId });
        const next = thread.messages[index + 1];
        if (missingAssistantRuns.has(message.runId) && next?.runId !== message.runId) {
          // Failed, cancelled, and live runs do not necessarily have a
          // persisted assistant message. Reserve their chronological position
          // before replay so an older run cannot be appended after a resumed
          // successor's stored answer and artifacts.
          messageNode("assistant", "", { runId: message.runId });
          missingAssistantRuns.delete(message.runId);
        }
      });
      renderThreads();
      if (thread.authority.lastCompaction) {
        elements.context_indicator.hidden = false;
        elements.context_indicator_text.textContent = `${thread.authority.lastCompaction.compactedMessages} earlier messages were compacted by AgInTi.`;
      }
      for (const requested of runs) {
        const requestedRunId = requested.runId;
        const { run } = requested;
        correlatedAgentRun(run, { runId: requestedRunId, threadId: thread.id });
        const terminal = TERMINAL.has(run.status);
        if (!terminal && (requested.persisted || requestedRunId !== thread.lastRunId)) {
          throw new AgintiProtocolError("A persisted Agent assistant run is not terminal", {
            code: "LEDGER_TERMINAL_MISMATCH",
          });
        }
        // Once every historical run is restored, the current live run resumes
        // its normal cancel/reconnect controls rather than staying read-only.
        if (!terminal) state.agentHistoryRestoring = false;
        await streamAgentRun(run, {
          expectedRunId: requestedRunId,
          expectedThreadId: thread.id,
          replayTerminal: terminal,
          offerResume: requestedRunId === thread.lastRunId,
        });
        if (!current()) return;
      }
      if (thread.lastRunId === null) state.runId = null;
      state.agentReplayFailed = false;
      return true;
    } catch (error) {
      if (clientReleaseMismatch(error) !== null) throw error;
      if (!current()) return false;
      state.agentReplayValidating = false;
      state.agentReplayFailed = true;
      state.agentReplayOfferResume = false;
      elements.resume_run.hidden = true;
      showToast("Verified Agent history could not be restored safely. Reopen this conversation to retry; no run was resumed.");
      return false;
    } finally {
      if (current()) {
        state.agentHistoryRestoring = false;
        updateImageControl();
        flushDeferredSessionRevalidation();
      }
    }
  }

  async function exactMutation(dispatch, retry, { onAmbiguous = () => {}, onConfirmed = () => {} } = {}) {
    try {
      const result = await dispatch();
      onConfirmed();
      return result;
    }
    catch (error) {
      if (error?.retryable !== true) throw error;
      onAmbiguous(error);
      connection("Retrying the same durable request", false);
      await wait(250);
      const result = await retry();
      onConfirmed();
      return result;
    }
  }

  function isAuthoritativeChatRejection(error) {
    return error instanceof DirectChatTransportError
      && error.retryable === false
      && Number.isSafeInteger(error.status)
      && error.status >= 400
      && error.status < 499;
  }

  function isAuthoritativeAgentRejection(error) {
    return error?.retryable === false
      && Number.isSafeInteger(error.status)
      && error.status >= 400
      && error.status < 499;
  }

  function releaseRejectedChatWorkflow(workflow, error) {
    const composer = workflow.lockedComposer ?? workflow.recoveryComposer;
    if (composer !== null && composer !== undefined) {
      if (!elements.message_input.value || elements.message_input.value === workflow.text
          || elements.message_input.value === composer.draft) {
        elements.message_input.value = composer.draft;
      }
      if (composer.images.length > 0 && state.selectedImages.length === 0) {
        try {
          restoreDetachedImage(Object.freeze({
            selected: composer.images,
            previewUrls: Object.freeze(composer.images.map((image) => createObjectUrl(image.previewBlob))),
          }));
        } catch { /* The exact text remains recoverable even if a local preview cannot be recreated. */ }
      }
    }
    workflow.lockedComposer = null;
    workflow.recoveryComposer = null;
    if (state.chatPendingSend === workflow) state.chatPendingSend = null;
    elements.resume_run.hidden = true;
    renderThreads();
    updateImageControl();
    const diagnostic = applyChatFailureDiagnostic(new LocalChatNotSentError(
      workflow.failureStage ?? "before_run_dispatch",
      error,
    ));
    showToast(composer?.images?.length > 0
      ? "The image message was rejected before it ran. Its prompt and images are ready to edit or retry."
      : "The message was rejected before it ran. Its prompt is ready to edit or retry.");
    if (diagnostic.reauthenticate) requireFreshAuthentication();
  }

  async function fetchChatSnapshot(threadId, signal, {
    expectedEpoch = state.viewEpoch,
    threadHint = null,
  } = {}) {
    const owner = Object.freeze({ session: state.session, chat: state.chat, expectedEpoch });
    const hintedRevision = threadHint?.threadId === threadId
      && Number.isSafeInteger(threadHint.revision) && threadHint.revision > 0
      ? threadHint.revision
      : 0;
    const ensureOwner = () => {
      if (state.session !== owner.session || state.chat !== owner.chat || !state.session.authenticated
          || state.mode !== "chat" || state.viewEpoch !== owner.expectedEpoch) {
        throw new DirectChatTransportError("Direct Chat snapshot ownership changed.", {
          code: "browser_state_changed",
          status: 499,
          retryable: false,
        });
      }
      if (signal?.aborted) throw signal.reason ?? new DOMException("request aborted", "AbortError");
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        ensureOwner();
        const [beforeResponse, prefetchedFirstPage] = await Promise.all([
          owner.chat.getThread(threadId, { signal }),
          hintedRevision > 0
            ? owner.chat.listMessages({
              threadId,
              afterRevision: 0,
              limit: Math.min(200, hintedRevision),
              signal,
            })
            : null,
        ]);
        const { thread: before } = beforeResponse;
        ensureOwner();
        const messages = [];
        let afterRevision = 0;
        let previousHash = null;
        let inconsistent = false;
        let firstPage = prefetchedFirstPage;
        while (afterRevision < before.revision) {
          const remaining = before.revision - afterRevision;
          const response = firstPage ?? await owner.chat.listMessages({
              threadId,
              afterRevision,
              limit: Math.min(200, remaining),
              signal,
            });
          firstPage = null;
          ensureOwner();
          if (response.messages.length < 1 || response.messages.length > remaining) {
            inconsistent = true;
            break;
          }
          for (const message of response.messages) {
            if (message.previousHash !== previousHash) {
              inconsistent = true;
              break;
            }
            messages.push(message);
            afterRevision = message.revision;
            previousHash = message.messageHash;
          }
          if (inconsistent) break;
        }
        const { thread: after } = await owner.chat.getThread(threadId, { signal });
        ensureOwner();
        const stable = before.revision === after.revision
          && before.ledgerHash === after.ledgerHash
          && before.currentGenerationId === after.currentGenerationId;
        const complete = messages.length === after.revision
          && (after.revision === 0 ? after.ledgerHash === null : previousHash === after.ledgerHash);
        if (!inconsistent && stable && complete) return Object.freeze({ thread: after, messages: Object.freeze(messages) });
      } catch (error) {
        if (error?.retryable !== true || attempt >= 2) throw error;
        ensureOwner();
        await wait(250 * (2 ** attempt), signal);
        ensureOwner();
        continue;
      }
      if (attempt < 2) {
        ensureOwner();
        await wait(250 * (2 ** attempt), signal);
        ensureOwner();
      }
    }
    throw new DirectChatProtocolError("Direct Chat changed while its authoritative snapshot was being read");
  }

  function chatFinalizationIsCurrent(finalization) {
    return state.chatFinalization === finalization
      && state.session === finalization.session
      && state.chat === finalization.chat
      && state.session.authenticated
      && state.mode === "chat"
      && state.chatThreadId === finalization.threadId
      && state.viewEpoch === finalization.expectedEpoch;
  }

  function markChatFinalizing(finalization) {
    if (!chatFinalizationIsCurrent(finalization)) return false;
    elements.workspace.dataset.status = "finalizing";
    elements.run_state.textContent = "Finalizing";
    elements.stop_run.hidden = true;
    elements.resume_run.hidden = true;
    connection("Finalizing response…");
    updateImageControl();
    renderThreads();
    return true;
  }

  function beginChatFinalization({ threadId, generationId = null, expectedEpoch = state.viewEpoch }) {
    const finalization = Object.freeze({
      session: state.session,
      chat: state.chat,
      threadId,
      generationId,
      expectedEpoch,
    });
    state.chatFinalization = finalization;
    markChatFinalizing(finalization);
    return finalization;
  }

  function abandonChatFinalization(finalization) {
    if (state.chatFinalization !== finalization) return false;
    state.chatFinalization = null;
    updateImageControl();
    renderThreads();
    return true;
  }

  function completeChatFinalization(finalization) {
    if (!chatFinalizationIsCurrent(finalization)) return false;
    state.chatFinalization = null;
    elements.workspace.dataset.status = "completed";
    elements.run_state.textContent = "Completed";
    elements.stop_run.hidden = true;
    elements.resume_run.hidden = true;
    connection("Connected");
    updateImageControl();
    renderThreads();
    return true;
  }

  function pauseChatFinalization(finalization) {
    if (!chatFinalizationIsCurrent(finalization)) return false;
    elements.workspace.dataset.status = "finalizing";
    elements.run_state.textContent = "Finalizing";
    elements.stop_run.hidden = true;
    elements.resume_run.hidden = false;
    connection("Finalizing · reconnect needed", false);
    updateImageControl();
    renderThreads();
    showToast("LocalLLM finished generating, but the authoritative final view is not ready yet. Resume completes it without rerunning the prompt.");
    return true;
  }

  async function renderChatSnapshot(snapshot, {
    expectedEpoch = state.viewEpoch,
    finalization: suppliedFinalization = null,
    restoreAttachments = true,
  } = {}) {
    clearConversation();
    state.chatThread = snapshot.thread;
    state.chatThreadId = snapshot.thread.threadId;
    elements.conversation_title.textContent = snapshot.thread.title || "New conversation";
    const last = snapshot.messages.at(-1);
    const completed = last?.role === "assistant";
    const finalization = suppliedFinalization ?? (completed
      ? beginChatFinalization({
        threadId: snapshot.thread.threadId,
        generationId: last.generationId,
        expectedEpoch,
      })
      : null);
    const ownsFinalization = finalization !== null && suppliedFinalization === null;
    if (finalization !== null) markChatFinalizing(finalization);
    const attachmentReadyTasks = [];
    snapshot.messages.forEach((message) => messageNode(message.role, message.content, {
      runId: message.generationId ?? undefined,
      attachment: message.attachment,
      attachments: message.attachments,
      threadId: snapshot.thread.threadId,
      attachmentReadyTasks,
    }));
    // Attachment previews are cosmetic. Register them only after the
    // authoritative conversation is usable; viewport observation then admits
    // at most one verified original at a time on memory-constrained clients.
    if (restoreAttachments) {
      void attachmentReadyTasks.reduce(
        (previous, restoreAttachment) => previous.then(restoreAttachment),
        Promise.resolve(),
      );
    } else {
      for (const restoreAttachment of attachmentReadyTasks) restoreAttachment({ observe: false });
    }
    if (state.mode !== "chat" || state.viewEpoch !== expectedEpoch
        || state.chatThreadId !== snapshot.thread.threadId) {
      if (ownsFinalization) abandonChatFinalization(finalization);
      return false;
    }
    if (ownsFinalization) completeChatFinalization(finalization);
    else if (!completed && suppliedFinalization === null) {
      elements.workspace.dataset.status = "idle";
      elements.run_state.textContent = "Idle";
    }
    clearChatFailureDiagnostic();
    renderThreads();
    return true;
  }

  async function refreshChatThread(threadId, signal, {
    expectedEpoch = state.viewEpoch,
    finalization = null,
    threadHint = null,
    refreshThreadList = true,
  } = {}) {
    const session = state.session;
    const chat = state.chat;
    const snapshot = await fetchChatSnapshot(threadId, signal, { expectedEpoch, threadHint });
    if (state.session !== session || state.chat !== chat) return snapshot;
    state.chatThread = snapshot.thread;
    state.chatThreadId = snapshot.thread.threadId;
    if (state.mode === "chat" && state.viewEpoch === expectedEpoch) {
      await renderChatSnapshot(snapshot, { expectedEpoch, finalization });
    }
    if (refreshThreadList) {
      void loadChatThreads().catch(() => { /* The open authoritative thread remains usable. */ });
    }
    return snapshot;
  }

  async function finalizeChatGeneration(finalization, signal) {
    if (!markChatFinalizing(finalization)) return false;
    try {
      const snapshot = await refreshChatThread(finalization.threadId, signal, {
        expectedEpoch: finalization.expectedEpoch,
        finalization,
      });
      if (!chatFinalizationIsCurrent(finalization)) return false;
      const assistant = snapshot.messages.at(-1);
      if (assistant?.role !== "assistant" || assistant.generationId !== finalization.generationId) {
        throw new DirectChatProtocolError("Direct Chat finalization did not include the completed assistant message");
      }
      state.chatThread = snapshot.thread;
    } catch (error) {
      if (recoverChatReadAuthentication(error, captureChatReadRecovery({
        threadId: finalization.threadId,
        generationId: finalization.generationId,
      }))) return false;
      pauseChatFinalization(finalization);
      return false;
    }
    return completeChatFinalization(finalization);
  }

  async function finishChatGeneration(generation, controller, expectedEpoch = state.viewEpoch) {
    state.chatGeneration = generation;
    const presenting = state.mode === "chat" && state.viewEpoch === expectedEpoch;
    if (presenting && state.chatThreadId === generation.threadId) {
      if (generation.status === "completed") {
        const finalization = beginChatFinalization({
          threadId: generation.threadId,
          generationId: generation.generationId,
          expectedEpoch,
        });
        await finalizeChatGeneration(finalization, controller.signal);
        return;
      }
      try {
        await refreshChatThread(generation.threadId, controller.signal, { expectedEpoch });
      } catch (error) {
        if (recoverChatReadAuthentication(error, captureChatReadRecovery({
          threadId: generation.threadId,
          generationId: generation.generationId,
        }))) return;
        // The terminal generation remains authoritative. A later send performs
        // another full pre-send snapshot render before appending local UI.
      }
    }
    if (presenting) {
      elements.workspace.dataset.status = generation.status;
      elements.run_state.textContent = statusLabel(generation.status);
      elements.resume_run.hidden = true;
    }
    if (presenting) connection("Connected");
  }

  async function streamChatGeneration(generation, { afterSequence = 0, output = "" } = {}) {
    const expectedEpoch = state.viewEpoch;
    const continuing = state.chatGeneration?.generationId === generation.generationId;
    state.chatGeneration = generation;
    state.chatAfterSequence = continuing ? Math.max(state.chatAfterSequence, afterSequence) : afterSequence;
    state.chatOutput = continuing ? state.chatOutput : output;
    if (!continuing || !state.assistantNode) {
      state.assistantNode = messageNode("assistant", state.chatOutput, { runId: generation.generationId });
    }
    state.streamAbort?.abort();
    const controller = new AbortController();
    state.streamAbort = controller;
    state.streamKind = "chat";
    elements.stop_run.hidden = false;
    elements.resume_run.hidden = true;
    elements.workspace.dataset.status = "running";
    const hasOutput = state.chatOutput.length > 0;
    elements.run_state.textContent = hasOutput ? "Generating" : "Warming LocalLLM";
    if (!hasOutput) connection("Warming LocalLLM…");
    let recoveries = 0;
    try {
      while (!controller.signal.aborted) {
        let failure;
        try {
          for await (const event of state.chat.streamRunEvents({
            threadId: generation.threadId,
            generationId: generation.generationId,
            afterSequence: state.chatAfterSequence,
            maxReconnects: 0,
            signal: controller.signal,
            onCursor: async (cursor) => { state.chatAfterSequence = cursor.afterSequence; },
          })) {
            if (event.type === "delta") {
              elements.run_state.textContent = "Generating";
              connection("Connected");
              state.chatOutput += event.delta.content;
              renderer.renderMarkdown(state.assistantNode, state.chatOutput);
            } else {
              await finishChatGeneration(event.generation, controller, expectedEpoch);
              return;
            }
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          failure = error;
        }
        if (failure instanceof DirectChatProtocolError || failure?.retryable !== true) throw failure;
        let authoritative;
        try {
          authoritative = (await state.chat.getRunStatus({
            threadId: generation.threadId,
            generationId: generation.generationId,
            signal: controller.signal,
          })).generation;
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof DirectChatProtocolError || error?.retryable === false) throw error;
        }
        if (authoritative?.terminal) {
          await finishChatGeneration(authoritative, controller, expectedEpoch);
          return;
        }
        recoveries += 1;
        connection("Reconnecting to LocalLLM", false);
        const backoffStep = Math.min(recoveries - 1, maxStreamBackoffSteps);
        await wait(Math.min(4_000, 250 * (2 ** backoffStep)), controller.signal);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (recoverChatReadAuthentication(error, captureChatReadRecovery({
        threadId: generation.threadId,
        generationId: generation.generationId,
      }))) return;
      elements.resume_run.hidden = false;
      connection("Chat stream interrupted", false);
      showToast("The generation is still server-owned. Resume reconnects without dispatching it again.");
      throw error;
    } finally {
      if (state.streamAbort === controller) {
        state.streamAbort = null;
        state.streamKind = null;
        elements.stop_run.hidden = true;
      }
    }
  }

  async function openChatThread(threadId, {
    backgroundStream = false,
    threadHint = null,
    refreshThreadList = true,
  } = {}) {
    const expectedEpoch = state.viewEpoch;
    const restoration = Object.freeze({ threadId, expectedEpoch, chat: state.chat });
    state.chatHistoryRestoration = restoration;
    updateImageControl();
    renderThreads();
    let generationId = null;
    try {
      const snapshot = await refreshChatThread(threadId, undefined, {
        expectedEpoch,
        threadHint,
        refreshThreadList,
      });
      if (state.mode !== "chat" || state.viewEpoch !== expectedEpoch) return;
      generationId = snapshot.thread.currentGenerationId;
      if (!generationId) {
        state.chatGeneration = null;
        state.chatAfterSequence = 0;
        state.chatOutput = "";
        return;
      }
      const { generation } = await state.chat.getRunStatus({ threadId, generationId });
      if (state.mode !== "chat" || state.viewEpoch !== expectedEpoch) return;
      state.chatGeneration = generation;
      state.chatAfterSequence = 0;
      state.chatOutput = "";
      if (generation.terminal) {
        elements.workspace.dataset.status = generation.status;
        elements.run_state.textContent = statusLabel(generation.status);
        return;
      }
      const stream = streamChatGeneration(generation);
      if (backgroundStream) {
        void stream.catch(() => {});
        return;
      }
      await stream;
    } catch (error) {
      if (state.chatHistoryRestoration !== restoration
          || state.chat !== restoration.chat
          || !state.session.authenticated
          || state.mode !== "chat"
          || state.viewEpoch !== expectedEpoch) return;
      if (recoverChatReadAuthentication(error, captureChatReadRecovery({ threadId, generationId }))) return;
      throw error;
    } finally {
      if (state.chatHistoryRestoration === restoration) {
        state.chatHistoryRestoration = null;
        updateImageControl();
        renderThreads();
      }
    }
  }

  async function reconnectRecoveredChat(recovery) {
    const expectedEpoch = state.viewEpoch;
    const snapshot = await refreshChatThread(recovery.threadId, undefined, { expectedEpoch });
    if (!state.session.authenticated || state.mode !== "chat" || state.viewEpoch !== expectedEpoch) return;
    const generationId = recovery.generationId ?? snapshot.thread.currentGenerationId;
    if (generationId === null) {
      state.chatGeneration = null;
      return;
    }
    const { generation } = await state.chat.getRunStatus({
      threadId: recovery.threadId,
      generationId,
    });
    if (!state.session.authenticated || state.mode !== "chat" || state.viewEpoch !== expectedEpoch) return;
    state.chatGeneration = generation;
    if (generation.terminal) {
      const finalAssistant = snapshot.messages.at(-1);
      if (generation.status === "completed"
          && (finalAssistant?.role !== "assistant" || finalAssistant.generationId !== generation.generationId)) {
        await finishChatGeneration(generation, new AbortController(), expectedEpoch);
        return;
      }
      elements.workspace.dataset.status = generation.status;
      elements.run_state.textContent = statusLabel(generation.status);
      elements.resume_run.hidden = true;
      connection("Connected");
      return;
    }
    await streamChatGeneration(generation, {
      afterSequence: recovery.generationId === generation.generationId ? recovery.afterSequence : 0,
      output: recovery.generationId === generation.generationId ? recovery.output : "",
    });
  }

  function currentThreadDeletion(pending) {
    return pending !== null && pending !== undefined
      && pending.session === state.session && pending.chat === state.chat
      && state.session.authenticated && state.mode === "chat";
  }

  function deletionAlreadyAbsent(error) {
    return error instanceof DirectChatTransportError && error.status === 404;
  }

  function definitiveDeletionRejection(error) {
    return error instanceof DirectChatTransportError && error.retryable === false
      && Number.isSafeInteger(error.status) && error.status >= 400 && error.status < 500
      && error.status !== 404;
  }

  function finishLocalThreadDeletion(pending, authoritativeThreads = null) {
    if (!currentThreadDeletion(pending)) return false;
    const threadId = pending.threadId;
    const previousIndex = state.chatThreads.findIndex((item) => item.threadId === threadId);
    state.chatThreadListEpoch += 1;
    state.chatThreads = authoritativeThreads === null
      ? state.chatThreads.filter((item) => item.threadId !== threadId)
      : [...authoritativeThreads];
    if (state.chatPendingDeletion === pending) state.chatPendingDeletion = null;
    purgeAttachmentBlobCacheForThread(threadId);
    if (state.chatThreadId === threadId) {
      state.viewEpoch += 1;
      state.streamAbort?.abort();
      state.streamAbort = null;
      state.streamKind = null;
      state.chatThreadId = null;
      state.chatThread = null;
      state.chatGeneration = null;
      state.chatAfterSequence = 0;
      state.chatOutput = "";
      clearChatFailureDiagnostic();
      clearConversation();
      elements.conversation_title.textContent = "New conversation";
    }
    connection("Connected");
    renderThreads();
    focusSoon(() => focusAfterThreadDeletion(previousIndex));
    showToast("Conversation deleted.");
    return true;
  }

  async function reconcileThreadDeletion(pending) {
    let response;
    try {
      response = await pending.chat.listThreads({ limit: 100 });
    } catch (error) {
      if (!currentThreadDeletion(pending)) return false;
      if (isChatAuthenticationAfterAmbiguousDispatch(error)) {
        if (state.chatPendingDeletion === pending) state.chatPendingDeletion = null;
        requireFreshAuthentication();
        return false;
      }
      renderThreads();
      focusSoon(() => focusThreadDeleteControl(pending.threadId));
      connection("Deletion confirmation paused", false);
      showToast("The deletion response is still uncertain. Retry reuses the exact same request.");
      return false;
    }
    if (!currentThreadDeletion(pending)) return false;
    const threads = [...response.threads];
    const authoritative = threads.find((item) => item.threadId === pending.threadId);
    if (authoritative === undefined) return finishLocalThreadDeletion(pending, threads);
    state.chatThreadListEpoch += 1;
    state.chatThreads = threads;
    if (authoritative.revision !== pending.revision || authoritative.ledgerHash !== pending.ledgerHash
        || authoritative.currentGenerationId !== null) {
      if (state.chatPendingDeletion === pending) state.chatPendingDeletion = null;
      renderThreads();
      focusSoon(() => focusThreadDeleteControl(pending.threadId));
      connection("Connected");
      showToast("Deletion stopped because this conversation changed or started new work.");
      return false;
    }
    // The read may have overtaken an earlier disconnected delete request. Keep
    // the exact ticket until either absence or a changed cursor is authoritative.
    renderThreads();
    focusSoon(() => focusThreadDeleteControl(pending.threadId));
    connection("Deletion confirmation paused", false);
    showToast("The deletion response is still uncertain. Retry reuses the exact same request.");
    return false;
  }

  async function deleteChatThread(threadId) {
    if (interactionLocked() || !state.session.authenticated || state.mode !== "chat"
        || state.chatPendingSend !== null) return false;
    let retained = state.chatPendingDeletion;
    if (retained !== null && (!currentThreadDeletion(retained) || retained.threadId !== threadId)) {
      if (!currentThreadDeletion(retained)) {
        state.chatPendingDeletion = null;
        retained = null;
      }
      else {
        showToast("Confirm the pending conversation deletion before deleting another conversation.");
        focusSoon(() => focusThreadDeleteControl(retained.threadId));
        return false;
      }
    }
    const thread = state.chatThreads.find((item) => item.threadId === threadId);
    if (!thread) {
      return retained !== null && retained.threadId === threadId
        ? finishLocalThreadDeletion(retained, state.chatThreads)
        : false;
    }
    if (thread.currentGenerationId !== null
        || (state.chatThreadId === threadId && state.chatGeneration
          && !TERMINAL.has(state.chatGeneration.status))) {
      showToast("Stop or resolve this LocalLLM response before deleting its conversation.");
      return false;
    }

    const session = state.session;
    const chat = state.chat;
    state.busy = true;
    updateImageControl();
    try {
      let pending = retained;
      if (pending === null) {
        let confirmed = false;
        try {
          confirmed = await confirmThreadDeletion(
            `Delete “${thread.title || "New conversation"}” and all of its saved messages and images? This cannot be undone.`,
          ) === true;
        } catch {
          confirmed = false;
        }
        if (!confirmed || state.session !== session || state.chat !== chat
            || !state.session.authenticated || state.mode !== "chat"
            || state.chatPendingSend !== null) return false;
        const current = state.chatThreads.find((item) => item.threadId === threadId);
        if (!current || current.revision !== thread.revision || current.ledgerHash !== thread.ledgerHash
            || current.currentGenerationId !== null) {
          showToast("This conversation changed before deletion. Reopen it and try again.");
          return false;
        }
        const ticket = chat.prepareThreadDeletion({
          threadId,
          expectedRevision: thread.revision,
          expectedHash: thread.ledgerHash,
        });
        pending = Object.freeze({
          session,
          chat,
          threadId,
          revision: thread.revision,
          ledgerHash: thread.ledgerHash,
          ticket,
        });
        state.chatPendingDeletion = pending;
      }

      let result = null;
      let ambiguous = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          result = await (attempt === 0 && retained === null
            ? pending.chat.deleteThread(pending.ticket)
            : pending.chat.retryDeleteThread(pending.ticket));
          ambiguous = null;
          break;
        } catch (error) {
          if (!currentThreadDeletion(pending)) return false;
          if (deletionAlreadyAbsent(error)) return finishLocalThreadDeletion(pending);
          if (definitiveDeletionRejection(error)) throw error;
          ambiguous = error;
          if (attempt === 0) {
            connection("Retrying the same durable deletion", false);
            await wait(250);
          }
        }
      }
      if (result !== null) {
        if (!currentThreadDeletion(pending) || result.deleted !== true || result.threadId !== threadId) return false;
        return finishLocalThreadDeletion(pending);
      }
      if (ambiguous !== null) return await reconcileThreadDeletion(pending);
      return false;
    } catch (error) {
      const pending = state.chatPendingDeletion;
      if (pending !== null && currentThreadDeletion(pending)) state.chatPendingDeletion = null;
      if (isChatAuthenticationAfterAmbiguousDispatch(error)) {
        requireFreshAuthentication();
      } else if (error instanceof DirectChatTransportError && error.status === 409) {
        if (retained !== null) {
          renderThreads();
          focusSoon(() => focusThreadDeleteControl(threadId));
        }
        showToast("Deletion stopped because this conversation changed or still has unresolved work.");
      } else {
        if (retained !== null) {
          renderThreads();
          focusSoon(() => focusThreadDeleteControl(threadId));
        }
        showToast("Conversation deletion was rejected before it could be confirmed.");
      }
      return false;
    } finally {
      state.busy = false;
      updateImageControl();
    }
  }

  function retainedUpdateRecoverySearchSignature() {
    if (state.mode !== "agent" || !state.agentSearchSelected) return "off";
    return `on:${String(elements.search_mode.value ?? "")}:${String(elements.search_limit.value ?? "")}`;
  }

  function retainedUpdateRecoveryInstallationCurrent(record = state.retainedUpdateRecoveryRecord, {
    ignoreSearch = false,
  } = {}) {
    const installation = state.retainedUpdateRecoveryInstallation;
    return state.retainedUpdateRecoveryInstalled === true
      && record !== null && installation?.record === record
      && installation.mode === state.mode
      && installation.images === state.selectedImages
      && String(elements.message_input.value ?? "") === record.draft
      && (ignoreSearch || installation.search === retainedUpdateRecoverySearchSignature());
  }

  function invalidateRetainedUpdateRecoveryInstallation() {
    state.retainedUpdateRecoveryInstalled = false;
    state.retainedUpdateRecoveryInstallation = null;
  }

  function retainedUpdateRecoverySearchConflicts(record) {
    if (record === null || state.mode !== "agent") return false;
    if (record.schemaVersion !== UPDATE_HANDOFF_PAYLOAD_SCHEMA_VERSION
        || record.mode !== "agent") return state.agentSearchSelected;
    if (record.search !== null) {
      const capability = state.capabilities.search;
      const supported = capability?.enabled === true
        && capability.modes.includes(record.search.mode)
        && record.search.limit <= capability.maximumSources;
      // An unavailable former choice is resolved by the explicit Search / No
      // Search confirmation flow, not treated as competing browser work.
      if (!supported) return false;
    }
    const expected = record.search === null
      ? "off"
      : `on:${record.search.mode}:${String(record.search.limit)}`;
    return retainedUpdateRecoverySearchSignature() !== expected;
  }

  function finishRetainedUpdateRecovery({ discard = false } = {}) {
    if (!state.retainedUpdateRecoveryPending) return true;
    // A verified destination alone does not own the browser composer. A
    // Safari/BFCache-restored value may have raced the protected row, so normal
    // consumption is legal only after restoreUpdateHandoff installed that exact
    // record. Cross-account and confirmed sign-out paths explicitly discard it.
    if (!discard && !retainedUpdateRecoveryInstallationCurrent()) {
      invalidateRetainedUpdateRecoveryInstallation();
      elements.resume_run.hidden = false;
      showToast("The browser composer changed after recovery. The protected prompt was retained; press Resume twice to restore it explicitly.");
      updateImageControl();
      return false;
    }
    state.retainedUpdateRecoveryPending = false;
    state.retainedUpdateRecoveryDurable = false;
    state.retainedUpdateRecoveryThreadId = null;
    state.retainedUpdateRecoveryRecord = null;
    invalidateRetainedUpdateRecoveryInstallation();
    state.protectedComposerReplacementConfirmation = null;
    scrubCapturedUpdateHandoffClaim(window);
    if (claimedUpdateHandoff !== null) {
      void updateHandoffStore.discard(workerScope, claimedUpdateHandoff.handoffId).catch(() => {});
    }
    if (state.session.authenticated) updateImageControl();
    return true;
  }

  function finishAgentAuthenticationRecovery() {
    state.agentAuthenticationRecoveryPending = false;
    state.agentAuthenticationRecoveryThreadId = null;
    state.agentAuthenticationRecoveryVerified = false;
    state.authRecoveryAgent = null;
    if (state.authRecoveryWorkflow === null && state.authRecoveryGeneration === null) {
      state.authRecoveryPending = false;
      state.authRecoveryUsername = null;
    }
  }

  function confirmProtectedComposerReplacement(record, action) {
    const visibleDraft = String(elements.message_input.value ?? "");
    const visibleImages = state.selectedImages;
    const visibleSearch = retainedUpdateRecoverySearchSignature();
    const conflicts = (visibleDraft.length > 0 && visibleDraft !== record.draft)
      || visibleImages.length > 0 || retainedUpdateRecoverySearchConflicts(record);
    if (!conflicts) {
      state.protectedComposerReplacementConfirmation = null;
      return true;
    }
    const pending = state.protectedComposerReplacementConfirmation;
    if (pending?.record === record && pending.action === action
        && pending.visibleDraft === visibleDraft && pending.visibleImages === visibleImages
        && pending.visibleSearch === visibleSearch) {
      state.protectedComposerReplacementConfirmation = null;
      return true;
    }
    state.protectedComposerReplacementConfirmation = Object.freeze({
      record,
      action,
      visibleDraft,
      visibleImages,
      visibleSearch,
    });
    showToast(`${action} again to replace the conflicting browser-restored composer with the protected update prompt. Nothing was changed yet.`);
    return false;
  }

  function installRetainedUpdateRecovery(record, action, { acceptCurrentSearch = false } = {}) {
    if (record === null || record === undefined || !state.retainedUpdateRecoveryPending
        || state.retainedUpdateRecoveryRecord !== record) return true;
    if (retainedUpdateRecoveryInstallationCurrent(record)) return true;
    if (acceptCurrentSearch && state.agentSearchRecoveryChoicePending
        && retainedUpdateRecoveryInstallationCurrent(record, { ignoreSearch: true })) {
      state.retainedUpdateRecoveryInstallation = Object.freeze({
        ...state.retainedUpdateRecoveryInstallation,
        search: retainedUpdateRecoverySearchSignature(),
      });
      return true;
    }
    invalidateRetainedUpdateRecoveryInstallation();
    if (!confirmProtectedComposerReplacement(record, action)) return false;
    // The durable/account-bound record owns this explicit replacement. Clear a
    // conflicting local image selection before restoring its exact image set.
    elements.message_input.value = record.draft;
    if (state.selectedImages.length > 0) clearSelectedImage();
    if (!restoreUpdateHandoff(record)) {
      elements.resume_run.hidden = false;
      showToast("The protected prompt could not be installed yet. Resume or retry this action; it was not discarded.");
      return false;
    }
    return true;
  }

  function agentSearchRecoveryChoiceReady() {
    if (!state.agentSearchRecoveryChoicePending || !state.session.authenticated
        || state.mode !== "agent" || state.capabilities.enabled !== true
        || state.unavailableAgentUpdateRecovery
        || state.agentHistoryRestoring || state.agentReplayValidating || state.agentReplayFailed) return false;
    if (state.agentAuthenticationRecoveryPending) {
      if (!state.agentAuthenticationRecoveryVerified) return false;
      if (state.agentAuthenticationRecoveryThreadId !== null
          && state.agentThreadId !== state.agentAuthenticationRecoveryThreadId) return false;
    }
    const record = state.retainedUpdateRecoveryRecord;
    if (record?.mode === "agent" && record.threadId !== null) {
      return state.agentThreadId === record.threadId;
    }
    if (state.legacyUpdateRecoveryPending) {
      return state.legacyUpdateRecoveryDestinationChosen;
    }
    return true;
  }

  function confirmAgentSearchRecoveryChoice() {
    if (!agentSearchRecoveryChoiceReady()) return false;
    const retainedRecord = state.retainedUpdateRecoveryRecord;
    if (!installRetainedUpdateRecovery(retainedRecord, "Press Run Agent", {
      acceptCurrentSearch: true,
    })) return false;
    let selectedSearch;
    try { selectedSearch = selectedAgentSearch(); }
    catch {
      showToast("Choose a valid current Search mode and source limit, or turn Search off, before confirming.");
      return false;
    }
    state.agentSearchRecoveryChoicePending = false;
    if (state.legacyUpdateRecoveryPending && state.legacyUpdateRecoveryDestinationChosen) {
      state.legacyUpdateRecoveryPending = false;
      state.legacyUpdateRecoveryDestinationChosen = false;
      state.legacyUpdateRecoveryDestinationThreadId = null;
    }
    finishRetainedUpdateRecovery();
    finishAgentAuthenticationRecovery();
    updateImageControl();
    showToast(selectedSearch === undefined
      ? "No Search confirmed for the recovered Agent prompt. Review it, then Run Agent again."
      : `Search ${selectedSearch.mode} (${selectedSearch.limit} sources) confirmed. Review the recovered prompt, then Run Agent.`);
    return true;
  }

  function resolveLegacyUpdateRecovery(destination) {
    if (!state.legacyUpdateRecoveryPending) return;
    const retainedRecord = state.retainedUpdateRecoveryRecord;
    if (!installRetainedUpdateRecovery(retainedRecord, `Choose ${destination}`)) return false;
    if (state.mode === "agent") {
      state.legacyUpdateRecoveryDestinationChosen = true;
      state.legacyUpdateRecoveryDestinationThreadId = state.agentThreadId;
      state.agentSearchRecoveryChoicePending = true;
      updateImageControl();
      showToast("Agent destination selected. Choose Search, or press Run Agent once to confirm No Search; the following press sends.");
      return true;
    }
    state.legacyUpdateRecoveryPending = false;
    state.legacyUpdateRecoveryDestinationChosen = false;
    state.legacyUpdateRecoveryDestinationThreadId = null;
    finishRetainedUpdateRecovery();
    showToast(`Recovered prompt assigned to ${destination}; review it before sending.`);
    return true;
  }

  async function openThread(threadId, { mode = state.mode } = {}) {
    if (interactionLocked() || mode !== state.mode) return;
    if (mode === "agent" && state.agentPendingThreadCreate !== null) {
      showToast("Retry the ready prompt to confirm its exact Agent conversation before opening another one.");
      return;
    }
    if (mode === "chat" && state.chatPendingDeletion) {
      showToast("Retry the pending conversation deletion before opening another conversation.");
      return;
    }
    if (mode === "chat" && state.chatPendingSend) {
      showToast("Confirm the pending durable send with Resume before opening another conversation.");
      return;
    }
    const retainedRecord = state.retainedUpdateRecoveryPending
      ? state.retainedUpdateRecoveryRecord
      : null;
    if (retainedRecord?.mode === mode && retainedRecord.threadId !== null
        && threadId !== retainedRecord.threadId) {
      showToast(`Retry the exact recovered ${mode === "agent" ? "Agent" : "Chat"} conversation, or choose New conversation to detach its prompt.`);
      return;
    }
    if (mode === "agent" && state.agentAuthenticationRecoveryThreadId !== null
        && threadId !== state.agentAuthenticationRecoveryThreadId) {
      showToast("Retry the exact conversation recovered after sign-in, or choose New conversation to detach its prompt.");
      return;
    }
    const assignsRetainedRecord = retainedRecord !== null
      && (retainedRecord.mode === null
        || (retainedRecord.mode === mode
          && (retainedRecord.threadId === null || retainedRecord.threadId === threadId)));
    if (assignsRetainedRecord
        && !installRetainedUpdateRecovery(retainedRecord, "Open this conversation")) return;
    // A successful Agent restoration already owns the complete verified
    // presentation for this thread. Treat another click on that settled
    // selection as idempotent: replaying it would briefly leave the old
    // completed DOM visible, then detach and rebuild every message/artifact.
    // A nonterminal run may still need a fresh read, and a failed ledger
    // replay must remain reopenable as promised by its recovery message.
    if (mode === "agent" && threadId === state.agentThreadId
        && state.agentReplayFailed !== true
        && (state.runId === null || TERMINAL.has(state.agentRunStatus))) {
      if (assignsRetainedRecord && retainedRecord.mode !== null
          && !state.agentSearchRecoveryChoicePending) {
        finishRetainedUpdateRecovery();
      }
      resolveLegacyUpdateRecovery("this conversation");
      return;
    }
    state.busy = true;
    updateImageControl();
    renderThreads();
    state.viewEpoch += 1;
    state.streamAbort?.abort();
    let releaseRefreshTarget = null;
    try {
      if (mode === "agent") await openAgentThread(threadId);
      else {
        const threadHint = state.chatThreads.find((thread) => thread.threadId === threadId) ?? null;
        await openChatThread(threadId, { backgroundStream: true, threadHint });
      }
      if (currentThreadId() === threadId && (mode !== "agent" || state.agentReplayFailed !== true)) {
        if (retainedRecord?.mode === mode && retainedRecord.threadId === threadId
            && !state.agentSearchRecoveryChoicePending) {
          finishRetainedUpdateRecovery();
        } else if (mode === "agent" && state.retainedUpdateRecoveryThreadId === threadId) {
          if (!state.agentSearchRecoveryChoicePending) finishRetainedUpdateRecovery();
        }
        if (mode === "agent" && state.agentAuthenticationRecoveryThreadId === threadId) {
          state.agentAuthenticationRecoveryVerified = true;
          if (!state.agentSearchRecoveryChoicePending) finishAgentAuthenticationRecovery();
        }
        resolveLegacyUpdateRecovery("this conversation");
      }
    } catch (error) {
      releaseRefreshTarget = clientReleaseMismatch(error);
      if (releaseRefreshTarget !== null) {
        connection("Migrating protected work to the newer app", false);
      }
      else showToast(mode === "agent"
        ? "This AgInTi thread could not be opened safely."
        : "This LocalLLM conversation could not be restored safely.");
    } finally {
      state.busy = false;
      updateImageControl();
      renderThreads();
      flushDeferredSessionRevalidation();
    }
    if (releaseRefreshTarget !== null) await refreshForReleaseMismatch(releaseRefreshTarget);
  }

  async function restoreModeView({ autoOpen = false, prefetchedChatThreads = null } = {}) {
    const mode = state.mode;
    const epoch = ++state.viewEpoch;
    const preferred = mode === "agent" ? state.agentThreadId : state.chatThreadId;
    state.streamAbort?.abort();
    clearConversation();
    elements.conversation_title.textContent = "New conversation";
    if (mode === "agent") {
      state.agentHistoryRestoring = true;
      state.agentThreadId = null;
      state.runId = null;
      state.agentRunStatus = null;
      updateImageControl();
    }
    try {
      if (mode === "agent") await loadAgentThreads();
      else await loadChatThreads({ prefetched: prefetchedChatThreads });
      if (epoch !== state.viewEpoch || mode !== state.mode) return;
      const available = currentThreads();
      const selected = available.find((thread) => (mode === "agent" ? thread.id : thread.threadId) === preferred) ?? available[0];
      if (!autoOpen || !selected) return;
      const threadId = mode === "agent" ? selected.id : selected.threadId;
      if (mode === "agent") await openAgentThread(threadId);
      else await openChatThread(threadId, {
        backgroundStream: true,
        threadHint: selected,
        refreshThreadList: false,
      });
    } finally {
      if (mode === "agent" && epoch === state.viewEpoch && mode === state.mode) {
        state.agentHistoryRestoring = false;
        updateImageControl();
        flushDeferredSessionRevalidation();
      }
    }
  }

  async function sendAgent(text, search) {
    const session = state.session;
    const agent = state.agent;
    const current = () => state.session === session && state.agent === agent && state.session.authenticated;
    const exactMutation = async (operation) => {
      try { return await operation(); }
      catch (error) {
        if (error?.retryable !== true) throw error;
        connection("Confirming Agent request", false);
        await wait(250);
        return await operation();
      }
    };
    let threadId = state.agentThreadId;
    if (!threadId) {
      const pendingCreate = state.agentPendingThreadCreate ?? Object.freeze({
        title: conversationTitle(text),
        idempotency: createBrowserOpaqueId("agent_thread"),
      });
      state.agentPendingThreadCreate = pendingCreate;
      const create = () => agent.createThread(
        { title: pendingCreate.title },
        { idempotency: pendingCreate.idempotency },
      );
      let result;
      try {
        result = await exactMutation(create);
      } catch (error) {
        // A bounded non-retryable 4xx proves that this exact create was not
        // accepted, including a release-fence rejection. Do not retain an
        // ambiguity fence that would prevent the required app refresh.
        if (isAuthoritativeAgentRejection(error)
            && state.agentPendingThreadCreate === pendingCreate) {
          state.agentPendingThreadCreate = null;
        }
        throw error;
      }
      const { thread } = result;
      if (!current() || state.agentPendingThreadCreate !== pendingCreate) return;
      state.agentPendingThreadCreate = null;
      state.agentThreadId = thread.id;
      threadId = thread.id;
      state.agentThreads.unshift(thread);
      elements.conversation_title.textContent = thread.title;
      renderThreads();
    }
    const previousRunId = state.runId;
    if (previousRunId !== null && !TERMINAL.has(state.agentRunStatus)) {
      throw new AgintiProtocolError("A follow-up requires the current Agent run to be terminal", {
        code: "AGENT_RUN_ACTIVE",
      });
    }
    const idempotency = createBrowserOpaqueId(previousRunId === null ? "agent_start" : "agent_followup");
    const options = {
      idempotency,
      ...(search === undefined ? {} : { search }),
    };
    const dispatch = previousRunId === null
      ? () => agent.startRun(threadId, text, options)
      : () => agent.resumeRun(previousRunId, text, options);
    const { run } = await exactMutation(dispatch);
    if (!current()) return;
    const accepted = previousRunId === null
      ? correlatedAgentRun(run, { runId: run?.id, threadId })
      : correlatedResumedAgentRun(run, { previousRunId, threadId });
    if (search !== undefined) {
      state.agentSearchSelected = false;
      updateSearchControl();
    }
    messageNode("user", text);
    await streamAgentRun(accepted, { expectedThreadId: threadId });
  }

  function workflowAttachmentFields(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return {};
    return attachments.length === 1
      ? { attachment: attachments[0] }
      : { attachments };
  }

  async function exactRunMutation(chat, workflow, dispatch, retry) {
    try {
      const result = await dispatch();
      if (workflow.ambiguousMutation === "run_dispatch") workflow.ambiguousMutation = null;
      return result;
    } catch (error) {
      if (error?.retryable !== true) throw error;
      workflow.ambiguousMutation = "run_dispatch";
      const hasImages = workflow.runTicket?.attachment !== undefined
        || workflow.runTicket?.attachments !== undefined;
      if (hasImages) {
        connection("Confirming the accepted image upload", false);
        try {
          const authoritative = await chat.getRunStatus({
            threadId: workflow.runTicket.threadId,
            generationId: workflow.runTicket.generationId,
          });
          workflow.ambiguousMutation = null;
          return authoritative;
        } catch (probeError) {
          const definitelyAbsent = probeError instanceof DirectChatTransportError
            && probeError.retryable === false && probeError.status === 404;
          if (!definitelyAbsent) {
            if (isChatAuthenticationAfterAmbiguousDispatch(probeError)) throw probeError;
            throw error;
          }
        }
      }
      connection("Retrying the same durable request", false);
      await wait(250);
      const result = await retry();
      workflow.ambiguousMutation = null;
      return result;
    }
  }

  async function continueChatSend(workflow) {
    const session = state.session;
    const chat = state.chat;
    const ensureCurrentSession = () => {
      if (state.session !== session || state.chat !== chat || !state.session.authenticated) {
        throw new TypeError("the authenticated browser session changed");
      }
    };
    let thread = state.chatThread;
    if (!workflow.threadTicket && !state.chatThreadId) {
      workflow.threadTicket = prepareLocalChat(
        "local_thread",
        () => chat.prepareThread({ title: conversationTitle(workflow.text) }),
      );
    }
    if (workflow.threadTicket && !workflow.runTicket) {
      workflow.runTicket = prepareLocalChat(
        "local_run",
        () => chat.prepareRun({
          threadId: workflow.threadTicket.threadId,
          content: workflow.text,
          expectedRevision: 0,
          expectedHash: null,
          ...workflowAttachmentFields(workflow.attachments),
        }),
      );
    }
    if (workflow.threadTicket && !workflow.thread) {
      workflow.failureStage = "thread_dispatch";
      const firstDispatch = workflow.threadDispatched
        ? () => chat.retryCreateThread(workflow.threadTicket)
        : () => chat.createThread(workflow.threadTicket);
      workflow.threadDispatched = true;
      const created = await exactMutation(
        firstDispatch,
        () => chat.retryCreateThread(workflow.threadTicket),
        {
          onAmbiguous() { workflow.ambiguousMutation = "thread_dispatch"; },
          onConfirmed() {
            if (workflow.ambiguousMutation === "thread_dispatch") workflow.ambiguousMutation = null;
          },
        },
      );
      ensureCurrentSession();
      thread = created.thread;
      workflow.thread = thread;
      state.chatThreadId = thread.threadId;
      state.chatThread = thread;
      state.chatThreadListEpoch += 1;
      state.chatThreads = [thread, ...state.chatThreads.filter((item) => item.threadId !== thread.threadId)];
      elements.conversation_title.textContent = thread.title || "New conversation";
      renderThreads();
    }
    thread = workflow.thread ?? thread;
    let started;
    if (workflow.runTicket && workflow.runDispatched) {
      started = await exactRunMutation(
        chat,
        workflow,
        () => chat.retryRun(workflow.runTicket),
        () => chat.retryRun(workflow.runTicket),
      );
      ensureCurrentSession();
    } else {
      if (!workflow.runTicket) {
        const threadId = thread?.threadId === state.chatThreadId ? thread.threadId : state.chatThreadId;
        if (!threadId) throw new TypeError("the Direct Chat thread is unavailable");
        workflow.failureStage = "snapshot";
        const snapshot = await fetchChatSnapshot(threadId);
        ensureCurrentSession();
        if (state.localMessageImageUrls.size > 0
            && !await renderChatSnapshot(snapshot, {
              expectedEpoch: state.viewEpoch,
              restoreAttachments: false,
            })) {
          throw new DirectChatTransportError("Direct Chat snapshot ownership changed.", {
            code: "browser_state_changed",
            status: 499,
            retryable: false,
          });
        }
        thread = snapshot.thread;
        workflow.thread = thread;
        state.chatThread = thread;
        if (thread.currentGenerationId) throw new TypeError("the conversation already has a generation in progress");
        workflow.runTicket = prepareLocalChat(
          "local_run",
          () => chat.prepareRun({
            threadId: thread.threadId,
            content: workflow.text,
            expectedRevision: thread.revision,
            expectedHash: thread.ledgerHash,
            ...workflowAttachmentFields(workflow.attachments),
          }),
        );
      }
      workflow.failureStage = "run_dispatch";
      workflow.runDispatched = true;
      started = await exactRunMutation(
        chat,
        workflow,
        () => chat.startRun(workflow.runTicket),
        () => chat.retryRun(workflow.runTicket),
      );
      ensureCurrentSession();
    }
    const acceptedGeneration = started.generation;
    // startRun() also returns its immutable request for callers that need an
    // audit receipt. Do not keep that request (and its image bytes) in this
    // long-lived async frame while LocalLLM is generating.
    started = null;
    workflow.runTicket = null;
    workflow.attachments = Object.freeze([]);
    if (workflow.lockedComposer !== null) {
      if (elements.message_input.value === workflow.lockedComposer.draft) elements.message_input.value = "";
      if (workflow.lockedComposer.images.length > 0
          && state.selectedImages === workflow.lockedComposer.images) {
        clearSelectedImage();
      }
      workflow.lockedComposer = null;
    }
    workflow.recoveryComposer = null;
    state.chatPendingSend = null;
    clearChatFailureDiagnostic();
    renderThreads();
    state.chatGeneration = acceptedGeneration;
    state.chatAfterSequence = 0;
    state.chatOutput = "";
    if (state.mode === "chat" && state.chatThreadId === acceptedGeneration.threadId) {
      messageNode("user", workflow.text, {
        runId: acceptedGeneration.generationId,
        ...(workflow.localPreviews.length === 0 ? {} : { localAttachments: workflow.localPreviews }),
      });
    }
    // The server now owns this exact turn. Release the canonical byte set and
    // its pre-serialized retry body before waiting on LocalLLM output; only
    // the bounded visible Blob previews remain in the conversation DOM.
    workflow.localPreviews = Object.freeze([]);
    const onAccepted = workflow.onAccepted;
    workflow.onAccepted = null;
    try { onAccepted?.(); } catch { /* Acceptance must not be undone by local cleanup. */ }
    if (acceptedGeneration.terminal) await finishChatGeneration(acceptedGeneration, new AbortController());
    else await streamChatGeneration(acceptedGeneration);
  }

  async function sendChat(text, attachments = Object.freeze([]), {
    localPreviews = Object.freeze([]), onAccepted = null,
  } = {}) {
    if (state.chatPendingSend) throw new TypeError("a durable chat request is already pending");
    if (state.chatGeneration?.status === "in_progress") throw new TypeError("the current generation must finish or be cancelled first");
    const workflow = {
      text,
      attachments,
      localPreviews,
      threadTicket: null,
      threadDispatched: false,
      thread: null,
      runTicket: null,
      runDispatched: false,
      lockedComposer: null,
      recoveryComposer: null,
      failureStage: "before_run_dispatch",
      ambiguousMutation: null,
      onAccepted,
    };
    // The workflow is the only owner until server acceptance. Clear the
    // parameter bindings because this frame stays alive for the full stream.
    attachments = Object.freeze([]);
    localPreviews = Object.freeze([]);
    onAccepted = null;
    state.chatPendingSend = workflow;
    renderThreads();
    try { await continueChatSend(workflow); }
    catch (error) {
      const authenticationAfterAmbiguousDispatch = workflow.ambiguousMutation !== null
        && isChatAuthenticationAfterAmbiguousDispatch(error);
      if (authenticationAfterAmbiguousDispatch) {
        elements.resume_run.hidden = false;
        renderThreads();
        throw error;
      }
      const authoritativeRejection = isAuthoritativeChatRejection(error);
      const notSent = error instanceof LocalChatNotSentError || authoritativeRejection
        || (!workflow.runDispatched && (!workflow.threadDispatched || workflow.thread !== null));
      if (notSent) {
        if (state.chatPendingSend === workflow) state.chatPendingSend = null;
        elements.resume_run.hidden = true;
      } else {
        elements.resume_run.hidden = false;
      }
      renderThreads();
      throw notSent && !(error instanceof LocalChatNotSentError)
        ? new LocalChatNotSentError(workflow.failureStage, error)
        : error;
    }
  }

  async function selectImage() {
    if (interactionLocked() || !state.session.authenticated || state.mode !== "chat"
        || state.chatCapabilities.visionInput !== true || state.chatPendingSend !== null
        || state.chatPendingDeletion !== null || state.logoutPending) return;
    const files = elements.image_input.files;
    if (!files || files.length < 1) {
      elements.image_input.value = "";
      updateImageControl();
      return;
    }
    const selectedFiles = Array.from(files);
    if (state.selectedImages.length + selectedFiles.length > COMPOSER_IMAGE_COUNT_LIMIT) {
      elements.image_input.value = "";
      showToast(`Choose up to ${COMPOSER_IMAGE_COUNT_LIMIT} JPEG, PNG, HEIC, or HEIF still images per message.`);
      updateImageControl();
      return;
    }
    const selectionEpoch = state.imageSelectionEpoch;
    const PreparationAbortController = window?.AbortController ?? globalThis.AbortController;
    const preparationController = typeof PreparationAbortController === "function"
      ? new PreparationAbortController()
      : null;
    state.imagePreparationAbort = preparationController;
    state.imagePreparing = true;
    updateImageControl();
    const prepared = [];
    const previewUrls = [];
    try {
      for (const file of selectedFiles) {
        prepared.push(await canonicalizeImage(file, {
          document,
          makeAttachmentId: createBrowserOpaqueId,
          signal: preparationController?.signal,
          timeoutMs: attachmentDecodeTimeoutMs,
        }));
      }
      if (selectionEpoch !== state.imageSelectionEpoch || !state.imagePreparing
          || !state.session.authenticated || state.mode !== "chat"
          || state.chatCapabilities.visionInput !== true || state.logoutPending) return;
      const combined = [...state.selectedImages, ...prepared];
      const totalBytes = combined.reduce((total, image) => total + image.byteLength, 0);
      if (totalBytes > COMPOSER_IMAGE_BYTES_LIMIT
          || new Set(combined.map((image) => image.attachmentId)).size !== combined.length) {
        throw new TypeError("selected images exceed the aggregate limit");
      }
      for (const selected of prepared) previewUrls.push(createObjectUrl(selected.previewBlob));
      invalidatePreparedUpdateHandoff();
      state.selectedImages = Object.freeze(combined);
      state.selectedImageUrls = Object.freeze([...state.selectedImageUrls, ...previewUrls]);
      previewUrls.length = 0;
      renderSelectedImages();
    } catch (error) {
      if (selectionEpoch === state.imageSelectionEpoch && state.imagePreparing) {
        const actionableHeifFailure = error instanceof VisionImageInputError
          && error.code === "heif_decode_unavailable";
        const timedOut = error instanceof VisionImageInputError
          && error.code === "image_preparation_timeout";
        showToast(actionableHeifFailure || timedOut
          ? error.message
          : "Those images could not be prepared safely. Use up to four JPEG, PNG, HEIC, or HEIF still photos, each up to 24 MiB; the app will downscale them for sending.");
      }
    } finally {
      for (const previewUrl of previewUrls) revokeObjectUrl(previewUrl);
      elements.image_input.value = "";
      if (selectionEpoch === state.imageSelectionEpoch) {
        state.imagePreparing = false;
        if (state.imagePreparationAbort === preparationController) state.imagePreparationAbort = null;
      }
      updateImageControl();
    }
  }

  async function submitMessage(event) {
    event?.preventDefault?.();
    if (!state.session.authenticated) return;
    if (state.agentSearchRecoveryChoicePending) {
      if (confirmAgentSearchRecoveryChoice()) return;
      if (state.protectedComposerReplacementConfirmation !== null) return;
      showToast(agentSearchRecoveryChoiceReady()
        ? "Choose a valid current Search setting, or turn Search off, before confirming this recovered Agent prompt."
        : "Wait for the recovered Agent conversation to finish verification before confirming Search or No Search.");
      return;
    }
    if (interactionLocked()) return;
    if (state.legacyUpdateRecoveryPending) {
      showToast("Choose the intended conversation, or New conversation, before sending this prompt recovered from the previous app version.");
      return;
    }
    if (state.retainedUpdateRecoveryPending) {
      showToast("Verify the exact recovered Agent conversation, or choose New conversation after Agent is available, before sending this prompt.");
      return;
    }
    if (state.agentAuthenticationRecoveryPending) {
      showToast("Wait for the exact Agent conversation to finish verification, or choose New conversation to detach the prompt.");
      return;
    }
    if (state.mode === "chat" && state.chatPendingDeletion) {
      showToast("Retry the pending conversation deletion before sending another message.");
      return;
    }
    if (state.mode === "agent" && (state.agentHistoryRestoring || state.agentReplayFailed)) {
      showToast(state.agentHistoryRestoring
        ? "Wait for verified Agent history to finish restoring before creating more work."
        : "Reopen this conversation before creating more Agent work; its verified history is not available yet.");
      return;
    }
    if (state.mode === "chat" && state.chatPendingSend) {
      showToast("The previous durable send is awaiting confirmation. Use Resume; this draft and its images were not changed.");
      return;
    }
    if (state.imagePreparing) {
      cancelImagePreparation();
      updateImageControl();
      return;
    }
    clearChatFailureDiagnostic();
    const draft = elements.message_input.value;
    let text;
    try { text = boundedMessage(draft); }
    catch { return; }
    const requestedTool = state.mode === "chat" && state.capabilities.enabled === true && !state.agentReplayFailed
      && state.selectedImages.length === 0
      ? requestedAvailableAgentTool(text, state.capabilities)
      : null;
    if (requestedTool !== null) {
      if (agentHandoffNeedsChatContext(text)) {
        showToast("This request depends on Direct Chat context that Agent cannot receive automatically. Switch to Agent and include the needed text, data, or code in this prompt; nothing was sent.");
        return;
      }
      setMode("agent", { restoreView: false, remember: false });
      if (state.mode === "agent") {
        newConversation();
        showToast(requestedTool === "document"
          ? "Handed to Agent because TeX/PDF creation needs its verified file tool."
          : "Handed to Agent to run code and show the result here.");
      }
    }
    const submissionSession = state.session;
    const submissionMode = state.mode;
    const submissionChat = state.chat;
    let agentSearch;
    if (submissionMode === "agent") {
      try { agentSearch = selectedAgentSearch(); }
      catch {
        showToast("Choose a valid Search mode and source limit before running the Agent.");
        return;
      }
    }
    if (state.mode === "chat") fenceAttachmentRestorationsForSend();
    let detachedImage = state.mode === "chat" ? detachSelectedImage() : null;
    let selected = detachedImage?.selected ?? Object.freeze([]);
    let attachments = Object.freeze(selected.map((image) => Object.freeze({
      attachmentId: image.attachmentId,
      mediaType: image.mediaType,
      byteLength: image.byteLength,
      width: image.width,
      height: image.height,
      bytes: image.bytes,
    })));
    let localPreviews = Object.freeze(selected.map((image) => {
      const previewBlob = image.previewBlob instanceof Blob
        ? image.previewBlob
        : new Blob([image.bytes], { type: image.mediaType });
      return Object.freeze({ mediaType: previewBlob.type || image.mediaType, previewBlob });
    }));
    let releaseRefreshTarget = null;
    elements.message_input.value = "";
    state.busy = true;
    elements.send_message.disabled = true;
    if (submissionMode === "agent") beginAgentSubmissionActivity();
    updateImageControl();
    try {
      if (state.mode === "agent" && state.capabilities.enabled) await sendAgent(text, agentSearch);
      else await sendChat(text, attachments, {
        localPreviews,
        onAccepted() {
          disposeDetachedImage(detachedImage);
          detachedImage = null;
          selected = Object.freeze([]);
          attachments = Object.freeze([]);
          localPreviews = Object.freeze([]);
        },
      });
    } catch (error) {
      const sameOwner = state.session === submissionSession
        && state.session.authenticated
        && state.mode === submissionMode
        && (submissionMode !== "chat" || state.chat === submissionChat);
      if (!sameOwner) return;
      releaseRefreshTarget = clientReleaseMismatch(error);
      if (releaseRefreshTarget !== null) {
        elements.message_input.value = draft;
        if (state.mode === "chat") {
          const imageRestored = restoreDetachedImage(detachedImage);
          if (imageRestored) detachedImage = null;
        }
        connection("Refreshing browser app", false);
        showToast("A newer app release is ready. Your unsent prompt and images are being protected before refresh.");
        return;
      }
      if (state.mode === "chat" && state.chatPendingSend) {
        state.chatPendingSend.recoveryComposer = Object.freeze({ draft, images: selected });
      }
      const ambiguousAuthenticationWorkflow = state.mode === "chat"
        && state.chatPendingSend?.ambiguousMutation !== null
        && state.chatPendingSend?.ambiguousMutation !== undefined
        && isChatAuthenticationAfterAmbiguousDispatch(error)
        ? state.chatPendingSend
        : null;
      if (ambiguousAuthenticationWorkflow !== null) {
        elements.message_input.value = draft;
        const imageRestored = restoreDetachedImage(detachedImage);
        detachedImage = null;
        ambiguousAuthenticationWorkflow.lockedComposer = Object.freeze({
          draft,
          images: imageRestored ? selected : Object.freeze([]),
        });
        const diagnostic = applyChatFailureDiagnostic(new LocalChatNotSentError(
          ambiguousAuthenticationWorkflow.ambiguousMutation,
          error,
        ));
        connection(`Send confirmation paused · ${diagnostic.label}`, false);
        showToast(imageRestored
          ? "Sign in again. This exact image send may already exist; Resume confirms it without creating a duplicate."
          : "Sign in again. This exact send may already exist; Resume confirms it without creating a duplicate.");
        requireFreshAuthentication({ workflow: ambiguousAuthenticationWorkflow });
      } else if (state.mode === "chat" && error instanceof LocalChatNotSentError) {
        elements.message_input.value = draft;
        const imageRestored = restoreDetachedImage(detachedImage);
        detachedImage = null;
        const diagnostic = applyChatFailureDiagnostic(error);
        showToast(imageRestored
          ? `This image message was not sent. Your prompt and ${selected.length === 1 ? "image" : "images"} are still ready; edit or retry them.`
          : "This message was not sent. Your prompt is still in the composer; edit it and try again.");
        if (diagnostic.reauthenticate) requireFreshAuthentication();
      } else if (state.mode === "chat" && state.chatPendingSend && !state.chatPendingSend.runDispatched) {
        elements.message_input.value = draft;
        const imageRestored = restoreDetachedImage(detachedImage);
        detachedImage = null;
        state.chatPendingSend.lockedComposer = Object.freeze({
          draft,
          images: imageRestored ? selected : Object.freeze([]),
        });
        connection("Thread confirmation pending", false);
        showToast(imageRestored
          ? `The thread may already exist. Your prompt and ${selected.length === 1 ? "image" : "images"} remain visible and locked; Resume confirms the exact send.`
          : "The thread may already exist. Your prompt remains visible and locked; Resume confirms the exact send.");
      } else {
        if (state.mode === "agent") {
          if (elements.message_input.value === "") elements.message_input.value = draft;
          elements.run_state.textContent = "Interrupted";
          elements.workspace.dataset.status = "failed";
          if (state.agentThreadId !== null) {
            // Until a fresh authoritative read succeeds, the dispatch may have
            // reached AgInTi even though its response was unusable. Reuse the
            // existing fail-closed history fence so another send cannot create
            // a successor from stale local state and same-thread reopen cannot
            // take the settled-view no-op path.
            state.agentReplayFailed = true;
          }
          connection("Request interrupted", false);
          showToast(state.agentThreadId !== null
            ? "AgInTi did not confirm this request. Your prompt is still ready; reopen this conversation to confirm server state before retrying."
            : state.agentPendingThreadCreate !== null
              ? "AgInTi did not confirm the new conversation. Your prompt is still ready; retry it to confirm the same exact conversation without creating a duplicate."
              : "AgInTi rejected the new conversation. Your prompt is still ready; edit it or retry when the service is available.");
        } else if (state.chatPendingSend) {
          connection("Send confirmation pending", false);
          showToast("The durable send is awaiting confirmation. Resume reuses it without dispatching a duplicate.");
        } else if (state.chatGeneration?.status === "in_progress") {
          connection("Generation connection paused", false);
          showToast("The LocalLLM generation remains server-owned. Resume reconnects to it without restarting.");
        } else {
          connection("Chat unavailable", false);
          showToast("This chat request could not be completed or safely retried.");
        }
      }
    } finally {
      disposeDetachedImage(detachedImage);
      state.busy = false;
      updateImageControl();
      renderThreads();
      flushDeferredSessionRevalidation();
      if (releaseRefreshTarget !== null) await refreshForReleaseMismatch(releaseRefreshTarget);
    }
  }

  async function authenticated(session, {
    preserveLoginInput = false,
    clearPasswordOnAuthenticated = false,
  } = {}) {
    const recoveringAuthenticationDraft = state.authRecoveryPending;
    const recoveryUsername = state.authRecoveryUsername;
    const recoveryWorkflow = state.authRecoveryWorkflow;
    const recoveryGeneration = state.authRecoveryGeneration;
    const recoveryAgent = state.authRecoveryAgent;
    const recoveryLegacyUpdate = state.authRecoveryLegacyUpdatePending;
    const recoveryLegacyMode = state.authRecoveryLegacyMode;
    const recoveryLegacyDestinationChosen = state.authRecoveryLegacyDestinationChosen;
    const recoveryLegacyDestinationThreadId = state.authRecoveryLegacyDestinationThreadId;
    const recoveryRetainedUpdate = state.retainedUpdateRecoveryPending;
    const recoveryRetainedDurable = state.retainedUpdateRecoveryDurable;
    const recoveryRetainedThreadId = state.retainedUpdateRecoveryThreadId;
    const recoveryRetainedRecord = state.retainedUpdateRecoveryRecord;
    const recoveryRetainedInstalled = state.retainedUpdateRecoveryInstalled;
    const recoveryRetainedInstallation = state.retainedUpdateRecoveryInstallation;
    const preserveUninstalledRetainedComposer = recoveryRetainedUpdate
      && recoveryRetainedRecord !== null
      && !retainedUpdateRecoveryInstallationCurrent(recoveryRetainedRecord);
    state.chatPendingDeletion = null;
    purgeAttachmentBlobCache();
    state.session = sessionEnvelope(session);
    if (!state.session.authenticated) { showLogin("", { preservePassword: preserveLoginInput }); return; }
    const discardedCrossAccountDraft = recoveringAuthenticationDraft
      && normalizedSessionUsername(state.session.username) !== recoveryUsername;
    if (discardedCrossAccountDraft) {
      finishRetainedUpdateRecovery({ discard: true });
      elements.message_input.value = "";
      clearSelectedImage();
      if (recoveryWorkflow !== null) {
        recoveryWorkflow.text = "";
        recoveryWorkflow.attachments = Object.freeze([]);
        recoveryWorkflow.localPreviews = Object.freeze([]);
        recoveryWorkflow.threadTicket = null;
        recoveryWorkflow.runTicket = null;
        recoveryWorkflow.lockedComposer = null;
        recoveryWorkflow.recoveryComposer = null;
        recoveryWorkflow.ambiguousMutation = null;
      }
      state.authRecoveryPending = false;
      state.authRecoveryUsername = null;
      state.authRecoveryWorkflow = null;
      state.authRecoveryGeneration = null;
      state.authRecoveryAgent = null;
      state.authRecoveryLegacyUpdatePending = false;
      state.authRecoveryLegacyMode = null;
      state.authRecoveryLegacyDestinationChosen = false;
      state.authRecoveryLegacyDestinationThreadId = null;
    }
    const sameAccountRecoveryWorkflow = discardedCrossAccountDraft ? null : recoveryWorkflow;
    const sameAccountRecoveryGeneration = discardedCrossAccountDraft ? null : recoveryGeneration;
    const sameAccountRecoveryAgent = discardedCrossAccountDraft ? null : recoveryAgent;
    const sameAccountRecoveryLegacy = !discardedCrossAccountDraft && recoveryLegacyUpdate;
    const carriedProtectedUpdate = !discardedCrossAccountDraft && recoveryRetainedUpdate
      && recoveryRetainedRecord !== null && sameAccountRecoveryWorkflow === null
      && sameAccountRecoveryGeneration === null && sameAccountRecoveryAgent === null
      && !sameAccountRecoveryLegacy;
    const authenticatedSession = state.session;
    if (clearPasswordOnAuthenticated) elements.password.value = "";
    elements.logout.disabled = true;
    try {
      state.viewEpoch += 1;
      state.streamAbort?.abort();
      state.agentThreads = [];
      state.chatThreadListEpoch += 1;
      state.chatThreads = [];
      state.agentThreadId = null;
      state.chatThreadId = sameAccountRecoveryGeneration?.threadId ?? null;
      state.chatThread = sameAccountRecoveryGeneration?.thread ?? null;
      state.chatGeneration = sameAccountRecoveryGeneration?.generation ?? null;
      state.chatAfterSequence = sameAccountRecoveryGeneration?.afterSequence ?? 0;
      state.chatOutput = sameAccountRecoveryGeneration?.output ?? "";
      state.chatPendingSend = sameAccountRecoveryWorkflow;
      state.chatPendingDeletion = null;
      state.chatFinalization = null;
      state.runId = null;
      state.agentRunStatus = null;
      state.agentPendingResume = null;
      state.agentPendingThreadCreate = null;
      state.agentSearchSelected = false;
      state.agentSearchRecoveryChoicePending = false;
      state.authRecoveryAgent = sameAccountRecoveryAgent;
      state.authRecoveryLegacyUpdatePending = sameAccountRecoveryLegacy;
      state.authRecoveryLegacyMode = sameAccountRecoveryLegacy ? recoveryLegacyMode : null;
      state.authRecoveryLegacyDestinationChosen = sameAccountRecoveryLegacy
        && recoveryLegacyDestinationChosen;
      state.authRecoveryLegacyDestinationThreadId = sameAccountRecoveryLegacy
        ? recoveryLegacyDestinationThreadId
        : null;
      state.legacyUpdateRecoveryPending = sameAccountRecoveryLegacy;
      state.legacyUpdateRecoveryDestinationChosen = sameAccountRecoveryLegacy
        && recoveryLegacyDestinationChosen;
      state.legacyUpdateRecoveryDestinationThreadId = sameAccountRecoveryLegacy
        ? recoveryLegacyDestinationThreadId
        : null;
      state.unavailableAgentUpdateRecovery = sameAccountRecoveryAgent !== null;
      state.retainedUpdateRecoveryPending = false;
      state.retainedUpdateRecoveryDurable = false;
      state.retainedUpdateRecoveryThreadId = null;
      state.retainedUpdateRecoveryRecord = null;
      invalidateRetainedUpdateRecoveryInstallation();
      state.protectedComposerReplacementConfirmation = null;
      state.agentAuthenticationRecoveryPending = sameAccountRecoveryAgent !== null;
      state.agentAuthenticationRecoveryThreadId = sameAccountRecoveryAgent?.threadId ?? null;
      state.agentAuthenticationRecoveryVerified = false;
      state.agentReplayFailed = sameAccountRecoveryAgent !== null;
      if (sameAccountRecoveryAgent !== null && !preserveUninstalledRetainedComposer) {
        state.agentThreadId = sameAccountRecoveryAgent.threadId;
        elements.message_input.value = sameAccountRecoveryAgent.draft;
      } else if (sameAccountRecoveryAgent !== null) {
        state.agentThreadId = sameAccountRecoveryAgent.threadId;
      }
      if (!discardedCrossAccountDraft && recoveryRetainedUpdate) {
        state.retainedUpdateRecoveryPending = true;
        state.retainedUpdateRecoveryDurable = recoveryRetainedDurable;
        state.retainedUpdateRecoveryThreadId = recoveryRetainedThreadId;
        state.retainedUpdateRecoveryRecord = recoveryRetainedRecord;
        state.retainedUpdateRecoveryInstalled = recoveryRetainedInstalled;
        state.retainedUpdateRecoveryInstallation = recoveryRetainedInstallation;
      }
      clearConversation();
      const updateRecovery = sameAccountRecoveryWorkflow === null && sameAccountRecoveryGeneration === null
          && sameAccountRecoveryAgent === null && !sameAccountRecoveryLegacy
        ? await consumeUpdateHandoff({
            agentCapabilities: FAIL_CLOSED_AGENT_CAPABILITIES,
            retainUntilInitialized: true,
          })
        : null;
      const updateHandoff = updateRecovery?.record
        ?? (carriedProtectedUpdate ? recoveryRetainedRecord : null);
      if (updateRecovery !== null) {
        // Capability and client setup below are fallible. Keep both an
        // in-memory ownership fence and, when possible, the encrypted local
        // row until the recovered destination can be reconstructed safely.
        state.retainedUpdateRecoveryPending = true;
        state.retainedUpdateRecoveryDurable = updateRecovery.retainedForReload === true;
        state.retainedUpdateRecoveryThreadId = updateHandoff.mode === "agent"
          ? updateHandoff.threadId
          : null;
        state.retainedUpdateRecoveryRecord = updateHandoff;
        invalidateRetainedUpdateRecoveryInstallation();
      }
      state.agent = createAgentClient(state.session);
      state.chat = createChatClient(state.session);
      requiredMethod(state.agent, "capabilities", "agent client");
      requiredMethod(state.agent, "listThreads", "agent client");
      requiredMethod(state.agent, "streamRunEvents", "agent client");
      for (const method of [
        "capabilities", "prepareThread", "createThread", "retryCreateThread", "listThreads", "getThread",
        "prepareThreadDeletion", "deleteThread", "retryDeleteThread", "listMessages", "getAttachment",
        "prepareRun", "startRun", "retryRun", "getRunStatus", "streamRunEvents", "prepareCancellation", "cancelRun",
      ]) requiredMethod(state.chat, method, "chat client");
      const authenticatedChat = state.chat;
      const startupChatThreads = Object.freeze({
        session: authenticatedSession,
        chat: authenticatedChat,
        result: Promise.resolve()
          .then(() => authenticatedChat.listThreads({ limit: 100 }))
          .then(
            (response) => Object.freeze({ succeeded: true, response }),
            (error) => Object.freeze({ succeeded: false, error }),
          ),
      });
      const readChatCapability = async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const value = chatCapabilityEnvelope(await authenticatedChat.capabilities());
            return { succeeded: true, value };
          } catch (error) {
            if (clientReleaseMismatch(error) !== null) throw error;
            if (attempt < 2) await wait(250 * (2 ** attempt));
          }
        }
        return {
          succeeded: false,
          value: Object.freeze({ visionInput: false, visionMediaTypes: Object.freeze([]), maximumImageBytes: 0 }),
        };
      };
      const readAgentCapability = async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            return { succeeded: true, value: validateAgentCapabilities(await state.agent.capabilities()) };
          } catch (error) {
            if (clientReleaseMismatch(error) !== null) throw error;
            if (attempt < 2) await wait(250 * (2 ** attempt));
          }
        }
        return { succeeded: false, value: FAIL_CLOSED_AGENT_CAPABILITIES };
      };
      const [agentCapabilityProbe, chatCapabilityProbe] = await Promise.all([
        readAgentCapability(),
        readChatCapability(),
      ]);
      const capability = agentCapabilityProbe.value;
      const chatCapabilityVerified = chatCapabilityProbe.succeeded;
      const chatCapability = chatCapabilityProbe.value;
      if (state.session !== authenticatedSession || !state.session.authenticated) return;
      state.capabilities = capability;
      state.chatCapabilities = chatCapability;
      if (state.session !== authenticatedSession || !state.session.authenticated) return;
      if (updateHandoff?.mode === "agent") state.agentThreadId = updateHandoff.threadId;
      else if (updateHandoff?.mode === "chat") state.chatThreadId = updateHandoff.threadId;
      const ambiguousLegacyRecovery = sameAccountRecoveryLegacy
        || updateHandoff?.legacyModeAmbiguous === true;
      const legacyRecoveryMode = ambiguousLegacyRecovery
        ? capability.enabled === true
          ? (sameAccountRecoveryLegacy ? recoveryLegacyMode : null)
            ?? restoreWorkspaceMode() ?? selectDefaultMode(capability)
          : "chat"
        : null;
      state.legacyUpdateRecoveryPending = ambiguousLegacyRecovery;
      state.authRecoveryLegacyUpdatePending = false;
      state.authRecoveryLegacyMode = null;
      state.authRecoveryLegacyDestinationChosen = false;
      state.authRecoveryLegacyDestinationThreadId = null;
      state.agentReplayFailed = false;
      const updateSearchAvailable = updateHandoff?.search == null
        || (capability.search?.enabled === true
          && capability.search.modes.includes(updateHandoff.search.mode)
          && updateHandoff.search.limit <= capability.search.maximumSources);
      const unavailableRecoveredAgent = updateHandoff?.mode === "agent"
        && capability.enabled !== true;
      const updateSearchChoiceRequired = updateHandoff?.mode === "agent"
        && capability.enabled === true && !updateSearchAvailable;
      const updateRequiresVerification = updateHandoff !== null
        && (unavailableRecoveredAgent || updateSearchChoiceRequired || updateHandoff.legacyModeAmbiguous
          || updateHandoff.threadId !== null);
      state.unavailableAgentUpdateRecovery = unavailableRecoveredAgent;
      if (updateHandoff !== null) {
        if (updateRequiresVerification) {
          state.retainedUpdateRecoveryPending = true;
          state.retainedUpdateRecoveryThreadId = updateHandoff.mode === "agent"
            ? updateHandoff.threadId
            : null;
          state.retainedUpdateRecoveryRecord = updateHandoff;
          invalidateRetainedUpdateRecoveryInstallation();
        }
      }
      const authenticationAgentSearchAvailable = sameAccountRecoveryAgent?.searchInvalid !== true
        && (sameAccountRecoveryAgent?.search == null
          || (capability.search?.enabled === true
          && capability.search.modes.includes(sameAccountRecoveryAgent.search.mode)
          && sameAccountRecoveryAgent.search.limit <= capability.search.maximumSources));
      const authenticationSearchChoiceRequired = sameAccountRecoveryAgent !== null
        && capability.enabled === true && !authenticationAgentSearchAvailable;
      state.agentSearchRecoveryChoicePending = updateSearchChoiceRequired
        || authenticationSearchChoiceRequired
        || (ambiguousLegacyRecovery && state.legacyUpdateRecoveryDestinationChosen);
      if (sameAccountRecoveryAgent !== null) {
        state.agentThreadId = sameAccountRecoveryAgent.threadId;
        state.agentAuthenticationRecoveryPending = true;
        state.agentAuthenticationRecoveryThreadId = sameAccountRecoveryAgent.threadId;
        state.agentAuthenticationRecoveryVerified = false;
        if (!preserveUninstalledRetainedComposer) {
          elements.message_input.value = sameAccountRecoveryAgent.draft;
        }
        if (capability.enabled !== true) {
          state.unavailableAgentUpdateRecovery = true;
        }
      }
      if (state.unavailableAgentUpdateRecovery) state.agentReplayFailed = true;
      if (sameAccountRecoveryWorkflow?.thread) {
        state.chatThread = sameAccountRecoveryWorkflow.thread;
        state.chatThreadId = sameAccountRecoveryWorkflow.thread.threadId;
      }
      showApp();
      const recoveryMode = (sameAccountRecoveryAgent !== null ? "agent" : null)
        ?? updateHandoff?.mode ?? legacyRecoveryMode
        ?? (recoveringAuthenticationDraft && !discardedCrossAccountDraft ? "chat" : null);
      setMode(recoveryMode
        ?? restoreWorkspaceMode() ?? selectDefaultMode(capability), {
        restoreView: false,
        remember: false,
        allowUnavailableAgentRecovery: state.unavailableAgentUpdateRecovery,
        allowRetainedUpdateRecovery: state.retainedUpdateRecoveryPending || sameAccountRecoveryAgent !== null,
        allowAgentAuthenticationRecovery: sameAccountRecoveryAgent !== null,
      });
      if (sameAccountRecoveryAgent?.search != null && authenticationAgentSearchAvailable) {
        state.agentSearchSelected = true;
        elements.search_mode.value = sameAccountRecoveryAgent.search.mode;
        elements.search_limit.value = String(sameAccountRecoveryAgent.search.limit);
      }
      const recoveryImageNeedsUserAction = recoveringAuthenticationDraft && !discardedCrossAccountDraft
        && state.selectedImages.length > 0 && chatCapability.visionInput !== true
        && sameAccountRecoveryWorkflow === null;
      const agentAuthenticationNeedsVerification = sameAccountRecoveryAgent !== null
        && state.agentAuthenticationRecoveryPending;
      state.authRecoveryPending = recoveryImageNeedsUserAction || agentAuthenticationNeedsVerification;
      state.authRecoveryUsername = state.authRecoveryPending
        ? normalizedSessionUsername(state.session.username)
        : null;
      state.authRecoveryWorkflow = null;
      state.authRecoveryGeneration = sameAccountRecoveryGeneration;
      state.authRecoveryAgent = agentAuthenticationNeedsVerification ? sameAccountRecoveryAgent : null;
      clearChatFailureDiagnostic();
      updateImageControl();
      const restoredUpdateHandoff = restoreUpdateHandoff(updateHandoff);
      if (updateHandoff !== null && !restoredUpdateHandoff) {
        elements.resume_run.hidden = false;
        showToast(state.retainedUpdateRecoveryDurable
          ? "The saved update draft could not be restored yet. Resume retries here; reload is also safe."
          : "The saved update draft is protected on this page only. Resume retries here, or choose New conversation to detach it explicitly.");
      } else if (updateHandoff !== null && !updateRequiresVerification) {
        finishRetainedUpdateRecovery();
      }
      if (sameAccountRecoveryWorkflow !== null) {
        connection("Signed in · exact send ready to confirm");
      } else if (sameAccountRecoveryGeneration !== null) {
        connection("Signed in · reconnecting to LocalLLM", false);
      } else if (recoveryImageNeedsUserAction) {
        connection(chatCapabilityVerified
          ? "Signed in · image sending unavailable"
          : "Signed in · image capability unavailable", false);
      } else if (state.unavailableAgentUpdateRecovery) {
        connection(sameAccountRecoveryAgent !== null
          ? "Signed in · Agent verification waiting"
          : "Updated · Agent recovery waiting", false);
      } else if (state.legacyUpdateRecoveryPending) {
        connection("Updated · choose the intended conversation", false);
      } else if (sameAccountRecoveryAgent !== null) {
        connection("Signed in · verifying exact Agent conversation", false);
      } else {
        connection(restoredUpdateHandoff
          ? "Updated · unsent draft ready"
          : recoveringAuthenticationDraft && !discardedCrossAccountDraft
          ? "Signed in · unsent draft ready"
          : capability.enabled === true ? "Connected" : "Connected · Chat only");
      }
      if (discardedCrossAccountDraft) {
        showToast("The previous account’s unsent draft and image were cleared before switching accounts.");
      } else if (recoveryImageNeedsUserAction) {
        showToast(chatCapabilityVerified
          ? "Image sending is unavailable. Your staged image remains visible; remove it to continue without the image."
          : "Image capability could not be confirmed. Your staged image remains visible and unsent; remove it only to continue without the image.");
      } else if (state.unavailableAgentUpdateRecovery) {
        elements.resume_run.hidden = false;
        showToast(state.retainedUpdateRecoveryDurable
          ? "Your Agent prompt remains protected. Resume retries Agent verification here; reload is also safe."
          : "Your Agent prompt is preserved on this page. Resume retries Agent verification without losing it.");
      } else if (state.legacyUpdateRecoveryPending) {
        showToast("Your prompt came from the previous app version. Choose its exact conversation, or New conversation, before sending it.");
      }
      try {
        const exactAgentRecoveryThreadId = !state.unavailableAgentUpdateRecovery
          ? sameAccountRecoveryAgent?.threadId
            ?? (updateHandoff?.mode === "agent" ? updateHandoff.threadId : null)
          : null;
        if (exactAgentRecoveryThreadId !== null) {
          try {
            await restoreModeView({ autoOpen: false, prefetchedChatThreads: startupChatThreads });
          } catch (error) {
            if (clientReleaseMismatch(error) !== null) throw error;
            // A sidebar-list outage must not prevent an exact authenticated
            // thread read. The direct ledger replay below remains authoritative.
            state.agentThreads = [];
            renderThreads();
          }
          state.agentThreadId = exactAgentRecoveryThreadId;
          if (!state.agentThreads.some((thread) => thread.id === exactAgentRecoveryThreadId)) {
            state.agentThreads.unshift(Object.freeze({
              id: exactAgentRecoveryThreadId,
              title: "Recovered Agent conversation",
            }));
            renderThreads();
          }
          if (await openAgentThread(exactAgentRecoveryThreadId)) {
            if (!state.agentSearchRecoveryChoicePending) finishRetainedUpdateRecovery();
            state.agentAuthenticationRecoveryVerified = true;
            if (!state.agentSearchRecoveryChoicePending) finishAgentAuthenticationRecovery();
            updateImageControl();
          }
        } else if (!state.unavailableAgentUpdateRecovery) {
          await restoreModeView({
            autoOpen: updateHandoff === null
              && sameAccountRecoveryWorkflow === null && sameAccountRecoveryGeneration === null
              && sameAccountRecoveryAgent === null && !sameAccountRecoveryLegacy
              && (claimedUpdateHandoff === null || state.updateHandoffConsumed),
            prefetchedChatThreads: startupChatThreads,
          });
          if (sameAccountRecoveryAgent !== null && sameAccountRecoveryAgent.threadId === null) {
            if (!state.agentSearchRecoveryChoicePending) finishRetainedUpdateRecovery();
            state.agentAuthenticationRecoveryVerified = true;
            if (!state.agentSearchRecoveryChoicePending) finishAgentAuthenticationRecovery();
            updateImageControl();
          }
          if (restoredUpdateHandoff && updateHandoff.mode === "chat" && updateHandoff.threadId !== null) {
            const target = state.chatThreads.find((thread) => thread.threadId === updateHandoff.threadId) ?? null;
            await openChatThread(updateHandoff.threadId, {
              backgroundStream: true,
              threadHint: target,
              refreshThreadList: false,
            });
            if (state.session === authenticatedSession && state.session.authenticated
                && state.mode === "chat" && state.chatThreadId === updateHandoff.threadId) {
              finishRetainedUpdateRecovery();
            }
          }
        }
      }
      catch (error) {
        const targetRelease = clientReleaseMismatch(error);
        // The caller owns login/resume single-flight state. Let it release
        // that lock before a versioned navigation is attempted.
        if (targetRelease !== null) throw error;
        if (state.mode === "chat" && isChatAuthenticationRejection(error)
            && requireFreshAuthentication({
              workflow: sameAccountRecoveryWorkflow,
              generationRecovery: sameAccountRecoveryGeneration,
            })) return;
        if (state.mode === "agent") {
          state.agentThreads = [];
          if (state.agentAuthenticationRecoveryPending) state.agentReplayFailed = true;
        }
        else {
          state.chatThreadListEpoch += 1;
          state.chatThreads = [];
        }
        renderThreads();
        connection(state.mode === "agent" ? "Agent unavailable" : "Chat unavailable", false);
      }
      if (sameAccountRecoveryWorkflow !== null && state.session === authenticatedSession) {
        state.chatPendingSend = sameAccountRecoveryWorkflow;
        if (sameAccountRecoveryWorkflow.thread !== null) {
          state.chatThread = sameAccountRecoveryWorkflow.thread;
          state.chatThreadId = sameAccountRecoveryWorkflow.thread.threadId;
          elements.conversation_title.textContent = sameAccountRecoveryWorkflow.thread.title || "New conversation";
        }
        elements.resume_run.hidden = false;
        connection("Signed in · exact send ready to confirm");
        updateImageControl();
        renderThreads();
      } else if (sameAccountRecoveryGeneration !== null
          && state.session === authenticatedSession && state.session.authenticated) {
        try {
          await reconnectRecoveredChat(sameAccountRecoveryGeneration);
          if (state.session === authenticatedSession && state.session.authenticated) {
            state.authRecoveryGeneration = null;
            updateImageControl();
            renderThreads();
          }
        } catch (error) {
          if (clientReleaseMismatch(error) !== null) throw error;
          if (recoverChatReadAuthentication(error, sameAccountRecoveryGeneration)) return;
          state.chatThreadId = sameAccountRecoveryGeneration.threadId;
          state.chatThread = sameAccountRecoveryGeneration.thread;
          state.chatGeneration = sameAccountRecoveryGeneration.generation;
          state.authRecoveryGeneration = sameAccountRecoveryGeneration;
          if (sameAccountRecoveryGeneration.thread !== null) {
            elements.conversation_title.textContent = sameAccountRecoveryGeneration.thread.title || "New conversation";
          }
          elements.resume_run.hidden = false;
          connection("Generation connection paused", false);
          showToast("The server-owned generation could not reconnect yet. Resume retries only authenticated reads.");
        }
      }
    } finally {
      if (state.session === authenticatedSession && state.session.authenticated
          && !state.loginPending && !state.logoutPending && !elements.app_view.hidden) {
        elements.logout.disabled = false;
      }
    }
  }

  async function login(event) {
    event?.preventDefault?.();
    if (!state.loginReady || state.loginPending) return;
    const username = elements.username.value;
    const password = elements.password.value;
    const remember = elements.remember_session.checked === true;
    state.loginPending = true;
    elements.logout.disabled = true;
    loginControl({ ready: false, label: "Signing in…" });
    elements.login_error.hidden = true;
    let releaseRefreshTarget = null;
    try {
      const session = await sessionClient.login({ username, password, remember });
      const validatedSession = sessionEnvelope(session);
      if (validatedSession.authenticated && remember) {
        try {
          const saving = credentialSaver(elements.login_form, navigator);
          void Promise.resolve(saving).catch(() => {});
        } catch { /* Password manager is optional. */ }
      }
      elements.password.value = "";
      await authenticated(validatedSession);
    } catch (error) {
      releaseRefreshTarget = clientReleaseMismatch(error);
      if (releaseRefreshTarget === null) showLogin(loginFailureMessage(error));
    } finally {
      elements.password.value = "";
      state.loginPending = false;
      if (!elements.login_view.hidden) loginControl({ ready: true, label: "Sign in" });
      else if (state.session.authenticated && !state.logoutPending) elements.logout.disabled = false;
      if (releaseRefreshTarget !== null) await refreshForReleaseMismatch(releaseRefreshTarget);
    }
  }

  async function logout() {
    if (state.loginPending || state.logoutPending || elements.logout.disabled) return;
    state.logoutPending = true;
    if (state.imagePreparing) cancelImagePreparation();
    elements.logout.disabled = true;
    elements.resume_run.disabled = true;
    updateImageControl();
    let result;
    try { result = logoutEnvelope(await sessionClient.logout()); }
    catch (error) {
      state.logoutPending = false;
      elements.resume_run.disabled = false;
      updateImageControl();
      if (state.session.authenticated && !elements.app_view.hidden) elements.logout.disabled = false;
      const targetRelease = clientReleaseMismatch(error);
      if (targetRelease !== null) await refreshForReleaseMismatch(targetRelease);
      else showToast("Sign-out could not be confirmed. Please retry.");
      return;
    }
    state.viewEpoch += 1;
    state.streamAbort?.abort();
    finishRetainedUpdateRecovery({ discard: true });
    state.imageSelectionEpoch += 1;
    state.imagePreparing = false;
    elements.message_input.value = "";
    state.session = Object.freeze({ authenticated: false });
    state.authRecoveryPending = false;
    state.authRecoveryUsername = null;
    state.authRecoveryWorkflow = null;
    state.authRecoveryGeneration = null;
    state.authRecoveryAgent = null;
    state.authRecoveryLegacyUpdatePending = false;
    state.authRecoveryLegacyMode = null;
    state.authRecoveryLegacyDestinationChosen = false;
    state.authRecoveryLegacyDestinationThreadId = null;
    clearChatFailureDiagnostic();
    state.agent = null;
    state.chat = null;
    state.capabilities = FAIL_CLOSED_AGENT_CAPABILITIES;
    state.agentThreads = [];
    state.chatThreadListEpoch += 1;
    state.chatThreads = [];
    state.agentThreadId = null;
    state.chatThreadId = null;
    state.chatThread = null;
    state.chatGeneration = null;
    state.chatPendingSend = null;
    state.chatPendingDeletion = null;
    state.chatFinalization = null;
    state.chatCapabilities = Object.freeze({ visionInput: false, visionMediaTypes: Object.freeze([]), maximumImageBytes: 0 });
    clearSelectedImage();
    updateImageControl();
    state.runId = null;
    state.agentRunStatus = null;
    state.agentPendingResume = null;
    state.agentPendingThreadCreate = null;
    state.agentSearchSelected = false;
    state.agentSearchRecoveryChoicePending = false;
    state.legacyUpdateRecoveryPending = false;
    state.legacyUpdateRecoveryDestinationChosen = false;
    state.legacyUpdateRecoveryDestinationThreadId = null;
    state.unavailableAgentUpdateRecovery = false;
    state.retainedUpdateRecoveryPending = false;
    state.retainedUpdateRecoveryDurable = false;
    state.retainedUpdateRecoveryThreadId = null;
    state.retainedUpdateRecoveryRecord = null;
    invalidateRetainedUpdateRecoveryInstallation();
    state.agentAuthenticationRecoveryPending = false;
    state.agentAuthenticationRecoveryThreadId = null;
    state.agentAuthenticationRecoveryVerified = false;
    state.agentReplayFailed = false;
    clearConversation();
    purgeAttachmentBlobCache();
    showLogin();
    loginControl({ ready: true, label: "Sign in" });
    state.logoutPending = false;
    elements.resume_run.disabled = false;
    if (result.agentCancellationPending) showToast("Signed out. AgInTi cancellation is still being confirmed server-side.");
  }

  async function stop() {
    if (claimedUpdateHandoff !== null && !state.updateHandoffConsumed) {
      showToast("The protected update draft must be recovered before run controls can be used.");
      return;
    }
    if (state.mode === "agent" && (state.agentHistoryRestoring || state.agentReplayFailed || state.agentCancelPending)) {
      showToast(state.agentHistoryRestoring
        ? "Wait for the read-only Agent history restoration to finish."
        : state.agentCancelPending
          ? "AgInTi cancellation is already awaiting its verified terminal event."
          : "Reopen this conversation to retry its read-only Agent history restoration.");
      return;
    }
    if (state.mode === "agent" && state.runId
        && !TERMINAL.has(state.agentRunStatus)
        && state.capabilities.actions.cancel) {
      const runId = state.runId;
      const threadId = state.agentThreadId;
      const agent = state.agent;
      const presentation = state.presentation;
      const epoch = state.viewEpoch;
      const current = () => state.mode === "agent"
        && state.agent === agent
        && state.viewEpoch === epoch
        && state.runId === runId
        && state.agentThreadId === threadId
        && state.presentation === presentation;
      // Fence a second Stop and every Agent mutation/navigation before the
      // cancellation RPC is dispatched, not after its response arrives.
      state.agentCancelPending = true;
      elements.stop_run.hidden = true;
      elements.resume_run.hidden = true;
      elements.run_state.textContent = "Cancelling";
      connection("Confirming Agent cancellation", false);
      updateImageControl();
      let cancellationRun;
      try {
        const { run } = await agent.cancelRun(runId);
        cancellationRun = correlatedAgentRun(run, { runId, threadId });
      } catch {
        if (current() && !TERMINAL.has(state.agentRunStatus)) {
          state.agentCancelPending = false;
          elements.stop_run.hidden = !state.capabilities.actions.cancel;
          updateImageControl();
          showToast("AgInTi cancellation could not be confirmed.");
          flushDeferredSessionRevalidation();
        }
        return;
      }
      if (!current()) return;
      // A cancellation acknowledgement is not a terminal ledger event. Keep
      // consuming from cursor zero until run.cancelled is verified. Restarting
      // the read-only ledger stream closes the race where the former iterator
      // ended while the cancellation RPC was in flight.
      if (!TERMINAL.has(state.agentRunStatus)) {
        connection("Waiting for verified Agent cancellation", false);
        state.streamAbort?.abort();
        void streamAgentRun(cancellationRun, {
          expectedRunId: runId,
          expectedThreadId: threadId,
          cancelPending: true,
          offerResume: false,
        }).catch(() => {});
      }
      return;
    }
    if (state.mode === "chat" && state.chatGeneration?.status === "in_progress") {
      const prepared = state.chat.prepareCancellation({
        threadId: state.chatGeneration.threadId,
        generationId: state.chatGeneration.generationId,
      });
      try {
        const result = await exactMutation(
          () => state.chat.cancelRun(prepared),
          () => state.chat.cancelRun(prepared),
        );
        state.chatGeneration = result.generation;
      } catch {
        showToast("LocalLLM cancellation could not be confirmed. The generation remains server-owned.");
        return;
      }
      state.streamAbort?.abort();
      try { await refreshChatThread(state.chatGeneration.threadId); } catch { /* Cancellation itself was confirmed. */ }
      elements.workspace.dataset.status = "cancelled";
      elements.run_state.textContent = "Cancelled";
      elements.resume_run.hidden = true;
      return;
    }
    state.streamAbort?.abort();
  }

  async function resume() {
    if (state.busy || state.logoutPending) return;
    if (claimedUpdateHandoff !== null && !state.updateHandoffConsumed) {
      showToast("The protected update draft must be recovered before run controls can be used.");
      return;
    }
    const protectedRecord = state.retainedUpdateRecoveryPending
      && !state.legacyUpdateRecoveryPending
      ? state.retainedUpdateRecoveryRecord
      : null;
    const canRetryProtectedRestore = protectedRecord !== null;
    const canRetryAgentVerification = state.mode === "agent" && state.unavailableAgentUpdateRecovery
      && state.authRecoveryAgent !== null;
    if (!canRetryProtectedRestore && !canRetryAgentVerification && state.mode === "agent"
        && (state.agentHistoryRestoring || state.agentReplayFailed || state.agentCancelPending)) {
      elements.resume_run.hidden = true;
      showToast(state.agentHistoryRestoring
        ? "Wait for the read-only Agent history restoration to finish; no run was resumed."
        : state.agentCancelPending
          ? "Wait for AgInTi's verified cancellation event; no run was resumed."
          : "Reopen this conversation to retry its read-only Agent history restoration; no run was resumed.");
      return;
    }
    if (!canRetryProtectedRestore && !canRetryAgentVerification
        && state.mode === "agent" && state.runId
        && (!state.agentReplayOfferResume || state.agentRunStatus === "completed")) {
      elements.resume_run.hidden = true;
      showToast("This verified Agent run is not resumable.");
      return;
    }
    state.busy = true;
    elements.resume_run.disabled = true;
    updateImageControl();
    let ownsAgentResume = null;
    let releaseRefreshTarget = null;
    try {
      if (canRetryProtectedRestore) {
        if (!installRetainedUpdateRecovery(protectedRecord, "Press Resume")) return;
        connection("Retrying protected draft restoration", false);
        if (protectedRecord.mode === "agent") {
          if (state.capabilities.enabled !== true) {
            state.authRecoveryPending = true;
            state.authRecoveryUsername = normalizedSessionUsername(state.session.username);
            state.authRecoveryAgent = Object.freeze({
              threadId: protectedRecord.threadId,
              draft: protectedRecord.draft,
              search: protectedRecord.search,
              searchInvalid: state.agentSearchRecoveryChoicePending,
            });
            state.authRecoveryLegacyUpdatePending = false;
            state.authRecoveryLegacyMode = null;
            state.authRecoveryLegacyDestinationChosen = false;
            state.authRecoveryLegacyDestinationThreadId = null;
            await authenticated(state.session);
          } else if (protectedRecord.threadId !== null) {
            state.agentThreadId = protectedRecord.threadId;
            if (await openAgentThread(protectedRecord.threadId)) {
              state.agentAuthenticationRecoveryVerified = true;
              if (!state.agentSearchRecoveryChoicePending) {
                finishRetainedUpdateRecovery();
                finishAgentAuthenticationRecovery();
              }
            }
          } else if (!state.agentSearchRecoveryChoicePending) {
            state.agentReplayFailed = false;
            finishRetainedUpdateRecovery();
            finishAgentAuthenticationRecovery();
          }
        } else if (protectedRecord.mode === "chat" && protectedRecord.threadId !== null) {
          const target = state.chatThreads.find((thread) => thread.threadId === protectedRecord.threadId) ?? null;
          await openChatThread(protectedRecord.threadId, {
            backgroundStream: true,
            threadHint: target,
            refreshThreadList: false,
          });
          if (state.chatThreadId === protectedRecord.threadId) finishRetainedUpdateRecovery();
        } else {
          finishRetainedUpdateRecovery();
        }
      } else if (canRetryAgentVerification) {
        connection("Retrying Agent verification", false);
        await authenticated(state.session);
      } else if (state.mode === "chat") {
        if (state.authRecoveryGeneration) {
          const recovery = state.authRecoveryGeneration;
          await reconnectRecoveredChat(recovery);
          if (state.session.authenticated && state.authRecoveryGeneration === recovery) {
            state.authRecoveryGeneration = null;
          }
        } else if (state.chatFinalization) {
          const finalization = state.chatFinalization;
          const controller = new AbortController();
          state.streamAbort?.abort();
          state.streamAbort = controller;
          state.streamKind = "chat-finalization";
          try { await finalizeChatGeneration(finalization, controller.signal); }
          finally {
            if (state.streamAbort === controller) {
              state.streamAbort = null;
              state.streamKind = null;
            }
          }
        } else if (state.chatPendingSend) await continueChatSend(state.chatPendingSend);
        else if (state.chatGeneration?.status === "in_progress") await streamChatGeneration(state.chatGeneration, {
          afterSequence: state.chatAfterSequence,
          output: state.chatOutput,
        });
      } else if (state.runId && state.capabilities.enabled && state.capabilities.actions.resume) {
        const requestedRunId = state.runId;
        const requestedThreadId = state.agentThreadId;
        const requestedSession = state.session;
        const requestedAgent = state.agent;
        const requestedEpoch = state.viewEpoch;
        let resumeTicket = state.agentPendingResume;
        if (resumeTicket === null) {
          let draft = null;
          let text;
          if (state.agentRunStatus === "failed" || state.agentRunStatus === "cancelled") {
            const candidate = elements.message_input.value;
            if (candidate !== "") {
              try {
                draft = candidate;
                text = boundedMessage(candidate);
              } catch {
                showToast("The corrected Agent prompt is invalid or too large. Edit it before resuming; no run was resumed.");
                return;
              }
            }
          }
          let search;
          if (text !== undefined) {
            try { search = selectedAgentSearch(); }
            catch {
              showToast("Choose a valid Search mode and source limit before resuming the Agent.");
              return;
            }
          }
          resumeTicket = Object.freeze({
            session: requestedSession,
            agent: requestedAgent,
            runId: requestedRunId,
            threadId: requestedThreadId,
            epoch: requestedEpoch,
            draft,
            text,
            search,
            idempotency: createBrowserOpaqueId("agent_resume"),
          });
          state.agentPendingResume = resumeTicket;
          updateImageControl();
        } else if (resumeTicket.session !== requestedSession
            || resumeTicket.agent !== requestedAgent
            || resumeTicket.runId !== requestedRunId
            || resumeTicket.threadId !== requestedThreadId
            || resumeTicket.epoch !== requestedEpoch) {
          state.agentPendingResume = null;
          showToast("The pending Agent resume no longer owns this view. Reopen the conversation before resuming.");
          return;
        }
        ownsAgentResume = () => state.session === requestedSession
          && state.session.authenticated
          && state.agent === requestedAgent
          && state.mode === "agent"
          && state.viewEpoch === requestedEpoch
          && state.agentThreadId === requestedThreadId
          && state.runId === requestedRunId;
        const response = await requestedAgent.resumeRun(
          requestedRunId,
          resumeTicket.text,
          {
            idempotency: resumeTicket.idempotency,
            ...(resumeTicket.search === undefined ? {} : { search: resumeTicket.search }),
          },
        );
        if (!ownsAgentResume() || state.agentPendingResume !== resumeTicket) return;
        const { run } = response;
        const resumedRun = correlatedResumedAgentRun(run, {
          previousRunId: requestedRunId,
          threadId: requestedThreadId,
        });
        if (state.agentPendingResume === resumeTicket) state.agentPendingResume = null;
        if (resumeTicket.text !== undefined) {
          if (elements.message_input.value === resumeTicket.draft) elements.message_input.value = "";
          messageNode("user", resumeTicket.text, { runId: resumedRun.id });
        }
        if (resumeTicket.search !== undefined) state.agentSearchSelected = false;
        await streamAgentRun(resumedRun, {
          expectedRunId: resumedRun.id,
          expectedThreadId: requestedThreadId,
        });
      }
    } catch (error) {
      if (ownsAgentResume !== null && !ownsAgentResume()) return;
      releaseRefreshTarget = clientReleaseMismatch(error);
      if (releaseRefreshTarget !== null) {
        // The release fence is an authoritative pre-mutation rejection. The
        // same draft/search remain in the composer and will be encrypted into
        // the successor handoff, so this obsolete resume ticket must not block
        // the version hop.
        state.agentPendingResume = null;
        connection("Migrating protected work to the newer app", false);
      } else if (state.agentPendingResume !== null && error?.retryable === false
          && Number.isSafeInteger(error?.status) && error.status >= 400 && error.status < 499
          && error?.code !== "AGINTI_ABORTED") {
        state.agentPendingResume = null;
      } else {
        const authenticatedReadRecovery = state.mode === "chat" ? state.authRecoveryGeneration : null;
        const ambiguousAuthenticationWorkflow = state.mode === "chat"
          && state.chatPendingSend?.ambiguousMutation !== null
          && state.chatPendingSend?.ambiguousMutation !== undefined
          && isChatAuthenticationAfterAmbiguousDispatch(error)
          ? state.chatPendingSend
          : null;
        if (authenticatedReadRecovery !== null
            && recoverChatReadAuthentication(error, authenticatedReadRecovery)) {
          /* The exact server-owned read descriptor remains available after same-account sign-in. */
        } else if (ambiguousAuthenticationWorkflow !== null) {
          const diagnostic = applyChatFailureDiagnostic(new LocalChatNotSentError(
            ambiguousAuthenticationWorkflow.ambiguousMutation,
            error,
          ));
          connection(`Send confirmation paused · ${diagnostic.label}`, false);
          showToast("Sign in again, then Resume the same exact send. No new request was created.");
          requireFreshAuthentication({ workflow: ambiguousAuthenticationWorkflow });
        } else if (state.mode === "chat" && state.chatPendingSend && isAuthoritativeChatRejection(error)) {
          releaseRejectedChatWorkflow(state.chatPendingSend, error);
        } else {
          showToast(state.mode === "chat"
            ? "The durable LocalLLM request could not reconnect yet."
            : "AgInTi could not resume this run.");
        }
      }
    } finally {
      state.busy = false;
      elements.resume_run.disabled = false;
      updateImageControl();
      renderThreads();
      flushDeferredSessionRevalidation();
    }
    if (releaseRefreshTarget !== null) await refreshForReleaseMismatch(releaseRefreshTarget);
  }

  function newConversation() {
    if (interactionLocked()) return;
    if (state.unavailableAgentUpdateRecovery) {
      showToast("Agent is unavailable. Use Resume to retry protected verification before assigning this prompt.");
      return;
    }
    const detachingRetainedAgentRecovery = state.mode === "agent"
      && state.retainedUpdateRecoveryPending && state.agentReplayFailed
      && !state.legacyUpdateRecoveryPending;
    const detachingAuthenticationAgentRecovery = state.mode === "agent"
      && state.agentAuthenticationRecoveryPending && state.agentReplayFailed;
    const detachingSearchChoiceRecovery = state.mode === "agent"
      && state.agentSearchRecoveryChoicePending && !state.legacyUpdateRecoveryPending
      && state.capabilities.enabled === true;
    const detachingProtectedComposer = state.retainedUpdateRecoveryPending
      && !state.legacyUpdateRecoveryPending && !state.unavailableAgentUpdateRecovery
      && state.retainedUpdateRecoveryRecord !== null;
    const protectedRecord = state.retainedUpdateRecoveryPending
      && !state.unavailableAgentUpdateRecovery
      ? state.retainedUpdateRecoveryRecord
      : null;
    const protectedImagesUnavailable = protectedRecord?.images?.length > 0
      && (state.mode !== "chat" || state.chatCapabilities.visionInput !== true);
    if (protectedImagesUnavailable) {
      elements.resume_run.hidden = false;
      showToast("This protected prompt includes images that are not restored yet. Use Resume or reload; New conversation will not discard them.");
      return;
    }
    if (state.mode === "agent" && state.agentPendingThreadCreate !== null) {
      showToast("Retry the ready prompt to confirm its exact Agent conversation before creating another one.");
      return;
    }
    if (state.mode === "agent" && state.agentReplayFailed
        && !detachingRetainedAgentRecovery && !detachingAuthenticationAgentRecovery
        && !state.legacyUpdateRecoveryPending) {
      showToast("Reopen an Agent conversation and restore its verified history before creating new work.");
      return;
    }
    if (state.mode === "chat" && state.chatPendingSend) {
      showToast("This durable request has an uncertain response. Use Resume before starting another conversation.");
      return;
    }
    if (state.mode === "chat" && state.chatPendingDeletion) {
      showToast("Retry the pending conversation deletion before starting another conversation.");
      return;
    }
    if (protectedRecord !== null) {
      if (!installRetainedUpdateRecovery(protectedRecord, "Choose New conversation")) return;
      // Explicit detachment owns the exact installed record. Consume it before
      // changing thread or Search presentation so the final ownership check
      // cannot be invalidated by our own authorized UI transition.
      if (detachingProtectedComposer && !finishRetainedUpdateRecovery()) return;
    }
    state.viewEpoch += 1;
    state.streamAbort?.abort();
    if (state.mode === "agent") {
      state.agentThreadId = null;
      state.runId = null;
      state.agentRunStatus = null;
      state.agentPendingResume = null;
      if (detachingRetainedAgentRecovery) {
        state.agentReplayFailed = false;
        state.agentSearchSelected = false;
        state.agentSearchRecoveryChoicePending = false;
        finishAgentAuthenticationRecovery();
        showToast("Recovered prompt detached to a new Agent conversation with Search off.");
      }
      if (detachingProtectedComposer && !detachingRetainedAgentRecovery) {
        state.agentSearchSelected = false;
        state.agentSearchRecoveryChoicePending = false;
        finishAgentAuthenticationRecovery();
        showToast("Protected prompt assigned explicitly to a new Agent conversation with Search off.");
      }
      if (detachingAuthenticationAgentRecovery) {
        state.agentReplayFailed = false;
        state.agentSearchSelected = false;
        state.agentSearchRecoveryChoicePending = false;
        finishAgentAuthenticationRecovery();
        showToast("Recovered prompt detached to a new Agent conversation with Search off.");
      }
      if (detachingSearchChoiceRecovery && !detachingProtectedComposer
          && !detachingAuthenticationAgentRecovery) {
        state.agentSearchSelected = false;
        state.agentSearchRecoveryChoicePending = false;
        finishRetainedUpdateRecovery();
        finishAgentAuthenticationRecovery();
        showToast("Recovered prompt assigned to a new Agent conversation with Search off.");
      }
    } else {
      if (detachingProtectedComposer) {
        showToast("Protected prompt assigned explicitly to a new Direct Chat conversation.");
      }
      state.chatThreadId = null;
      state.chatThread = null;
      state.chatGeneration = null;
      state.chatPendingSend = null;
      state.chatFinalization = null;
      state.chatAfterSequence = 0;
      state.chatOutput = "";
    }
    resolveLegacyUpdateRecovery("a new conversation");
    if (protectedRecord === null) clearSelectedImage();
    clearChatFailureDiagnostic();
    updateImageControl();
    elements.conversation_title.textContent = "New conversation";
    clearConversation();
    renderThreads();
  }

  function updateHasUnsafeActivity() {
    return state.loginPending || state.logoutPending || state.busy || state.chatFinalization !== null
      || (claimedUpdateHandoff !== null && !state.updateHandoffConsumed)
      || state.chatHistoryRestoration !== null
      || state.imagePreparing || state.chatPendingSend !== null || state.chatPendingDeletion !== null
      || state.authRecoveryGeneration !== null
      || state.agentHistoryRestoring || state.agentReplayValidating || state.agentReplayFailed || state.agentCancelPending
      || state.agentPendingResume !== null || state.agentPendingThreadCreate !== null
      || state.legacyUpdateRecoveryPending || state.unavailableAgentUpdateRecovery
      || state.agentSearchRecoveryChoicePending
      || state.retainedUpdateRecoveryPending
      || state.agentAuthenticationRecoveryPending
      || (state.chatGeneration && !TERMINAL.has(state.chatGeneration.status))
      || (state.runId && !TERMINAL.has(state.agentRunStatus)) || state.streamAbort !== null;
  }

  function updateComposerWork() {
    return Object.freeze({
      draft: String(elements.message_input.value ?? ""),
      images: state.selectedImages,
    });
  }

  function updateHandoffThreadId() {
    return state.mode === "agent" ? state.agentThreadId : state.chatThreadId;
  }

  function invalidatePreparedUpdateHandoff() {
    state.updateHandoffEpoch += 1;
    const claim = state.updatePreparedHandoff?.claim ?? state.updateHandoffStagingClaim;
    state.updatePreparedHandoff = null;
    if (claim) void updateHandoffStore.discard(workerScope, claim.handoffId).catch(() => {});
  }

  function updateHandoffMatchesComposer(targetRelease = state.updateTargetRelease) {
    const prepared = state.updatePreparedHandoff;
    const work = updateComposerWork();
    let search;
    try { search = updateHandoffSearch(); }
    catch { return false; }
    return prepared !== null && prepared.targetRelease === targetRelease
      && prepared.session === state.session && prepared.mode === state.mode
      && prepared.threadId === updateHandoffThreadId()
      && prepared.draft === work.draft && prepared.images === work.images
      && sameUpdateHandoffSearch(prepared.search, search);
  }

  function updateHandoffEligible(targetRelease) {
    const work = updateComposerWork();
    try { updateHandoffSearch(); }
    catch { return false; }
    return !updateHasUnsafeActivity() && state.session.authenticated
      && (state.mode === "chat" || (state.mode === "agent" && work.images.length === 0))
      && !state.authRecoveryPending && validAgentRelease(currentRelease) && validAgentRelease(targetRelease)
      && work.images.length <= UPDATE_HANDOFF_IMAGE_COUNT_LIMIT
      && (work.draft.length > 0 || work.images.length > 0)
      && (work.images.length === 0 || state.chatCapabilities.visionInput === true)
      && (updateHandoffThreadId() === null || UPDATE_HANDOFF_IDENTIFIER.test(updateHandoffThreadId()));
  }

  async function prepareUpdateHandoff(targetRelease) {
    if (state.updatePreparedHandoff !== null && !updateHandoffMatchesComposer(targetRelease)) {
      invalidatePreparedUpdateHandoff();
    }
    if (state.updateHandoffInFlight || !updateHandoffEligible(targetRelease)) return false;
    state.updateHandoffInFlight = true;
    let claim = null;
    elements.apply_update.disabled = true;
    elements.defer_update.disabled = true;
    const epoch = state.updateHandoffEpoch;
    const session = state.session;
    const mode = state.mode;
    const threadId = updateHandoffThreadId();
    const { draft, images: selectedImages } = updateComposerWork();
    const search = updateHandoffSearch();
    try {
      claim = createUpdateHandoffClaim();
      state.updateHandoffStagingClaim = claim;
      const instant = Number(now());
      if (!Number.isSafeInteger(instant) || instant < 0) throw new TypeError("update handoff time is invalid");
      const images = updateHandoffImages(selectedImages.map((selectedImage) => ({
        attachmentId: selectedImage.attachmentId,
        mediaType: selectedImage.mediaType,
        byteLength: selectedImage.byteLength,
        width: selectedImage.width,
        height: selectedImage.height,
        bytes: selectedImage.bytes,
      })));
      const accountDigest = await updateHandoffDigest(updateHandoffEncoder.encode(
        `lazying-agent-update-account\u0000${normalizedSessionUsername(session.username)}`,
      ));
      const unsigned = Object.freeze({
        schemaVersion: UPDATE_HANDOFF_PAYLOAD_SCHEMA_VERSION,
        scope: workerScope,
        sourceRelease: currentRelease,
        targetRelease,
        createdAt: instant,
        accountDigest,
        mode,
        search,
        threadId,
        draft: updateHandoffDraft(draft),
        images,
      });
      const record = Object.freeze({
        ...unsigned,
        digest: await updateHandoffDigest(updateHandoffDigestInput(unsigned)),
      });
      await updateHandoffStore.save(await encryptUpdateHandoff(record, claim));
      if (epoch !== state.updateHandoffEpoch || state.session !== session || state.mode !== mode
          || updateHandoffThreadId() !== threadId || !updateHandoffEligible(targetRelease)
          || elements.message_input.value !== draft || state.selectedImages !== selectedImages
          || !sameUpdateHandoffSearch(search, updateHandoffSearch())) {
        await updateHandoffStore.discard(workerScope, claim.handoffId).catch(() => {});
        return false;
      }
      state.updatePreparedHandoff = Object.freeze({
        targetRelease,
        session,
        mode,
        search,
        threadId,
        draft,
        images: selectedImages,
        claim,
      });
      return true;
    } catch {
      if (claim) await updateHandoffStore.discard(workerScope, claim.handoffId).catch(() => {});
      state.updatePreparedHandoff = null;
      showToast("The update is ready, but this draft and its images could not be protected. This page stayed open; retry safely.");
      return false;
    } finally {
      state.updateHandoffInFlight = false;
      state.updateHandoffStagingClaim = null;
      if (!state.updateConfirmed && !state.updateReloaded) {
        elements.apply_update.disabled = false;
        elements.defer_update.disabled = false;
      }
      scheduleSafeUpdateReload();
    }
  }

  async function consumeUpdateHandoff({ agentCapabilities, retainUntilInitialized = false }) {
    if (state.updateHandoffConsumed || claimedUpdateHandoff === null
        || !state.session.authenticated || !validAgentRelease(currentRelease)) return null;
    let value;
    try { value = await updateHandoffStore.take(workerScope, claimedUpdateHandoff.handoffId); }
    catch {
      showToast("The saved update draft could not be read yet. Its local recovery key remains available; reload or sign in again to retry.");
      return null;
    }
    state.updateHandoffConsumed = true;
    if (value === null || value === undefined) {
      scrubCapturedUpdateHandoffClaim(window);
      showToast("The saved update draft was no longer available and was not restored.");
      return null;
    }
    try {
      const record = await decryptUpdateHandoff(value, claimedUpdateHandoff, {
        scope: workerScope,
        currentRelease,
        username: state.session.username,
        now,
      });
      const searchAvailable = record.search === null || (agentCapabilities?.search?.enabled === true
        && agentCapabilities.search.modes.includes(record.search.mode)
        && record.search.limit <= agentCapabilities.search.maximumSources);
      const unavailableAgentRecovery = record.mode === "agent"
        && (agentCapabilities?.enabled !== true || !searchAvailable);
      const requiresVerification = unavailableAgentRecovery || record.legacyModeAmbiguous
        || record.threadId !== null;
      const retainUntilVerified = retainUntilInitialized || requiresVerification;
      let retainedForReload = false;
      if (retainUntilVerified) {
        try {
          await updateHandoffStore.save(value);
          retainedForReload = retainCapturedUpdateHandoffClaim(window, claimedUpdateHandoff);
          if (!retainedForReload) {
            await updateHandoffStore.discard(workerScope, claimedUpdateHandoff.handoffId).catch(() => {});
          }
        } catch { retainedForReload = false; }
      }
      if (!retainedForReload) scrubCapturedUpdateHandoffClaim(window);
      return Object.freeze({
        record,
        unavailableAgentRecovery,
        requiresVerification,
        retainedForReload,
      });
    } catch {
      scrubCapturedUpdateHandoffClaim(window);
      showToast("A saved update draft failed its safety checks and was discarded.");
      return null;
    }
  }

  function restoreUpdateHandoff(record) {
    if (record === null || !state.session.authenticated || (record.mode !== null && state.mode !== record.mode)
        || state.chatPendingSend !== null
        || (elements.message_input.value && elements.message_input.value !== record.draft)
        || state.selectedImages.length > 0) return false;
    let detached = null;
    try {
      let restoredSearch = false;
      if (record.search !== null) {
        const capability = state.capabilities.search;
        const supported = state.mode === "agent" && capability?.enabled === true
          && capability.modes.includes(record.search.mode)
          && record.search.limit <= capability.maximumSources;
        if (!supported && !state.unavailableAgentUpdateRecovery
            && !state.agentSearchRecoveryChoicePending) return false;
        if (supported) {
          elements.search_mode.value = record.search.mode;
          elements.search_limit.value = String(record.search.limit);
          restoredSearch = true;
        }
      }
      if (record.images.length > 0) {
        if (state.chatCapabilities.visionInput !== true) return false;
        const selected = Object.freeze(record.images.map((image) => {
          const previewBlob = new Blob([image.bytes], { type: image.mediaType });
          return Object.freeze({ ...image, previewBlob });
        }));
        const previewUrls = [];
        try {
          for (const image of selected) previewUrls.push(createObjectUrl(image.previewBlob));
        } catch (error) {
          for (const url of previewUrls) revokeObjectUrl(url);
          throw error;
        }
        detached = Object.freeze({
          selected,
          previewUrls: Object.freeze(previewUrls),
        });
        if (!restoreDetachedImage(detached)) return false;
        detached = null;
      }
      if (state.mode === "agent") state.agentSearchSelected = restoredSearch;
      elements.message_input.value = record.draft;
      if (state.retainedUpdateRecoveryRecord === record) {
        state.retainedUpdateRecoveryInstalled = true;
        state.retainedUpdateRecoveryInstallation = Object.freeze({
          record,
          mode: state.mode,
          images: state.selectedImages,
          search: retainedUpdateRecoverySearchSignature(),
        });
      }
      updateImageControl();
      showToast(record.images.length === 0
        ? "Updated app loaded. Your unsent prompt was restored; review it before sending."
        : `Updated app loaded. Your unsent prompt and ${record.images.length === 1 ? "image was" : "images were"} restored; review before sending.`);
      return true;
    } catch {
      disposeDetachedImage(detached);
      return false;
    }
  }

  function updateReloadSafe(targetRelease = state.updateTargetRelease) {
    if (state.updateHandoffInFlight || updateHasUnsafeActivity()) return false;
    if (!state.session.authenticated && String(elements.password.value ?? "").length > 0) return false;
    const work = updateComposerWork();
    return (work.draft.length === 0 && work.images.length === 0)
      || (updateHandoffEligible(targetRelease) && updateHandoffMatchesComposer(targetRelease));
  }

  function clearUpdateReloadTimers() {
    for (const key of ["updateReleaseTimer", "updateSafetyTimer"]) {
      if (state[key] !== null) window?.clearTimeout?.(state[key]);
      state[key] = null;
    }
  }

  function reloadForActiveUpdate() {
    if (!state.updateControllerChanged || state.updateReloaded || !updateReloadSafe(state.updateTargetRelease)) return false;
    if (!validAgentRelease(state.updateTargetRelease)) return false;
    const releaseId = state.updateTargetRelease;
    return replaceWithRelease(releaseId);
  }

  function replaceWithRelease(releaseId, {
    handoffClaim = state.updatePreparedHandoff?.claim ?? null,
  } = {}) {
    if (state.updateReloaded || !validAgentRelease(releaseId)) return false;
    state.updateReloaded = true;
    clearUpdateReloadTimers();
    const target = new URL(workerScope, window.location.href);
    target.search = `?v=${encodeURIComponent(releaseId)}`;
    target.hash = handoffClaim === null ? "" : updateHandoffFragment(handoffClaim);
    purgeAttachmentMemory();
    if (typeof window?.location?.replace === "function") window.location.replace(target.href);
    else if (window?.location) window.location.href = target.href;
    return true;
  }

  function authenticationRecoveryUpdateDescriptor() {
    if (!state.session.authenticated || state.retainedUpdateRecoveryPending
        || state.chatPendingSend !== null || state.authRecoveryWorkflow !== null) return null;
    const session = state.session;
    if (state.authRecoveryUsername !== null
        && normalizedSessionUsername(session.username) !== state.authRecoveryUsername) return null;
    const selectedImages = state.selectedImages;
    const recoveryAgent = state.authRecoveryAgent;
    if (recoveryAgent !== null) {
      if (recoveryAgent.searchInvalid === true || selectedImages.length !== 0
          || String(elements.message_input.value ?? "") !== recoveryAgent.draft) return null;
      return Object.freeze({
        session,
        owner: recoveryAgent,
        mode: "agent",
        threadId: recoveryAgent.threadId,
        draft: recoveryAgent.draft,
        images: selectedImages,
        search: recoveryAgent.search,
        current: () => state.session === session && state.authRecoveryAgent === recoveryAgent
          && state.selectedImages === selectedImages
          && String(elements.message_input.value ?? "") === recoveryAgent.draft,
      });
    }
    const recoveryGeneration = state.authRecoveryGeneration;
    if (recoveryGeneration !== null) {
      const draft = String(elements.message_input.value ?? "");
      return Object.freeze({
        session,
        owner: recoveryGeneration,
        mode: "chat",
        threadId: recoveryGeneration.threadId,
        draft,
        images: selectedImages,
        search: null,
        current: () => state.session === session
          && state.authRecoveryGeneration === recoveryGeneration
          && state.selectedImages === selectedImages
          && String(elements.message_input.value ?? "") === draft,
      });
    }
    if (!state.authRecoveryPending || state.mode !== "chat") return null;
    const draft = String(elements.message_input.value ?? "");
    const threadId = state.chatThreadId;
    if (draft.length === 0 && selectedImages.length === 0 && threadId === null) return null;
    return Object.freeze({
      session,
      owner: null,
      mode: "chat",
      threadId,
      draft,
      images: selectedImages,
      search: null,
      current: () => state.session === session && state.authRecoveryPending
        && state.authRecoveryAgent === null && state.authRecoveryGeneration === null
        && state.selectedImages === selectedImages
        && String(elements.message_input.value ?? "") === draft,
    });
  }

  async function carryAuthenticationRecoveryToRelease(targetRelease, descriptor) {
    if (descriptor === null || state.updateHandoffInFlight || state.updateReloaded
        || !validAgentRelease(currentRelease) || !validAgentRelease(targetRelease)
        || targetRelease === currentRelease) return false;
    state.updateHandoffInFlight = true;
    elements.apply_update.disabled = true;
    elements.defer_update.disabled = true;
    let claim = null;
    try {
      const mode = descriptor.mode;
      const threadId = descriptor.threadId;
      if (!descriptor.current() || !["chat", "agent"].includes(mode)
          || (threadId !== null && (typeof threadId !== "string"
            || !UPDATE_HANDOFF_IDENTIFIER.test(threadId)))
          || (mode === "agent" && descriptor.images.length !== 0)) return false;
      const draft = updateHandoffDraft(descriptor.draft);
      const images = updateHandoffImages(descriptor.images.map((selectedImage) => ({
        attachmentId: selectedImage.attachmentId,
        mediaType: selectedImage.mediaType,
        byteLength: selectedImage.byteLength,
        width: selectedImage.width,
        height: selectedImage.height,
        bytes: selectedImage.bytes,
      })));
      const search = descriptor.search === null ? null : validateAgentSearch(descriptor.search);
      if ((search !== null && mode !== "agent")
          || (draft.length === 0 && images.length === 0 && threadId === null)) return false;
      const instant = Number(now());
      if (!Number.isSafeInteger(instant) || instant < 0) return false;
      claim = createUpdateHandoffClaim();
      state.updateHandoffStagingClaim = claim;
      const accountDigest = await updateHandoffDigest(updateHandoffEncoder.encode(
        `lazying-agent-update-account\u0000${normalizedSessionUsername(descriptor.session.username)}`,
      ));
      const unsigned = Object.freeze({
        schemaVersion: UPDATE_HANDOFF_PAYLOAD_SCHEMA_VERSION,
        scope: workerScope,
        sourceRelease: currentRelease,
        targetRelease,
        createdAt: instant,
        accountDigest,
        mode,
        search,
        threadId,
        draft,
        images,
      });
      const record = Object.freeze({
        ...unsigned,
        digest: await updateHandoffDigest(updateHandoffDigestInput(unsigned)),
      });
      await updateHandoffStore.save(await encryptUpdateHandoff(record, claim));
      if (!descriptor.current()) {
        await updateHandoffStore.discard(workerScope, claim.handoffId).catch(() => {});
        return false;
      }
      if (replaceWithRelease(targetRelease, { handoffClaim: claim })) return true;
      await updateHandoffStore.discard(workerScope, claim.handoffId).catch(() => {});
      return false;
    } catch {
      if (claim !== null) await updateHandoffStore.discard(workerScope, claim.handoffId).catch(() => {});
      showToast("The newer app is ready, but authenticated recovery could not be carried safely yet. This page kept the exact work for retry.");
      return false;
    } finally {
      state.updateHandoffInFlight = false;
      state.updateHandoffStagingClaim = null;
      if (!state.updateReloaded && !state.updateConfirmed) {
        elements.apply_update.disabled = false;
        elements.defer_update.disabled = false;
      }
    }
  }

  async function migrateRetainedUpdateHandoff(targetRelease) {
    const record = state.retainedUpdateRecoveryRecord;
    if (record === null || claimedUpdateHandoff === null || !state.session.authenticated
        || !validAgentRelease(targetRelease) || targetRelease === currentRelease) return false;
    const instant = Number(now());
    if (!Number.isSafeInteger(instant) || instant < 0) return false;
    const common = {
      schemaVersion: record.schemaVersion,
      scope: workerScope,
      sourceRelease: currentRelease,
      targetRelease,
      createdAt: instant,
      accountDigest: record.accountDigest,
      threadId: record.threadId,
      draft: record.draft,
      ...(record.schemaVersion === UPDATE_HANDOFF_PAYLOAD_SCHEMA_VERSION
        ? { mode: record.mode, search: record.search }
        : {}),
    };
    const unsigned = Object.freeze(record.schemaVersion === UPDATE_HANDOFF_LEGACY_SCHEMA_VERSION
      ? { ...common, image: record.images[0] ?? null }
      : { ...common, images: record.images });
    const migrated = Object.freeze({
      ...unsigned,
      digest: await updateHandoffDigest(updateHandoffDigestInput(unsigned)),
    });
    const migrationClaim = Object.freeze({
      handoffId: claimedUpdateHandoff.handoffId,
      key: claimedUpdateHandoff.key,
    });
    await updateHandoffStore.save(await encryptUpdateHandoff(migrated, migrationClaim));
    state.retainedUpdateRecoveryDurable = true;
    return replaceWithRelease(targetRelease, { handoffClaim: migrationClaim });
  }

  function retainedUpdateMigrationHasCompetingComposer(record = state.retainedUpdateRecoveryRecord) {
    if (record !== null && retainedUpdateRecoveryInstallationCurrent(record)) return false;
    const visibleDraft = String(elements.message_input.value ?? "");
    const installationSearchChanged = record !== null
      && state.retainedUpdateRecoveryInstallation?.record === record
      && state.retainedUpdateRecoveryInstallation.search !== retainedUpdateRecoverySearchSignature();
    return installationSearchChanged || retainedUpdateRecoverySearchConflicts(record)
      || (record !== null && visibleDraft.length > 0 && visibleDraft !== record.draft)
      || (record === null && visibleDraft.length > 0)
      || state.selectedImages.length > 0;
  }

  function signedOutRetainedUpdateHasCompetingComposer(record) {
    const visibleDraft = String(elements.message_input.value ?? "");
    if (visibleDraft.length > 0 && visibleDraft !== record.draft) return true;
    if (state.selectedImages.length === 0) return false;
    const installation = state.retainedUpdateRecoveryInstallation;
    return installation?.record !== record || installation.images !== state.selectedImages;
  }

  function exposeReleaseRecoveryControls(mode = state.retainedUpdateRecoveryRecord?.mode) {
    if (!state.session.authenticated || !elements.app_view.hidden) return;
    if (mode === "agent" || mode === "chat") {
      setMode(mode, {
        restoreView: false,
        remember: false,
        allowUnavailableAgentRecovery: true,
        allowRetainedUpdateRecovery: true,
        allowAgentAuthenticationRecovery: true,
      });
    }
    showApp();
    elements.logout.disabled = true;
    elements.resume_run.hidden = false;
    connection("Update recovery needs confirmation", false);
    updateImageControl();
  }

  async function refreshForReleaseMismatch(targetRelease) {
    if (!validAgentRelease(targetRelease) || targetRelease === currentRelease || state.updateReloaded) return false;
    state.updateTargetRelease = targetRelease;
    elements.update_banner.hidden = false;
    if (claimedUpdateHandoff !== null && !state.updateHandoffConsumed) {
      if (retainedUpdateMigrationHasCompetingComposer(null)) {
        showToast("A newer app is required, but different browser-restored work is also present. It stayed on this page; clear it explicitly before retrying the protected refresh.");
        return false;
      }
      // Session restore itself may be release-fenced before account-bound
      // decryption is possible. Carry the untouched local row and fragment to
      // the exact successor; the successor still must authenticate the account
      // digest before displaying any plaintext.
      try {
        const chainedClaim = await createChainedUpdateHandoffClaim(
          claimedUpdateHandoff,
          currentRelease,
          targetRelease,
        );
        return replaceWithRelease(targetRelease, { handoffClaim: chainedClaim });
      } catch {
        showToast("A newer app is ready, but the unread protected prompt could not be carried safely yet.");
        return false;
      }
    }
    if (state.retainedUpdateRecoveryRecord !== null && claimedUpdateHandoff !== null) {
      if (!state.session.authenticated && state.retainedUpdateRecoveryDurable) {
        // Signing out intentionally resets the visible mode and Search controls.
        // The ciphertext still owns their exact values, so compare only real
        // browser composer divergence before carrying that row opaquely.
        if (signedOutRetainedUpdateHasCompetingComposer(state.retainedUpdateRecoveryRecord)) {
          showLogin("A different browser-restored draft is also present. Sign in to choose which protected work to keep.", {
            preservePassword: true,
          });
          return false;
        }
        try {
          const chainedClaim = await createChainedUpdateHandoffClaim(
            claimedUpdateHandoff,
            currentRelease,
            targetRelease,
          );
          return replaceWithRelease(targetRelease, { handoffClaim: chainedClaim });
        } catch {
          showToast("A newer app is ready, but the signed-out protected prompt could not be carried safely yet.");
          return false;
        }
      }
      if (retainedUpdateMigrationHasCompetingComposer()) {
        invalidateRetainedUpdateRecoveryInstallation();
        exposeReleaseRecoveryControls();
        elements.resume_run.hidden = false;
        showToast("A newer app is required, but a different browser-restored composer is also present. It and the protected prompt were both retained; press Resume twice to choose the protected prompt before refreshing.");
        updateImageControl();
        return false;
      }
      try {
        if (await migrateRetainedUpdateHandoff(targetRelease)) return true;
      } catch { /* The current in-memory and encrypted recovery remain authoritative. */ }
      showToast("A newer app is ready, but the protected recovered prompt could not be migrated yet. Retry without re-sending it.");
      return false;
    }
    const authenticationRecovery = authenticationRecoveryUpdateDescriptor();
    if (authenticationRecovery !== null) {
      if (await carryAuthenticationRecoveryToRelease(targetRelease, authenticationRecovery)) return true;
      exposeReleaseRecoveryControls(authenticationRecovery.mode);
      return false;
    }
    if (updateHasUnsafeActivity()) return false;
    const work = updateComposerWork();
    if (work.draft.length > 0 || work.images.length > 0) {
      if (!updateHandoffEligible(targetRelease) || !await prepareUpdateHandoff(targetRelease)) {
        showToast("The current app is stale, but your unsent work stayed on this page because protected refresh storage is unavailable.");
        return false;
      }
    }
    return replaceWithRelease(targetRelease);
  }

  function waitingUpdateCanActivateAutomatically() {
    const worker = state.updateRegistration?.waiting;
    if (!worker || worker !== state.updateOfferedWorker || state.updateConfirmed) return false;
    if (worker === state.updateDeferredWorker && Number(now()) < state.updateDeferredUntil) return false;
    const releaseId = state.updateKnownWorkerReleases.get(worker);
    if (!validAgentRelease(releaseId)) return false;
    if (validAgentRelease(state.updateActiveControllerRelease)
        && state.updateActiveControllerRelease === releaseId) return false;
    if (state.updateObservedWaitingWorkers.has(worker)) return true;
    return releaseId === currentRelease
      && validAgentRelease(state.updateActiveControllerRelease)
      && state.updateActiveControllerRelease !== currentRelease;
  }

  function scheduleSafeUpdateReload() {
    if (state.updateReloaded || state.updateSafetyTimer !== null) return;
    if (state.updateControllerChanged) {
      if (!validAgentRelease(state.updateTargetRelease)) return;
      if (reloadForActiveUpdate()) return;
    } else if (waitingUpdateCanActivateAutomatically()) {
      const releaseId = state.updateKnownWorkerReleases.get(state.updateRegistration?.waiting);
      if (updateReloadSafe(releaseId)) {
        void activateWaitingUpdate({ announceUnsafe: false });
        return;
      }
    } else return;
    state.updateSafetyTimer = window?.setTimeout?.(() => {
      state.updateSafetyTimer = null;
      scheduleSafeUpdateReload();
    }, 1_000) ?? null;
  }

  async function activateWaitingUpdate({ announceUnsafe = true } = {}) {
    if (state.updateControllerChanged) {
      if (!validAgentRelease(state.updateTargetRelease)) {
        elements.update_banner.hidden = false;
        elements.apply_update.disabled = true;
        void state.retryUpdateControllerRelease?.({ announceFailure: announceUnsafe });
        return false;
      }
      if (!updateReloadSafe(state.updateTargetRelease)) {
        if (announceUnsafe && updateHandoffEligible(state.updateTargetRelease)) {
          if (await prepareUpdateHandoff(state.updateTargetRelease)) {
            return await activateWaitingUpdate({ announceUnsafe });
          }
          return false;
        }
        elements.update_banner.hidden = false;
        if (announceUnsafe && !state.updateHandoffInFlight) {
          showToast("Finish the current draft or response before reloading the updated app.");
        }
        scheduleSafeUpdateReload();
        return false;
      }
      return reloadForActiveUpdate();
    }
    const worker = state.updateRegistration?.waiting;
    if (!worker || worker !== state.updateOfferedWorker || state.updateConfirmed) return false;
    const targetRelease = state.updateKnownWorkerReleases.get(worker);
    if (!updateReloadSafe(targetRelease)) {
      if (announceUnsafe && updateHandoffEligible(targetRelease)) {
        if (await prepareUpdateHandoff(targetRelease)) return await activateWaitingUpdate({ announceUnsafe });
        return false;
      }
      elements.update_banner.hidden = false;
      if (announceUnsafe && !state.updateHandoffInFlight) {
        showToast("Finish the current draft or response before activating the update.");
      }
      scheduleSafeUpdateReload();
      return false;
    }
    state.updateConfirmed = true;
    state.updateConfirmedWorker = worker;
    state.updateDeferredUntil = Number.NEGATIVE_INFINITY;
    state.updateDeferredWorker = null;
    elements.apply_update.disabled = true;
    elements.defer_update.disabled = true;
    try {
      worker.postMessage({ type: "SKIP_WAITING" });
    } catch {
      state.updateConfirmed = false;
      state.updateConfirmedWorker = null;
      invalidatePreparedUpdateHandoff();
      elements.apply_update.disabled = false;
      elements.defer_update.disabled = false;
      elements.update_banner.hidden = false;
      showToast("The update could not be activated. You can retry safely.");
      return false;
    }
    if (state.updateActivationTimer !== null) window?.clearTimeout?.(state.updateActivationTimer);
    state.updateActivationTimer = window?.setTimeout?.(() => {
      if (state.updateControllerChanged || state.updateReloaded) return;
      state.updateConfirmed = false;
      state.updateConfirmedWorker = null;
      state.updateActivationTimer = null;
      invalidatePreparedUpdateHandoff();
      elements.apply_update.disabled = false;
      elements.defer_update.disabled = false;
      elements.update_banner.hidden = state.updateRegistration?.waiting !== state.updateOfferedWorker;
      showToast("The update is still waiting. You can retry or choose Later.");
    }, activationTimeoutMs) ?? null;
    return true;
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;
    elements.login_form.addEventListener("submit", (event) => { void login(event); });
    elements.composer.addEventListener("submit", (event) => { void submitMessage(event); });
    elements.add_image.addEventListener("click", () => elements.image_input.click?.());
    elements.image_input.addEventListener("change", () => { void selectImage(); });
    elements.remove_image.addEventListener("click", () => {
      if (interactionLocked() || state.chatPendingSend) return;
      clearSelectedImage();
      if (state.authRecoveryPending && state.session.authenticated) {
        state.authRecoveryPending = false;
        state.authRecoveryUsername = null;
        state.authRecoveryWorkflow = null;
        connection("Connected");
      }
      updateImageControl();
    });
    elements.logout.addEventListener("click", () => { void logout(); });
    elements.new_thread.addEventListener("click", newConversation);
    elements.stop_run.addEventListener("click", () => { void stop(); });
    elements.resume_run.addEventListener("click", () => { void resume(); });
    elements.search_toggle.addEventListener("click", () => {
      if (elements.search_toggle.disabled || elements.search_controls.hidden) return;
      state.agentSearchSelected = !state.agentSearchSelected;
      updateSearchControl();
      if (state.agentSearchSelected && agentSearchRecoveryChoiceReady()) {
        confirmAgentSearchRecoveryChoice();
      }
    });
    elements.agent_mode.addEventListener("click", () => setMode("agent"));
    elements.chat_mode.addEventListener("click", () => setMode("chat"));
    elements.theme_picker.addEventListener("change", () => applyTheme(elements.theme_picker.value, { document }));
    elements.open_sidebar.addEventListener("click", () => { elements.sidebar.dataset.open = "true"; elements.sidebar_scrim.hidden = false; });
    elements.sidebar_scrim.addEventListener("click", () => { elements.sidebar.dataset.open = "false"; elements.sidebar_scrim.hidden = true; });
    elements.apply_update.addEventListener("click", () => { void activateWaitingUpdate(); });
    elements.defer_update.addEventListener("click", () => {
      const worker = state.updateRegistration?.waiting;
      if (!worker || worker !== state.updateOfferedWorker || state.updateConfirmed) return;
      state.updateDeferredWorker = worker;
      state.updateDeferredUntil = Number(now()) + updateDeferralMs;
      elements.update_banner.hidden = true;
      if (state.updateSafetyTimer !== null) window?.clearTimeout?.(state.updateSafetyTimer);
      state.updateSafetyTimer = null;
      if (state.updateDeferralTimer !== null) window?.clearTimeout?.(state.updateDeferralTimer);
      state.updateDeferralTimer = window?.setTimeout?.(() => {
        state.updateDeferralTimer = null;
        state.updateDeferredUntil = Number.NEGATIVE_INFINITY;
        state.showUpdatePrompt?.();
      }, updateDeferralMs) ?? null;
    });
    elements.install_app.addEventListener("click", async () => {
      if (!state.installPrompt) return;
      await state.installPrompt.prompt();
      state.installPrompt = null;
      elements.install_app.hidden = true;
    });
    window?.addEventListener?.("online", () => { elements.offline_banner.hidden = true; connection("Connected"); });
    window?.addEventListener?.("offline", () => { elements.offline_banner.hidden = false; connection("Offline", false); });
    window?.addEventListener?.("pagehide", (event) => {
      if (event?.persisted !== true) purgeAttachmentMemory();
    });
    window?.addEventListener?.("pageshow", () => { void revalidateSessionOnResume(); });
    document?.addEventListener?.("visibilitychange", () => {
      if (document?.visibilityState !== "hidden") void revalidateSessionOnResume();
    });
    window?.addEventListener?.("beforeinstallprompt", (event) => {
      event.preventDefault?.();
      state.installPrompt = event;
      elements.install_app.hidden = false;
    });
    for (const input of [elements.username, elements.password, elements.message_input]) {
      input.addEventListener("input", () => {
        if (input === elements.message_input) {
          invalidatePreparedUpdateHandoff();
          if (state.retainedUpdateRecoveryPending) {
            invalidateRetainedUpdateRecoveryInstallation();
            state.protectedComposerReplacementConfirmation = null;
          }
        }
        if (state.updateSafetyTimer !== null) window?.clearTimeout?.(state.updateSafetyTimer);
        state.updateSafetyTimer = null;
        scheduleSafeUpdateReload();
      });
    }
  }

  async function registerPwa() {
    if (!navigator?.serviceWorker?.register || window?.location?.protocol !== "https:" || currentRelease === null) return;
    try {
      let observedController = navigator.serviceWorker.controller ?? null;
      const controlledAtStartup = observedController !== null;
      let hadController = observedController !== null;
      state.updateController = observedController;
      const queryWorkerRelease = (worker) => {
        const known = state.updateKnownWorkerReleases.get(worker);
        if (known) return Promise.resolve(known);
        const pending = state.updateReleaseQueries.get(worker);
        if (pending) return pending.promise;

        let settle;
        const promise = new Promise((resolve) => { settle = resolve; });
        let timer = null;
        let replyPort = null;
        const query = {
          promise,
          finish(releaseId) {
            if (state.updateReleaseQueries.get(worker) !== query) return;
            state.updateReleaseQueries.delete(worker);
            if (timer !== null) window?.clearTimeout?.(timer);
            try { replyPort?.close?.(); } catch { /* A transferred channel is optional. */ }
            const accepted = validAgentRelease(releaseId) ? releaseId : null;
            if (accepted !== null) state.updateKnownWorkerReleases.set(worker, accepted);
            settle(accepted);
          },
        };
        state.updateReleaseQueries.set(worker, query);
        timer = window?.setTimeout?.(() => query.finish(null), 1_000) ?? null;
        try {
          const Channel = window?.MessageChannel ?? globalThis.MessageChannel;
          const channel = typeof Channel === "function" ? new Channel() : null;
          if (channel?.port1 && channel?.port2) {
            replyPort = channel.port1;
            const receive = (event) => query.finish(agentReleaseMessage(event?.data));
            if (typeof replyPort.addEventListener === "function") replyPort.addEventListener("message", receive, { once: true });
            else replyPort.onmessage = receive;
            replyPort.start?.();
            worker.postMessage({ type: "GET_LAZYING_AGENT_RELEASE" }, [channel.port2]);
          } else {
            worker.postMessage({ type: "GET_LAZYING_AGENT_RELEASE" });
          }
        } catch {
          query.finish(null);
        }
        return promise;
      };
      const queryActiveUpdateRelease = async ({ announceFailure = false } = {}) => {
        const controller = state.updateController;
        if (!state.updateControllerChanged || controller === null || state.updateReloaded) return false;
        const releaseId = await queryWorkerRelease(controller);
        if (state.updateController !== controller || !state.updateControllerChanged || state.updateReloaded) return false;
        if (!validAgentRelease(releaseId)) {
          state.updateTargetRelease = null;
          elements.update_banner.hidden = false;
          elements.apply_update.disabled = false;
          elements.defer_update.disabled = false;
          if (announceFailure) showToast("The updated app version could not be verified yet. Retry keeps this page open safely.");
          return false;
        }
        state.updateActiveControllerRelease = releaseId;
        state.updateTargetRelease = releaseId;
        elements.apply_update.disabled = false;
        elements.defer_update.disabled = false;
        if (state.updateSafetyTimer !== null) window?.clearTimeout?.(state.updateSafetyTimer);
        state.updateSafetyTimer = null;
        scheduleSafeUpdateReload();
        return true;
      };
      state.retryUpdateControllerRelease = queryActiveUpdateRelease;
      navigator.serviceWorker.addEventListener?.("message", (event) => {
        const releaseId = agentReleaseMessage(event?.data);
        if (releaseId === null) return;
        state.updateReleaseQueries.get(event.source)?.finish(releaseId);
        if (event.source !== state.updateController) return;
        state.updateActiveControllerRelease = releaseId;
        if (!state.updateControllerChanged) {
          state.showUpdatePrompt?.();
          return;
        }
        state.updateTargetRelease = releaseId;
        if (state.updateReleaseTimer !== null) window?.clearTimeout?.(state.updateReleaseTimer);
        state.updateReleaseTimer = null;
        if (state.updateSafetyTimer !== null) window?.clearTimeout?.(state.updateSafetyTimer);
        state.updateSafetyTimer = null;
        scheduleSafeUpdateReload();
      });
      navigator.serviceWorker.addEventListener?.("controllerchange", () => {
        const nextController = navigator.serviceWorker.controller ?? null;
        if (nextController === observedController) return;
        observedController = nextController;
        state.updateController = nextController;
        state.updateActiveControllerRelease = null;
        state.updateTargetRelease = null;
        clearUpdateReloadTimers();
        if (!hadController) {
          hadController = nextController !== null;
          return;
        }
        if (nextController === null || state.updateReloaded) return;
        state.updateControllerChanged = true;
        if (state.imagePreparing) {
          cancelImagePreparation();
          updateImageControl();
        }
        if (state.updateActivationTimer !== null) window?.clearTimeout?.(state.updateActivationTimer);
        state.updateActivationTimer = null;
        state.updateConfirmed = false;
        state.updateConfirmedWorker = null;
        state.updateOfferedWorker = null;
        elements.apply_update.disabled = false;
        elements.defer_update.disabled = false;
        elements.update_banner.hidden = false;
        void queryActiveUpdateRelease();
      });
      const registration = await navigator.serviceWorker.register(workerPath, { scope: workerScope, updateViaCache: "none" });
      const offerWaitingWorker = (waiting, releaseId) => {
        if (registration.waiting !== waiting) return;
        const activeControllerIsCurrentPage = releaseId === currentRelease
          && state.updateActiveControllerRelease === currentRelease;
        const noIncumbentWorker = observedController === null && registration.active == null;
        const currentPageReplacesActiveController = releaseId === currentRelease
          && validAgentRelease(state.updateActiveControllerRelease)
          && state.updateActiveControllerRelease !== currentRelease;
        if (releaseId === currentRelease
            && !currentPageReplacesActiveController
            && (activeControllerIsCurrentPage || noIncumbentWorker)) {
          if (state.updateOfferedWorker === waiting) state.updateOfferedWorker = null;
          if (state.updateDeferredWorker === waiting) {
            state.updateDeferredWorker = null;
            state.updateDeferredUntil = Number.NEGATIVE_INFINITY;
          }
          elements.update_banner.hidden = true;
          return;
        }
        if (state.updateConfirmed && waiting === state.updateConfirmedWorker) return;
        if (waiting !== state.updateConfirmedWorker) {
          state.updateConfirmed = false;
          state.updateConfirmedWorker = null;
          elements.apply_update.disabled = false;
          elements.defer_update.disabled = false;
        }
        const sameDeferredWorker = waiting === state.updateDeferredWorker;
        if (sameDeferredWorker && Number(now()) < state.updateDeferredUntil) return;
        state.updateDeferredWorker = null;
        state.updateDeferredUntil = Number.NEGATIVE_INFINITY;
        state.updateRegistration = registration;
        state.updateOfferedWorker = waiting;
        elements.update_banner.hidden = false;
        scheduleSafeUpdateReload();
      };
      const ready = () => {
        const waiting = registration.waiting;
        if (!waiting) {
          if (!state.updateControllerChanged) elements.update_banner.hidden = true;
          state.updateOfferedWorker = null;
          return;
        }
        state.updateRegistration = registration;
        const known = state.updateKnownWorkerReleases.get(waiting);
        if (known) {
          offerWaitingWorker(waiting, known);
          return;
        }
        if (state.updateOfferedWorker !== waiting) elements.update_banner.hidden = true;
        void queryWorkerRelease(waiting).then((releaseId) => offerWaitingWorker(waiting, releaseId));
      };
      state.showUpdatePrompt = ready;
      if (observedController !== null) {
        void queryWorkerRelease(observedController).then((releaseId) => {
          if (state.updateController !== observedController) return;
          state.updateActiveControllerRelease = releaseId;
          ready();
        });
      }
      ready();
      registration.addEventListener?.("updatefound", () => {
        const installing = registration.installing;
        installing?.addEventListener?.("statechange", () => {
          if (registration.waiting === installing) state.updateObservedWaitingWorkers.add(installing);
          ready();
        });
      });
      const checkForUpdate = async ({ force = false, onlineTransition = false } = {}) => {
        const instant = Number(now());
        if (!Number.isFinite(instant)) return false;
        const eligible = force || !(document?.visibilityState === "hidden" || navigator?.onLine === false
          || instant - state.updateCheckAt < updateCheckIntervalMs
          || (!onlineTransition && instant - state.updateFailureAt < 60_000));
        if (state.updateCheckInFlight) {
          if (eligible) {
            state.updateCheckPending = true;
            state.updateCheckPendingOnlineTransition ||= onlineTransition;
          }
          return false;
        }
        if (!eligible) return false;
        state.updateCheckInFlight = true;
        try {
          await registration.update?.();
          state.updateCheckAt = instant;
          state.updateFailureAt = Number.NEGATIVE_INFINITY;
          ready();
        } catch {
          state.updateFailureAt = instant;
          /* The installed shell remains available offline. */
        }
        finally {
          state.updateCheckInFlight = false;
          if (state.updateCheckPending) {
            const pendingOnlineTransition = state.updateCheckPendingOnlineTransition;
            state.updateCheckPending = false;
            state.updateCheckPendingOnlineTransition = false;
            void checkForUpdate({ onlineTransition: pendingOnlineTransition });
          }
        }
        return true;
      };
      const scheduleUpdateCheck = () => {
        if (state.updatePollTimer !== null) return;
        state.updatePollTimer = window?.setTimeout?.(async () => {
          state.updatePollTimer = null;
          await checkForUpdate();
          scheduleUpdateCheck();
        }, updateCheckIntervalMs) ?? null;
      };
      document?.addEventListener?.("visibilitychange", () => { void checkForUpdate(); });
      window?.addEventListener?.("online", () => { void checkForUpdate({ onlineTransition: true }); });
      if (controlledAtStartup) void checkForUpdate({ force: true });
      scheduleUpdateCheck();
    } catch { /* PWA installation is optional; chat remains usable. */ }
  }

  function schedulePwaRegistration() {
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      void registerPwa();
    };
    if (navigator?.serviceWorker?.controller !== null
        && navigator?.serviceWorker?.controller !== undefined) {
      start();
      return;
    }
    if (typeof window?.requestIdleCallback === "function") {
      try {
        window.requestIdleCallback(start, { timeout: 1_000 });
        return;
      } catch { /* The zero-delay fallback still runs after hydration. */ }
    }
    void Promise.resolve().then(start);
  }

  async function initialize() {
    if (state.initialized) return;
    state.initialized = true;
    bind();
    const theme = restoreTheme({ document });
    elements.theme_picker.value = theme;
    elements.offline_banner.hidden = navigator?.onLine !== false;
    try {
      await authenticated(await sessionClient.restore(), {
        preserveLoginInput: true,
        clearPasswordOnAuthenticated: true,
      });
    }
    catch (error) {
      const targetRelease = clientReleaseMismatch(error);
      if (targetRelease !== null) await refreshForReleaseMismatch(targetRelease);
      else {
        showLogin("The session could not be restored safely.", { preservePassword: true });
        connection("Signed out", false);
      }
    }
    finally {
      if (!state.session.authenticated || !elements.login_view.hidden) {
        loginControl({ ready: true, label: "Sign in" });
      }
    }
    schedulePwaRegistration();
  }

  return Object.freeze({
    initialize,
    submitMessage,
    login,
    logout,
    stop,
    resume,
    openThread,
    deleteChatThread,
    setMode,
  });
}
