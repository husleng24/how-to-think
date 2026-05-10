import { spawnSync } from 'node:child_process';

const shouldRunDesktopSmoke = process.env.HTT_RUN_TAURI_SMOKE === '1';

if (!shouldRunDesktopSmoke) {
  console.log(
    'SKIP desktop smoke: set HTT_RUN_TAURI_SMOKE=1 to run the optional Tauri prerequisite check.',
  );
  process.exit(0);
}

const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
if (cargo.status !== 0) {
  console.log('SKIP desktop smoke: Rust/Cargo is not available in this environment.');
  process.exit(0);
}

const tauri = spawnSync('npx', ['tauri', '--version'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

if (tauri.status !== 0) {
  console.log('SKIP desktop smoke: Tauri CLI is not available in this environment.');
  process.exit(0);
}

console.log(`Desktop smoke prerequisites available: ${cargo.stdout.trim()}; ${tauri.stdout.trim()}`);
console.log('Launch smoke command: npm run tauri:dev');
