/* global process, console */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'how-to-think-git-spike-'));
const authorEnv = {
  GIT_AUTHOR_NAME: 'How to Think Spike',
  GIT_AUTHOR_EMAIL: 'spike@example.invalid',
  GIT_COMMITTER_NAME: 'How to Think Spike',
  GIT_COMMITTER_EMAIL: 'spike@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...authorEnv, ...options.env },
    encoding: 'utf8',
    shell: false,
  });

  return {
    command: `${command} ${args.join(' ')}`,
    cwd: options.cwd,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    ok: result.error == null && result.status === 0,
    error: result.error?.message,
  };
}

function git(cwd, args) {
  return run('git', args, { cwd });
}

function requireOk(result) {
  if (!result.ok) {
    throw new Error(`${result.command} failed: ${result.stderr || result.error}`);
  }

  return result;
}

function initRepo(path) {
  mkdirSync(path, { recursive: true });
  requireOk(git(path, ['init']));
  requireOk(git(path, ['config', 'core.autocrlf', 'false']));
  requireOk(git(path, ['checkout', '-b', 'main']));
}

function commitAll(path, message) {
  requireOk(git(path, ['add', '--all']));
  requireOk(git(path, ['-c', 'commit.gpgsign=false', 'commit', '--no-gpg-sign', '-m', message]));
}

function repoProbe(path) {
  const topLevel = git(path, ['rev-parse', '--show-toplevel']);
  const bare = git(path, ['rev-parse', '--is-bare-repository']);
  const inside = git(path, ['rev-parse', '--is-inside-work-tree']);

  return {
    path,
    topLevel: topLevel.ok ? topLevel.stdout.replaceAll('\\', '/') : null,
    isBare: bare.ok ? bare.stdout === 'true' : null,
    insideWorkTree: inside.ok ? inside.stdout === 'true' : null,
    ok: topLevel.ok || bare.ok,
    error: topLevel.ok ? null : topLevel.stderr,
  };
}

function status(path) {
  return git(path, ['status', '--porcelain=v1', '-z']);
}

const results = {
  root,
  gitVersion: requireOk(run('git', ['--version'])).stdout,
  states: {},
  operations: {},
};

try {
  const notRepo = join(root, 'not-repo');
  mkdirSync(notRepo);
  results.states.notRepository = repoProbe(notRepo);

  const repo = join(root, 'repo');
  initRepo(repo);
  mkdirSync(join(repo, 'notes'));
  writeFileSync(join(repo, 'notes', 'idea.md'), '# Idea\n\nFirst version.\n');
  results.operations.statusAfterCreate = status(repo).stdout;
  commitAll(repo, 'Add idea');
  results.operations.historyAfterFirstCommit = requireOk(
    git(repo, ['log', '--oneline', '--max-count=5']),
  ).stdout;

  writeFileSync(join(repo, 'notes', 'idea.md'), '# Idea\n\nSecond version.\n');
  results.operations.diffAfterEdit = requireOk(
    git(repo, ['diff', '--no-ext-diff', '--no-color', '--', 'notes/idea.md']),
  ).stdout;
  requireOk(git(repo, ['restore', '--source=HEAD', '--', 'notes/idea.md']));
  results.operations.restoreFromHead = {
    status: requireOk(status(repo)).stdout,
    content: readFileSync(join(repo, 'notes', 'idea.md'), 'utf8'),
  };

  writeFileSync(join(repo, 'notes', 'idea.md'), '# Idea\n\nSecond version.\n');
  commitAll(repo, 'Update idea');
  requireOk(git(repo, ['restore', '--source=HEAD~1', '--', 'notes/idea.md']));
  results.operations.restoreOlderRevisionAsWorkingChange = {
    status: requireOk(status(repo)).stdout,
    content: readFileSync(join(repo, 'notes', 'idea.md'), 'utf8'),
  };
  requireOk(git(repo, ['restore', '--source=HEAD', '--', 'notes/idea.md']));

  results.states.validRepository = repoProbe(repo);

  const parent = join(root, 'parent');
  initRepo(parent);
  mkdirSync(join(parent, 'workspace'));
  results.states.parentRepository = repoProbe(join(parent, 'workspace'));

  const nestedParent = join(root, 'nested-parent');
  initRepo(nestedParent);
  const nested = join(nestedParent, 'workspace');
  initRepo(nested);
  results.states.nestedRepository = {
    selected: repoProbe(nested),
    ancestor: repoProbe(nestedParent),
  };

  requireOk(git(repo, ['checkout', '--detach', 'HEAD~1']));
  results.states.detachedHead = {
    symbolicRef: git(repo, ['symbolic-ref', '-q', '--short', 'HEAD']),
    revision: requireOk(git(repo, ['rev-parse', '--short', 'HEAD'])).stdout,
  };
  requireOk(git(repo, ['checkout', 'main']));

  const conflict = join(root, 'conflict');
  initRepo(conflict);
  writeFileSync(join(conflict, 'topic.md'), '# Topic\n\nbase\n');
  commitAll(conflict, 'Base');
  requireOk(git(conflict, ['checkout', '-b', 'side']));
  writeFileSync(join(conflict, 'topic.md'), '# Topic\n\nside\n');
  commitAll(conflict, 'Side edit');
  requireOk(git(conflict, ['checkout', 'main']));
  writeFileSync(join(conflict, 'topic.md'), '# Topic\n\nmain\n');
  commitAll(conflict, 'Main edit');
  const merge = git(conflict, ['merge', 'side']);
  results.states.mergeConflict = {
    mergeStatus: merge.status,
    unmergedPaths: git(conflict, ['diff', '--name-only', '--diff-filter=U']).stdout,
    porcelain: status(conflict).stdout,
  };

  const bare = join(root, 'bare.git');
  requireOk(run('git', ['init', '--bare', bare]));
  results.states.bareRepository = repoProbe(bare);

  const corrupt = join(root, 'corrupt');
  initRepo(corrupt);
  rmSync(join(corrupt, '.git', 'HEAD'));
  const corruptStatus = status(corrupt);
  results.states.corruptedRepository = {
    status: corruptStatus.status,
    stderr: corruptStatus.stderr,
  };

  console.log(JSON.stringify(results, null, 2));
} finally {
  if (process.env.KEEP_GIT_SPIKE_TEMP !== '1') {
    rmSync(root, { recursive: true, force: true });
  }
}
