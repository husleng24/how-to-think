import { describe, expect, it } from 'vitest';

import { createWorkspaceLifecycleFixture } from './testFixtures';

describe('workspace lifecycle test fixtures', () => {
  it('generates a compact local-first workspace with Markdown edge cases', () => {
    const fixture = createWorkspaceLifecycleFixture();
    const indexedPaths = fixture.files().map((file) => file.relativePath);

    expect(indexedPaths).toEqual([
      'README.md',
      'notes/empty.md',
      'notes/plain.md',
      'notes/plan.md',
      'projects/restart.md',
    ]);
    expect(fixture.markdownFiles['notes/empty.md']).toBe('');
    expect(fixture.markdownFiles['notes/plain.md']).toContain('prose only');
    expect(fixture.nonMarkdownPaths).toEqual(['assets/diagram.png', 'notes/todo.txt']);
    expect(fixture.skippedMarkdownPaths).toEqual([
      '.git/ignored.md',
      'node_modules/pkg/readme.md',
      'target/generated.md',
    ]);
  });

  it('builds restartable session, open, and save payloads with stable file versions', () => {
    const fixture = createWorkspaceLifecycleFixture();
    const session = fixture.session({ lastOpenedFile: 'projects/restart.md' });
    const opened = fixture.openResult('projects/restart.md');
    const saved = fixture.savedResult('projects/restart.md', {
      markdown: '# Restart\n\n## Saved after restart\n',
    });

    expect(session.lastOpenedFile).toBe('projects/restart.md');
    expect(opened.snapshot.content).toBe(fixture.markdownFiles['projects/restart.md']);
    expect(saved.save?.version.token).toBe('saved-token');
    expect(saved.markdown).toBe('# Restart\n\n## Saved after restart\n');
  });
});
