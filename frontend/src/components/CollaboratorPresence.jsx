import { Users } from 'lucide-react';

export default function CollaboratorPresence({ participants, connectionStatus }) {
  const localParticipant = participants.find(participant => participant.isCurrentSession);
  const remoteParticipants = participants.filter(participant => !participant.isCurrentSession);
  const duplicateNames = remoteParticipants.reduce((counts, participant) => {
    counts.set(participant.name, (counts.get(participant.name) || 0) + 1);
    return counts;
  }, new Map());
  const seenNames = new Map();

  const renderParticipant = (participant, isLocal = false) => {
    const seen = isLocal ? 0 : (seenNames.get(participant.name) || 0) + 1;
    if (!isLocal) seenNames.set(participant.name, seen);
    const duplicateSuffix = !isLocal && duplicateNames.get(participant.name) > 1 ? ` · ${seen}` : '';
    const label = isLocal ? `You · ${participant.name}` : `${participant.name}${duplicateSuffix}`;

    return (
      <div className="presence-person" key={participant.clientId} title={label}>
        <span className="presence-avatar" style={{ backgroundColor: participant.color }} aria-hidden="true">
          {participant.name.charAt(0).toUpperCase()}
          {duplicateSuffix && <span className="presence-index">{seen}</span>}
        </span>
        <span className="presence-name">{label}</span>
      </div>
    );
  };

  return (
    <div className="header-presence" role="group" aria-label="Collaboration presence">
      {localParticipant && renderParticipant(localParticipant, true)}
      {remoteParticipants.map(participant => renderParticipant(participant))}
      {connectionStatus === 'connected' && remoteParticipants.length === 0 && (
        <span className="presence-empty"><Users size={15} aria-hidden="true" /> No other collaborators connected</span>
      )}
      {connectionStatus !== 'connected' && (
        <span className="presence-empty paused"><Users size={15} aria-hidden="true" /> Presence appears after synchronization</span>
      )}
    </div>
  );
}
