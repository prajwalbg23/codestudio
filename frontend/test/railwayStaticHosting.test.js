import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateRailwayBackendUrl } from '../scripts/validateRailwayBuildConfig.mjs';

const frontendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Railway frontend build requires an HTTPS backend origin', () => {
  assert.equal(validateRailwayBackendUrl('https://api.example.test'), 'https://api.example.test');
  assert.equal(validateRailwayBackendUrl('https://api.example.test/'), 'https://api.example.test');
  for (const value of [undefined, '', 'http://api.example.test', 'https://api.example.test/api', 'https://user:pass@api.example.test']) {
    assert.throws(() => validateRailwayBackendUrl(value), /HTTPS backend origin/);
  }
});

test('Railway frontend container builds with the backend URL and serves an SPA on the assigned port', () => {
  const dockerfile = fs.readFileSync(path.join(frontendDirectory, 'Dockerfile'), 'utf8');
  const caddyfile = fs.readFileSync(path.join(frontendDirectory, 'Caddyfile'), 'utf8');
  const dockerignore = fs.readFileSync(path.join(frontendDirectory, '.dockerignore'), 'utf8');

  assert.match(dockerfile, /ARG VITE_BACKEND_URL/);
  assert.match(dockerfile, /scripts\/validateRailwayBuildConfig\.mjs/);
  assert.match(dockerfile, /npm run build/);
  assert.match(dockerfile, /FROM caddy:2-alpine/);
  assert.match(dockerfile, /COPY --from=frontend-build \/frontend\/dist \/srv/);
  assert.match(dockerfile, /CMD \["caddy", "run"/);
  assert.match(caddyfile, /:\{\$PORT:3000\}/);
  assert.match(caddyfile, /try_files \{path\} \/index\.html/);
  assert.match(caddyfile, /file_server/);
  assert.match(dockerignore, /^\.env\*$/m);
  assert.match(dockerignore, /^node_modules$/m);
  assert.match(dockerignore, /^dist$/m);
});
