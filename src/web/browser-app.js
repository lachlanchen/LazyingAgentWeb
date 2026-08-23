import { AgintiBrowserClient, selectDefaultMode } from "./aginti-client.js";
import { AgintiProtocolError, FAIL_CLOSED_AGENT_CAPABILITIES, validateAgentCapabilities } from "./aginti-protocol.js";
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
  restoreTheme,
} from "./pwa-assets.js";
import { canonicalizeVisionImage } from "./vision-image-client.js";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const UNSAFE_MESSAGE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const AUTHENTICATION_FAILURE_CODES = new Set(["authentication_required", "invalid_session"]);
const BODY_REJECTION_CODES = new Set([
  "invalid_attachment", "invalid_json", "request_aborted", "request_error", "request_too_large",
]);
const SAFE_CHAT_FAILURE_OPERATIONS = new Set([
  "local_thread", "local_run", "thread_dispatch", "snapshot", "run_dispatch", "before_run_dispatch",
]);

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

function boundedMessage(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 32_000
      || UNSAFE_MESSAGE_CONTROL.test(value)) {
    throw new TypeError("message is invalid");
  }
  const text = value.trim();
  if (!text) throw new TypeError("message must contain non-whitespace text");
  return text;
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
  canonicalizeImage = canonicalizeVisionImage,
  createObjectUrl = (blob) => globalThis.URL.createObjectURL(blob),
  revokeObjectUrl = (url) => globalThis.URL.revokeObjectURL(url),
  serviceWorkerPath,
  serviceWorkerScope,
  updateCheckIntervalMs = 15 * 60 * 1_000,
  updateDeferralMs = 60 * 60 * 1_000,
  activationTimeoutMs = 30_000,
  attachmentDecodeTimeoutMs = 15_000,
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
  const sessionClient = suppliedSessionClient ?? new CloudSessionClient({ baseUrl: browserBaseUrl });
  const createAgentClient = suppliedAgentClientFactory ?? ((session) => new AgintiBrowserClient({
    transportEndpoint: "/api/transport",
    baseUrl: browserBaseUrl,
    csrfToken: () => sessionClient.csrfToken?.() ?? session.csrfToken,
  }));
  const createChatClient = suppliedChatClientFactory ?? (() => new DirectChatBrowserClient({
    baseUrl: browserBaseUrl,
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
  if (typeof canonicalizeImage !== "function" || typeof createObjectUrl !== "function"
      || typeof revokeObjectUrl !== "function") {
    throw new TypeError("browser image handlers must be functions");
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
  const declaredRelease = metaContent(document, "lazying-agent-release");
  const currentRelease = validAgentRelease(declaredRelease) ? declaredRelease : null;
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
    chatFinalization: null,
    chatFailureDiagnostic: null,
    authRecoveryPending: false,
    authRecoveryUsername: null,
    authRecoveryWorkflow: null,
    authRecoveryGeneration: null,
    selectedImage: null,
    selectedImageUrl: null,
    imagePreparing: false,
    imageSelectionEpoch: 0,
    imageRenderEpoch: 0,
    messageImageUrls: new Set(),
    runId: null,
    agentRunStatus: null,
    presentation: null,
    assistantNode: null,
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
    updateCheckAt: Number.NEGATIVE_INFINITY,
    updateFailureAt: Number.NEGATIVE_INFINITY,
    updateCheckInFlight: false,
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

  function requireFreshAuthentication({ workflow = null, generationRecovery = null } = {}) {
    if (!state.session.authenticated) return false;
    const recoveryUsername = normalizedSessionUsername(state.session.username);
    state.viewEpoch += 1;
    state.streamAbort?.abort();
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
    state.chatFinalization = null;
    state.runId = null;
    state.agentRunStatus = null;
    state.mode = "chat";
    state.authRecoveryPending = true;
    state.authRecoveryUsername = recoveryUsername;
    state.authRecoveryWorkflow = workflow;
    state.authRecoveryGeneration = generationRecovery;
    elements.resume_run.hidden = workflow === null;
    elements.logout.disabled = true;
    showLogin(generationRecovery !== null
      ? "Your session expired. Sign in again to reconnect to the server-owned generation; your draft and image are preserved."
      : "Your session expired. Sign in again; your unsent draft and image are preserved.");
    loginControl({ ready: true, label: "Sign in" });
    return true;
  }

  function recoverChatReadAuthentication(error, recovery) {
    return isChatAuthenticationRejection(error)
      && requireFreshAuthentication({ workflow: null, generationRecovery: recovery });
  }

  function detachSelectedImage() {
    state.imageSelectionEpoch += 1;
    state.imagePreparing = false;
    const detached = state.selectedImage === null ? null : Object.freeze({
      selected: state.selectedImage,
      previewUrl: state.selectedImageUrl,
    });
    state.selectedImage = null;
    state.selectedImageUrl = null;
    elements.image_input.value = "";
    elements.image_preview_thumbnail.src = "";
    elements.image_preview_label.textContent = "";
    elements.image_preview.hidden = true;
    return detached;
  }

  function disposeDetachedImage(detached) {
    if (detached?.previewUrl !== null && detached?.previewUrl !== undefined) {
      revokeObjectUrl(detached.previewUrl);
    }
  }

  function clearSelectedImage() {
    disposeDetachedImage(detachSelectedImage());
  }

  function restoreDetachedImage(detached) {
    if (!detached || state.selectedImage !== null || !state.session.authenticated
        || state.mode !== "chat" || state.chatCapabilities.visionInput !== true) {
      disposeDetachedImage(detached);
      return false;
    }
    state.selectedImage = detached.selected;
    state.selectedImageUrl = detached.previewUrl;
    elements.image_preview_thumbnail.src = detached.previewUrl;
    elements.image_preview_label.textContent = `${detached.selected.width}×${detached.selected.height} · ${Math.ceil(detached.selected.byteLength / 1024)} KiB`;
    elements.image_preview.hidden = false;
    return true;
  }

  function interactionLocked() {
    return state.busy || state.logoutPending || state.chatFinalization !== null
      || state.authRecoveryGeneration !== null;
  }

  function updateImageControl() {
    const available = state.session.authenticated && state.mode === "chat"
      && state.chatCapabilities.visionInput === true;
    const pendingChatSend = state.mode === "chat" && state.chatPendingSend !== null;
    const locked = interactionLocked();
    const preservingAuthenticationDraft = state.authRecoveryPending && state.selectedImage !== null;
    const preservingAmbiguousImage = state.chatPendingSend?.ambiguousMutation !== null
      && state.chatPendingSend?.ambiguousMutation !== undefined
      && state.selectedImage !== null;
    const fencedImage = preservingAuthenticationDraft || preservingAmbiguousImage;
    if (!available && !fencedImage && (state.imagePreparing || state.selectedImage !== null)) clearSelectedImage();
    elements.add_image.hidden = !available;
    elements.add_image.disabled = !available || locked || state.imagePreparing || pendingChatSend;
    elements.remove_image.disabled = (!available && !preservingAuthenticationDraft) || locked || pendingChatSend
      || (state.selectedImage === null && !state.imagePreparing);
    elements.message_input.disabled = !state.session.authenticated || locked || state.imagePreparing || pendingChatSend
      || preservingAuthenticationDraft;
    elements.send_message.disabled = !state.session.authenticated || locked || state.imagePreparing || pendingChatSend
      || preservingAuthenticationDraft;
    elements.new_thread.disabled = !state.session.authenticated || locked || pendingChatSend || preservingAuthenticationDraft;
    elements.agent_mode.disabled = !state.session.authenticated || !state.capabilities.enabled || locked
      || preservingAuthenticationDraft;
    elements.chat_mode.disabled = !state.session.authenticated || locked || preservingAuthenticationDraft;
    elements.composer.setAttribute("aria-busy", locked || state.imagePreparing || pendingChatSend ? "true" : "false");
    elements.workspace.setAttribute("aria-busy", state.chatFinalization === null ? "false" : "true");
    for (const button of elements.thread_list.children ?? []) {
      button.disabled = locked || pendingChatSend;
    }
    scheduleSafeUpdateReload();
  }

  function currentThreads() {
    return state.mode === "agent" ? state.agentThreads : state.chatThreads;
  }

  function currentThreadId() {
    return state.mode === "agent" ? state.agentThreadId : state.chatThreadId;
  }

  function setMode(mode, { restoreView = true } = {}) {
    const agentAvailable = state.capabilities.enabled === true;
    const nextMode = mode === "agent" && agentAvailable ? "agent" : "chat";
    const changed = nextMode !== state.mode;
    if (changed && interactionLocked()) return;
    if (changed && state.mode === "chat" && state.chatPendingSend) {
      showToast("Confirm the pending durable send with Resume before changing modes.");
      return;
    }
    if (changed) {
      state.viewEpoch += 1;
      state.streamAbort?.abort();
    }
    state.mode = nextMode;
    elements.workspace.dataset.mode = state.mode;
    elements.mode_switch.hidden = !agentAvailable;
    elements.agent_mode.setAttribute("aria-pressed", state.mode === "agent" ? "true" : "false");
    elements.chat_mode.setAttribute("aria-pressed", state.mode === "chat" ? "true" : "false");
    elements.activity_panel.hidden = state.mode !== "agent";
    elements.welcome_eyebrow.textContent = state.mode === "agent" ? "AgInTi Agent" : "Direct LocalLLM chat";
    elements.welcome_copy.textContent = state.mode === "agent"
      ? "AgInTi owns planning, tools, context, compaction, runs, and artifacts."
      : "Durable server-owned conversations with LocalLLM, without Agent tools or browser-owned history.";
    elements.message_input.placeholder = state.mode === "agent" ? "Ask AgInTi Agent" : "Message LocalLLM";
    updateImageControl();
    renderThreads();
    if (changed && restoreView && state.session.authenticated) void restoreModeView({ autoOpen: true });
  }

  function clearConversation() {
    state.imageRenderEpoch += 1;
    for (const url of state.messageImageUrls) revokeObjectUrl(url);
    state.messageImageUrls.clear();
    elements.messages.replaceChildren();
    elements.agent_plan.replaceChildren();
    elements.agent_timeline.replaceChildren();
    elements.agent_artifacts.replaceChildren();
    elements.context_indicator.hidden = true;
    elements.welcome.hidden = false;
    elements.run_state.textContent = "Idle";
    elements.workspace.dataset.status = "idle";
    elements.stop_run.hidden = true;
    elements.resume_run.hidden = true;
    state.presentation = null;
    state.assistantNode = null;
  }

  function restoredImageIsCurrent({ chat, expectedEpoch, expectedImageEpoch }) {
    return state.chat === chat && state.viewEpoch === expectedEpoch
      && state.imageRenderEpoch === expectedImageEpoch;
  }

  function waitForImageDecode(image) {
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
      const timer = globalThis.setTimeout(() => {
        reject(new TypeError("restored image decode timed out"));
      }, attachmentDecodeTimeoutMs);
      readiness.then(
        (value) => { globalThis.clearTimeout(timer); resolve(value); },
        (error) => { globalThis.clearTimeout(timer); reject(error); },
      );
    });
  }

  async function restoreMessageAttachment({ article, image, status, threadId, attachment }) {
    const expectedEpoch = state.viewEpoch;
    const expectedImageEpoch = state.imageRenderEpoch;
    const chat = state.chat;
    const current = () => restoredImageIsCurrent({ chat, expectedEpoch, expectedImageEpoch });
    const unavailable = () => {
      image.src = "";
      image.hidden = true;
      image.alt = "Attached image preview unavailable";
      image.dataset.previewState = "unavailable";
      status.textContent = "Attached image preview unavailable";
      status.hidden = false;
      article.dataset.attachmentState = "unavailable";
    };
    let url = null;
    try {
      const { bytes, descriptor } = await chat.getAttachment({ threadId, attachment });
      if (!current()) return "stale";
      url = createObjectUrl(new Blob([bytes], { type: descriptor.mediaType }));
      state.messageImageUrls.add(url);
      image.src = url;
      await waitForImageDecode(image);
      if (!current()) {
        if (state.messageImageUrls.delete(url)) revokeObjectUrl(url);
        return "stale";
      }
      image.alt = "Attached image";
      image.hidden = false;
      image.dataset.previewState = "ready";
      status.hidden = true;
      article.dataset.attachmentState = "ready";
      return "ready";
    } catch (error) {
      if (url !== null && state.messageImageUrls.delete(url)) revokeObjectUrl(url);
      if (!current()) return "stale";
      if (recoverChatReadAuthentication(error, captureChatReadRecovery({ threadId }))) return "stale";
      unavailable();
      return "unavailable";
    }
  }

  function messageNode(role, content, {
    runId, attachment, threadId, localAttachment, attachmentReadyTasks,
  } = {}) {
    const article = document.createElement("article");
    article.className = "message";
    article.dataset.role = role;
    if (runId) article.dataset.runId = runId;
    if (role === "user" && (localAttachment !== undefined || (attachment !== undefined && threadId && state.chat))) {
      const image = document.createElement("img");
      image.className = "message-attachment";
      image.alt = "Attached image";
      article.appendChild(image);
      if (localAttachment !== undefined) {
        const url = createObjectUrl(new Blob([localAttachment.bytes], { type: localAttachment.mediaType }));
        state.messageImageUrls.add(url);
        image.src = url;
        image.dataset.previewState = "local";
        article.dataset.attachmentState = "local";
      } else {
        image.hidden = true;
        image.alt = "Loading attached image";
        image.dataset.previewState = "loading";
        article.dataset.attachmentState = "loading";
        const status = document.createElement("span");
        status.className = "message-attachment-status muted";
        status.textContent = "Loading attached image…";
        status.setAttribute("role", "status");
        article.appendChild(status);
        const ready = restoreMessageAttachment({ article, image, status, threadId, attachment });
        if (Array.isArray(attachmentReadyTasks)) attachmentReadyTasks.push(ready);
        else void ready;
      }
    }
    const body = document.createElement("div");
    body.className = "message-content";
    renderer.renderMarkdown(body, content);
    article.appendChild(body);
    elements.messages.appendChild(article);
    elements.welcome.hidden = true;
    return body;
  }

  function renderThreads() {
    elements.thread_list.replaceChildren();
    const mode = state.mode;
    const selected = currentThreadId();
    currentThreads().forEach((thread) => {
      const threadId = mode === "agent" ? thread.id : thread.threadId;
      const title = thread.title || "New conversation";
      const button = makeButton(document, title, () => { void openThread(threadId, { mode }); });
      button.disabled = interactionLocked() || (mode === "chat" && state.chatPendingSend !== null);
      button.dataset.threadId = threadId;
      button.dataset.mode = mode;
      button.setAttribute("aria-current", threadId === selected ? "true" : "false");
      elements.thread_list.appendChild(button);
    });
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

  async function loadChatThreads() {
    const session = state.session;
    const chat = state.chat;
    const listEpoch = ++state.chatThreadListEpoch;
    const response = await chat.listThreads({ limit: 100 });
    if (state.session !== session || state.chat !== chat || state.chatThreadListEpoch !== listEpoch) return;
    state.chatThreads = [...response.threads];
    if (state.mode === "chat") renderThreads();
  }

  function renderPresentation(snapshot) {
    state.agentRunStatus = safeRunStatus(snapshot.status);
    elements.workspace.dataset.status = snapshot.status;
    elements.run_state.textContent = statusLabel(snapshot.status);
    if (!state.assistantNode) state.assistantNode = messageNode("assistant", "", { runId: snapshot.runId });
    renderer.renderMarkdown(state.assistantNode, snapshot.output);
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
    snapshot.artifacts.forEach((artifact) => {
      const section = document.createElement("section");
      section.className = "artifact";
      const heading = document.createElement("h3");
      heading.textContent = artifact.title;
      section.appendChild(heading);
      const body = document.createElement("div");
      renderer.renderArtifact(body, artifact);
      section.appendChild(body);
      elements.agent_artifacts.appendChild(section);
    });
    const isTerminal = TERMINAL.has(snapshot.status);
    elements.stop_run.hidden = isTerminal || !state.capabilities.actions.cancel;
    elements.resume_run.hidden = snapshot.status !== "failed" && snapshot.status !== "cancelled";
  }

  async function streamAgentRun(run, { cursor } = {}) {
    state.runId = run.id;
    state.agentRunStatus = safeRunStatus(run.status);
    state.presentation = createRunPresentation({ runId: run.id, threadId: run.threadId, cursor });
    state.assistantNode = null;
    state.streamAbort?.abort();
    const controller = new AbortController();
    state.streamAbort = controller;
    state.streamKind = "agent";
    elements.workspace.dataset.status = safeRunStatus(run.status);
    elements.run_state.textContent = statusLabel(safeRunStatus(run.status));
    elements.stop_run.hidden = !state.capabilities.actions.cancel;
    elements.resume_run.hidden = true;
    let recoveries = 0;
    try {
      while (!controller.signal.aborted) {
        let failure = null;
        try {
          for await (const { event } of state.agent.streamRunEvents({
            runId: run.id,
            threadId: run.threadId,
            cursor: state.presentation.snapshot().cursor,
            maxReconnects: 0,
            signal: controller.signal,
            onCursor: cursorStore ? async (next) => cursorStore.save({ runId: run.id, threadId: run.threadId, cursor: next }) : undefined,
          })) {
            renderPresentation(state.presentation.apply(event));
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          failure = error;
        }
        const snapshot = state.presentation.snapshot();
        if (TERMINAL.has(snapshot.status)) {
          connection("Connected");
          return;
        }
        if (failure instanceof AgintiProtocolError || (failure && failure.retryable !== true)) throw failure;
        let authoritativeRun = null;
        try {
          const response = await state.agent.runStatus(run.id, { signal: controller.signal });
          authoritativeRun = response.run;
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof AgintiProtocolError || error?.retryable === false) throw error;
        }
        if (authoritativeRun && TERMINAL.has(authoritativeRun.status)) {
          state.agentRunStatus = authoritativeRun.status;
          elements.workspace.dataset.status = authoritativeRun.status;
          elements.run_state.textContent = statusLabel(authoritativeRun.status);
          if (!state.assistantNode) state.assistantNode = messageNode("assistant", "", { runId: authoritativeRun.id });
          renderer.renderMarkdown(state.assistantNode, authoritativeRun.output);
          elements.resume_run.hidden = authoritativeRun.status === "completed" || !state.capabilities.actions.resume;
          connection("Connected");
          return;
        }
        recoveries += 1;
        connection("Reconnecting to AgInTi", false);
        const backoffStep = Math.min(recoveries - 1, maxStreamBackoffSteps);
        await wait(Math.min(4_000, 250 * (2 ** backoffStep)), controller.signal);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      elements.resume_run.hidden = !state.capabilities.actions.resume;
      connection("Agent stream interrupted", false);
      showToast("The Agent run is still owned by AgInTi. Resume reconnects without restarting it.");
    } finally {
      if (state.streamAbort === controller) {
        state.streamAbort = null;
        state.streamKind = null;
      }
      elements.stop_run.hidden = true;
    }
  }

  async function openAgentThread(threadId, { expectedEpoch = state.viewEpoch } = {}) {
    if (!state.capabilities.enabled) return;
    try {
      const session = state.session;
      const agent = state.agent;
      const { thread } = await agent.getThread(threadId);
      if (state.session !== session || state.agent !== agent || state.mode !== "agent" || state.viewEpoch !== expectedEpoch) return;
      clearConversation();
      state.agentThreadId = thread.id;
      state.runId = null;
      state.agentRunStatus = null;
      elements.conversation_title.textContent = thread.title;
      thread.messages.forEach((message) => messageNode(message.role, message.content, { runId: message.runId }));
      renderThreads();
      if (thread.authority.lastCompaction) {
        elements.context_indicator.hidden = false;
        elements.context_indicator_text.textContent = `${thread.authority.lastCompaction.compactedMessages} earlier messages were compacted by AgInTi.`;
      }
      if (thread.lastRunId) {
        const { run } = await agent.runStatus(thread.lastRunId);
        if (state.session !== session || state.agent !== agent || state.mode !== "agent" || state.viewEpoch !== expectedEpoch) return;
        if (!TERMINAL.has(run.status)) await streamAgentRun(run);
      }
    } catch {
      showToast("This AgInTi thread could not be opened safely.");
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

  function releaseRejectedChatWorkflow(workflow, error) {
    const composer = workflow.lockedComposer ?? workflow.recoveryComposer;
    if (composer !== null && composer !== undefined) {
      if (!elements.message_input.value || elements.message_input.value === workflow.text
          || elements.message_input.value === composer.draft) {
        elements.message_input.value = composer.draft;
      }
      if (composer.image !== null && state.selectedImage === null) {
        try {
          restoreDetachedImage(Object.freeze({
            selected: composer.image,
            previewUrl: createObjectUrl(composer.image.previewBlob),
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
    showToast(composer?.image
      ? "The image message was rejected before it ran. Its prompt and image are ready to edit or retry."
      : "The message was rejected before it ran. Its prompt is ready to edit or retry.");
    if (diagnostic.reauthenticate) requireFreshAuthentication();
  }

  async function fetchChatSnapshot(threadId, signal, { expectedEpoch = state.viewEpoch } = {}) {
    const owner = Object.freeze({ session: state.session, chat: state.chat, expectedEpoch });
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
        const { thread: before } = await owner.chat.getThread(threadId, { signal });
        ensureOwner();
        const messages = [];
        let afterRevision = 0;
        let previousHash = null;
        let inconsistent = false;
        while (afterRevision < before.revision) {
          const remaining = before.revision - afterRevision;
          const response = await owner.chat.listMessages({
            threadId,
            afterRevision,
            limit: Math.min(200, remaining),
            signal,
          });
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
      threadId: snapshot.thread.threadId,
      attachmentReadyTasks,
    }));
    await Promise.all(attachmentReadyTasks);
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
  } = {}) {
    const session = state.session;
    const chat = state.chat;
    const snapshot = await fetchChatSnapshot(threadId, signal, { expectedEpoch });
    if (state.session !== session || state.chat !== chat) return snapshot;
    state.chatThread = snapshot.thread;
    state.chatThreadId = snapshot.thread.threadId;
    if (state.mode === "chat" && state.viewEpoch === expectedEpoch) {
      await renderChatSnapshot(snapshot, { expectedEpoch, finalization });
    }
    void loadChatThreads().catch(() => { /* The open authoritative thread remains usable. */ });
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
    if (generation.status === "completed" && presenting && state.chatThreadId === generation.threadId) {
      const finalization = beginChatFinalization({
        threadId: generation.threadId,
        generationId: generation.generationId,
        expectedEpoch,
      });
      await finalizeChatGeneration(finalization, controller.signal);
      return;
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

  async function openChatThread(threadId, { backgroundStream = false } = {}) {
    const expectedEpoch = state.viewEpoch;
    let generationId = null;
    try {
      const snapshot = await refreshChatThread(threadId, undefined, { expectedEpoch });
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
      if (recoverChatReadAuthentication(error, captureChatReadRecovery({ threadId, generationId }))) return;
      throw error;
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

  async function openThread(threadId, { mode = state.mode } = {}) {
    if (interactionLocked() || mode !== state.mode) return;
    if (mode === "chat" && state.chatPendingSend) {
      showToast("Confirm the pending durable send with Resume before opening another conversation.");
      return;
    }
    state.busy = true;
    updateImageControl();
    renderThreads();
    state.viewEpoch += 1;
    state.streamAbort?.abort();
    try {
      if (mode === "agent") await openAgentThread(threadId);
      else await openChatThread(threadId, { backgroundStream: true });
    } catch {
      showToast(mode === "agent"
        ? "This AgInTi thread could not be opened safely."
        : "This LocalLLM conversation could not be restored safely.");
    } finally {
      state.busy = false;
      updateImageControl();
      renderThreads();
    }
  }

  async function restoreModeView({ autoOpen = false } = {}) {
    const mode = state.mode;
    const epoch = ++state.viewEpoch;
    state.streamAbort?.abort();
    clearConversation();
    elements.conversation_title.textContent = "New conversation";
    if (mode === "agent") await loadAgentThreads();
    else await loadChatThreads();
    if (epoch !== state.viewEpoch || mode !== state.mode) return;
    const preferred = mode === "agent" ? state.agentThreadId : state.chatThreadId;
    const available = currentThreads();
    const selected = available.find((thread) => (mode === "agent" ? thread.id : thread.threadId) === preferred) ?? available[0];
    if (!autoOpen || !selected) return;
    const threadId = mode === "agent" ? selected.id : selected.threadId;
    if (mode === "agent") await openAgentThread(threadId);
    else await openChatThread(threadId, { backgroundStream: true });
  }

  async function sendAgent(text) {
    const session = state.session;
    const agent = state.agent;
    const current = () => state.session === session && state.agent === agent && state.session.authenticated;
    let threadId = state.agentThreadId;
    if (!threadId) {
      const { thread } = await agent.createThread({ title: conversationTitle(text) });
      if (!current()) return;
      state.agentThreadId = thread.id;
      threadId = thread.id;
      state.agentThreads.unshift(thread);
      elements.conversation_title.textContent = thread.title;
      renderThreads();
    }
    messageNode("user", text);
    const { run } = await agent.startRun(threadId, text);
    if (!current()) return;
    await streamAgentRun(run);
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
          ...(workflow.attachment === null ? {} : { attachment: workflow.attachment }),
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
      started = await exactMutation(
        () => chat.retryRun(workflow.runTicket),
        () => chat.retryRun(workflow.runTicket),
        {
          onAmbiguous() { workflow.ambiguousMutation = "run_dispatch"; },
          onConfirmed() {
            if (workflow.ambiguousMutation === "run_dispatch") workflow.ambiguousMutation = null;
          },
        },
      );
      ensureCurrentSession();
    } else {
      if (!workflow.runTicket) {
        const threadId = thread?.threadId === state.chatThreadId ? thread.threadId : state.chatThreadId;
        if (!threadId) throw new TypeError("the Direct Chat thread is unavailable");
        workflow.failureStage = "snapshot";
        thread = (await fetchChatSnapshot(threadId)).thread;
        ensureCurrentSession();
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
            ...(workflow.attachment === null ? {} : { attachment: workflow.attachment }),
          }),
        );
      }
      workflow.failureStage = "run_dispatch";
      workflow.runDispatched = true;
      started = await exactMutation(
        () => chat.startRun(workflow.runTicket),
        () => chat.retryRun(workflow.runTicket),
        {
          onAmbiguous() { workflow.ambiguousMutation = "run_dispatch"; },
          onConfirmed() {
            if (workflow.ambiguousMutation === "run_dispatch") workflow.ambiguousMutation = null;
          },
        },
      );
      ensureCurrentSession();
    }
    if (workflow.lockedComposer !== null) {
      if (elements.message_input.value === workflow.lockedComposer.draft) elements.message_input.value = "";
      if (workflow.lockedComposer.image !== null && state.selectedImage === workflow.lockedComposer.image) {
        clearSelectedImage();
      }
      workflow.lockedComposer = null;
    }
    workflow.recoveryComposer = null;
    state.chatPendingSend = null;
    clearChatFailureDiagnostic();
    renderThreads();
    state.chatGeneration = started.generation;
    state.chatAfterSequence = 0;
    state.chatOutput = "";
    if (state.mode === "chat" && state.chatThreadId === started.generation.threadId) {
      messageNode("user", workflow.text, {
        runId: started.generation.generationId,
        ...(workflow.attachment === null ? {} : { localAttachment: workflow.attachment }),
      });
    }
    if (started.generation.terminal) await finishChatGeneration(started.generation, new AbortController());
    else await streamChatGeneration(started.generation);
  }

  async function sendChat(text, attachment = null) {
    if (state.chatPendingSend) throw new TypeError("a durable chat request is already pending");
    if (state.chatGeneration?.status === "in_progress") throw new TypeError("the current generation must finish or be cancelled first");
    const workflow = {
      text,
      attachment,
      threadTicket: null,
      threadDispatched: false,
      thread: null,
      runTicket: null,
      runDispatched: false,
      lockedComposer: null,
      recoveryComposer: null,
      failureStage: "before_run_dispatch",
      ambiguousMutation: null,
    };
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
        || state.logoutPending) return;
    const files = elements.image_input.files;
    if (!files || files.length !== 1) {
      clearSelectedImage();
      updateImageControl();
      showToast("Choose exactly one JPEG or PNG image.");
      return;
    }
    const file = files[0];
    clearSelectedImage();
    const selectionEpoch = state.imageSelectionEpoch;
    state.imagePreparing = true;
    updateImageControl();
    try {
      const selected = await canonicalizeImage(file, {
        document,
        makeAttachmentId: createBrowserOpaqueId,
      });
      if (selectionEpoch !== state.imageSelectionEpoch || !state.imagePreparing
          || !state.session.authenticated || state.mode !== "chat"
          || state.chatCapabilities.visionInput !== true || state.logoutPending) return;
      const previewUrl = createObjectUrl(selected.previewBlob);
      state.selectedImage = selected;
      state.selectedImageUrl = previewUrl;
      elements.image_preview_thumbnail.src = previewUrl;
      elements.image_preview_label.textContent = `${selected.width}×${selected.height} · ${Math.ceil(selected.byteLength / 1024)} KiB`;
      elements.image_preview.hidden = false;
    } catch {
      if (selectionEpoch === state.imageSelectionEpoch && state.imagePreparing) {
        showToast("That image could not be prepared safely. Use one JPEG or PNG under the displayed limits.");
      }
    } finally {
      if (selectionEpoch === state.imageSelectionEpoch) state.imagePreparing = false;
      updateImageControl();
    }
  }

  async function submitMessage(event) {
    event?.preventDefault?.();
    if (interactionLocked() || !state.session.authenticated) return;
    if (state.mode === "chat" && state.chatPendingSend) {
      showToast("The previous durable send is awaiting confirmation. Use Resume; this draft and image were not changed.");
      return;
    }
    if (state.imagePreparing) {
      clearSelectedImage();
      updateImageControl();
      return;
    }
    const submissionSession = state.session;
    const submissionMode = state.mode;
    const submissionChat = state.chat;
    clearChatFailureDiagnostic();
    const draft = elements.message_input.value;
    let text;
    try { text = boundedMessage(draft); }
    catch { return; }
    let detachedImage = state.mode === "chat" ? detachSelectedImage() : null;
    const selected = detachedImage?.selected ?? null;
    const attachment = selected === null ? null : Object.freeze({
      attachmentId: selected.attachmentId,
      mediaType: selected.mediaType,
      byteLength: selected.byteLength,
      width: selected.width,
      height: selected.height,
      bytes: selected.bytes,
    });
    elements.message_input.value = "";
    state.busy = true;
    elements.send_message.disabled = true;
    updateImageControl();
    try {
      if (state.mode === "agent" && state.capabilities.enabled) await sendAgent(text);
      else await sendChat(text, attachment);
    } catch (error) {
      const sameOwner = state.session === submissionSession
        && state.session.authenticated
        && state.mode === submissionMode
        && (submissionMode !== "chat" || state.chat === submissionChat);
      if (!sameOwner) return;
      if (state.mode === "chat" && state.chatPendingSend) {
        state.chatPendingSend.recoveryComposer = Object.freeze({ draft, image: selected });
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
          image: imageRestored ? selected : null,
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
          ? "This image message was not sent. Your prompt and image are still ready; edit or retry them."
          : "This message was not sent. Your prompt is still in the composer; edit it and try again.");
        if (diagnostic.reauthenticate) requireFreshAuthentication();
      } else if (state.mode === "chat" && state.chatPendingSend && !state.chatPendingSend.runDispatched) {
        elements.message_input.value = draft;
        const imageRestored = restoreDetachedImage(detachedImage);
        detachedImage = null;
        state.chatPendingSend.lockedComposer = Object.freeze({
          draft,
          image: imageRestored ? selected : null,
        });
        connection("Thread confirmation pending", false);
        showToast(imageRestored
          ? "The thread may already exist. Your prompt and image remain visible and locked; Resume confirms the exact send."
          : "The thread may already exist. Your prompt remains visible and locked; Resume confirms the exact send.");
      } else {
        if (state.mode === "agent") {
          connection("Request interrupted", false);
          showToast("AgInTi did not accept or complete this request. Existing server work was not replaced.");
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
    state.session = sessionEnvelope(session);
    if (!state.session.authenticated) { showLogin("", { preservePassword: preserveLoginInput }); return; }
    const discardedCrossAccountDraft = recoveringAuthenticationDraft
      && normalizedSessionUsername(state.session.username) !== recoveryUsername;
    if (discardedCrossAccountDraft) {
      elements.message_input.value = "";
      clearSelectedImage();
      if (recoveryWorkflow !== null) {
        recoveryWorkflow.text = "";
        recoveryWorkflow.attachment = null;
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
    }
    const sameAccountRecoveryWorkflow = discardedCrossAccountDraft ? null : recoveryWorkflow;
    const sameAccountRecoveryGeneration = discardedCrossAccountDraft ? null : recoveryGeneration;
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
      state.chatFinalization = null;
      state.runId = null;
      state.agentRunStatus = null;
      clearConversation();
      state.agent = createAgentClient(state.session);
      state.chat = createChatClient(state.session);
      requiredMethod(state.agent, "capabilities", "agent client");
      requiredMethod(state.agent, "listThreads", "agent client");
      requiredMethod(state.agent, "streamRunEvents", "agent client");
      for (const method of [
        "capabilities", "prepareThread", "createThread", "retryCreateThread", "listThreads", "getThread", "listMessages", "getAttachment",
        "prepareRun", "startRun", "retryRun", "getRunStatus", "streamRunEvents", "prepareCancellation", "cancelRun",
      ]) requiredMethod(state.chat, method, "chat client");
      const authenticatedChat = state.chat;
      const readChatCapability = async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const value = chatCapabilityEnvelope(await authenticatedChat.capabilities());
            return { succeeded: true, value };
          } catch {
            if (attempt < 2) await wait(250 * (2 ** attempt));
          }
        }
        return {
          succeeded: false,
          value: Object.freeze({ visionInput: false, visionMediaTypes: Object.freeze([]), maximumImageBytes: 0 }),
        };
      };
      const [rawAgentCapability, chatCapabilityProbe] = await Promise.all([
        Promise.resolve().then(() => state.agent.capabilities()).catch(() => FAIL_CLOSED_AGENT_CAPABILITIES),
        readChatCapability(),
      ]);
      let capability;
      try { capability = validateAgentCapabilities(rawAgentCapability); }
      catch { capability = FAIL_CLOSED_AGENT_CAPABILITIES; }
      const chatCapabilityVerified = chatCapabilityProbe.succeeded;
      const chatCapability = chatCapabilityProbe.value;
      if (state.session !== authenticatedSession || !state.session.authenticated) return;
      state.capabilities = capability;
      state.chatCapabilities = chatCapability;
      if (sameAccountRecoveryWorkflow?.thread) {
        state.chatThread = sameAccountRecoveryWorkflow.thread;
        state.chatThreadId = sameAccountRecoveryWorkflow.thread.threadId;
      }
      showApp();
      setMode(recoveringAuthenticationDraft && !discardedCrossAccountDraft
        ? "chat"
        : selectDefaultMode(capability), { restoreView: false });
      const recoveryImageNeedsUserAction = recoveringAuthenticationDraft && !discardedCrossAccountDraft
        && state.selectedImage !== null && chatCapability.visionInput !== true
        && sameAccountRecoveryWorkflow === null;
      state.authRecoveryPending = recoveryImageNeedsUserAction;
      state.authRecoveryUsername = recoveryImageNeedsUserAction
        ? normalizedSessionUsername(state.session.username)
        : null;
      state.authRecoveryWorkflow = null;
      state.authRecoveryGeneration = sameAccountRecoveryGeneration;
      clearChatFailureDiagnostic();
      updateImageControl();
      if (sameAccountRecoveryWorkflow !== null) {
        connection("Signed in · exact send ready to confirm");
      } else if (sameAccountRecoveryGeneration !== null) {
        connection("Signed in · reconnecting to LocalLLM", false);
      } else if (recoveryImageNeedsUserAction) {
        connection(chatCapabilityVerified
          ? "Signed in · image sending unavailable"
          : "Signed in · image capability unavailable", false);
      } else {
        connection(recoveringAuthenticationDraft && !discardedCrossAccountDraft
          ? "Signed in · unsent draft ready"
          : "Connected");
      }
      if (discardedCrossAccountDraft) {
        showToast("The previous account’s unsent draft and image were cleared before switching accounts.");
      } else if (recoveryImageNeedsUserAction) {
        showToast(chatCapabilityVerified
          ? "Image sending is unavailable. Your staged image remains visible; remove it to continue without the image."
          : "Image capability could not be confirmed. Your staged image remains visible and unsent; remove it only to continue without the image.");
      }
      try {
        await restoreModeView({
          autoOpen: sameAccountRecoveryWorkflow === null && sameAccountRecoveryGeneration === null,
        });
      }
      catch (error) {
        if (state.mode === "chat" && isChatAuthenticationRejection(error)
            && requireFreshAuthentication({
              workflow: sameAccountRecoveryWorkflow,
              generationRecovery: sameAccountRecoveryGeneration,
            })) return;
        if (state.mode === "agent") state.agentThreads = [];
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
      showLogin(loginFailureMessage(error));
    } finally {
      elements.password.value = "";
      state.loginPending = false;
      if (!elements.login_view.hidden) loginControl({ ready: true, label: "Sign in" });
      else if (state.session.authenticated && !state.logoutPending) elements.logout.disabled = false;
    }
  }

  async function logout() {
    if (state.loginPending || state.logoutPending || elements.logout.disabled) return;
    state.logoutPending = true;
    elements.logout.disabled = true;
    elements.resume_run.disabled = true;
    updateImageControl();
    let result;
    try { result = logoutEnvelope(await sessionClient.logout()); }
    catch {
      state.logoutPending = false;
      elements.resume_run.disabled = false;
      updateImageControl();
      if (state.session.authenticated && !elements.app_view.hidden) elements.logout.disabled = false;
      showToast("Sign-out could not be confirmed. Please retry.");
      return;
    }
    state.viewEpoch += 1;
    state.streamAbort?.abort();
    state.imageSelectionEpoch += 1;
    state.imagePreparing = false;
    elements.message_input.value = "";
    state.session = Object.freeze({ authenticated: false });
    state.authRecoveryPending = false;
    state.authRecoveryUsername = null;
    state.authRecoveryWorkflow = null;
    state.authRecoveryGeneration = null;
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
    state.chatFinalization = null;
    state.chatCapabilities = Object.freeze({ visionInput: false, visionMediaTypes: Object.freeze([]), maximumImageBytes: 0 });
    clearSelectedImage();
    updateImageControl();
    state.runId = null;
    state.agentRunStatus = null;
    clearConversation();
    showLogin();
    loginControl({ ready: true, label: "Sign in" });
    state.logoutPending = false;
    elements.resume_run.disabled = false;
    if (result.agentCancellationPending) showToast("Signed out. AgInTi cancellation is still being confirmed server-side.");
  }

  async function stop() {
    if (state.mode === "agent" && state.runId && state.capabilities.actions.cancel) {
      try {
        const { run } = await state.agent.cancelRun(state.runId);
        state.agentRunStatus = safeRunStatus(run.status);
      } catch { showToast("AgInTi cancellation could not be confirmed."); return; }
      state.streamAbort?.abort();
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
    state.busy = true;
    elements.resume_run.disabled = true;
    updateImageControl();
    try {
      if (state.mode === "chat") {
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
        const { run } = await state.agent.resumeRun(state.runId);
        await streamAgentRun(run);
      }
    } catch (error) {
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
    } finally {
      state.busy = false;
      elements.resume_run.disabled = false;
      updateImageControl();
      renderThreads();
    }
  }

  function newConversation() {
    if (interactionLocked()) return;
    if (state.mode === "chat" && state.chatPendingSend) {
      showToast("This durable request has an uncertain response. Use Resume before starting another conversation.");
      return;
    }
    state.viewEpoch += 1;
    state.streamAbort?.abort();
    if (state.mode === "agent") {
      state.agentThreadId = null;
      state.runId = null;
      state.agentRunStatus = null;
    } else {
      state.chatThreadId = null;
      state.chatThread = null;
      state.chatGeneration = null;
      state.chatPendingSend = null;
      state.chatFinalization = null;
      state.chatAfterSequence = 0;
      state.chatOutput = "";
    }
    clearSelectedImage();
    clearChatFailureDiagnostic();
    updateImageControl();
    elements.conversation_title.textContent = "New conversation";
    clearConversation();
    renderThreads();
  }

  function updateReloadSafe() {
    if (state.loginPending || state.logoutPending || state.busy || state.chatFinalization !== null || state.imagePreparing
        || state.selectedImage || state.chatPendingSend || state.authRecoveryGeneration !== null
        || (state.chatGeneration && !TERMINAL.has(state.chatGeneration.status))
        || (state.runId && !TERMINAL.has(state.agentRunStatus))
        || state.streamAbort || String(elements.message_input.value ?? "").length > 0) return false;
    if (!state.session.authenticated && String(elements.password.value ?? "").length > 0) return false;
    return true;
  }

  function clearUpdateReloadTimers() {
    for (const key of ["updateReleaseTimer", "updateSafetyTimer"]) {
      if (state[key] !== null) window?.clearTimeout?.(state[key]);
      state[key] = null;
    }
  }

  function reloadForActiveUpdate() {
    if (!state.updateControllerChanged || state.updateReloaded || !updateReloadSafe()) return false;
    if (!validAgentRelease(state.updateTargetRelease)) return false;
    state.updateReloaded = true;
    clearUpdateReloadTimers();
    const releaseId = state.updateTargetRelease;
    const target = new URL(workerScope, window.location.href);
    target.search = `?v=${encodeURIComponent(releaseId)}`;
    target.hash = "";
    if (typeof window?.location?.replace === "function") window.location.replace(target.href);
    else if (window?.location) window.location.href = target.href;
    return true;
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
      if (updateReloadSafe()) {
        activateWaitingUpdate({ announceUnsafe: false });
        return;
      }
    } else return;
    state.updateSafetyTimer = window?.setTimeout?.(() => {
      state.updateSafetyTimer = null;
      scheduleSafeUpdateReload();
    }, 1_000) ?? null;
  }

  function activateWaitingUpdate({ announceUnsafe = true } = {}) {
    if (state.updateControllerChanged) {
      if (!updateReloadSafe()) {
        elements.update_banner.hidden = false;
        if (announceUnsafe) showToast("Finish the current draft or response before reloading the updated app.");
        scheduleSafeUpdateReload();
        return false;
      }
      if (!validAgentRelease(state.updateTargetRelease)) {
        elements.update_banner.hidden = false;
        elements.apply_update.disabled = true;
        void state.retryUpdateControllerRelease?.({ announceFailure: announceUnsafe });
        return false;
      }
      return reloadForActiveUpdate();
    }
    const worker = state.updateRegistration?.waiting;
    if (!worker || worker !== state.updateOfferedWorker || state.updateConfirmed) return false;
    if (!updateReloadSafe()) {
      elements.update_banner.hidden = false;
      if (announceUnsafe) showToast("Finish the current draft or response before activating the update.");
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
    elements.agent_mode.addEventListener("click", () => setMode("agent"));
    elements.chat_mode.addEventListener("click", () => setMode("chat"));
    elements.theme_picker.addEventListener("change", () => applyTheme(elements.theme_picker.value, { document }));
    elements.open_sidebar.addEventListener("click", () => { elements.sidebar.dataset.open = "true"; elements.sidebar_scrim.hidden = false; });
    elements.sidebar_scrim.addEventListener("click", () => { elements.sidebar.dataset.open = "false"; elements.sidebar_scrim.hidden = true; });
    elements.apply_update.addEventListener("click", () => { activateWaitingUpdate(); });
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
    window?.addEventListener?.("beforeinstallprompt", (event) => {
      event.preventDefault?.();
      state.installPrompt = event;
      elements.install_app.hidden = false;
    });
    for (const input of [elements.username, elements.password, elements.message_input]) {
      input.addEventListener("input", () => {
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
        if (!Number.isFinite(instant) || state.updateCheckInFlight
            || (!force && (document?.visibilityState === "hidden" || navigator?.onLine === false
              || instant - state.updateCheckAt < updateCheckIntervalMs
              || (!onlineTransition && instant - state.updateFailureAt < 60_000)))) return false;
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
        finally { state.updateCheckInFlight = false; }
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

  async function initialize() {
    if (state.initialized) return;
    state.initialized = true;
    bind();
    const theme = restoreTheme({ document });
    elements.theme_picker.value = theme;
    elements.offline_banner.hidden = navigator?.onLine !== false;
    void registerPwa();
    try {
      await authenticated(await sessionClient.restore(), {
        preserveLoginInput: true,
        clearPasswordOnAuthenticated: true,
      });
    }
    catch {
      showLogin("The session could not be restored safely.", { preservePassword: true });
      connection("Signed out", false);
    }
    finally {
      if (!state.session.authenticated || !elements.login_view.hidden) {
        loginControl({ ready: true, label: "Sign in" });
      }
    }
  }

  return Object.freeze({ initialize, submitMessage, login, logout, stop, resume, openThread, setMode });
}
