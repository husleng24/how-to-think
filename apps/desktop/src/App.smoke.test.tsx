import { invoke } from '@tauri-apps/api/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, vi } from 'vitest';

import App from './App';
import './styles.css';

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

  it('renders viewport-constrained desktop status surfaces', async () => {
    render(<App />);

    const shell = document.querySelector('.app-shell-root');
    const editor = await screen.findByRole('main', { name: /mind map editor/i });

    expect(shell).toBeInstanceOf(HTMLElement);
    expect(getComputedStyle(document.body).overflow).toBe('hidden');
    expect(getComputedStyle(shell as HTMLElement).display).toBe('grid');
    expect(getComputedStyle(editor).overflow).toBe('auto');
    expect(screen.getByRole('region', { name: 'Workspace status overview' })).toBeVisible();
    expect(screen.getAllByText('Index idle').length).toBeGreaterThan(0);
    expect(screen.getAllByText('AI blocked').length).toBeGreaterThan(0);
  });
});
