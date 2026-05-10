import { render, screen, within } from '@testing-library/react';

import App from './App';

describe('App shell', () => {
  it('renders the mind map editor surface', () => {
    render(<App />);

    const editor = screen.getByRole('main', { name: /mind map editor/i });

    expect(editor).toBeInTheDocument();
    expect(within(editor).getByRole('button', { name: 'Untitled thought' })).toBeVisible();
    expect(within(editor).getByRole('button', { name: /fit to content/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /open markdown/i })).toBeEnabled();
    expect(screen.getByText('Local Markdown')).toBeVisible();
  });
});
