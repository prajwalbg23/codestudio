const configuredHttpEndpoint = import.meta.env.VITE_BACKEND_URL?.trim();
const normalizedHttpEndpoint = (configuredHttpEndpoint || 'http://127.0.0.1:3001').replace(/\/+$/, '');
let parsedEndpoint;

try {
  parsedEndpoint = new URL(normalizedHttpEndpoint);
} catch {
  throw new Error('VITE_BACKEND_URL must be a valid local HTTP URL.');
}

if (parsedEndpoint.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(parsedEndpoint.hostname)
  || parsedEndpoint.username || parsedEndpoint.password || parsedEndpoint.pathname !== '/'
  || parsedEndpoint.search || parsedEndpoint.hash) {
  throw new Error('VITE_BACKEND_URL must point to a local HTTP backend on localhost or 127.0.0.1.');
}

export const backendHttpUrl = parsedEndpoint.origin;
export const backendWebSocketUrl = backendHttpUrl.replace(/^http:/i, 'ws:');
