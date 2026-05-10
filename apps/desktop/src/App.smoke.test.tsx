import { invoke } from '@tauri-apps/api/core';
import { render, screen, within } from '@testing-library/react';
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

  it('renders the mind map editor surface', async () => {
    render(<App />);

    const editor = screen.getByRole('main', { name: /mind map editor/i });

    expect(editor).toBeInTheDocument();
    expect(within(editor).getByRole('button', { name: 'Untitled thought' })).toBeVisible();
    expect(within(editor).getByRole('button', { name: /fit to content/i })).toBeEnabled();
    expect(await screen.findByLabelText(/workspace path/i)).toBeVisible();
    expect(screen.getByText('Local Markdown')).toBeVisible();
    expect(screen.getByRole('button', { name: /ai unavailable/i })).toBeDisabled();
    expect(screen.getByText('No local AI provider is configured.')).toBeVisible();
  });
});
