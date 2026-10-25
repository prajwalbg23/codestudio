let accessToken = null;

export function setAccessToken(token) {
  accessToken = typeof token === 'string' && token ? token : null;
}

export function clearAccessToken() {
  accessToken = null;
}

export function authenticatedFetch(input, options = {}) {
  const headers = new Headers(options.headers || {});
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  return fetch(input, { ...options, headers }).then(response => {
    if (response.status === 401) window.dispatchEvent(new Event('codestudio-auth-expired'));
    return response;
  });
}
