import { fileURLToPath } from 'node:url';

export function validateRailwayBackendUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('VITE_BACKEND_URL must be configured as an HTTPS backend origin for the Railway build.');
  }

  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('VITE_BACKEND_URL must be configured as an HTTPS backend origin for the Railway build.');
  }

  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
    || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
    || ![endpoint.origin, `${endpoint.origin}/`].includes(value)) {
    throw new Error('VITE_BACKEND_URL must be configured as an HTTPS backend origin for the Railway build.');
  }
  return endpoint.origin;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    validateRailwayBackendUrl(process.env.VITE_BACKEND_URL);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
