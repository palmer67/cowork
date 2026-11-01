import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoInfo } from '../src/git.ts';
import { stateRoot } from '../src/store.ts';
import { removeTree } from './helpers.ts';

export const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

export function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/\r?\n$/, '');
}

export function cw(root: string, args: string[], agent = 'codex') {
  return spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20_000,
    env: { ...process.env, COWORK_AGENT_ID: agent, NODE_NO_WARNINGS: '1' },
  });
}

export function makeRepo(prefix = 'cowork-m3-') {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.name', 'test'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  git(['config', 'core.longpaths', 'true'], root);
  mkdirSync(path.join(root, '.cowork'), { recursive: true });
  writeFileSync(path.join(root, '.cowork', 'config.json'), JSON.stringify({ schemaVersion: 1, trunk: 'main' }));
  writeFileSync(path.join(root, '.gitignore'), '.cowork/lanes/\n');
  writeFileSync(path.join(root, 'shared.txt'), Array.from({ length: 80 }, (_, n) => `line ${n + 1}`).join('\n') + '\n');
  git(['add', '.'], root);
  git(['commit', '-qm', 'init'], root);
  const info = repoInfo(root);
  return { root, info, state: stateRoot(info), cleanup: () => removeTree(root) };
}

export function lane(root: string, name: string): string {
  const dir = path.join(root, '.cowork', 'lanes', name);
  git(['worktree', 'add', '-q', '-b', `dsh/${name}`, dir, 'main'], root);
  return dir;
}
