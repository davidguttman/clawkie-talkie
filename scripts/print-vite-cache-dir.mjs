import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { viteCacheDirForRepo } from './vite-cache-dir.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

console.log(viteCacheDirForRepo(repoRoot));
