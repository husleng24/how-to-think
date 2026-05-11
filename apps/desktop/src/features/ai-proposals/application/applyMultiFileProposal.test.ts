import { describe, expect, it, vi } from 'vitest';

import {
  buildGuardedApplyConfirmation,
  createLinkTargetChangeProposalFixture,
  createMultiFileProposalFixture,
  prepareMultiFileProposalApply,
  preflightMultiFileProposalApply,
  proposalFixtureFileVersion,
  proposalFixtureOtherFileVersion,
  type AiChangeProposal,
  type MultiFileApplyBackend,
  type MultiFileApplyPreflightFileState,
  type MultiFileBackendApplyInput,
  type MultiFileBackendBatchApplyResult,
} from '../index';
import { applyMultiFileProposal } from './applyMultiFileProposal';

describe('applyMultiFileProposal', () => {
  it('requires guarded confirmation before preparing a risky proposal', () => {
    const proposal = createMultiFileProposalFixture();

    const unconfirmed = prepareMultiFileProposalApply({ proposal });
    expect(unconfirmed.ok).toBe(false);
    if (!unconfirmed.ok) {
      expect(unconfirmed.error.code).toBe('guarded_confirmation_required');
      expect(unconfirmed.error.step).toBe('confirmation');
    }

    const confirmed = prepareMultiFileProposalApply({
      proposal,
      confirmedGuardedApplyToken: confirmationToken(proposal),
    });
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok) {
      expect(confirmed.prepared.files.map((file) => file.path)).toEqual([
        'notes/root.md',
        'notes/other.md',
      ]);
      expect(confirmed.prepared.confirmation.affectedFiles[0]).toMatchObject({
        path: 'notes/root.md',
        operationType: 'modify',
        baseVersionToken: proposalFixtureFileVersion.token,
      });
    }
  });

  it('applies a clean two-file proposal through a batch backend and returns refresh instructions', async () => {
    const proposal = createMultiFileProposalFixture();
    const backend: MultiFileApplyBackend = {
      preflightFiles: vi.fn(() => cleanPreflightStates()),
      applyBatch: vi.fn((input: MultiFileBackendApplyInput): MultiFileBackendBatchApplyResult => ({
        ok: true as const,
        appliedFiles: input.files.map((file) => ({
          path: file.path,
          operationType: file.operationType,
          version: file.path === 'notes/root.md' ? savedVersion('root') : savedVersion('other'),
        })),
      })),
      refreshAfterApply: vi.fn(() => ({ ok: true as const })),
    };

    const result = await applyMultiFileProposal({
      proposal,
      workspaceId: 'workspace-1',
      backend,
      confirmedGuardedApplyToken: confirmationToken(proposal),
      openDocuments: [
        { path: 'notes/root.md', version: proposalFixtureFileVersion, isDirty: false },
        { path: 'notes/other.md', version: proposalFixtureOtherFileVersion, isDirty: false },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.backendMode).toBe('batch');
    expect(result.appliedFiles).toHaveLength(2);
    expect(result.refresh.openDocumentsToRefresh).toEqual(['notes/root.md', 'notes/other.md']);
    expect(result.refresh.fileListShouldRefresh).toBe(true);
    expect(backend.applyBatch).toHaveBeenCalledTimes(1);
    expect(backend.refreshAfterApply).toHaveBeenCalledTimes(1);
  });

  it('rejects stale, dirty, missing, permission-denied, and ambiguous-link preflight conflicts', async () => {
    const proposal = createMultiFileProposalFixture();
    const prepared = prepareMultiFileProposalApply({
      proposal,
      confirmedGuardedApplyToken: confirmationToken(proposal),
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }

    const result = await preflightMultiFileProposalApply({
      workspaceId: 'workspace-1',
      prepared: prepared.prepared,
      backend: {
        preflightFiles: () => [
          {
            path: 'notes/root.md',
            exists: true,
            version: { ...proposalFixtureFileVersion, token: 'stale' },
            writable: true,
            ambiguousLinkTargets: ['Topic'],
          },
          {
            path: 'notes/other.md',
            exists: false,
            writable: false,
          },
        ],
      },
      openDocuments: [
        { path: 'notes/root.md', version: proposalFixtureFileVersion, isDirty: true },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.code)).toEqual(
        expect.arrayContaining([
          'stale_file',
          'dirty_file',
          'missing_file',
          'permission_denied',
          'ambiguous_link_target',
        ]),
      );
    }
  });

  it('rejects invalid paths and unsupported extensions before backend preflight', () => {
    const absolutePath = prepareMultiFileProposalApply({
      proposal: withAffectedPath(createMultiFileProposalFixture(), 'C:/Users/example/root.md'),
      confirmedGuardedApplyToken: confirmationToken(
        withAffectedPath(createMultiFileProposalFixture(), 'C:/Users/example/root.md'),
      ),
    });
    expect(absolutePath.ok).toBe(false);
    if (!absolutePath.ok) {
      expect(absolutePath.error.code).toBe('out_of_workspace_file');
      expect(absolutePath.error.step).toBe('prepare');
    }

    const unsupportedExtension = prepareMultiFileProposalApply({
      proposal: withAffectedPath(createMultiFileProposalFixture(), 'notes/root.txt'),
      confirmedGuardedApplyToken: confirmationToken(
        withAffectedPath(createMultiFileProposalFixture(), 'notes/root.txt'),
      ),
    });
    expect(unsupportedExtension.ok).toBe(false);
    if (!unsupportedExtension.ok) {
      expect(unsupportedExtension.error.code).toBe('unsupported_file_type');
    }
  });

  it('blocks ambiguous link targets for guarded link target changes', async () => {
    const proposal = createLinkTargetChangeProposalFixture();
    const result = await applyMultiFileProposal({
      proposal,
      workspaceId: 'workspace-1',
      confirmedGuardedApplyToken: confirmationToken(proposal),
      backend: {
        preflightFiles: () => [
          {
            path: 'notes/root.md',
            exists: true,
            version: proposalFixtureFileVersion,
            writable: true,
            ambiguousLinkTargets: ['Other'],
          },
        ],
        applyFile: vi.fn(() => ({
          ok: true as const,
          appliedFile: { path: 'notes/root.md', operationType: 'modify' as const },
        })),
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('ambiguous_link_target');
      expect(result.error.conflicts?.map((error) => error.code)).toContain('ambiguous_link_target');
    }
  });

  it('reports rollback status when a sequential backend write fails after a partial apply', async () => {
    const proposal = createMultiFileProposalFixture();
    const backend: MultiFileApplyBackend = {
      preflightFiles: () => cleanPreflightStates(),
      applyFile: vi
        .fn()
        .mockReturnValueOnce({
          ok: true,
          appliedFile: {
            path: 'notes/root.md',
            operationType: 'modify' as const,
            version: savedVersion('root'),
          },
          rollback: {
            path: 'notes/root.md',
            operationType: 'modify' as const,
            recoveryToken: 'rollback-root',
            previousVersion: proposalFixtureFileVersion,
          },
        })
        .mockReturnValueOnce({
          ok: false,
          code: 'backend_write_failed',
          message: 'Disk write failed.',
          filePath: 'notes/other.md',
        }),
      rollbackFile: vi.fn(() => ({ ok: true as const })),
    };

    const result = await applyMultiFileProposal({
      proposal,
      workspaceId: 'workspace-1',
      backend,
      confirmedGuardedApplyToken: confirmationToken(proposal),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.step).toBe('write');
      expect(result.error.filePath).toBe('notes/other.md');
      expect(result.error.rollbackStatus).toBe('completed');
      expect(result.error.appliedFiles).toHaveLength(1);
    }
    expect(backend.rollbackFile).toHaveBeenCalledWith(
      expect.objectContaining({
        rollback: expect.objectContaining({ recoveryToken: 'rollback-root' }),
      }),
    );
  });

  it('surfaces incomplete rollback when recovery cannot restore all previous writes', async () => {
    const proposal = createMultiFileProposalFixture();
    const backend: MultiFileApplyBackend = {
      preflightFiles: () => cleanPreflightStates(),
      applyFile: vi
        .fn()
        .mockReturnValueOnce({
          ok: true,
          appliedFile: { path: 'notes/root.md', operationType: 'modify' as const },
          rollback: {
            path: 'notes/root.md',
            operationType: 'modify' as const,
            recoveryToken: 'rollback-root',
          },
        })
        .mockReturnValueOnce({
          ok: false,
          message: 'Disk write failed.',
          filePath: 'notes/other.md',
        }),
      rollbackFile: vi.fn(() => ({ ok: false as const, message: 'Rollback failed.' })),
    };

    const result = await applyMultiFileProposal({
      proposal,
      workspaceId: 'workspace-1',
      backend,
      confirmedGuardedApplyToken: confirmationToken(proposal),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.rollbackStatus).toBe('incomplete');
    }
  });
});

function confirmationToken(proposal: AiChangeProposal): string {
  return buildGuardedApplyConfirmation(proposal).token;
}

function cleanPreflightStates(): MultiFileApplyPreflightFileState[] {
  return [
    {
      path: 'notes/root.md',
      exists: true,
      version: proposalFixtureFileVersion,
      writable: true,
    },
    {
      path: 'notes/other.md',
      exists: true,
      version: proposalFixtureOtherFileVersion,
      writable: true,
    },
  ];
}

function savedVersion(suffix: string) {
  return {
    token: `saved:${suffix}`,
    modifiedAt: '2026-05-10T00:00:00.000Z',
    byteSize: 100,
    contentHash: `saved-${suffix}`,
  };
}

function withAffectedPath(proposal: AiChangeProposal, path: string): AiChangeProposal {
  return {
    ...proposal,
    affectedFiles: [
      {
        ...proposal.affectedFiles[0],
        path,
      },
      ...proposal.affectedFiles.slice(1),
    ],
  };
}
