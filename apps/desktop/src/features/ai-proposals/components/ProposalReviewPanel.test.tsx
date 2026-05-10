import { fireEvent, render, screen, within } from '@testing-library/react';

import {
  createDeletionProposalFixture,
  createEmptyProposalSuggestionFixture,
  createInvalidProposalSuggestionFixture,
  createMultiFileProposalFixture,
  createProposalFixtureContext,
  createProposalReview,
  createProposalReviewEditorSnapshot,
  createStaleProposalReviewFixture,
  receiveAiConversationProposal,
} from '../index';
import { ProposalReviewPanel } from './ProposalReviewPanel';

describe('ProposalReviewPanel', () => {
  it('renders invalid and empty proposal reasons with accept disabled', () => {
    const invalidReview = receiveAiConversationProposal({
      suggestion: createInvalidProposalSuggestionFixture(),
      validationContext: createProposalFixtureContext(),
      editorSnapshot: createProposalReviewEditorSnapshot(),
    });

    render(<ProposalReviewPanel review={invalidReview} />);

    expect(screen.getByText('Failed')).toBeVisible();
    expect(screen.getAllByText('Path outside workspace')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /accept whole proposal/i })).toBeDisabled();

    const emptyReview = receiveAiConversationProposal({
      suggestion: createEmptyProposalSuggestionFixture(),
      validationContext: createProposalFixtureContext(),
      editorSnapshot: createProposalReviewEditorSnapshot(),
    });

    render(<ProposalReviewPanel review={emptyReview} />);
    expect(screen.getByText('Empty proposal')).toBeVisible();
  });

  it('renders stale conflicts and prevents accepting them', () => {
    render(<ProposalReviewPanel review={createStaleProposalReviewFixture()} />);

    expect(screen.getByText('Conflict')).toBeVisible();
    expect(screen.getByText('Document changed since proposal')).toBeVisible();
    expect(screen.getByRole('button', { name: /accept whole proposal/i })).toBeDisabled();
  });

  it('renders deletion warnings and exposes whole-proposal actions only', () => {
    const onConfirmRiskFlag = vi.fn();
    const review = createProposalReview(
      createDeletionProposalFixture(),
      createProposalReviewEditorSnapshot(),
    );

    render(<ProposalReviewPanel review={review} onConfirmRiskFlag={onConfirmRiskFlag} />);

    expect(screen.getByText('Deletion warning')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /node deletion/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /accept whole proposal/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /accept operation/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /partial/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /node deletion/i }));
    expect(onConfirmRiskFlag).toHaveBeenCalledWith('node_deletion', review);
  });

  it('renders multi-file scope, affected files, and Markdown previews', () => {
    const review = createProposalReview(
      createMultiFileProposalFixture(),
      createProposalReviewEditorSnapshot(),
    );
    render(<ProposalReviewPanel review={review} />);

    expect(screen.getByText('Multiple files (2)')).toBeVisible();
    expect(screen.getByText('Multi-file warning')).toBeVisible();

    const affectedFiles = screen.getByRole('region', { name: /affected files/i });
    expect(within(affectedFiles).getByText('notes/root.md')).toBeVisible();
    expect(within(affectedFiles).getByText('notes/other.md')).toBeVisible();

    expect(screen.getByLabelText('Before notes/root.md')).toHaveTextContent('Alpha');
    expect(screen.getByLabelText('After notes/other.md')).toHaveTextContent('Beta revised');
    expect(screen.getByRole('button', { name: /accept whole proposal/i })).toBeDisabled();
  });
});
