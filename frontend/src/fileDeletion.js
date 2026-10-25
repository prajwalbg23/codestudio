export async function requestFileDeletion({ backendHttpUrl, fileName, clientId, fetchImpl = fetch }) {
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
  try {
    const response = await fetchImpl(
      `${backendHttpUrl}/api/files/${encodeURIComponent(fileName)}${query}`,
      { method: 'DELETE' },
    );
    if (response.ok) return { ok: true };

    let message = response.status >= 500 ? 'Could not delete the file.' : 'Could not delete the file.';
    let code = null;
    try {
      const body = await response.json();
      if (typeof body.error === 'string') message = body.error;
      if (typeof body.code === 'string') code = body.code;
    } catch {
      // Keep a safe fallback when the backend does not return JSON.
    }
    return { ok: false, status: response.status, code, message };
  } catch {
    return { ok: false, status: 0, code: 'network_error', message: 'Could not reach the backend to delete the file.' };
  }
}

export function getFileDeletionTransition(result, activeFile, fileName) {
  const closeActiveSession = Boolean(result?.ok && activeFile === fileName);
  return {
    activeFile: closeActiveSession ? '' : activeFile,
    closeActiveSession,
  };
}
