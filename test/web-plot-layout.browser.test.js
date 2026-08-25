import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BRIGHT_APP_CSS } from "../src/web/pwa-assets.js";

const CHROME = [
  process.env.CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((candidate) => typeof candidate === "string" && existsSync(candidate)) ?? null;
const CHROME_STARTUP_TIMEOUT_MS = 20_000;
const CHROME_DIAGNOSTIC_LIMIT = 4_096;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function retry(operation, attempts = 120) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }
  throw lastError ?? new Error("operation timed out");
}

function observeChrome(chrome) {
  let exit = null;
  let spawnError = null;
  let stderr = "";
  chrome.stderr.setEncoding("utf8");
  chrome.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-CHROME_DIAGNOSTIC_LIMIT);
  });
  const exited = new Promise((resolve) => {
    chrome.once("error", (error) => {
      spawnError = error;
      resolve();
    });
    chrome.once("close", (code, signal) => {
      exit = { code, signal };
      resolve();
    });
  });
  return {
    exited,
    snapshot: () => ({ exit, spawnError, stderr }),
  };
}

function validatedDebuggerPort(value) {
  const port = Number(value);
  if (!/^\d{1,5}$/u.test(value) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid DevTools port ${JSON.stringify(value)}`);
  }
  return port;
}

async function debuggerPort(profile, stderr) {
  try {
    const value = await readFile(join(profile, "DevToolsActivePort"), "utf8");
    const [candidate] = value.trim().split("\n");
    return validatedDebuggerPort(candidate);
  } catch (fileError) {
    const match = /DevTools listening on ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})\//u.exec(stderr);
    if (match) return validatedDebuggerPort(match[1]);
    throw fileError;
  }
}

function chromeStartupError({ exit, spawnError, stderr }, lastReadinessError, timeoutMs) {
  const status = spawnError
    ? `spawn error: ${spawnError.message}`
    : (exit ? `exit code ${String(exit.code)}, signal ${String(exit.signal)}` : "process still running");
  const summary = spawnError || exit
    ? `Chrome failed before CDP became ready (${status}).`
    : `Chrome did not become CDP-ready within ${timeoutMs} ms (${status}).`;
  const readiness = lastReadinessError instanceof Error ? lastReadinessError.message : "no readiness response";
  const diagnostic = stderr.trim() || "<empty>";
  return new Error([
    summary,
    `Executable: ${CHROME}`,
    `Last readiness error: ${readiness}`,
    `Chrome stderr (last ${CHROME_DIAGNOSTIC_LIMIT} bytes):\n${diagnostic}`,
  ].join("\n"));
}

async function waitForExit(exited, timeoutMs) {
  let timeout;
  try {
    await Promise.race([
      exited,
      new Promise((resolve) => { timeout = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForChromeDebugger(chromeState, profile, timeoutMs = CHROME_STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastReadinessError;
  while (Date.now() < deadline) {
    const state = chromeState.snapshot();
    if (state.spawnError || state.exit) throw chromeStartupError(state, lastReadinessError, timeoutMs);
    try {
      const port = await debuggerPort(profile, state.stderr);
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (!response.ok) throw new Error(`DevTools readiness returned HTTP ${response.status}`);
      const version = await response.json();
      if (typeof version.webSocketDebuggerUrl !== "string") throw new Error("DevTools readiness omitted its browser WebSocket URL");
      return { port };
    } catch (error) {
      lastReadinessError = error;
    }
    await Promise.race([delay(50), chromeState.exited]);
  }
  throw chromeStartupError(chromeState.snapshot(), lastReadinessError, timeoutMs);
}

function cdpConnection(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let sequence = 0;
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const operation = pending.get(message.id);
    if (!operation) return;
    pending.delete(message.id);
    if (message.error) operation.reject(new Error(message.error.message));
    else operation.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const operation of pending.values()) operation.reject(new Error("CDP connection closed"));
    pending.clear();
  });
  return {
    async send(method, params = {}) {
      await opened;
      const id = ++sequence;
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}/`;
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

const BROWSER_FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="lazying-agent-release" content="release-${"f".repeat(64)}">
<style>${BRIGHT_APP_CSS}</style></head><body>
<div class="app-view">
  <aside id="sidebar" class="sidebar">Private conversations</aside><button class="sidebar-scrim" hidden></button>
  <section id="workspace" class="workspace">
    <header class="topbar">Adversarial plot layout</header><div hidden></div><div hidden></div>
    <div class="chat-scroll"><section class="messages"><article class="message" data-role="assistant">
      <p>Completed bounded analysis.</p><section class="message-artifacts">
        <article class="artifact"><h3>Long categorical labels</h3><div id="categorical"></div></article>
        <article class="artifact"><h3>Large scientific ticks</h3><div id="large-scientific"></div></article>
        <article class="artifact"><h3>Small scientific ticks</h3><div id="small-scientific"></div></article>
        <article class="artifact"><h3>Narrow scientific ticks</h3><div id="narrow-scientific"></div></article>
        <article class="artifact"><h3>Compiled paper</h3><div id="file-artifact"></div></article>
      </section>
    </article></section></div>
    <aside class="activity-panel"><header><strong>Agent activity</strong><span>Completed</span></header><ol><li>Plan response — Completed</li><li>Run bounded analysis — Completed</li><li>Prepare answer — Completed</li></ol></aside><form id="composer" class="composer"><textarea id="message-input"></textarea><button id="run-agent">Run</button></form><p id="footer-note" class="footer-note">Agent footer</p>
  </section>
</div>
<script type="module">
import { createSafeRenderer } from "/safe-rendering.js";
const renderer = createSafeRenderer({ document });
const labels = Array.from({ length: 128 }, (unused, index) => (index % 2 ? "WWWWWWWWWWWWWWWW" : "界界界界界界界界界界界界界界界界"));
const maximum = Number.MAX_SAFE_INTEGER;
renderer.renderArtifact(document.querySelector("#categorical"), {
  id: "art_${"a".repeat(64)}", title: "Categorical extremes", kind: "plot",
  spec: { schemaVersion: "1", type: "line", labels,
    series: [{ name: "Bounded values", data: labels.map((unused, index) => -maximum + 2 * maximum * index / (labels.length - 1)) }] },
});
renderer.renderArtifact(document.querySelector("#large-scientific"), {
  id: "art_${"b".repeat(64)}", title: "Large numeric extremes", kind: "plot",
  spec: { schemaVersion: "1", type: "scatter", series: [{ name: "Large values", points: [
    { x: -maximum, y: -maximum }, { x: 0, y: 0 }, { x: maximum, y: maximum },
  ] }] },
});
renderer.renderArtifact(document.querySelector("#small-scientific"), {
  id: "art_${"c".repeat(64)}", title: "Small numeric extremes", kind: "plot",
  spec: { schemaVersion: "1", type: "scatter", series: [{ name: "Small values", points: [
    { x: -1e-320, y: -1e-320 }, { x: -5e-324, y: -5e-324 },
    { x: 5e-324, y: 5e-324 }, { x: 1e-320, y: 1e-320 },
  ] }] },
});
renderer.renderArtifact(document.querySelector("#narrow-scientific"), {
  id: "art_${"d".repeat(64)}", title: "Narrow numeric range", kind: "plot",
  spec: { schemaVersion: "1", type: "scatter", xLabel: "Iteration",
    series: [{ name: "Adjacent safe integers", points: [
      { x: maximum - 4, y: 0 }, { x: maximum - 2, y: 1 }, { x: maximum, y: 2 },
    ] }] },
});
renderer.renderArtifact(document.querySelector("#file-artifact"), {
  id: "art_${"e".repeat(64)}", title: "Compiled paper", kind: "file",
  spec: { schemaVersion: "1", filename: "QAOA 结果与补充材料.pdf", mime: "application/pdf",
    bytes: 16777216, sha256: "f".repeat(64) },
});
</script></body></html>`;

const GEOMETRY_EXPRESSION = `(() => {
  const rectangle = (node) => {
    const value = node.getBoundingClientRect();
    return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
  };
  const visible = (node) => getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().width > 0;
  const contains = (outer, inner) => inner.left >= outer.left - .5 && inner.right <= outer.right + .5
    && inner.top >= outer.top - .5 && inner.bottom <= outer.bottom + .5;
  const overlaps = (nodes) => nodes.some((left, index) => nodes.slice(index + 1).some((right) => {
    const a = left.getBoundingClientRect();
    const b = right.getBoundingClientRect();
    return Math.min(a.right, b.right) - Math.max(a.left, b.left) > .5
      && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > .5;
  }));
  const chart = (target) => {
    const svg = target.querySelector('svg.artifact-plot');
    const bounds = svg.getBoundingClientRect();
    const ticks = [...svg.querySelectorAll('text.plot-tick')].filter(visible);
    const xTicks = [...svg.querySelectorAll('text.plot-x-tick')].filter(visible);
    const horizontalAxis = [...svg.querySelectorAll('line.plot-axis')]
      .map((node) => node.getBoundingClientRect()).sort((left, right) => right.width - left.width)[0];
    return {
      plot: rectangle(svg),
      dataWidth: horizontalAxis.width,
      minimumTickHeight: Math.min(...ticks.map((node) => node.getBoundingClientRect().height)),
      ticksClipped: ticks.some((node) => {
        const tick = node.getBoundingClientRect();
        return tick.left < bounds.left - 1 || tick.right > bounds.right + 1
          || tick.top < bounds.top - 1 || tick.bottom > bounds.bottom + 1;
      }),
      xTicksOverlap: overlaps(xTicks),
      xTickTexts: xTicks.map((node) => node.textContent.trim()),
      xTickRects: xTicks.map(rectangle),
      xTickAnchors: xTicks.map((node) => node.getAttribute('text-anchor')),
    };
  };
  const categoricalTarget = document.querySelector('#categorical');
  const categoricalTicks = [...categoricalTarget.querySelectorAll('text[data-label-index]')];
  const wideLabels = [...categoricalTarget.querySelectorAll('.plot-label-wide')];
  const compactLabels = [...categoricalTarget.querySelectorAll('.plot-label-compact')];
  const workspace = rectangle(document.querySelector('#workspace'));
  const chatScroll = rectangle(document.querySelector('.chat-scroll'));
  const composer = rectangle(document.querySelector('#composer'));
  const messageInput = rectangle(document.querySelector('#message-input'));
  const runAgent = rectangle(document.querySelector('#run-agent'));
  const footer = rectangle(document.querySelector('#footer-note'));
  const fileTarget = document.querySelector('#file-artifact');
  const fileControls = fileTarget.querySelector('.artifact-file-controls');
  const fileActions = [...fileTarget.querySelectorAll('.artifact-file-action')];
  const fileTargetRect = rectangle(fileTarget);
  const fileControlsRect = rectangle(fileControls);
  const sidebar = document.querySelector('#sidebar');
  sidebar.hidden = true;
  const maskedWorkspace = rectangle(document.querySelector('#workspace'));
  sidebar.hidden = false;
  return {
    viewport: { width: innerWidth, height: innerHeight },
    workspace,
    shell: {
      chatScroll,
      composer,
      messageInput,
      runAgent,
      footer,
      chatScrollInsideWorkspace: contains(workspace, chatScroll),
      composerInsideWorkspace: contains(workspace, composer),
      inputInsideComposer: contains(composer, messageInput),
      actionInsideComposer: contains(composer, runAgent),
      footerInsideWorkspace: contains(workspace, footer),
      chatScrollAboveComposer: chatScroll.bottom <= composer.top + .5,
      composerAboveFooter: composer.bottom <= footer.top + .5,
    },
    file: {
      target: fileTargetRect,
      controls: fileControlsRect,
      actions: fileActions.map(rectangle),
      actionsCount: fileActions.length,
      controlsInsideTarget: contains(fileTargetRect, fileControlsRect),
      actionsInsideControls: fileActions.every((node) => contains(fileControlsRect, rectangle(node))),
      actionsOverlap: overlaps(fileActions),
      minimumActionHeight: Math.min(...fileActions.map((node) => node.getBoundingClientRect().height)),
      hrefs: fileActions.map((node) => node.href),
    },
    maskPreserved: workspace.left === maskedWorkspace.left && workspace.width === maskedWorkspace.width,
    pageOverflow: document.documentElement.scrollWidth > innerWidth,
    categorical: chart(categoricalTarget),
    largeScientific: chart(document.querySelector('#large-scientific')),
    smallScientific: chart(document.querySelector('#small-scientific')),
    narrowScientific: chart(document.querySelector('#narrow-scientific')),
    narrowOffset: document.querySelector('#narrow-scientific .plot-x-offset')?.textContent ?? '',
    narrowOffsetOverlapsLabel: (() => {
      const offset = document.querySelector('#narrow-scientific .plot-x-offset')?.getBoundingClientRect();
      const label = document.querySelector('#narrow-scientific .plot-x-label')?.getBoundingClientRect();
      return Boolean(offset && label
        && Math.min(offset.right, label.right) - Math.max(offset.left, label.left) > .5
        && Math.min(offset.bottom, label.bottom) - Math.max(offset.top, label.top) > .5);
    })(),
    categoricalTickCount: categoricalTicks.length,
    categoricalFullLabelsPreserved: categoricalTicks.every((node) => [...node.getAttribute('aria-label')].length === 16),
    categoricalAnchors: categoricalTicks.map((node) => node.getAttribute('text-anchor')),
    wideLabelsVisible: wideLabels.filter(visible).map((node) => node.textContent),
    compactLabelsVisible: compactLabels.filter(visible).map((node) => node.textContent),
  };
})()`;

test("real Chrome keeps adversarial Agent plot ticks readable and contained at desktop and iPhone widths", {
  skip: CHROME === null ? "Chrome is unavailable" : false,
  timeout: 45_000,
}, async () => {
  const [safeRendering, protocol, webRelease] = await Promise.all([
    readFile(new URL("../src/web/safe-rendering.js", import.meta.url)),
    readFile(new URL("../src/web/aginti-protocol.js", import.meta.url)),
    readFile(new URL("../src/web/web-release.js", import.meta.url)),
  ]);
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(BROWSER_FIXTURE);
    } else if (pathname === "/safe-rendering.js") {
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.end(safeRendering);
    } else if (pathname === "/aginti-protocol.js") {
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.end(protocol);
    } else if (pathname === "/web-release.js") {
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.end(webRelease);
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  let origin;
  let profile;
  let chrome;
  let chromeState;
  let page;
  try {
    origin = await listen(server);
    profile = await mkdtemp(join(tmpdir(), "lazying-agent-web-plot-"));
    const requestedCdpPort = process.env.LAZYING_AGENT_WEB_TEST_CDP_PORT === undefined
      ? 0
      : validatedDebuggerPort(process.env.LAZYING_AGENT_WEB_TEST_CDP_PORT);
    chrome = spawn(CHROME, [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--no-first-run", "--no-default-browser-check",
      "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${requestedCdpPort}`,
      `--user-data-dir=${profile}`, "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    chromeState = observeChrome(chrome);
    const { port } = await waitForChromeDebugger(chromeState, profile);
    const targetResponse = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(origin)}`, { method: "PUT" });
    assert.equal(targetResponse.ok, true);
    const target = await targetResponse.json();
    page = cdpConnection(target.webSocketDebuggerUrl);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Accessibility.enable");

    const results = new Map();
    for (const metrics of [
      { label: "desktop", width: 1_280, height: 900, deviceScaleFactor: 1, mobile: false },
      { label: "iphone", width: 390, height: 844, screenWidth: 390, screenHeight: 844, deviceScaleFactor: 3, mobile: true },
    ]) {
      await page.send("Emulation.setDeviceMetricsOverride", metrics);
      await page.send("Page.navigate", { url: origin });
      await retry(async () => {
        const ready = await page.send("Runtime.evaluate", {
          expression: "document.readyState === 'complete' && document.querySelectorAll('svg.artifact-plot').length === 4 && document.querySelectorAll('#file-artifact a').length === 2",
          returnByValue: true,
        });
        if (ready.result.value !== true) throw new Error("plot fixture is not ready");
      });
      const evaluated = await page.send("Runtime.evaluate", { expression: GEOMETRY_EXPRESSION, returnByValue: true });
      const accessibility = await page.send("Accessibility.getFullAXTree");
      evaluated.result.value.accessiblePlots = Object.fromEntries(accessibility.nodes
        .filter((node) => node.role?.value === "image" && typeof node.name?.value === "string")
        .map((node) => [node.name.value, node.description?.value ?? ""]));
      results.set(metrics.label, evaluated.result.value);
    }

    const desktop = results.get("desktop");
    const iphone = results.get("iphone");
    assert.deepEqual(desktop.viewport, { width: 1_280, height: 900 });
    assert.deepEqual(iphone.viewport, { width: 390, height: 844 });
    const shellFailures = [];
    for (const [label, result] of [["desktop", desktop], ["iphone", iphone]]) {
      assert.equal(result.pageOverflow, false);
      assert.equal(result.maskPreserved, true);
      assert.equal(result.file.actionsCount, 2);
      assert.equal(result.file.controlsInsideTarget, true);
      assert.equal(result.file.actionsInsideControls, true);
      assert.equal(result.file.actionsOverlap, false);
      assert.ok(result.file.minimumActionHeight >= 44);
      assert.deepEqual(result.file.hrefs, [
        `http://127.0.0.1:${new URL(origin).port}/api/agent/artifacts/art_${"e".repeat(64)}/content?v=release-${"f".repeat(64)}`,
        `http://127.0.0.1:${new URL(origin).port}/api/agent/artifacts/art_${"e".repeat(64)}/content?v=release-${"f".repeat(64)}&download=1`,
      ]);
      for (const [check, accepted] of Object.entries({
        chatScrollInsideWorkspace: result.shell.chatScrollInsideWorkspace,
        composerInsideWorkspace: result.shell.composerInsideWorkspace,
        inputInsideComposer: result.shell.inputInsideComposer,
        actionInsideComposer: result.shell.actionInsideComposer,
        footerInsideWorkspace: result.shell.footerInsideWorkspace,
        chatScrollAboveComposer: result.shell.chatScrollAboveComposer,
        composerAboveFooter: result.shell.composerAboveFooter,
      })) {
        if (accepted !== true) shellFailures.push({ label, check, shell: result.shell });
      }
      assert.equal(result.categoricalTickCount, 4);
      assert.equal(result.categoricalFullLabelsPreserved, true);
      assert.equal(result.categoricalAnchors[0], "start");
      assert.equal(result.categoricalAnchors.at(-1), "end");
      for (const [name, chart] of Object.entries({
        categorical: result.categorical,
        largeScientific: result.largeScientific,
        smallScientific: result.smallScientific,
        narrowScientific: result.narrowScientific,
      })) {
        assert.equal(chart.ticksClipped, false, `${label} ${name} ticks clip`);
        assert.equal(chart.xTicksOverlap, false, `${label} ${name} x ticks overlap: ${JSON.stringify(chart.xTickRects)}`);
        assert.equal(chart.xTickAnchors[0], "start");
        assert.equal(chart.xTickAnchors.at(-1), "end");
      }
      assert.equal(result.narrowOffsetOverlapsLabel, false, `${label} narrow offset overlaps the x-axis label`);
      assert.equal(new Set(result.narrowScientific.xTickTexts).size, 5, `${label} narrow ticks are not distinct`);
      assert.equal(result.narrowOffset, "offset +9007199254740987");
      assert.match(result.accessiblePlots["Categorical extremes"], /界界界界界界界界界界界界界界界界/u);
      assert.match(result.accessiblePlots["Categorical extremes"], /WWWWWWWWWWWWWWWW/u);
      assert.match(result.accessiblePlots["Narrow numeric range"], /X-axis absolute ticks: 9007199254740987/u);
      assert.match(result.accessiblePlots["Narrow numeric range"], /visual labels use offset \+9007199254740987/u);
    }
    assert.equal(desktop.wideLabelsVisible.length, 4);
    assert.equal(desktop.compactLabelsVisible.length, 0);
    assert.ok(desktop.wideLabelsVisible.every((value) => [...value].length <= 10));
    assert.equal(iphone.wideLabelsVisible.length, 0);
    assert.equal(iphone.compactLabelsVisible.length, 4);
    assert.ok(iphone.compactLabelsVisible.every((value) => [...value].length <= 5));
    assert.ok(iphone.categorical.plot.width >= 300);
    assert.ok(iphone.categorical.dataWidth >= 238);
    assert.ok(iphone.categorical.minimumTickHeight >= 10);
    assert.ok(iphone.largeScientific.xTickTexts.every((value) => value.length <= 8 && !value.includes("e+")));
    assert.ok(iphone.smallScientific.xTickTexts.every((value) => value.length <= 8 && !value.includes("e+")));
    assert.deepEqual(shellFailures, [], `shell layout escaped the clipped workspace: ${JSON.stringify(shellFailures)}`);
  } finally {
    page?.close();
    if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGTERM");
    if (chromeState) await waitForExit(chromeState.exited, 2_000);
    if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill("SIGKILL");
      await chromeState.exited;
    }
    if (server.listening) await closeServer(server);
    if (profile) await rm(profile, { recursive: true, force: true });
  }
});
