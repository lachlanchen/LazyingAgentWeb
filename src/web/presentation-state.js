import {
  assertVerifiedAgentEvent,
  initialEventCursor,
  validateRunId,
  validateThreadId,
} from "./aginti-protocol.js";

const TERMINAL_STATUS = Object.freeze({
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
});

function copyCursor(value) {
  const initial = initialEventCursor();
  if (value === undefined) return initial;
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || !Number.isSafeInteger(value.seq) || value.seq < 0
      || typeof value.hash !== "string" || !/^[a-f0-9]{64}$/u.test(value.hash)
      || Object.keys(value).some((key) => !["seq", "hash"].includes(key))) {
    throw new TypeError("presentation cursor is invalid");
  }
  if (value.seq === 0 && value.hash !== initial.hash) throw new TypeError("initial presentation cursor hash must be zero");
  return Object.freeze({ seq: value.seq, hash: value.hash });
}

function freezeArray(value) {
  return Object.freeze(value.map((item) => Object.freeze({ ...item })));
}

/*
 * A run projection is deliberately disposable presentation state. It never
 * creates work, compacts context, chooses tools, or synthesizes artifacts.
 * Reloading it from AgInTi's authoritative replay must always be safe.
 */
export function createRunPresentation({ runId, threadId, cursor } = {}) {
  validateRunId(runId);
  validateThreadId(threadId);
  let delivery = copyCursor(cursor);
  let status = "starting";
  let output = "";
  let outputComplete = false;
  let plan = [];
  let compaction = null;
  const tools = new Map();
  const artifacts = new Map();

  function snapshot() {
    return Object.freeze({
      authority: "aginti",
      authoritative: false,
      runId,
      threadId,
      cursor: delivery,
      status,
      output,
      outputComplete,
      plan: freezeArray(plan),
      compaction: compaction === null ? null : Object.freeze({ ...compaction }),
      tools: freezeArray([...tools.values()]),
      artifacts: Object.freeze([...artifacts.values()]),
    });
  }

  function apply(value) {
    const event = assertVerifiedAgentEvent(value);
    if (event.runId !== runId || event.threadId !== threadId) throw new TypeError("event does not belong to this presentation");
    if (event.seq !== delivery.seq + 1 || event.previousHash !== delivery.hash) throw new TypeError("event is not contiguous with this presentation");
    delivery = Object.freeze({ seq: event.seq, hash: event.hash });
    if (event.type === "run.status") status = event.payload.status;
    else if (event.type === "plan.updated") plan = event.payload.steps.map((step) => ({ ...step }));
    else if (event.type === "context.compacted") compaction = { ...event.payload };
    else if (event.type.startsWith("tool.")) {
      tools.set(event.payload.callId, {
        callId: event.payload.callId,
        label: event.payload.publicLabel,
        summary: event.payload.publicSummary,
        at: event.payload.at,
        state: event.type.slice("tool.".length),
      });
    } else if (event.type === "output.delta") {
      if (outputComplete) throw new TypeError("output delta arrived after output.completed");
      output += event.payload.text;
      if (output.length > 32_000) throw new TypeError("presentation output exceeded 32000 characters");
    } else if (event.type === "output.completed") outputComplete = true;
    else if (event.type === "artifact.created" || event.type === "artifact.updated") {
      if (event.type === "artifact.updated" && !artifacts.has(event.payload.artifact.id)) {
        throw new TypeError("artifact.updated arrived before artifact.created");
      }
      artifacts.set(event.payload.artifact.id, event.payload.artifact);
    } else if (Object.hasOwn(TERMINAL_STATUS, event.type)) status = TERMINAL_STATUS[event.type];
    return snapshot();
  }

  return Object.freeze({ apply, snapshot });
}
