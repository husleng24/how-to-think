import { invoke } from '@tauri-apps/api/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, vi } from 'vitest';

import App from './App';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('App shell', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it('renders the workspace-aware shell surface', async () => {
    render(<App />);

    const editor = screen.getByRole('main', { name: /mind map editor/i });

    expect(editor).toBeInTheDocument();
    expect(await screen.findByLabelText(/workspace path/i)).toBeVisible();
    expect(
      await within(editor).findByRole('heading', { name: /select a workspace/i }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Mind map' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('button', { name: /ai unavailable/i })).toBeDisabled();
    expect(screen.getByText('No local AI provider is configured.')).toBeVisible();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

    const palette = await screen.findByRole('dialog', { name: /command palette/i });
    expect(within(palette).getByText('Go to Dashboard')).toBeVisible();

    fireEvent.keyDown(screen.getByPlaceholderText(/search commands/i), { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /command palette/i })).not.toBeInTheDocument(),
    );
  });
});
