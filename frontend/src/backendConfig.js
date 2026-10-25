export const DEFAULT_BACKEND_HTTP_URL = 'http://127.0.0.1:3001';

export function resolveBackendUrls(configuredEndpoint) {
  const value = typeof configuredEndpoint === 'string' && configuredEndpoint.trim()
    ? configuredEndpoint.trim()
    : DEFAULT_BACKEND_HTTP_URL;
  let endpoint;

  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('VITE_BACKEND_URL must be a valid backend origin.');
  }

  const localHttp = endpoint.protocol === 'http:'
    && ['localhost', '127.0.0.1'].includes(endpoint.hostname);
  const secureHttp = endpoint.protocol === 'https:';
  if ((!localHttp && !secureHttp) || endpoint.username || endpoint.password
    || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('VITE_BACKEND_URL must be an HTTPS origin or a local HTTP origin.');
  }

  const scheme = secureHttp ? 'wss:' : 'ws:';
  return {
    backendHttpUrl: endpoint.origin,
    backendWebSocketUrl: `${scheme}//${endpoint.host}`,
  };
}

const configuredEndpoint = import.meta.env?.VITE_BACKEND_URL;
const backendUrls = resolveBackendUrls(configuredEndpoint);

export const backendHttpUrl = backendUrls.backendHttpUrl;
export const backendWebSocketUrl = backendUrls.backendWebSocketUrl;
