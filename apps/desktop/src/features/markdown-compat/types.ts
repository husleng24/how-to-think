import type {
  CompatibilityDiagnostic,
  DiagnosticSeverity,
  LinkTokenKind,
  WorkspaceId,
  WorkspaceRelativePath,
} from '../../types/markdownLifecycle';

export type LinkResolutionStatus = 'resolved' | 'unresolved' | 'ambiguous' | 'rejected';
export type LinkDiagnosticSeverity = DiagnosticSeverity;

export interface LinkReference {
  kind: LinkTokenKind;
  raw?: string | null;
  label?: string | null;
  target: string;
  alias?: string | null;
}

export interface ResolveLinkRequest {
  workspaceId: WorkspaceId;
  sourceRelativePath: WorkspaceRelativePath;
  link: LinkReference;
}

export interface LinkHeadingAnchor {
  text: string;
  anchor: string;
  line: number;
  level: number;
}

export interface LinkCandidate {
  relativePath: WorkspaceRelativePath;
  name: string;
  stem: string;
  heading?: LinkHeadingAnchor | null;
}

export interface LinkDiagnostic {
  code: string;
  severity: LinkDiagnosticSeverity;
  message: string;
  sourceRelativePath?: WorkspaceRelativePath;
  target?: string;
  candidates: LinkCandidate[];
}

export interface LinkOpenIntent {
  workspaceId: WorkspaceId;
  relativePath: WorkspaceRelativePath;
  fragment?: string | null;
}

export interface LinkCreateIntent {
  workspaceId: WorkspaceId;
  relativePath: WorkspaceRelativePath;
  title: string;
  normalizedFilename: string;
}

export interface LinkResolution {
  workspaceId: WorkspaceId;
  sourceRelativePath: WorkspaceRelativePath;
  kind: LinkTokenKind;
  raw?: string | null;
  target: string;
  label?: string | null;
  alias?: string | null;
  displayText: string;
  fragment?: string | null;
  status: LinkResolutionStatus;
  open?: LinkOpenIntent | null;
  create?: LinkCreateIntent | null;
  candidates: LinkCandidate[];
  diagnostics: LinkDiagnostic[];
}

export interface LinkResolverService {
  resolveLink(request: ResolveLinkRequest): Promise<LinkResolution>;
}

export interface LinkInteractionController extends LinkResolverService {
  workspaceId: WorkspaceId;
  sourceRelativePath: WorkspaceRelativePath;
  openTarget(relativePath: WorkspaceRelativePath, fragment?: string | null): Promise<void> | void;
  createTarget(relativePath: WorkspaceRelativePath): Promise<void> | void;
}

export interface CompatibilityDiagnosticItem {
  id: string;
  source: 'parser' | 'save' | 'links';
  severity: LinkDiagnosticSeverity;
  code: string;
  message: string;
  relativePath?: WorkspaceRelativePath | null;
  line?: number;
}

export interface CompatibilityDiagnosticsSource {
  documentDiagnostics?: CompatibilityDiagnostic[];
  saveDiagnostics?: CompatibilityDiagnostic[];
  linkDiagnostics?: LinkDiagnostic[];
}
