import {
  createExportError,
  createExportWarning,
  validateMindMapRenderSnapshot,
} from './contract';
import type {
  ExportBounds,
  ExportDimensionOptions,
  ExportError,
  ExportOptions,
  ExportWarning,
  MindMapRenderLinkToken,
  MindMapRenderNode,
  MindMapRenderSnapshot,
  MindMapTextRun,
  TextRunMark,
} from './types';

export interface VisualExportLimits {
  maxSvgWidth: number;
  maxSvgHeight: number;
  maxPngWidth: number;
  maxPngHeight: number;
  maxPngPixels: number;
  defaultPadding: number;
  substantialScaleWarningRatio: number;
}

export interface RenderedSvgArtifact {
  svg: string;
  width: number;
  height: number;
  viewBox: string;
  warnings: readonly ExportWarning[];
}

export type RenderSvgResult =
  | {
      ok: true;
      artifact: RenderedSvgArtifact;
    }
  | {
      ok: false;
      error: ExportError;
      warnings: readonly ExportWarning[];
    };

interface DimensionPlan {
  width: number;
  height: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  warnings: readonly ExportWarning[];
}

interface TextToken {
  text: string;
  linkTokenId?: string;
  linkTarget?: string;
  marks: readonly TextRunMark[];
}

const DEFAULT_FONT_FAMILY = 'Inter, Segoe UI, Arial, sans-serif';
const DEFAULT_PALETTE = {
  background: '#ffffff',
  edgeStroke: '#8aa0b8',
  rootFill: '#153a5b',
  rootStroke: '#0d263d',
  rootText: '#ffffff',
  nodeFill: '#ffffff',
  nodeStroke: '#c8d3df',
  nodeText: '#1d2b3a',
  mutedText: '#5d6c7c',
  linkText: '#075da8',
  collapsedFill: '#e9f4ff',
  collapsedStroke: '#9dc6eb',
};

export const DEFAULT_VISUAL_EXPORT_LIMITS: VisualExportLimits = {
  maxSvgWidth: 20000,
  maxSvgHeight: 20000,
  maxPngWidth: 16384,
  maxPngHeight: 16384,
  maxPngPixels: 134217728,
  defaultPadding: 48,
  substantialScaleWarningRatio: 0.75,
};

export function renderMindMapSnapshotToSvg(
  snapshot: MindMapRenderSnapshot,
  options: ExportOptions,
  limits: VisualExportLimits = DEFAULT_VISUAL_EXPORT_LIMITS,
): RenderSvgResult {
  const validation = validateMindMapRenderSnapshot(snapshot);
  if (!validation.ok) {
    return {
      ok: false,
      error: validation.errors[0],
      warnings: snapshot.warnings ?? [],
    };
  }

  const dimensionPlan = resolveDimensionPlan(snapshot.bounds, options.dimensions, limits);
  if (!dimensionPlan.ok) {
    return {
      ok: false,
      error: dimensionPlan.error,
      warnings: snapshot.warnings,
    };
  }

  const plan = dimensionPlan.plan;
  const palette = paletteFromOptions(snapshot, options);
  const linkTokens = new Map(snapshot.linkTokens.map((token) => [token.id, token]));
  const collapsedMarkers = new Map(snapshot.collapsedMarkers.map((marker) => [marker.nodeId, marker]));
  const sortedEdges = [...snapshot.edges].sort((left, right) => left.id.localeCompare(right.id));
  const sortedNodes = [...snapshot.nodes].sort((left, right) =>
    left.order === right.order ? left.id.localeCompare(right.id) : left.order - right.order,
  );
  const transformPoint = (point: { x: number; y: number }) => ({
    x: point.x * plan.scale + plan.offsetX,
    y: point.y * plan.scale + plan.offsetY,
  });
  const edgeMarkup = sortedEdges
    .map((edge) => renderEdge(transformPoint(edge.from), transformPoint(edge.to), palette.edgeStroke))
    .join('\n');
  const nodeMarkup = sortedNodes
    .map((node) => renderNode(node, {
      bounds: transformBounds(node.bounds, plan),
      linkTokens,
      collapsedMarker: collapsedMarkers.get(node.sourceNodeId),
      palette,
      fontScale: Math.max(0.65, Math.min(1.4, plan.scale)),
    }))
    .join('\n');
  const title = exportTitle(snapshot);
  const desc = `Mind map export containing ${sortedNodes.length} visible nodes and ${sortedEdges.length} connectors.`;
  const background = palette.background === 'transparent'
    ? ''
    : `  <rect x="0" y="0" width="${formatNumber(plan.width)}" height="${formatNumber(plan.height)}" fill="${escapeXml(palette.background)}" />\n`;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${formatNumber(plan.width)}" height="${formatNumber(plan.height)}" viewBox="0 0 ${formatNumber(plan.width)} ${formatNumber(plan.height)}" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(title)}</title>
  <desc id="desc">${escapeXml(desc)}</desc>
  <metadata data-snapshot-id="${escapeXml(snapshot.snapshotId)}" data-contract-version="${escapeXml(snapshot.contractVersion)}" />
${background}  <g id="edges" fill="none">
${edgeMarkup}
  </g>
  <g id="nodes">
${nodeMarkup}
  </g>
</svg>
`;

  return {
    ok: true,
    artifact: {
      svg,
      width: plan.width,
      height: plan.height,
      viewBox: `0 0 ${formatNumber(plan.width)} ${formatNumber(plan.height)}`,
      warnings: uniqueWarnings([...snapshot.warnings, ...plan.warnings]),
    },
  };
}

export function projectedPngDimensions(
  svg: Pick<RenderedSvgArtifact, 'width' | 'height'>,
  pixelDensity = 1,
): { width: number; height: number } {
  return {
    width: Math.ceil(svg.width * pixelDensity),
    height: Math.ceil(svg.height * pixelDensity),
  };
}

export function validatePngDimensions(
  width: number,
  height: number,
  limits: VisualExportLimits = DEFAULT_VISUAL_EXPORT_LIMITS,
): ExportError | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return createExportError('invalid_export_dimensions', 'PNG dimensions must be positive finite numbers.', {
      details: { width: printableNumber(width), height: printableNumber(height) },
    });
  }

  if (width > limits.maxPngWidth || height > limits.maxPngHeight) {
    return createExportError('invalid_export_dimensions', 'PNG dimensions exceed converter safeguards.', {
      details: {
        width,
        height,
        maxWidth: limits.maxPngWidth,
        maxHeight: limits.maxPngHeight,
      },
    });
  }

  if (width * height > limits.maxPngPixels) {
    return createExportError('invalid_export_dimensions', 'PNG pixel area exceeds converter safeguards.', {
      details: {
        width,
        height,
        pixels: width * height,
        maxPixels: limits.maxPngPixels,
      },
    });
  }

  return null;
}

function resolveDimensionPlan(
  bounds: ExportBounds,
  dimensions: ExportDimensionOptions | undefined,
  limits: VisualExportLimits,
):
  | {
      ok: true;
      plan: DimensionPlan;
    }
  | {
      ok: false;
      error: ExportError;
    } {
  const naturalWidth = bounds.width + limits.defaultPadding * 2;
  const naturalHeight = bounds.height + limits.defaultPadding * 2;
  let width = naturalWidth;
  let height = naturalHeight;
  let scale = 1;
  const warnings: ExportWarning[] = [];

  if (!dimensions || dimensions.mode === 'layout_bounds') {
    const maxWidth = dimensions?.mode === 'layout_bounds' ? dimensions.maxWidth : undefined;
    const maxHeight = dimensions?.mode === 'layout_bounds' ? dimensions.maxHeight : undefined;
    const maxScale = Math.min(
      maxWidth ? maxWidth / naturalWidth : 1,
      maxHeight ? maxHeight / naturalHeight : 1,
      1,
    );
    scale = maxScale;
    width = naturalWidth * scale;
    height = naturalHeight * scale;
  } else if (dimensions.mode === 'explicit') {
    width = dimensions.width;
    height = dimensions.height;
    const contentWidth = width - limits.defaultPadding * 2;
    const contentHeight = height - limits.defaultPadding * 2;
    if (contentWidth <= 0 || contentHeight <= 0) {
      return {
        ok: false,
        error: createExportError('invalid_export_dimensions', 'Explicit dimensions leave no drawable area.', {
          details: { width, height, padding: limits.defaultPadding },
        }),
      };
    }
    scale = Math.min(contentWidth / bounds.width, contentHeight / bounds.height);
  } else {
    scale = dimensions.scale;
    width = naturalWidth * scale;
    height = naturalHeight * scale;
  }

  width = Math.ceil(width);
  height = Math.ceil(height);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {
      ok: false,
      error: createExportError('invalid_export_dimensions', 'Resolved export dimensions are invalid.', {
        details: { width: printableNumber(width), height: printableNumber(height) },
      }),
    };
  }

  if (width > limits.maxSvgWidth || height > limits.maxSvgHeight) {
    return {
      ok: false,
      error: createExportError('invalid_export_dimensions', 'SVG dimensions exceed export safeguards.', {
        details: {
          width,
          height,
          maxWidth: limits.maxSvgWidth,
          maxHeight: limits.maxSvgHeight,
        },
      }),
    };
  }

  if (scale < limits.substantialScaleWarningRatio) {
    warnings.push(
      createExportWarning('large_map_scaled', 'Map was scaled down to fit export dimensions.', {
        scale: round(scale),
        width,
        height,
      }),
    );
  }

  const offsetX = (width - bounds.width * scale) / 2 - bounds.x * scale;
  const offsetY = (height - bounds.height * scale) / 2 - bounds.y * scale;

  return {
    ok: true,
    plan: {
      width,
      height,
      scale,
      offsetX,
      offsetY,
      warnings,
    },
  };
}

function renderEdge(
  from: { x: number; y: number },
  to: { x: number; y: number },
  stroke: string,
): string {
  const delta = Math.max(32, Math.abs(to.x - from.x) * 0.52);
  const path = [
    `M ${formatNumber(from.x)} ${formatNumber(from.y)}`,
    `C ${formatNumber(from.x + delta)} ${formatNumber(from.y)}, ${formatNumber(to.x - delta)} ${formatNumber(to.y)}, ${formatNumber(to.x)} ${formatNumber(to.y)}`,
  ].join(' ');

  return `    <path d="${path}" stroke="${escapeXml(stroke)}" stroke-width="2" stroke-linecap="round" />`;
}

function renderNode(
  node: MindMapRenderNode,
  input: {
    bounds: ExportBounds;
    linkTokens: ReadonlyMap<string, MindMapRenderLinkToken>;
    collapsedMarker?: { label: string; hiddenNodeCount: number };
    palette: typeof DEFAULT_PALETTE;
    fontScale: number;
  },
): string {
  const isRoot = node.parentNodeId === null || node.depth === 0;
  const fill = isRoot ? input.palette.rootFill : input.palette.nodeFill;
  const stroke = isRoot ? input.palette.rootStroke : input.palette.nodeStroke;
  const textColor = isRoot ? input.palette.rootText : input.palette.nodeText;
  const fontSize = Math.max(9, Math.round((isRoot ? 15 : 13) * input.fontScale));
  const lineHeight = Math.ceil(fontSize * 1.38);
  const textX = input.bounds.x + 14 * input.fontScale;
  const firstBaseline = input.bounds.y + 24 * input.fontScale;
  const maxTextWidth = Math.max(24, input.bounds.width - 28 * input.fontScale);
  const tokens = tokensForRuns(node.textRuns, input.linkTokens);
  const lines = wrapTokens(tokens, maxTextWidth, fontSize);
  const textMarkup = lines
    .map((line, lineIndex) =>
      renderTextLine(line, {
        x: textX,
        y: firstBaseline + lineIndex * lineHeight,
        fontSize,
        color: textColor,
        linkColor: input.palette.linkText,
      }),
    )
    .join('\n');
  const marker = input.collapsedMarker
    ? renderCollapsedMarker(input.bounds, input.collapsedMarker, input.palette, input.fontScale)
    : '';

  return `    <g id="${escapeXml(node.id)}" data-source-node-id="${escapeXml(node.sourceNodeId)}">
      <rect x="${formatNumber(input.bounds.x)}" y="${formatNumber(input.bounds.y)}" width="${formatNumber(input.bounds.width)}" height="${formatNumber(input.bounds.height)}" rx="${formatNumber(Math.min(8, 8 * input.fontScale))}" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="1.3" />
${textMarkup}${marker}
    </g>`;
}

function renderTextLine(
  line: readonly TextToken[],
  input: {
    x: number;
    y: number;
    fontSize: number;
    color: string;
    linkColor: string;
  },
): string {
  const spans = line
    .map((token) => {
      const isLink = Boolean(token.linkTokenId);
      const fill = isLink ? ` fill="${escapeXml(input.linkColor)}"` : '';
      const decoration = isLink ? ' text-decoration="underline"' : '';
      const target = token.linkTarget ? ` data-link-target="${escapeXml(token.linkTarget)}"` : '';
      const weight = token.marks.includes('bold') ? ' font-weight="700"' : '';
      const style = token.marks.includes('italic') ? ' font-style="italic"' : '';
      const family = token.marks.includes('code') ? ' font-family="Consolas, monospace"' : '';

      return `<tspan${fill}${decoration}${target}${weight}${style}${family}>${escapeXml(token.text)}</tspan>`;
    })
    .join('');

  return `      <text x="${formatNumber(input.x)}" y="${formatNumber(input.y)}" font-family="${DEFAULT_FONT_FAMILY}" font-size="${input.fontSize}" fill="${escapeXml(input.color)}" xml:space="preserve">${spans}</text>`;
}

function renderCollapsedMarker(
  bounds: ExportBounds,
  marker: { label: string; hiddenNodeCount: number },
  palette: typeof DEFAULT_PALETTE,
  fontScale: number,
): string {
  const label = marker.label || `+${marker.hiddenNodeCount}`;
  const width = Math.max(46, label.length * 8 + 18) * fontScale;
  const height = 18 * fontScale;
  const x = bounds.x + 14 * fontScale;
  const y = bounds.y + bounds.height - height - 8 * fontScale;
  const fontSize = Math.max(9, Math.round(11 * fontScale));

  return `
      <g data-collapsed-marker="true">
        <rect x="${formatNumber(x)}" y="${formatNumber(y)}" width="${formatNumber(width)}" height="${formatNumber(height)}" rx="${formatNumber(height / 2)}" fill="${escapeXml(palette.collapsedFill)}" stroke="${escapeXml(palette.collapsedStroke)}" />
        <text x="${formatNumber(x + 10 * fontScale)}" y="${formatNumber(y + height - 5 * fontScale)}" font-family="${DEFAULT_FONT_FAMILY}" font-size="${fontSize}" fill="${escapeXml(palette.mutedText)}">${escapeXml(label)}</text>
      </g>`;
}

function tokensForRuns(
  runs: readonly MindMapTextRun[],
  linkTokens: ReadonlyMap<string, MindMapRenderLinkToken>,
): readonly TextToken[] {
  return runs.flatMap((run) => expandRunLinks(run, linkTokens)).flatMap(splitWhitespaceTokens);
}

function expandRunLinks(
  run: MindMapTextRun,
  linkTokens: ReadonlyMap<string, MindMapRenderLinkToken>,
): readonly TextToken[] {
  const marks = run.marks ?? [];
  const matchingTokens = [...linkTokens.values()].filter((token) => run.text.includes(token.raw));

  if (matchingTokens.length === 0) {
    const token = run.linkTokenId ? linkTokens.get(run.linkTokenId) : undefined;

    return [
      {
        text: token?.label ?? run.text,
        ...(token ? { linkTokenId: token.id, linkTarget: token.target } : {}),
        marks,
      },
    ];
  }

  const tokens: TextToken[] = [];
  let cursor = 0;
  for (const linkToken of matchingTokens.sort((left, right) => run.text.indexOf(left.raw) - run.text.indexOf(right.raw))) {
    const index = run.text.indexOf(linkToken.raw, cursor);
    if (index < cursor) {
      continue;
    }

    if (index > cursor) {
      tokens.push({ text: run.text.slice(cursor, index), marks });
    }

    tokens.push({
      text: linkToken.label,
      linkTokenId: linkToken.id,
      linkTarget: linkToken.target,
      marks,
    });
    cursor = index + linkToken.raw.length;
  }

  if (cursor < run.text.length) {
    tokens.push({ text: run.text.slice(cursor), marks });
  }

  return tokens;
}

function splitWhitespaceTokens(token: TextToken): readonly TextToken[] {
  return token.text
    .split(/(\s+)/)
    .filter((part) => part.length > 0)
    .map((part) => ({
      ...token,
      text: /\s+/.test(part) ? ' ' : part,
    }));
}

function wrapTokens(tokens: readonly TextToken[], maxWidth: number, fontSize: number): readonly TextToken[][] {
  const lines: TextToken[][] = [];
  let current: TextToken[] = [];
  let currentWidth = 0;

  const pushLine = () => {
    while (current.length > 0 && current[current.length - 1].text === ' ') {
      current.pop();
    }

    if (current.length > 0) {
      lines.push(current);
    }
    current = [];
    currentWidth = 0;
  };

  for (const token of tokens.flatMap((candidate) => splitLongToken(candidate, maxWidth, fontSize))) {
    const width = measureToken(token, fontSize);
    if (token.text === ' ' && current.length === 0) {
      continue;
    }

    if (current.length > 0 && currentWidth + width > maxWidth) {
      pushLine();
      if (token.text === ' ') {
        continue;
      }
    }

    current.push(token);
    currentWidth += width;
  }

  pushLine();
  return lines.length > 0 ? lines : [[{ text: 'Untitled', marks: [] }]];
}

function splitLongToken(token: TextToken, maxWidth: number, fontSize: number): readonly TextToken[] {
  if (token.text === ' ' || measureToken(token, fontSize) <= maxWidth) {
    return [token];
  }

  const maxChars = Math.max(4, Math.floor(maxWidth / (fontSize * 0.62)));
  const chunks: TextToken[] = [];
  for (let index = 0; index < token.text.length; index += maxChars) {
    chunks.push({
      ...token,
      text: token.text.slice(index, index + maxChars),
    });
  }

  return chunks;
}

function measureToken(token: TextToken, fontSize: number): number {
  if (token.text === ' ') {
    return fontSize * 0.34;
  }

  const markFactor = token.marks.includes('code') ? 0.62 : 0.55;
  const linkFactor = token.linkTokenId ? 1.05 : 1;
  return token.text.length * fontSize * markFactor * linkFactor;
}

function transformBounds(bounds: ExportBounds, plan: DimensionPlan): ExportBounds {
  return {
    x: bounds.x * plan.scale + plan.offsetX,
    y: bounds.y * plan.scale + plan.offsetY,
    width: bounds.width * plan.scale,
    height: bounds.height * plan.scale,
  };
}

function paletteFromOptions(
  snapshot: MindMapRenderSnapshot,
  options: ExportOptions,
): typeof DEFAULT_PALETTE {
  const tokens = {
    ...snapshot.theme.tokens,
    ...(options.theme.source === 'explicit' ? options.theme.tokens ?? {} : {}),
  };

  return {
    background: stringToken(tokens.background, DEFAULT_PALETTE.background),
    edgeStroke: stringToken(tokens.edgeStroke ?? tokens.edge, DEFAULT_PALETTE.edgeStroke),
    rootFill: stringToken(tokens.rootFill, DEFAULT_PALETTE.rootFill),
    rootStroke: stringToken(tokens.rootStroke, DEFAULT_PALETTE.rootStroke),
    rootText: stringToken(tokens.rootText, DEFAULT_PALETTE.rootText),
    nodeFill: stringToken(tokens.nodeFill, DEFAULT_PALETTE.nodeFill),
    nodeStroke: stringToken(tokens.nodeStroke, DEFAULT_PALETTE.nodeStroke),
    nodeText: stringToken(tokens.nodeText ?? tokens.text, DEFAULT_PALETTE.nodeText),
    mutedText: stringToken(tokens.mutedText, DEFAULT_PALETTE.mutedText),
    linkText: stringToken(tokens.linkText ?? tokens.link, DEFAULT_PALETTE.linkText),
    collapsedFill: stringToken(tokens.collapsedFill, DEFAULT_PALETTE.collapsedFill),
    collapsedStroke: stringToken(tokens.collapsedStroke, DEFAULT_PALETTE.collapsedStroke),
  };
}

function stringToken(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function exportTitle(snapshot: MindMapRenderSnapshot): string {
  const rootNode = snapshot.nodes.find((node) => node.parentNodeId === null) ?? snapshot.nodes[0];
  const text = rootNode?.textRuns.map((run) => run.text).join('').trim();

  return text && text.length > 0
    ? text
    : snapshot.source.workspaceRelativePath ?? snapshot.source.documentId;
}

function uniqueWarnings(warnings: readonly ExportWarning[]): readonly ExportWarning[] {
  const seen = new Set<string>();
  const result: ExportWarning[] = [];

  for (const warning of warnings) {
    const key = `${warning.code}:${warning.message}:${JSON.stringify(warning.details ?? {})}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(warning);
    }
  }

  return result;
}

function escapeXml(value: string | number | boolean): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function printableNumber(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}
