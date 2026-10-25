export function getPresenceParticipants(awarenessStates, localClientId) {
  return Array.from(awarenessStates, ([clientId, state]) => {
    const name = typeof state?.user?.name === 'string' ? state.user.name.trim() : '';
    if (!name || !Number.isSafeInteger(clientId)) return null;

    const color = typeof state.user.color === 'string' && /^#[\da-f]{6}$/i.test(state.user.color)
      ? state.user.color
      : '#64748b';

    return { name, color, clientId, isCurrentSession: clientId === localClientId };
  }).filter(Boolean).sort((a, b) => a.clientId - b.clientId);
}

export function getVisiblePresenceParticipants(participants, connectionStatus) {
  return connectionStatus === 'connected' ? participants : [];
}
