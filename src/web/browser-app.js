import { AgintiBrowserClient, selectDefaultMode } from "./aginti-client.js";
import { AgintiProtocolError, FAIL_CLOSED_AGENT_CAPABILITIES, validateAgentCapabilities } from "./aginti-protocol.js";
import { CloudSessionClient } from "./cloud-session-client.js";
import { createBrowserOpaqueId, DirectChatBrowserClient, DirectChatProtocolError } from "./direct-chat-client.js";
import { createRunPresentation } from "./presentation-state.js";
import {
  applyTheme,
  offerPasswordManagerSave,
  restoreTheme,
} from "./pwa-assets.js";
import { canonicalizeVisionImage } from "./vision-image-client.js";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

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
  if (typeof value !== "string" || value.length < 1 || value.length > 32_000 || /\u0000/u.test(value)) {
    throw new TypeError("message is invalid");
  }
  const text = value.trim();
  if (!text) throw new TypeError("message must contain non-whitespace text");
  return text;
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
  if (!Number.isSafeInteger(updateCheckIntervalMs) || updateCheckIntervalMs < 60_000 || updateCheckIntervalMs > 86_400_000) {
    throw new TypeError("updateCheckIntervalMs must be from one minute through one day");
  }
  if (!Number.isSafeInteger(updateDeferralMs) || updateDeferralMs < 60_000 || updateDeferralMs > 86_400_000) {
    throw new TypeError("updateDeferralMs must be from one minute through one day");
  }
  if (!Number.isSafeInteger(activationTimeoutMs) || activationTimeoutMs < 5_000 || activationTimeoutMs > 300_000) {
    throw new TypeError("activationTimeoutMs must be from five seconds through five minutes");
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
    agentThreadId: null,
    chatThreadId: null,
    chatThread: null,
    chatGeneration: null,
    chatAfterSequence: 0,
    chatOutput: "",
    chatPendingSend: null,
    selectedImage: null,
    selectedImageUrl: null,
    imagePreparing: false,
    imageSelectionEpoch: 0,
    imageRenderEpoch: 0,
    messageImageUrls: new Set(),
    runId: null,
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

  function clearSelectedImage() {
    state.imageSelectionEpoch += 1;
    state.imagePreparing = false;
    if (state.selectedImageUrl !== null) revokeObjectUrl(state.selectedImageUrl);
    state.selectedImage = null;
    state.selectedImageUrl = null;
    elements.image_input.value = "";
    elements.image_preview_thumbnail.src = "";
    elements.image_preview_label.textContent = "";
    elements.image_preview.hidden = true;
  }

  function updateImageControl() {
    const available = state.session.authenticated && state.mode === "chat"
      && state.chatCapabilities.visionInput === true;
    if (!available && (state.imagePreparing || state.selectedImage !== null)) clearSelectedImage();
    elements.add_image.hidden = !available;
    elements.add_image.disabled = !available || state.busy || state.imagePreparing;
    elements.send_message.disabled = !state.session.authenticated || state.busy || state.imagePreparing;
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
    if (changed && state.busy) return;
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

  function messageNode(role, content, { runId, attachment, threadId } = {}) {
    const article = document.createElement("article");
    article.className = "message";
    article.dataset.role = role;
    if (runId) article.dataset.runId = runId;
    if (attachment !== undefined && role === "user" && threadId && state.chat) {
      const image = document.createElement("img");
      image.className = "message-attachment";
      image.alt = "Attached image";
      article.appendChild(image);
      const expectedEpoch = state.viewEpoch;
      const expectedImageEpoch = state.imageRenderEpoch;
      const chat = state.chat;
      void chat.getAttachment({ threadId, attachment }).then(({ bytes, descriptor }) => {
        if (state.viewEpoch !== expectedEpoch || state.imageRenderEpoch !== expectedImageEpoch || state.chat !== chat) return;
        const url = createObjectUrl(new Blob([bytes], { type: descriptor.mediaType }));
        state.messageImageUrls.add(url);
        image.src = url;
      }).catch(() => {
        image.alt = "Attached image preview unavailable";
      });
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
    const response = await chat.listThreads({ limit: 100 });
    if (state.session !== session || state.chat !== chat) return;
    state.chatThreads = [...response.threads];
    if (state.mode === "chat") renderThreads();
  }

  function renderPresentation(snapshot) {
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

  async function exactMutation(dispatch, retry) {
    try { return await dispatch(); }
    catch (error) {
      if (error?.retryable !== true) throw error;
      connection("Retrying the same durable request", false);
      await wait(250);
      return await retry();
    }
  }

  async function fetchChatSnapshot(threadId, signal) {
    const chat = state.chat;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { thread: before } = await chat.getThread(threadId, { signal });
      const messages = [];
      let afterRevision = 0;
      let previousHash = null;
      let inconsistent = false;
      while (afterRevision < before.revision) {
        const remaining = before.revision - afterRevision;
        const response = await chat.listMessages({
          threadId,
          afterRevision,
          limit: Math.min(200, remaining),
          signal,
        });
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
      const { thread: after } = await chat.getThread(threadId, { signal });
      const stable = before.revision === after.revision
        && before.ledgerHash === after.ledgerHash
        && before.currentGenerationId === after.currentGenerationId;
      const complete = messages.length === after.revision
        && (after.revision === 0 ? after.ledgerHash === null : previousHash === after.ledgerHash);
      if (!inconsistent && stable && complete) return Object.freeze({ thread: after, messages: Object.freeze(messages) });
    }
    throw new DirectChatProtocolError("Direct Chat changed while its authoritative snapshot was being read");
  }

  function renderChatSnapshot(snapshot) {
    clearConversation();
    state.chatThread = snapshot.thread;
    state.chatThreadId = snapshot.thread.threadId;
    elements.conversation_title.textContent = snapshot.thread.title || "New conversation";
    snapshot.messages.forEach((message) => messageNode(message.role, message.content, {
      runId: message.generationId ?? undefined,
      attachment: message.attachment,
      threadId: snapshot.thread.threadId,
    }));
    const last = snapshot.messages.at(-1);
    elements.workspace.dataset.status = last?.role === "assistant" ? "completed" : "idle";
    elements.run_state.textContent = last?.role === "assistant" ? "Completed" : "Idle";
    renderThreads();
  }

  async function refreshChatThread(threadId, signal, { expectedEpoch = state.viewEpoch } = {}) {
    const session = state.session;
    const chat = state.chat;
    const snapshot = await fetchChatSnapshot(threadId, signal);
    if (state.session !== session || state.chat !== chat) return snapshot;
    state.chatThread = snapshot.thread;
    state.chatThreadId = snapshot.thread.threadId;
    if (state.mode === "chat" && state.viewEpoch === expectedEpoch) renderChatSnapshot(snapshot);
    try { await loadChatThreads(); } catch { /* The open authoritative thread remains usable. */ }
    return snapshot;
  }

  async function finishChatGeneration(generation, controller, expectedEpoch = state.viewEpoch) {
    state.chatGeneration = generation;
    const presenting = state.mode === "chat" && state.viewEpoch === expectedEpoch;
    if (presenting) {
      elements.workspace.dataset.status = generation.status;
      elements.run_state.textContent = statusLabel(generation.status);
      elements.resume_run.hidden = true;
    }
    if (generation.status === "completed" && presenting && state.chatThreadId === generation.threadId) {
      const snapshot = await refreshChatThread(generation.threadId, controller.signal, { expectedEpoch });
      state.chatThread = snapshot.thread;
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
    elements.run_state.textContent = "Running";
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
    const snapshot = await refreshChatThread(threadId, undefined, { expectedEpoch });
    if (state.mode !== "chat" || state.viewEpoch !== expectedEpoch) return;
    const generationId = snapshot.thread.currentGenerationId;
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
  }

  async function openThread(threadId, { mode = state.mode } = {}) {
    if (state.busy || mode !== state.mode) return;
    state.busy = true;
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
      const { thread } = await agent.createThread({ title: text.slice(0, 80) });
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
      workflow.threadTicket = chat.prepareThread({ title: workflow.text.slice(0, 80) });
    }
    if (workflow.threadTicket && !workflow.thread) {
      const firstDispatch = workflow.threadDispatched
        ? () => chat.retryCreateThread(workflow.threadTicket)
        : () => chat.createThread(workflow.threadTicket);
      workflow.threadDispatched = true;
      const created = await exactMutation(
        firstDispatch,
        () => chat.retryCreateThread(workflow.threadTicket),
      );
      ensureCurrentSession();
      thread = created.thread;
      workflow.thread = thread;
      state.chatThreadId = thread.threadId;
      state.chatThread = thread;
      state.chatThreads = [thread, ...state.chatThreads.filter((item) => item.threadId !== thread.threadId)];
      elements.conversation_title.textContent = thread.title || "New conversation";
      renderThreads();
    }
    thread = workflow.thread ?? thread;
    if (workflow.runTicket) {
      const started = await exactMutation(
        () => chat.retryRun(workflow.runTicket),
        () => chat.retryRun(workflow.runTicket),
      );
      ensureCurrentSession();
      state.chatPendingSend = null;
      state.chatGeneration = started.generation;
      state.chatAfterSequence = 0;
      state.chatOutput = "";
      await refreshChatThread(started.generation.threadId);
      ensureCurrentSession();
      if (started.generation.terminal) await finishChatGeneration(started.generation, new AbortController());
      else await streamChatGeneration(started.generation);
      return;
    }
    if (!thread || thread.threadId !== state.chatThreadId) {
      thread = (await fetchChatSnapshot(state.chatThreadId)).thread;
      ensureCurrentSession();
      state.chatThread = thread;
    } else {
      thread = (await fetchChatSnapshot(thread.threadId)).thread;
      ensureCurrentSession();
      state.chatThread = thread;
    }
    if (thread.currentGenerationId) throw new TypeError("the conversation already has a generation in progress");
    if (!workflow.runTicket) {
      workflow.runTicket = chat.prepareRun({
        threadId: thread.threadId,
        content: workflow.text,
        expectedRevision: thread.revision,
        expectedHash: thread.ledgerHash,
        ...(workflow.attachment === null ? {} : { attachment: workflow.attachment }),
      });
    }
    workflow.runDispatched = true;
    const started = await exactMutation(
      () => chat.startRun(workflow.runTicket),
      () => chat.retryRun(workflow.runTicket),
    );
    ensureCurrentSession();
    state.chatPendingSend = null;
    state.chatGeneration = started.generation;
    state.chatAfterSequence = 0;
    state.chatOutput = "";
    await refreshChatThread(thread.threadId);
    ensureCurrentSession();
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
    };
    state.chatPendingSend = workflow;
    try { await continueChatSend(workflow); }
    catch (error) {
      elements.resume_run.hidden = false;
      throw error;
    }
  }

  async function selectImage() {
    if (state.busy || !state.session.authenticated || state.mode !== "chat"
        || state.chatCapabilities.visionInput !== true) return;
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
          || state.chatCapabilities.visionInput !== true) return;
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
    if (state.busy || !state.session.authenticated) return;
    if (state.imagePreparing) {
      clearSelectedImage();
      updateImageControl();
      return;
    }
    let text;
    try { text = boundedMessage(elements.message_input.value); }
    catch { return; }
    const selected = state.mode === "chat" ? state.selectedImage : null;
    const attachment = selected === null ? null : Object.freeze({
      attachmentId: selected.attachmentId,
      mediaType: selected.mediaType,
      byteLength: selected.byteLength,
      width: selected.width,
      height: selected.height,
      bytes: selected.bytes,
    });
    clearSelectedImage();
    elements.message_input.value = "";
    state.busy = true;
    elements.send_message.disabled = true;
    updateImageControl();
    try {
      if (state.mode === "agent" && state.capabilities.enabled) await sendAgent(text);
      else await sendChat(text, attachment);
      connection("Connected");
    } catch {
      connection("Request interrupted", false);
      showToast(state.mode === "agent"
        ? "AgInTi did not accept or complete this request. Existing server work was not replaced."
        : "LocalLLM chat was interrupted.");
    } finally {
      state.busy = false;
      updateImageControl();
    }
  }

  async function authenticated(session, {
    preserveLoginInput = false,
    clearPasswordOnAuthenticated = false,
  } = {}) {
    state.session = sessionEnvelope(session);
    if (!state.session.authenticated) { showLogin("", { preservePassword: preserveLoginInput }); return; }
    const authenticatedSession = state.session;
    if (clearPasswordOnAuthenticated) elements.password.value = "";
    elements.logout.disabled = true;
    try {
      state.viewEpoch += 1;
      state.streamAbort?.abort();
      state.agentThreads = [];
      state.chatThreads = [];
      state.agentThreadId = null;
      state.chatThreadId = null;
      state.chatThread = null;
      state.chatGeneration = null;
      state.chatPendingSend = null;
      state.runId = null;
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
      const [rawAgentCapability, rawChatCapability] = await Promise.all([
        Promise.resolve().then(() => state.agent.capabilities()).catch(() => FAIL_CLOSED_AGENT_CAPABILITIES),
        Promise.resolve().then(() => state.chat.capabilities()).catch(() => ({
          visionInput: false, visionMediaTypes: [], maximumImageBytes: 0,
        })),
      ]);
      let capability;
      try { capability = validateAgentCapabilities(rawAgentCapability); }
      catch { capability = FAIL_CLOSED_AGENT_CAPABILITIES; }
      let chatCapability;
      try { chatCapability = chatCapabilityEnvelope(rawChatCapability); }
      catch { chatCapability = Object.freeze({ visionInput: false, visionMediaTypes: Object.freeze([]), maximumImageBytes: 0 }); }
      if (state.session !== authenticatedSession || !state.session.authenticated) return;
      state.capabilities = capability;
      state.chatCapabilities = chatCapability;
      showApp();
      setMode(selectDefaultMode(capability), { restoreView: false });
      connection("Connected");
      try { await restoreModeView({ autoOpen: true }); }
      catch {
        if (state.mode === "agent") state.agentThreads = [];
        else state.chatThreads = [];
        renderThreads();
        connection(state.mode === "agent" ? "Agent unavailable" : "Chat unavailable", false);
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
    state.viewEpoch += 1;
    state.streamAbort?.abort();
    clearSelectedImage();
    updateImageControl();
    let result;
    try { result = logoutEnvelope(await sessionClient.logout()); }
    catch {
      state.logoutPending = false;
      if (state.session.authenticated && !elements.app_view.hidden) elements.logout.disabled = false;
      showToast("Sign-out could not be confirmed. Please retry.");
      return;
    }
    state.session = Object.freeze({ authenticated: false });
    state.agent = null;
    state.chat = null;
    state.capabilities = FAIL_CLOSED_AGENT_CAPABILITIES;
    state.agentThreads = [];
    state.chatThreads = [];
    state.agentThreadId = null;
    state.chatThreadId = null;
    state.chatThread = null;
    state.chatGeneration = null;
    state.chatPendingSend = null;
    state.chatCapabilities = Object.freeze({ visionInput: false, visionMediaTypes: Object.freeze([]), maximumImageBytes: 0 });
    clearSelectedImage();
    updateImageControl();
    state.runId = null;
    clearConversation();
    showLogin();
    loginControl({ ready: true, label: "Sign in" });
    state.logoutPending = false;
    if (result.agentCancellationPending) showToast("Signed out. AgInTi cancellation is still being confirmed server-side.");
  }

  async function stop() {
    if (state.mode === "agent" && state.runId && state.capabilities.actions.cancel) {
      try { await state.agent.cancelRun(state.runId); }
      catch { showToast("AgInTi cancellation could not be confirmed."); return; }
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
    if (state.busy) return;
    state.busy = true;
    try {
      if (state.mode === "chat") {
        if (state.chatPendingSend) await continueChatSend(state.chatPendingSend);
        else if (state.chatGeneration?.status === "in_progress") await streamChatGeneration(state.chatGeneration, {
          afterSequence: state.chatAfterSequence,
          output: state.chatOutput,
        });
      } else if (state.runId && state.capabilities.enabled && state.capabilities.actions.resume) {
        const { run } = await state.agent.resumeRun(state.runId);
        await streamAgentRun(run);
      }
    } catch {
      showToast(state.mode === "chat"
        ? "The durable LocalLLM request could not reconnect yet."
        : "AgInTi could not resume this run.");
    } finally { state.busy = false; }
  }

  function newConversation() {
    if (state.busy) return;
    if (state.mode === "chat" && state.chatPendingSend) {
      showToast("This durable request has an uncertain response. Use Resume before starting another conversation.");
      return;
    }
    state.viewEpoch += 1;
    state.streamAbort?.abort();
    if (state.mode === "agent") {
      state.agentThreadId = null;
      state.runId = null;
    } else {
      state.chatThreadId = null;
      state.chatThread = null;
      state.chatGeneration = null;
      state.chatPendingSend = null;
      state.chatAfterSequence = 0;
      state.chatOutput = "";
    }
    clearSelectedImage();
    updateImageControl();
    elements.conversation_title.textContent = "New conversation";
    clearConversation();
    renderThreads();
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;
    elements.login_form.addEventListener("submit", (event) => { void login(event); });
    elements.composer.addEventListener("submit", (event) => { void submitMessage(event); });
    elements.add_image.addEventListener("click", () => elements.image_input.click?.());
    elements.image_input.addEventListener("change", () => { void selectImage(); });
    elements.remove_image.addEventListener("click", () => {
      clearSelectedImage();
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
    elements.apply_update.addEventListener("click", () => {
      const worker = state.updateRegistration?.waiting;
      if (!worker || state.updateConfirmed) return;
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
        return;
      }
      if (state.updateActivationTimer !== null) window?.clearTimeout?.(state.updateActivationTimer);
      state.updateActivationTimer = window?.setTimeout?.(() => {
        if (state.updateReloaded) return;
        state.updateConfirmed = false;
        state.updateConfirmedWorker = null;
        state.updateActivationTimer = null;
        elements.apply_update.disabled = false;
        elements.defer_update.disabled = false;
        elements.update_banner.hidden = !state.updateRegistration?.waiting;
        showToast("The update is still waiting. You can retry or choose Later.");
      }, activationTimeoutMs) ?? null;
    });
    elements.defer_update.addEventListener("click", () => {
      const worker = state.updateRegistration?.waiting;
      if (!worker || state.updateConfirmed) return;
      state.updateDeferredWorker = worker;
      state.updateDeferredUntil = Number(now()) + updateDeferralMs;
      elements.update_banner.hidden = true;
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
  }

  async function registerPwa() {
    if (!navigator?.serviceWorker?.register || window?.location?.protocol !== "https:") return;
    try {
      let hadController = Boolean(navigator.serviceWorker.controller);
      navigator.serviceWorker.addEventListener?.("controllerchange", () => {
        if (!hadController) {
          hadController = true;
          return;
        }
        if (state.updateReloaded) return;
        state.updateReloaded = true;
        if (state.updateActivationTimer !== null) window?.clearTimeout?.(state.updateActivationTimer);
        state.updateActivationTimer = null;
        window.location.reload();
      });
      const registration = await navigator.serviceWorker.register(workerPath, { scope: workerScope, updateViaCache: "none" });
      const ready = () => {
        const waiting = registration.waiting;
        if (!waiting) return;
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
        elements.update_banner.hidden = false;
      };
      state.showUpdatePrompt = ready;
      ready();
      registration.addEventListener?.("updatefound", () => {
        registration.installing?.addEventListener?.("statechange", ready);
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
      document?.addEventListener?.("visibilitychange", () => { void checkForUpdate(); });
      window?.addEventListener?.("online", () => { void checkForUpdate({ onlineTransition: true }); });
      void checkForUpdate({ force: true });
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
