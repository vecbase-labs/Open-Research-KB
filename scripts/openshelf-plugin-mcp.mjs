#!/usr/bin/env node
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultDataDir = process.env.CLAUDE_PLUGIN_DATA
  ? path.join(process.env.CLAUDE_PLUGIN_DATA, 'data')
  : path.join(os.homedir(), '.openshelf', 'data');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tsxCli = path.join(pluginRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const requiredRuntimePaths = [
  path.join(pluginRoot, 'node_modules', '@modelcontextprotocol', 'server'),
  path.join(pluginRoot, 'node_modules', '@duckdb', 'node-api'),
  tsxCli,
];

if (requiredRuntimePaths.some(requiredPath => !existsSync(requiredPath))) {
  const install = spawnSync(npmCommand, ['install', '--silent'], {
    cwd: pluginRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (install.status !== 0) {
    process.exit(install.status ?? 1);
  }
}

const child = spawn(process.execPath, [tsxCli, path.join(pluginRoot, 'src-ts', 'server.ts')], {
  cwd: pluginRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    OPENSHELF_DATA_DIR: process.env.OPENSHELF_DATA_DIR ?? defaultDataDir,
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', error => {
  console.error(error);
  process.exit(1);
});
