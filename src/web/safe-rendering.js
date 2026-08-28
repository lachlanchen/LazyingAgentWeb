import { validateArtifact } from "./aginti-protocol.js";
import { optionalWebRelease } from "./web-release.js";

const MAX_MARKDOWN = 32_000;
const MAX_TEX_TOTAL = 8_192;
const MAX_TEX_EXPRESSION = 4_096;
const MAX_MATH_EXPRESSIONS = 32;
const MAX_INLINE_DEPTH = 12;
const MAX_BLOCK_DEPTH = 8;
const SVG_NS = "http://www.w3.org/2000/svg";
const PLOT_COLORS = Object.freeze(["#147d75", "#4472ca", "#c55c37", "#8c5bbd", "#73802d", "#bb4f7b", "#427f9e", "#9b6b2f"]);
const DOWNLOADABLE_SVG_ELEMENTS = new Set([
  "circle", "desc", "g", "line", "path", "rect", "svg", "text", "title", "tspan",
]);
const STANDALONE_PLOT_STYLE = [
  ".plot-grid{stroke:var(--line,#d5d9de)}",
  ".plot-axis{stroke:var(--muted,#66727f)}",
  ".plot-grid,.plot-axis,.plot-series path{vector-effect:non-scaling-stroke}",
  ".plot-tick{fill:var(--muted,#66727f);font-family:system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;font-size:13px}",
  ".plot-axis-label{font-size:14px;font-weight:650}",
  ".plot-axis-offset{font-size:11px;font-variant-numeric:tabular-nums}",
  ".plot-label-compact{display:none}",
].join("");

function browserDocument(value) {
  if (!value || typeof value.createElement !== "function" || typeof value.createTextNode !== "function"
      || typeof value.createDocumentFragment !== "function" || typeof value.createElementNS !== "function") {
    throw new TypeError("a DOM document implementation is required");
  }
  return value;
}

function targetNode(value) {
  if (!value || typeof value.replaceChildren !== "function" || typeof value.appendChild !== "function") {
    throw new TypeError("render target must be a DOM node");
  }
  return value;
}

function createNode(document, name, className) {
  const node = document.createElement(name);
  if (className) node.className = className;
  return node;
}

function createSvg(document, name, attributes = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function appendText(document, parent, value) {
  parent.appendChild(document.createTextNode(value));
}

function xmlText(value) {
  return String(value).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function xmlAttribute(value) {
  return xmlText(value).replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function svgAttributeEntries(node) {
  const entries = [];
  const attributes = node?.attributes;
  if (attributes instanceof Map) {
    for (const [name, value] of attributes) entries.push([String(name), String(value)]);
  } else if (typeof attributes?.[Symbol.iterator] === "function") {
    for (const attribute of attributes) entries.push([String(attribute.name), String(attribute.value)]);
  } else if (Number.isSafeInteger(attributes?.length)) {
    for (let index = 0; index < attributes.length; index += 1) {
      const attribute = attributes.item?.(index) ?? attributes[index];
      if (attribute) entries.push([String(attribute.name), String(attribute.value)]);
    }
  }
  const className = typeof node?.className === "string"
    ? node.className
    : (typeof node?.className?.baseVal === "string" ? node.className.baseVal : "");
  if (className && !entries.some(([name]) => name === "class")) entries.push(["class", className]);
  const unique = new Map();
  for (const [name, value] of entries) {
    if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/u.test(name)) throw new TypeError("SVG attribute name is invalid");
    unique.set(name, value);
  }
  return [...unique].sort(([left], [right]) => (left < right ? -1 : (left > right ? 1 : 0)));
}

function serializeSafeSvgNode(node) {
  if (node?.nodeType === 3 || node?.tagName === "#text") return xmlText(node.nodeValue ?? node.textContent ?? "");
  const name = String(node?.localName ?? node?.tagName ?? "").toLowerCase();
  if (!DOWNLOADABLE_SVG_ELEMENTS.has(name)) throw new TypeError("SVG export contains an unsupported element");
  const attributes = svgAttributeEntries(node)
    .map(([key, value]) => ` ${key}="${xmlAttribute(value)}"`)
    .join("");
  const children = Array.from(node.childNodes ?? node.children ?? []);
  return `<${name}${attributes}>${children.map(serializeSafeSvgNode).join("")}</${name}>`;
}

function serializeStandalonePlot(svg) {
  const serialized = serializeSafeSvgNode(svg);
  const rootEnd = serialized.indexOf(">");
  if (rootEnd < 0) throw new TypeError("SVG export root is invalid");
  return `${serialized.slice(0, rootEnd + 1)}<style>${xmlText(STANDALONE_PLOT_STYLE)}</style>${serialized.slice(rootEnd + 1)}`;
}

function artifactDownloadFilename(artifact, fallback, extension) {
  const stem = artifact.title.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || fallback;
  return `${stem}-${artifact.id.slice(4, 12)}.${extension}`;
}

function dataDownloadHref(mediaType, content) {
  return `data:${mediaType};charset=utf-8,${encodeURIComponent(content)}`;
}

function appendArtifactDownload(document, target, { label, filename, mediaType, content }) {
  const controls = createNode(document, "div", "artifact-export-controls artifact-file-controls");
  const download = createNode(document, "a", "artifact-export-action artifact-file-action");
  download.setAttribute("href", dataDownloadHref(mediaType, content));
  download.setAttribute("download", filename);
  download.setAttribute("rel", "noopener");
  download.setAttribute("aria-label", `${label}: ${filename}`);
  appendText(document, download, label);
  controls.appendChild(download);
  target.appendChild(controls);
}

function csvCell(value) {
  let text = value === null ? "" : String(value);
  if (typeof value === "string" && /^[\t ]*[=+@-]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/gu, '""')}"`;
}

function tableCsv(spec) {
  const rows = [
    spec.columns.map(({ label }) => csvCell(label)),
    ...spec.rows.map((row) => spec.columns.map(({ key }) => csvCell(row[key]))),
  ];
  return `\ufeff${rows.map((row) => row.join(",")).join("\r\n")}\r\n`;
}

function escapedAt(value, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function closingDelimiter(value, delimiter, start) {
  let index = start;
  while ((index = value.indexOf(delimiter, index)) !== -1) {
    if (!escapedAt(value, index)) return index;
    index += delimiter.length;
  }
  return -1;
}

function safeHref(value, locationHref) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  if (value.startsWith("#") && /^#[A-Za-z0-9_.:-]{1,200}$/u.test(value)) return value;
  let parsed;
  try {
    parsed = new URL(value, locationHref);
  } catch {
    return null;
  }
  if (!["https:", "http:", "mailto:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  return parsed.href;
}

function mathNode({ document, katex }, source, displayMode, budget) {
  const container = createNode(document, displayMode ? "div" : "span", displayMode ? "math-display" : "math-inline");
  const bounded = source.slice(0, MAX_TEX_EXPRESSION);
  if (source.length > MAX_TEX_EXPRESSION || budget.expressions >= MAX_MATH_EXPRESSIONS
      || budget.characters + bounded.length > MAX_TEX_TOTAL || !katex || typeof katex.render !== "function") {
    const fallback = createNode(document, "code", "math-fallback");
    fallback.textContent = `${displayMode ? "$$" : "$"}${source}${displayMode ? "$$" : "$"}`;
    container.appendChild(fallback);
    return container;
  }
  budget.expressions += 1;
  budget.characters += bounded.length;
  try {
    katex.render(bounded, container, {
      displayMode,
      output: "mathml",
      trust: false,
      throwOnError: false,
      strict: "error",
      maxExpand: 500,
      maxSize: 10,
      macros: {},
    });
  } catch {
    const fallback = createNode(document, "code", "math-fallback");
    fallback.textContent = `${displayMode ? "$$" : "$"}${bounded}${displayMode ? "$$" : "$"}`;
    container.replaceChildren(fallback);
  }
  return container;
}

function appendInline(runtime, parent, source, budget, depth = 0) {
  const { document, locationHref } = runtime;
  if (depth > MAX_INLINE_DEPTH) {
    appendText(document, parent, source);
    return;
  }
  let cursor = 0;
  while (cursor < source.length) {
    const remaining = source.slice(cursor);
    if (remaining.startsWith("\\(") && !escapedAt(source, cursor)) {
      const end = closingDelimiter(source, "\\)", cursor + 2);
      if (end > cursor + 2) {
        parent.appendChild(mathNode(runtime, source.slice(cursor + 2, end), false, budget));
        cursor = end + 2;
        continue;
      }
    }
    if (source[cursor] === "$" && source[cursor + 1] !== "$" && !escapedAt(source, cursor)) {
      const end = closingDelimiter(source, "$", cursor + 1);
      if (end > cursor + 1 && !/\s/u.test(source[cursor + 1]) && !/\s/u.test(source[end - 1])) {
        parent.appendChild(mathNode(runtime, source.slice(cursor + 1, end), false, budget));
        cursor = end + 1;
        continue;
      }
    }
    if (source[cursor] === "`") {
      let length = 1;
      while (source[cursor + length] === "`") length += 1;
      const delimiter = "`".repeat(length);
      const end = source.indexOf(delimiter, cursor + length);
      if (end !== -1) {
        const code = createNode(document, "code", "inline-code");
        code.textContent = source.slice(cursor + length, end);
        parent.appendChild(code);
        cursor = end + length;
        continue;
      }
    }
    const link = /^\[([^\]\n]{1,500})\]\(([^\s()]{1,2048})\)/u.exec(remaining);
    if (link) {
      const href = safeHref(link[2], locationHref);
      if (href === null) appendText(document, parent, link[0]);
      else {
        const anchor = createNode(document, "a");
        anchor.href = href;
        anchor.rel = "noopener noreferrer";
        if (/^https?:/u.test(href)) anchor.target = "_blank";
        appendInline(runtime, anchor, link[1], budget, depth + 1);
        parent.appendChild(anchor);
      }
      cursor += link[0].length;
      continue;
    }
    const autoLink = /^<(https?:\/\/[^<>\s]{1,2048}|mailto:[^<>\s]{1,2048})>/iu.exec(remaining);
    if (autoLink) {
      const href = safeHref(autoLink[1], locationHref);
      if (href === null) appendText(document, parent, autoLink[0]);
      else {
        const anchor = createNode(document, "a");
        anchor.href = href;
        anchor.rel = "noopener noreferrer";
        if (/^https?:/u.test(href)) anchor.target = "_blank";
        anchor.textContent = autoLink[1];
        parent.appendChild(anchor);
      }
      cursor += autoLink[0].length;
      continue;
    }
    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/u.exec(remaining);
    if (strong) {
      const node = createNode(document, "strong");
      appendInline(runtime, node, strong[2], budget, depth + 1);
      parent.appendChild(node);
      cursor += strong[0].length;
      continue;
    }
    const strike = /^~~(?=\S)([\s\S]*?\S)~~/u.exec(remaining);
    if (strike) {
      const node = createNode(document, "del");
      appendInline(runtime, node, strike[1], budget, depth + 1);
      parent.appendChild(node);
      cursor += strike[0].length;
      continue;
    }
    const emphasis = /^(\*|_)(?=\S)([^\n]*?\S)\1/u.exec(remaining);
    if (emphasis) {
      const node = createNode(document, "em");
      appendInline(runtime, node, emphasis[2], budget, depth + 1);
      parent.appendChild(node);
      cursor += emphasis[0].length;
      continue;
    }
    if (source[cursor] === "\\" && /[\\`*_[\]{}()#+.!$~-]/u.test(source[cursor + 1] ?? "")) {
      appendText(document, parent, source[cursor + 1]);
      cursor += 2;
      continue;
    }
    if (source[cursor] === "\n") {
      parent.appendChild(source.slice(Math.max(0, cursor - 2), cursor) === "  " ? createNode(document, "br") : document.createTextNode(" "));
      cursor += 1;
      continue;
    }
    let next = cursor + 1;
    while (next < source.length && !/[\\`*$\[<_~\n]/u.test(source[next])) next += 1;
    appendText(document, parent, source.slice(cursor, next));
    cursor = next;
  }
}

function splitTableRow(line) {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !escapedAt(value, value.length - 1)) value = value.slice(0, -1);
  const cells = [];
  let cell = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "|" && !escapedAt(value, index)) {
      cells.push(cell.trim());
      cell = "";
    } else cell += value[index];
  }
  cells.push(cell.trim());
  return cells.slice(0, 20);
}

function tableSeparator(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function blockStart(lines, index) {
  const line = lines[index] ?? "";
  if (!line.trim()) return true;
  if (/^ {0,3}(?:#{1,6})\s+|^ {0,3}(?:[-+*]|\d+[.)])\s+|^ {0,3}>|^ {0,3}(?:`{3,}|~{3,})/u.test(line)) return true;
  if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line) || line.trim().startsWith("$$") || line.trim().startsWith("\\[")) return true;
  return index + 1 < lines.length && line.includes("|") && tableSeparator(lines[index + 1]);
}

function renderBlocks(runtime, target, lines, budget, depth = 0) {
  const { document } = runtime;
  if (depth > MAX_BLOCK_DEPTH) {
    const fallback = createNode(document, "pre", "markdown-fallback");
    fallback.textContent = lines.join("\n");
    target.appendChild(fallback);
    return;
  }
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/u.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const body = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^ {0,3}${marker === "`" ? "`" : "~"}{${fence[1].length},}\\s*$`, "u").test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = createNode(document, "pre", "code-block");
      const code = createNode(document, "code");
      const language = fence[2].trim().split(/\s+/u, 1)[0].toLowerCase();
      if (/^[a-z0-9_+-]{1,32}$/u.test(language)) code.className = `language-${language}`;
      code.textContent = body.join("\n");
      pre.appendChild(code);
      target.appendChild(pre);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("$$") || trimmed.startsWith("\\[")) {
      const open = trimmed.startsWith("$$") ? "$$" : "\\[";
      const close = open === "$$" ? "$$" : "\\]";
      let expression = trimmed.slice(open.length);
      let closed = expression.endsWith(close) && expression.length > close.length;
      if (closed) expression = expression.slice(0, -close.length);
      index += 1;
      while (!closed && index < lines.length) {
        const candidate = lines[index];
        if (candidate.trim().endsWith(close)) {
          expression += `${expression ? "\n" : ""}${candidate.slice(0, candidate.lastIndexOf(close))}`;
          closed = true;
          index += 1;
        } else {
          expression += `${expression ? "\n" : ""}${candidate}`;
          index += 1;
        }
      }
      if (closed && expression.trim()) target.appendChild(mathNode(runtime, expression.trim(), true, budget));
      else {
        const fallback = createNode(document, "pre", "math-fallback");
        fallback.textContent = `${open}${expression}`;
        target.appendChild(fallback);
      }
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*$/u.exec(line);
    if (heading) {
      const node = createNode(document, `h${heading[1].length}`);
      appendInline(runtime, node, heading[2], budget);
      target.appendChild(node);
      index += 1;
      continue;
    }
    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
      target.appendChild(createNode(document, "hr"));
      index += 1;
      continue;
    }
    if (/^ {0,3}>/u.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^ {0,3}>/u.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^ {0,3}> ?/u, ""));
        index += 1;
      }
      const quote = createNode(document, "blockquote");
      renderBlocks(runtime, quote, quoteLines, budget, depth + 1);
      target.appendChild(quote);
      continue;
    }
    const listStart = /^ {0,3}([-+*]|\d+[.)])\s+(.+)$/u.exec(line);
    if (listStart) {
      const ordered = /^\d/u.test(listStart[1]);
      const list = createNode(document, ordered ? "ol" : "ul");
      let rows = 0;
      while (index < lines.length && rows < 500) {
        const item = /^ {0,3}([-+*]|\d+[.)])\s+(.+)$/u.exec(lines[index]);
        if (!item || /^\d/u.test(item[1]) !== ordered) break;
        const entry = createNode(document, "li");
        appendInline(runtime, entry, item[2], budget);
        list.appendChild(entry);
        index += 1;
        rows += 1;
      }
      target.appendChild(list);
      continue;
    }
    if (index + 1 < lines.length && line.includes("|") && tableSeparator(lines[index + 1])) {
      const headings = splitTableRow(line);
      const alignments = splitTableRow(lines[index + 1]);
      const wrapper = createNode(document, "div", "table-scroll");
      const table = createNode(document, "table");
      const head = createNode(document, "thead");
      const headingRow = createNode(document, "tr");
      headings.forEach((heading, column) => {
        const cell = createNode(document, "th");
        cell.scope = "col";
        cell.dataset.align = alignments[column]?.startsWith(":") && alignments[column]?.endsWith(":")
          ? "center" : (alignments[column]?.endsWith(":") ? "right" : "left");
        appendInline(runtime, cell, heading, budget);
        headingRow.appendChild(cell);
      });
      head.appendChild(headingRow);
      table.appendChild(head);
      const body = createNode(document, "tbody");
      index += 2;
      let rows = 0;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim() && rows < 200) {
        const row = createNode(document, "tr");
        const cells = splitTableRow(lines[index]);
        headings.forEach((unused, column) => {
          const cell = createNode(document, "td");
          cell.dataset.align = alignments[column]?.startsWith(":") && alignments[column]?.endsWith(":")
            ? "center" : (alignments[column]?.endsWith(":") ? "right" : "left");
          appendInline(runtime, cell, cells[column] ?? "", budget);
          row.appendChild(cell);
        });
        body.appendChild(row);
        index += 1;
        rows += 1;
      }
      table.appendChild(body);
      wrapper.appendChild(table);
      target.appendChild(wrapper);
      continue;
    }
    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && !blockStart(lines, index)) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    const paragraph = createNode(document, "p");
    appendInline(runtime, paragraph, paragraphLines.join("\n"), budget);
    target.appendChild(paragraph);
  }
}

function normalizedPlot(spec) {
  const categorical = spec.type !== "scatter";
  return {
    ...spec,
    series: spec.series.map((series, index) => ({
      name: series.name,
      color: PLOT_COLORS[index % PLOT_COLORS.length],
      points: categorical
        ? series.data.map((y, point) => ({ x: point, y, label: spec.labels[point] }))
        : series.points.map(({ x, y }) => ({ x, y, label: String(x) })),
    })),
  };
}

function plotBounds(plot) {
  const points = plot.series.flatMap((series) => series.points);
  let minX = Math.min(...points.map((point) => point.x));
  let maxX = Math.max(...points.map((point) => point.x));
  let minY = Math.min(0, ...points.map((point) => point.y));
  let maxY = Math.max(0, ...points.map((point) => point.y));
  if (minX === maxX) { minX -= 1; maxX += 1; }
  if (minY === maxY) { minY -= 1; maxY += 1; }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  if (![minX, maxX, minY, maxY, spanX, spanY].every(Number.isFinite)
      || spanX <= 0 || spanY <= 0) {
    throw new TypeError("plot bounds are not safely renderable");
  }
  return { minX, maxX, minY, maxY };
}

function formatPlotTick(value, precision = 2) {
  if (Object.is(value, -0) || value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000 || magnitude < 0.001) {
    const [coefficient, exponent] = value.toExponential(Math.max(0, precision - 1)).split("e");
    const compactCoefficient = coefficient.includes(".")
      ? coefficient.replace(/0+$/u, "").replace(/\.$/u, "")
      : coefficient;
    return `${compactCoefficient}e${Number(exponent)}`;
  }
  return Number(value.toPrecision(precision)).toString();
}

function labelsDistinguishValues(values, labels) {
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      if (values[left] !== values[right] && labels[left] === labels[right]) return false;
    }
  }
  return true;
}

function formatPlotTicks(values, { allowOffset = false, preferCompact = false } = {}) {
  for (let precision = preferCompact ? 2 : 3; precision <= 3; precision += 1) {
    const readableLabels = values.map((value) => formatPlotTick(value, precision));
    if (labelsDistinguishValues(values, readableLabels)) return { labels: readableLabels, offset: null };
  }
  if (allowOffset) {
    const offset = values[0];
    const relative = values.map((value) => value - offset);
    for (let precision = 2; precision <= 6; precision += 1) {
      const labels = relative.map((value) => {
        const label = formatPlotTick(value, precision);
        return value > 0 ? `+${label}` : label;
      });
      if (labelsDistinguishValues(relative, labels)) {
        return { labels, offset };
      }
    }
  }
  for (let precision = 4; precision <= 15; precision += 1) {
    const labels = values.map((value) => formatPlotTick(value, precision));
    if (labelsDistinguishValues(values, labels)) return { labels, offset: null };
  }
  return { labels: values.map(String), offset: null };
}

function formatPlotOffset(value) {
  return value.toString().replace("e+", "e");
}

function compactPlotLabel(value, maximum) {
  const characters = [...value];
  return characters.length > maximum
    ? `${characters.slice(0, maximum - 1).join("")}…`
    : value;
}

function categoricalTickIndices(count, maximum) {
  if (count <= maximum) return Array.from({ length: count }, (unused, index) => index);
  const step = Math.max(2, Math.ceil((count - 1) / (maximum - 1)));
  const indices = [];
  for (let index = 0; index < count; index += step) indices.push(index);
  if (indices.at(-1) !== count - 1) {
    if (count - 1 - indices.at(-1) < 2) indices[indices.length - 1] = count - 1;
    else indices.push(count - 1);
  }
  return indices;
}

function renderPlot(document, target, artifact) {
  const plot = normalizedPlot(artifact.spec);
  const bounds = plotBounds(plot);
  const dimensions = { width: 720, height: 390, left: 116, right: 32, top: 40, bottom: 58 };
  const innerWidth = dimensions.width - dimensions.left - dimensions.right;
  const innerHeight = dimensions.height - dimensions.top - dimensions.bottom;
  const xAt = (value) => dimensions.left + (value - bounds.minX) / (bounds.maxX - bounds.minX) * innerWidth;
  const yAt = (value) => dimensions.top + (bounds.maxY - value) / (bounds.maxY - bounds.minY) * innerHeight;
  const yTickValues = Array.from({ length: 5 }, (unused, tick) => (
    bounds.maxY - (bounds.maxY - bounds.minY) * tick / 4
  ));
  const yTickLabels = formatPlotTicks(yTickValues).labels;
  const categoricalIndices = plot.labels ? categoricalTickIndices(plot.labels.length, 4) : null;
  const xTickValues = plot.labels ? null : Array.from({ length: 5 }, (unused, index) => (
    bounds.minX + (bounds.maxX - bounds.minX) * index / 4
  ));
  const xTickPlan = xTickValues === null ? null : formatPlotTicks(xTickValues, {
    allowOffset: true,
    preferCompact: true,
  });
  const descriptionId = `plot-description-${artifact.id.slice(4)}`;
  const svg = createSvg(document, "svg", {
    xmlns: SVG_NS,
    viewBox: `0 0 ${dimensions.width} ${dimensions.height}`,
    width: dimensions.width,
    height: dimensions.height,
    role: "img",
    "aria-label": artifact.title,
    "aria-describedby": descriptionId,
    preserveAspectRatio: "xMidYMid meet",
  });
  svg.classList.add("artifact-plot");
  const title = createSvg(document, "title");
  title.textContent = artifact.title;
  svg.appendChild(title);
  const description = createSvg(document, "desc", { id: descriptionId });
  description.textContent = [
    plot.xLabel ? `X axis: ${plot.xLabel}` : "",
    plot.yLabel ? `Y axis: ${plot.yLabel}` : "",
    categoricalIndices === null
      ? `X-axis absolute ticks: ${xTickValues.map(String).join(", ")}${xTickPlan.offset === null
        ? ""
        : `; visual labels use offset ${xTickPlan.offset > 0 ? "+" : ""}${formatPlotOffset(xTickPlan.offset)}`}`
      : `Displayed category ticks: ${categoricalIndices.map((index) => plot.labels[index]).join("; ")}`,
    `Y-axis ticks: ${yTickValues.map(String).join(", ")}`,
    `Series: ${plot.series.map((series) => series.name).join("; ")}`,
  ].filter(Boolean).join(". ");
  svg.appendChild(description);
  for (let tick = 0; tick <= 4; tick += 1) {
    const y = dimensions.top + innerHeight * tick / 4;
    svg.appendChild(createSvg(document, "line", { class: "plot-grid", x1: dimensions.left, y1: y, x2: dimensions.width - dimensions.right, y2: y }));
    const text = createSvg(document, "text", {
      class: "plot-tick plot-y-tick",
      x: dimensions.left - 10,
      y: y + 4,
      "text-anchor": "end",
      "aria-label": yTickValues[tick].toString(),
    });
    text.textContent = yTickLabels[tick];
    svg.appendChild(text);
  }
  const zeroY = yAt(0);
  plot.series.forEach((series, seriesIndex) => {
    const group = createSvg(document, "g", { class: "plot-series", "data-series": seriesIndex });
    if (plot.type === "bar") {
      const groupWidth = innerWidth / series.points.length;
      const barWidth = Math.max(2, Math.min(36, groupWidth * 0.72 / plot.series.length));
      series.points.forEach((point) => {
        const center = dimensions.left + (point.x + 0.5) / series.points.length * innerWidth;
        const x = center - (barWidth * plot.series.length / 2) + seriesIndex * barWidth;
        const y = yAt(Math.max(0, point.y));
        const bottom = yAt(Math.min(0, point.y));
        group.appendChild(createSvg(document, "rect", { x, y, width: Math.max(1, barWidth - 1), height: Math.max(1, bottom - y), rx: 2, fill: series.color }));
      });
    } else {
      const commands = series.points.map((point, index) => `${index ? "L" : "M"}${xAt(point.x).toFixed(2)} ${yAt(point.y).toFixed(2)}`).join(" ");
      if (plot.type === "area") {
        group.appendChild(createSvg(document, "path", {
          d: `${commands} L${xAt(series.points.at(-1).x).toFixed(2)} ${zeroY.toFixed(2)} L${xAt(series.points[0].x).toFixed(2)} ${zeroY.toFixed(2)} Z`,
          fill: series.color,
          opacity: 0.18,
        }));
      }
      if (plot.type !== "scatter") group.appendChild(createSvg(document, "path", { d: commands, fill: "none", stroke: series.color, "stroke-width": 2.5 }));
      series.points.forEach((point) => group.appendChild(createSvg(document, "circle", {
        cx: xAt(point.x), cy: yAt(point.y), r: plot.type === "scatter" ? 4.5 : 3, fill: series.color,
      })));
    }
    svg.appendChild(group);
  });
  svg.appendChild(createSvg(document, "line", { class: "plot-axis", x1: dimensions.left, y1: zeroY, x2: dimensions.width - dimensions.right, y2: zeroY }));
  svg.appendChild(createSvg(document, "line", { class: "plot-axis", x1: dimensions.left, y1: dimensions.top, x2: dimensions.left, y2: dimensions.height - dimensions.bottom }));
  if (plot.labels) {
    categoricalIndices.forEach((index, position) => {
      const value = plot.labels[index];
      const tick = createSvg(document, "text", {
        class: "plot-tick plot-x-tick",
        "aria-label": value,
        "data-label-index": index,
        x: plot.type === "bar"
          ? dimensions.left + (index + 0.5) / plot.labels.length * innerWidth
          : xAt(index),
        y: dimensions.height - dimensions.bottom + 19,
        "text-anchor": categoricalIndices.length === 1
          ? "middle"
          : (position === 0 ? "start" : (position === categoricalIndices.length - 1 ? "end" : "middle")),
      });
      const wide = createSvg(document, "tspan", { class: "plot-label-wide" });
      wide.textContent = compactPlotLabel(value, 7);
      tick.appendChild(wide);
      const compact = createSvg(document, "tspan", { class: "plot-label-compact" });
      compact.textContent = compactPlotLabel(value, 5);
      tick.appendChild(compact);
      svg.appendChild(tick);
    });
  } else {
    for (let index = 0; index <= 4; index += 1) {
      const tick = createSvg(document, "text", {
        class: "plot-tick plot-x-tick",
        x: dimensions.left + innerWidth * index / 4,
        y: dimensions.height - dimensions.bottom + 19,
        "text-anchor": index === 0 ? "start" : (index === 4 ? "end" : "middle"),
        "aria-label": xTickValues[index].toString(),
      });
      tick.textContent = xTickPlan.labels[index];
      svg.appendChild(tick);
    }
    if (xTickPlan.offset !== null) {
      const offset = createSvg(document, "text", {
        class: "plot-tick plot-axis-offset plot-x-offset",
        x: dimensions.width - dimensions.right,
        y: 26,
        "text-anchor": "end",
      });
      offset.textContent = `offset ${xTickPlan.offset > 0 ? "+" : ""}${formatPlotOffset(xTickPlan.offset)}`;
      svg.appendChild(offset);
    }
  }
  if (plot.xLabel) {
    const text = createSvg(document, "text", {
      class: "plot-tick plot-axis-label plot-x-label",
      x: dimensions.left + innerWidth / 2,
      y: dimensions.height - 14,
      "text-anchor": "middle",
    });
    text.textContent = plot.xLabel;
    svg.appendChild(text);
  }
  if (plot.yLabel) {
    const middle = dimensions.top + innerHeight / 2;
    const text = createSvg(document, "text", {
      class: "plot-tick plot-axis-label plot-y-label",
      x: 18,
      y: middle,
      transform: `rotate(-90 18 ${middle})`,
      "text-anchor": "middle",
      "dominant-baseline": "middle",
    });
    text.textContent = plot.yLabel;
    svg.appendChild(text);
  }
  target.appendChild(svg);
  const legend = createNode(document, "ul", "artifact-legend");
  plot.series.forEach((series, seriesIndex) => {
    const item = createNode(document, "li");
    const swatch = createNode(document, "span", `artifact-swatch artifact-swatch-${seriesIndex % PLOT_COLORS.length}`);
    item.appendChild(swatch);
    appendText(document, item, series.name);
    legend.appendChild(item);
  });
  target.appendChild(legend);
  appendArtifactDownload(document, target, {
    label: "Download SVG",
    filename: artifactDownloadFilename(artifact, "agent-plot", "svg"),
    mediaType: "image/svg+xml",
    content: `<?xml version="1.0" encoding="UTF-8"?>\n${serializeStandalonePlot(svg)}\n`,
  });
}

function renderTable(document, target, artifact) {
  const wrapper = createNode(document, "div", "artifact-table-scroll");
  const table = createNode(document, "table", "artifact-table");
  const head = createNode(document, "thead");
  const heading = createNode(document, "tr");
  artifact.spec.columns.forEach((column) => {
    const cell = createNode(document, "th");
    cell.scope = "col";
    cell.textContent = column.label;
    heading.appendChild(cell);
  });
  head.appendChild(heading);
  table.appendChild(head);
  const body = createNode(document, "tbody");
  artifact.spec.rows.forEach((row) => {
    const tableRow = createNode(document, "tr");
    artifact.spec.columns.forEach(({ key }) => {
      const cell = createNode(document, "td");
      cell.textContent = row[key] === null ? "" : String(row[key]);
      tableRow.appendChild(cell);
    });
    body.appendChild(tableRow);
  });
  table.appendChild(body);
  wrapper.appendChild(table);
  target.appendChild(wrapper);
  appendArtifactDownload(document, target, {
    label: "Download CSV",
    filename: artifactDownloadFilename(artifact, "agent-table", "csv"),
    mediaType: "text/csv",
    content: tableCsv(artifact.spec),
  });
}

function renderSources(document, target, artifact) {
  const list = createNode(document, "ol", "artifact-sources");
  artifact.spec.sources.forEach((source) => {
    const item = createNode(document, "li", "artifact-source-card");
    const heading = createNode(document, "h4", "artifact-source-title");
    const anchor = createNode(document, "a");
    anchor.setAttribute("href", source.url);
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
    appendText(document, anchor, source.title);
    heading.appendChild(anchor);
    item.appendChild(heading);
    if (source.snippet) {
      const snippet = createNode(document, "p", "artifact-source-snippet");
      appendText(document, snippet, source.snippet);
      item.appendChild(snippet);
    }
    const metadata = createNode(document, "p", "artifact-source-metadata");
    const values = [
      source.kind === "paper" ? "Paper" : "Web",
      source.providers.join(", "),
      source.publishedDate,
      source.doi === null ? null : `DOI ${source.doi}`,
    ].filter((value) => value !== null);
    appendText(document, metadata, values.join(" · "));
    item.appendChild(metadata);
    list.appendChild(item);
  });
  target.appendChild(list);
}

function formatFileBytes(value) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(value < 10 * 1_024 ? 1 : 0)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(value < 10 * 1_024 * 1_024 ? 1 : 0)} MB`;
}

function renderFile(runtime, target, artifact) {
  const { document, locationHref, releaseId } = runtime;
  if (releaseId === null) throw new TypeError('file artifact URL requires an immutable web release');
  const base = new URL(locationHref);
  const openHref = new URL(`/api/agent/artifacts/${artifact.id}/content`, base);
  openHref.search = `?v=${encodeURIComponent(releaseId)}`;
  const downloadHref = new URL(openHref.href);
  downloadHref.search = `?v=${encodeURIComponent(releaseId)}&download=1`;
  if (!['http:', 'https:'].includes(base.protocol) || openHref.origin !== base.origin
      || downloadHref.origin !== base.origin || openHref.username || openHref.password
      || downloadHref.username || downloadHref.password || openHref.search !== `?v=${releaseId}`
      || downloadHref.search !== `?v=${releaseId}&download=1` || openHref.hash || downloadHref.hash) {
    throw new TypeError('file artifact URL is not same-origin');
  }
  const metadata = createNode(document, 'p', 'artifact-file-metadata');
  appendText(document, metadata, `${artifact.spec.filename} · ${formatFileBytes(artifact.spec.bytes)}`);
  target.appendChild(metadata);
  const controls = createNode(document, 'div', 'artifact-file-controls');
  const open = createNode(document, 'a', 'artifact-file-action artifact-file-open');
  open.setAttribute('href', openHref.href);
  // Keep protected artifacts in the current PWA browsing context. On iOS a
  // new top-level window can leave the installed app's authenticated cookie
  // store and turn a valid local artifact into a misleading sign-in failure.
  open.setAttribute('aria-label', `Open ${artifact.spec.filename}`);
  appendText(document, open, 'Open');
  controls.appendChild(open);
  const download = createNode(document, 'a', 'artifact-file-action artifact-file-download');
  download.setAttribute('href', downloadHref.href);
  download.setAttribute('download', artifact.spec.filename);
  download.setAttribute('rel', 'noopener');
  download.setAttribute('aria-label', `Download ${artifact.spec.filename}`);
  appendText(document, download, 'Download');
  controls.appendChild(download);
  target.appendChild(controls);
  const privacy = createNode(document, 'p', 'artifact-file-privacy');
  appendText(document, privacy, 'Served from your local Agent session. Not stored or cached by the web edge.');
  target.appendChild(privacy);
}

export function createSafeRenderer({
  document = globalThis.document,
  katex,
  locationHref = globalThis.location?.href ?? "https://invalid.local/",
  releaseId,
} = {}) {
  const declaredRelease = releaseId === undefined
    ? document?.querySelector?.('meta[name="lazying-agent-release"]')?.getAttribute?.('content')
    : releaseId;
  const runtime = Object.freeze({
    document: browserDocument(document),
    katex,
    locationHref: String(locationHref),
    releaseId: optionalWebRelease(declaredRelease),
  });
  const renderMarkdown = (target, source) => {
    targetNode(target);
    const normalized = typeof source === "string"
      ? source.slice(0, MAX_MARKDOWN).replace(/\r\n?|\u2028|\u2029/gu, "\n")
      : "";
    const fragment = document.createDocumentFragment();
    try {
      renderBlocks(runtime, fragment, normalized.split("\n"), { expressions: 0, characters: 0 });
    } catch {
      const fallback = createNode(document, "pre", "markdown-fallback");
      fallback.textContent = normalized;
      fragment.replaceChildren(fallback);
    }
    target.replaceChildren(fragment);
  };
  return Object.freeze({
    renderMarkdown,
    renderArtifact(target, value) {
      targetNode(target);
      target.replaceChildren();
      let artifact;
      try {
        artifact = validateArtifact(value);
      } catch {
        target.dataset.status = "rejected";
        const rejected = createNode(document, "p", "artifact-rejected");
        rejected.textContent = "This artifact could not be displayed safely.";
        target.appendChild(rejected);
        return false;
      }
      target.dataset.status = "ready";
      target.dataset.artifactKind = artifact.kind;
      try {
        if (artifact.kind === "plot") renderPlot(document, target, artifact);
        else if (artifact.kind === "table") renderTable(document, target, artifact);
        else if (artifact.kind === "markdown") {
          const markdown = createNode(document, "div", "artifact-markdown");
          renderMarkdown(markdown, artifact.spec.markdown);
          target.appendChild(markdown);
        } else if (artifact.kind === "sources") renderSources(document, target, artifact);
        else renderFile(runtime, target, artifact);
      } catch {
        target.replaceChildren();
        target.dataset.status = "rejected";
        delete target.dataset.artifactKind;
        const rejected = createNode(document, "p", "artifact-rejected");
        rejected.textContent = "This artifact could not be displayed safely.";
        target.appendChild(rejected);
        return false;
      }
      return true;
    },
  });
}
