# AI Change Proposal Contract

The `ai-proposals` feature owns the pure frontend/domain contract between normalized AI suggestion output and proposal review. It does not call Tauri, read files, write files, invoke AI models, or apply changes to editor state.

## Envelope

An `AiChangeProposal` is only created through `createAiChangeProposal` or `convertNormalizedAiSuggestionToProposal`. A valid proposal includes:

- `proposalId`, `sourceConversationId`, and `createdAt`.
- An explicit target scope: `node`, `branch`, `current-file`, or `multi-file`.
- `baseDocumentVersion`, captured when AI context was generated.
- `affectedFiles`, each with a workspace-relative Markdown path and backend-controlled `baseFileVersion`.
- A non-empty operation list.
- Derived `riskFlags`, `validationStatus`, `validationErrors`, and `impactSummary`.

Workspace-wide proposal scopes are intentionally not represented. Multi-file proposals must list every target file explicitly in both `targetScope.filePaths` and `affectedFiles`.

## Validation

Validators are pure TypeScript functions. They reject:

- Missing target scope, document version, file version anchors, or multi-file metadata.
- Empty operation lists.
- Unsupported scope or operation types.
- Absolute, backslash-separated, non-Markdown, or workspace-escaping file paths.
- Operations targeting files not listed in `affectedFiles`.
- Unknown node targets, malformed operations, duplicate operation ids, and duplicate inserted node ids.
- Root deletion/move, moves into descendants, invalid sibling orders, and produced tree invariant failures.
- Stale document/file version anchors when current context is available.
- Invalid Markdown serialization output from the Markdown compatibility boundary.

Invalid input returns typed `ProposalValidationError` records and no applyable proposal.

## Review Model

The first release supports whole-proposal accept/reject only through `ProposalReviewDecision`. Operation ids exist for diagnostics and review rendering; this feature does not expose partial-apply APIs.

## Non-Goals

- Applying proposal operations to the live editor.
- Persisting proposal changes to disk.
- Parsing raw AI text.
- Running Markdown parser/serializer processes.
