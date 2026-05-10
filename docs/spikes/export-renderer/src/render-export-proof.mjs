import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";
import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const spikeRoot = path.resolve(__dirname, "..");
const fixturePath = path.join(spikeRoot, "fixtures", "representative-render-snapshot.json");
const artifactDir = path.join(spikeRoot, "artifacts");

const palette = {
  background: "#f7f9fc",
  edge: "#8aa0b8",
  rootFill: "#153a5b",
  rootStroke: "#0d263d",
  rootText: "#ffffff",
  nodeFill: "#ffffff",
  nodeStroke: "#c8d3df",
  text: "#1d2b3a",
  muted: "#5d6c7c",
  link: "#075da8",
  collapsedFill: "#e9f4ff",
  collapsedStroke: "#9dc6eb",
};

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function tokenizeText(text) {
  const tokens = [];
  const linkPattern = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(([^)]+)\)/g;
  let cursor = 0;

  function pushWords(segment, link = false, title = undefined) {
    for (const part of segment.split(/(\s+)/)) {
      if (!part) continue;
      tokens.push({
        text: /\s+/.test(part) ? " " : part,
        link,
        title,
      });
    }
  }

  for (const match of text.matchAll(linkPattern)) {
    if (match.index > cursor) {
      pushWords(text.slice(cursor, match.index));
    }

    const wikilinkTarget = match[1];
    const wikilinkAlias = match[2];
    const markdownText = match[3];
    const markdownTarget = match[4];
    pushWords(
      wikilinkAlias || wikilinkTarget || markdownText,
      true,
      wikilinkTarget || markdownTarget,
    );
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    pushWords(text.slice(cursor));
  }

  return tokens;
}

function measureToken(token, fontSize) {
  if (token.text === " ") return fontSize * 0.35;
  return token.text.length * fontSize * (token.link ? 0.59 : 0.55);
}

function splitLongToken(token, maxWidth, fontSize) {
  if (measureToken(token, fontSize) <= maxWidth || token.text === " ") {
    return [token];
  }

  const maxChars = Math.max(6, Math.floor(maxWidth / (fontSize * 0.59)));
  const chunks = [];
  for (let index = 0; index < token.text.length; index += maxChars) {
    chunks.push({
      ...token,
      text: token.text.slice(index, index + maxChars),
    });
  }

  return chunks;
}

function wrapText(text, maxWidth, fontSize) {
  const tokens = tokenizeText(text).flatMap((token) => splitLongToken(token, maxWidth, fontSize));
  const lines = [];
  let current = [];
  let currentWidth = 0;

  function pushLine() {
    while (current.length > 0 && current[current.length - 1].text === " ") {
      current.pop();
    }

    if (current.length > 0) lines.push(current);
    current = [];
    currentWidth = 0;
  }

  for (const token of tokens) {
    const tokenWidth = measureToken(token, fontSize);
    if (token.text === " " && current.length === 0) continue;

    if (current.length > 0 && currentWidth + tokenWidth > maxWidth) {
      pushLine();
      if (token.text === " ") continue;
    }

    current.push(token);
    currentWidth += tokenWidth;
  }

  pushLine();
  return lines.length > 0 ? lines : [[{ text: "", link: false }]];
}

function countDescendants(snapshot, nodeId) {
  const node = snapshot.nodes[nodeId];
  if (!node) return 0;

  return node.childIds.reduce(
    (count, childId) => count + 1 + countDescendants(snapshot, childId),
    0,
  );
}

function prepareLayout(snapshot) {
  const options = snapshot.renderOptions;
  const rootId = snapshot.rootNodeId;
  const layoutNodes = [];
  const edges = [];

  function annotate(nodeId, depth = 0) {
    const node = snapshot.nodes[nodeId];
    if (!node) throw new Error(`Missing node in render snapshot: ${nodeId}`);

    const width = depth === 0 ? options.rootNodeWidth : options.nodeWidth;
    const textWidth = width - 28;
    const lines = wrapText(node.text, textWidth, options.fontSize);
    const hiddenDescendantCount = node.collapsed ? countDescendants(snapshot, node.id) : 0;
    const collapsedMarkerHeight = hiddenDescendantCount > 0 ? 22 : 0;
    const height = Math.max(62, lines.length * options.lineHeight + 28 + collapsedMarkerHeight);
    const visibleChildIds = node.collapsed ? [] : node.childIds;
    const children = visibleChildIds.map((childId) => annotate(childId, depth + 1));
    const childHeight = children.reduce((sum, child) => sum + child.subtreeHeight, 0);
    const childGaps = Math.max(0, children.length - 1) * options.verticalGap;
    const subtreeHeight = Math.max(height, childHeight + childGaps);

    return {
      node,
      depth,
      width,
      height,
      lines,
      children,
      subtreeHeight,
      hiddenDescendantCount,
    };
  }

  function place(tree, top) {
    const x = options.margin + tree.depth * (options.nodeWidth + options.horizontalGap);
    const y = top + (tree.subtreeHeight - tree.height) / 2;
    const item = { ...tree, x, y };
    layoutNodes.push(item);

    const childHeight = tree.children.reduce((sum, child) => sum + child.subtreeHeight, 0);
    const childGaps = Math.max(0, tree.children.length - 1) * options.verticalGap;
    let childTop = top + (tree.subtreeHeight - childHeight - childGaps) / 2;

    for (const child of tree.children) {
      const childItem = place(child, childTop);
      edges.push({ from: item, to: childItem });
      childTop += child.subtreeHeight + options.verticalGap;
    }

    return item;
  }

  const tree = annotate(rootId);
  place(tree, options.margin);

  const width = Math.ceil(Math.max(...layoutNodes.map((item) => item.x + item.width)) + options.margin);
  const height = Math.ceil(tree.subtreeHeight + options.margin * 2);

  return { width, height, nodes: layoutNodes, edges };
}

function renderLine(fragments, x, baseline, options, color) {
  const spans = fragments
    .map((fragment) => {
      const fill = fragment.link ? ` fill="${palette.link}"` : "";
      const decoration = fragment.link ? ' text-decoration="underline"' : "";
      const target = fragment.title ? ` data-link-target="${escapeXml(fragment.title)}"` : "";
      return `<tspan${fill}${decoration}${target}>${escapeXml(fragment.text)}</tspan>`;
    })
    .join("");

  return `<text x="${x.toFixed(1)}" y="${baseline.toFixed(1)}" font-family="${options.fontFamily}" font-size="${options.fontSize}" fill="${color}" xml:space="preserve">${spans}</text>`;
}

function renderNode(item, options) {
  const { node, x, y, width, height } = item;
  const isRoot = node.parentId === null;
  const fill = isRoot ? palette.rootFill : palette.nodeFill;
  const stroke = isRoot ? palette.rootStroke : palette.nodeStroke;
  const textFill = isRoot ? palette.rootText : palette.text;
  const lineStartY = y + 24;
  const text = item.lines
    .map((line, index) => renderLine(line, x + 14, lineStartY + index * options.lineHeight, options, textFill))
    .join("");

  const marker = item.hiddenDescendantCount
    ? `<g>
        <rect x="${(x + 14).toFixed(1)}" y="${(y + height - 26).toFixed(1)}" width="78" height="18" rx="9" fill="${palette.collapsedFill}" stroke="${palette.collapsedStroke}" />
        <text x="${(x + 25).toFixed(1)}" y="${(y + height - 13).toFixed(1)}" font-family="${options.fontFamily}" font-size="11" fill="${palette.muted}">+${item.hiddenDescendantCount} hidden</text>
      </g>`
    : "";

  return [
    `<g id="node-${escapeXml(node.id)}">`,
    `    <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${width}" height="${height.toFixed(1)}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1.3" />`,
    `    ${text}`,
    ...(marker ? [`    ${marker}`] : []),
    "  </g>",
  ].join("\n");
}

function renderEdge(edge) {
  const sourceX = edge.from.x + edge.from.width;
  const sourceY = edge.from.y + edge.from.height / 2;
  const targetX = edge.to.x;
  const targetY = edge.to.y + edge.to.height / 2;
  const midX = sourceX + (targetX - sourceX) * 0.52;
  const pathData = [
    `M ${sourceX.toFixed(1)} ${sourceY.toFixed(1)}`,
    `C ${midX.toFixed(1)} ${sourceY.toFixed(1)}, ${midX.toFixed(1)} ${targetY.toFixed(1)}, ${targetX.toFixed(1)} ${targetY.toFixed(1)}`,
  ].join(" ");

  return `<path d="${pathData}" fill="none" stroke="${palette.edge}" stroke-width="2" stroke-linecap="round" />`;
}

function buildSvg(snapshot) {
  const layout = prepareLayout(snapshot);
  const edgeMarkup = layout.edges.map(renderEdge).join("\n");
  const nodeMarkup = layout.nodes.map((node) => renderNode(node, snapshot.renderOptions)).join("\n");
  const totalNodeCount = Object.keys(snapshot.nodes).length;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(snapshot.title)}</title>
  <desc id="desc">Representative mind map export proof with links, collapsed branches, long text, and deep nesting.</desc>
  <rect x="0" y="0" width="${layout.width}" height="${layout.height}" fill="${palette.background}" />
  <g id="edges">
${edgeMarkup}
  </g>
  <g id="nodes">
${nodeMarkup}
  </g>
</svg>
`;

  return {
    svg,
    summary: {
      width: layout.width,
      height: layout.height,
      visibleNodeCount: layout.nodes.length,
      totalNodeCount,
      hiddenNodeCount: totalNodeCount - layout.nodes.length,
    },
  };
}

async function writePdf(svg, pdfPath, width, height) {
  const doc = new PDFDocument({ size: [width, height], margin: 0, compress: true });
  const stream = createWriteStream(pdfPath);
  doc.pipe(stream);
  SVGtoPDF(doc, svg, 0, 0, {
    width,
    height,
    assumePt: true,
  });
  doc.end();
  await once(stream, "finish");
}

async function validateArtifacts(paths) {
  const svg = await fs.readFile(paths.svgPath, "utf8");
  if (!svg.includes("<svg") || !svg.includes("Renderer Spike")) {
    throw new Error("SVG validation failed");
  }

  const png = await fs.readFile(paths.pngPath);
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!png.subarray(0, 8).equals(pngSignature)) {
    throw new Error("PNG validation failed");
  }

  const pdf = await fs.readFile(paths.pdfPath);
  if (pdf.toString("ascii", 0, 4) !== "%PDF") {
    throw new Error("PDF validation failed");
  }
}

async function main() {
  const snapshot = JSON.parse(await fs.readFile(fixturePath, "utf8"));
  const { svg, summary } = buildSvg(snapshot);

  await fs.mkdir(artifactDir, { recursive: true });

  const svgPath = path.join(artifactDir, "representative-mind-map.svg");
  const pngPath = path.join(artifactDir, "representative-mind-map.png");
  const pdfPath = path.join(artifactDir, "representative-mind-map.pdf");

  await fs.writeFile(svgPath, svg, "utf8");

  const resvg = new Resvg(svg, {
    background: "white",
    font: {
      loadSystemFonts: true,
    },
  });
  await fs.writeFile(pngPath, resvg.render().asPng());
  await writePdf(svg, pdfPath, summary.width, summary.height);
  await validateArtifacts({ svgPath, pngPath, pdfPath });

  const artifactStats = {
    svgBytes: (await fs.stat(svgPath)).size,
    pngBytes: (await fs.stat(pngPath)).size,
    pdfBytes: (await fs.stat(pdfPath)).size,
  };

  console.log(JSON.stringify({
    ok: true,
    renderer: "svg-first",
    headless: true,
    desktopInstanceRequired: false,
    fixture: fixturePath,
    artifactDir,
    artifacts: {
      svg: svgPath,
      png: pngPath,
      pdf: pdfPath,
      ...artifactStats,
    },
    summary,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
