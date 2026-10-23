export const UNAVAILABLE_ROOM_CLOSE_CODE = 1011;
export const UNAVAILABLE_ROOM_CLOSE_REASON = 'Document history unavailable';

export function isUnavailableRoomClose(event) {
  return event?.code === UNAVAILABLE_ROOM_CLOSE_CODE
    && event.reason === UNAVAILABLE_ROOM_CLOSE_REASON;
}

export function getRoomUiState(roomState, editorReady) {
  const status = !roomState.file ? 'idle'
    : roomState.unavailable ? 'unavailable'
      : roomState.connection === 'reconnecting' ? 'reconnecting'
        : roomState.connection === 'disconnected' ? 'disconnected'
          : roomState.connection === 'connecting' ? 'connecting'
            : roomState.synced ? 'connected' : 'synchronizing';

  return {
    status,
    unavailable: Boolean(roomState.unavailable),
    showCollaborators: !roomState.unavailable,
    editorReadOnly: !editorReady || status !== 'connected' || !roomState.synced,
  };
}

/** Owns all resources for one room session and disposes them at most once. */
export function createCollaborationSession({
  provider,
  binding,
  ydoc,
  cursorStyle,
  isCurrent = () => true,
  onAwarenessChange,
  onStatus,
  onSync,
  onConnectionError,
  onUnavailable,
  onDisposed,
}) {
  let disposed = false;
  const guard = callback => (...args) => {
    if (!disposed && isCurrent()) callback?.(...args);
  };

  const awarenessChange = guard(onAwarenessChange);
  const statusChange = guard(onStatus);
  const syncChange = guard(onSync);
  const connectionError = guard(onConnectionError);
  const connectionClose = event => {
    if (disposed || !isCurrent() || !isUnavailableRoomClose(event)) return;
    try {
      onUnavailable?.();
    } finally {
      dispose();
    }
  };

  provider.awareness.on('change', awarenessChange);
  provider.on('status', statusChange);
  provider.on('sync', syncChange);
  provider.on('connection-error', connectionError);
  provider.on('connection-close', connectionClose);

  function dispose() {
    if (disposed) return;
    disposed = true;

    const cleanup = [
      () => provider.awareness.off('change', awarenessChange),
      () => provider.off('status', statusChange),
      () => provider.off('sync', syncChange),
      () => provider.off('connection-error', connectionError),
      () => provider.off('connection-close', connectionClose),
      () => provider.awareness.setLocalState(null),
      () => binding.destroy(),
      () => provider.destroy(),
      () => ydoc.destroy(),
      () => cursorStyle.remove(),
      () => onDisposed?.(),
    ];

    // Attempt every release even if one library cleanup step throws.
    for (const release of cleanup) {
      try { release(); } catch { /* Continue releasing the remaining session resources. */ }
    }
  }

  return {
    dispose,
    get disposed() { return disposed; },
  };
}
