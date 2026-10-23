const BACKEND_BIND_HOST = '127.0.0.1';

// Vite's unconfigured development and preview servers use ports 5173 and 4173.
// Both host spellings are included because browsers preserve the URL host in Origin.
const ALLOWED_FRONTEND_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]);

function isAllowedFrontendOrigin(origin) {
  return typeof origin === 'string' && ALLOWED_FRONTEND_ORIGINS.has(origin);
}

module.exports = { BACKEND_BIND_HOST, ALLOWED_FRONTEND_ORIGINS, isAllowedFrontendOrigin };
