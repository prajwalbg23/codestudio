const net = require('node:net');

const DEFAULT_BACKEND_BIND_HOST = '127.0.0.1';
const DEFAULT_BACKEND_PORT = 3001;

// Vite's unconfigured development and preview servers use ports 5173 and 4173.
// Both host spellings are included because browsers preserve the URL host in Origin.
const DEVELOPMENT_FRONTEND_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]);

function resolveBackendBindHost(env = process.env) {
  const host = typeof env.CODESTUDIO_BIND_HOST === 'string' && env.CODESTUDIO_BIND_HOST.trim()
    ? env.CODESTUDIO_BIND_HOST.trim()
    : DEFAULT_BACKEND_BIND_HOST;
  if (host !== 'localhost' && net.isIP(host) === 0) {
    throw new Error('CODESTUDIO_BIND_HOST must be localhost or an IP address.');
  }
  return host;
}

function resolveBackendPort(env = process.env) {
  const port = env.PORT === undefined || env.PORT === '' ? DEFAULT_BACKEND_PORT : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535.');
  }
  return port;
}

function isLoopbackBindHost(host) {
  if (host === 'localhost' || host === '::1') return true;
  if (typeof host !== 'string' || net.isIP(host) !== 4) return false;
  const firstOctet = Number(host.split('.')[0]);
  return firstOctet === 127;
}

function assertPublicBindDisabled(host) {
  if (!isLoopbackBindHost(host)) {
    throw new Error('Public backend binding remains disabled pending an explicit network-boundary change and deployment review.');
  }
}

function parseProductionFrontendOrigins(value) {
  if (value === undefined) return new Set();
  if (typeof value !== 'string') {
    throw new Error('CODESTUDIO_FRONTEND_ORIGINS must be a comma-separated list of exact HTTPS origins.');
  }
  if (value.trim() === '') return new Set();
  const entries = value.split(',').map(entry => entry.trim());
  if (entries.some(entry => !entry || entry === '*')) {
    throw new Error('CODESTUDIO_FRONTEND_ORIGINS must be a comma-separated list of exact HTTPS origins.');
  }
  const origins = new Set();
  for (const entry of entries) {
    let parsed;
    try {
      parsed = new URL(entry);
    } catch {
      throw new Error('CODESTUDIO_FRONTEND_ORIGINS contains an invalid origin.');
    }
    if (parsed.protocol !== 'https:' || parsed.origin !== entry || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('CODESTUDIO_FRONTEND_ORIGINS must contain exact HTTPS origins without paths or credentials.');
    }
    origins.add(parsed.origin);
  }
  return origins;
}

function resolveAllowedFrontendOrigins(env = process.env) {
  if (env.CODESTUDIO_FRONTEND_ORIGINS !== undefined
    && typeof env.CODESTUDIO_FRONTEND_ORIGINS !== 'string') {
    throw new Error('CODESTUDIO_FRONTEND_ORIGINS must be a comma-separated list of exact HTTPS origins.');
  }
  const productionOrigins = parseProductionFrontendOrigins(env.CODESTUDIO_FRONTEND_ORIGINS);
  if (env.NODE_ENV === 'production' && productionOrigins.size === 0) {
    throw new Error('CODESTUDIO_FRONTEND_ORIGINS is required in production.');
  }
  return env.NODE_ENV === 'production'
    ? productionOrigins
    : new Set([...DEVELOPMENT_FRONTEND_ORIGINS, ...productionOrigins]);
}

const BACKEND_BIND_HOST = resolveBackendBindHost();
const BACKEND_PORT = resolveBackendPort();
const ALLOWED_FRONTEND_ORIGINS = resolveAllowedFrontendOrigins();

function isAllowedFrontendOrigin(origin, allowedOrigins = ALLOWED_FRONTEND_ORIGINS) {
  return typeof origin === 'string' && allowedOrigins.has(origin);
}

module.exports = {
  DEFAULT_BACKEND_BIND_HOST,
  DEFAULT_BACKEND_PORT,
  DEVELOPMENT_FRONTEND_ORIGINS,
  BACKEND_BIND_HOST,
  BACKEND_PORT,
  ALLOWED_FRONTEND_ORIGINS,
  assertPublicBindDisabled,
  isAllowedFrontendOrigin,
  isLoopbackBindHost,
  parseProductionFrontendOrigins,
  resolveAllowedFrontendOrigins,
  resolveBackendBindHost,
  resolveBackendPort,
};
