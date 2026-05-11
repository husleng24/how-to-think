import type { MindMapDocument, MindMapNode, NodeId } from '../../mindmap/domain/mindMap';
import { createEmptyMindMapDocument } from '../../mindmap/domain/mindMap';
import { layoutMindMapDocument } from '../../mindmap/layout';
import type { MindMapLayoutResult } from '../../mindmap/layout';
import type {
  ExportRequest,
  MindMapRenderLinkToken,
  MindMapRenderSnapshot,
} from '../domain/types';
import { EXPORT_CONTRACT_VERSION, createExportWarning } from '../domain/contract';

export interface SpikeRenderNodeFixture {
  id: NodeId;
  text: string;
  parentId: NodeId | null;
  childIds: NodeId[];
  collapsed: boolean;
  linkTokens: Array<{
    kind: 'wikilink' | 'markdown';
    raw: string;
    target: string;
    alias?: string;
  }>;
}

export interface SpikeRenderSnapshotFixture {
  id: string;
  title: string;
  source: {
    documentPath: string;
    scope: string;
  };
  nodes: Record<NodeId, SpikeRenderNodeFixture>;
  rootNodeId: NodeId;
}

const FIXTURE_DATE = '2026-05-11T00:00:00.000Z';

export function createValidSvgExportRequest(): ExportRequest {
  return {
    contractVersion: EXPORT_CONTRACT_VERSION,
    format: 'svg',
    scope: {
      type: 'selected_branch',
      rootNodeId: 'renderer',
      selectionId: 'selection-renderer',
    },
    options: {
      outputPath: 'exports/renderer.svg',
      overwritePolicy: 'fail_if_exists',
      dimensions: {
        mode: 'explicit',
        width: 1280,
        height: 720,
      },
      theme: {
        source: 'document',
      },
      collapsedBranchPolicy: 'preserve_collapsed',
    },
    source: {
      documentId: 'vit-105-representative-render-snapshot',
      documentVersion: 1,
      workspaceRelativePath: 'maps/export-renderer-proof.md',
      generatedAt: FIXTURE_DATE,
    },
  };
}

export function createMindMapDocumentFromSpikeFixture(
  fixture: SpikeRenderSnapshotFixture,
): MindMapDocument {
  const createdAt = FIXTURE_DATE;
  const document = createEmptyMindMapDocument({
    id: fixture.id,
    title: fixture.title,
    sourcePath: fixture.source.documentPath,
    rootNodeId: fixture.rootNodeId,
    rootText: fixture.nodes[fixture.rootNodeId]?.text ?? fixture.title,
    now: new Date(FIXTURE_DATE),
  });
  const nodes: Record<NodeId, MindMapNode> = {};

  for (const node of Object.values(fixture.nodes)) {
    nodes[node.id] = {
      id: node.id,
      text: node.text,
      parentId: node.parentId,
      childIds: [...node.childIds],
      collapsed: node.collapsed,
      createdAt,
      updatedAt: createdAt,
    };
  }

  return {
    ...document,
    nodes,
    version: Object.keys(nodes).length,
    updatedAt: createdAt,
  };
}

export function createRenderSnapshotFromSpikeFixture(
  fixture: SpikeRenderSnapshotFixture,
): MindMapRenderSnapshot {
  const document = createMindMapDocumentFromSpikeFixture(fixture);
  const layout = layoutMindMapDocument(document);
  const linkTokens = createLinkTokens(fixture);

  return {
    contractVersion: EXPORT_CONTRACT_VERSION,
    snapshotId: fixture.id,
    source: {
      documentId: document.id,
      documentVersion: document.version,
      workspaceRelativePath: fixture.source.documentPath,
      generatedAt: FIXTURE_DATE,
    },
    scope: {
      type: 'current_file',
    },
    bounds: layoutBoundsToExportBounds(layout),
    nodes: layout.nodes.map((layoutNode, index) => {
      const sourceFixtureNode = fixture.nodes[layoutNode.id];
      const sourceLinkTokenIds = sourceFixtureNode.linkTokens.map(
        (_token, tokenIndex) => `${layoutNode.id}:link-${tokenIndex}`,
      );

      return {
        id: `render:${layoutNode.id}`,
        sourceNodeId: layoutNode.id,
        parentNodeId: layoutNode.node.parentId,
        depth: layoutNode.depth,
        order: index,
        bounds: {
          x: layoutNode.x,
          y: layoutNode.y,
          width: layoutNode.width,
          height: layoutNode.height,
        },
        textRuns: [
          {
            text: layoutNode.node.text,
            ...(sourceLinkTokenIds[0] ? { linkTokenId: sourceLinkTokenIds[0] } : {}),
          },
        ],
        linkTokenIds: sourceLinkTokenIds,
        collapsed: layoutNode.node.collapsed,
        hiddenDescendantCount: layoutNode.hiddenDescendantCount,
      };
    }),
    edges: layout.edges.map((edge) => ({
      id: `render:${edge.id}`,
      sourceNodeId: edge.sourceId,
      targetNodeId: edge.targetId,
      from: edge.source,
      to: edge.target,
    })),
    linkTokens,
    collapsedMarkers: layout.nodes
      .filter((node) => node.hiddenDescendantCount > 0)
      .map((node) => ({
        nodeId: node.id,
        hiddenNodeCount: node.hiddenDescendantCount,
        label: `+${node.hiddenDescendantCount}`,
      })),
    theme: {
      source: 'document',
      tokens: {
        background: '#ffffff',
        nodeFill: '#f8fafc',
        edgeStroke: '#64748b',
      },
    },
    warnings: [
      createExportWarning(
        'collapsed_content_preserved',
        'Collapsed branch markers are preserved in the render snapshot.',
        { collapsedMarkerCount: layout.nodes.filter((node) => node.hiddenDescendantCount > 0).length },
      ),
    ],
  };
}

function createLinkTokens(
  fixture: SpikeRenderSnapshotFixture,
): MindMapRenderLinkToken[] {
  return Object.values(fixture.nodes).flatMap((node) =>
    node.linkTokens.map((token, index) => ({
      id: `${node.id}:link-${index}`,
      kind: token.kind === 'wikilink' ? 'obsidian_wiki' : 'standard_markdown',
      raw: token.raw,
      label: token.alias ?? token.target,
      target: token.target,
      alias: token.alias ?? null,
      resolvedWorkspacePath: null,
    })),
  );
}

function layoutBoundsToExportBounds(layout: MindMapLayoutResult): MindMapRenderSnapshot['bounds'] {
  return {
    x: layout.bounds.minX,
    y: layout.bounds.minY,
    width: layout.bounds.width,
    height: layout.bounds.height,
  };
}
