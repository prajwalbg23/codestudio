import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createCollaborationSession,
  getRoomUiState,
  isUnavailableRoomClose,
} from '../src/collaborationLifecycle.js';
import { getPresenceParticipants } from '../src/collaboratorPresence.js';

function makeSession({ isCurrent = () => true, onUnavailable = () => {}, onStatus = () => {}, onAwarenessChange = () => {} } = {}) {
  const calls = { binding: 0, provider: 0, doc: 0, style: 0, awarenessNull: 0, unavailable: 0, status: [] };
  const provider = new EventEmitter();
  provider.awareness = new EventEmitter();
  provider.awareness.clientID = 1;
  provider.awareness.setLocalState = state => {
    if (state === null) calls.awarenessNull += 1;
  };
  provider.destroy = () => { calls.provider += 1; };
  const binding = { destroy: () => { calls.binding += 1; } };
  const ydoc = { destroy: () => { calls.doc += 1; } };
  const cursorStyle = { remove: () => { calls.style += 1; } };
  const session = createCollaborationSession({
    provider,
    binding,
    ydoc,
    cursorStyle,
    isCurrent,
    onAwarenessChange,
    onUnavailable: () => { calls.unavailable += 1; onUnavailable(); },
    onStatus: status => { calls.status.push(status); onStatus(status); },
  });
  return { calls, provider, session };
}

test('awareness changes update join and leave snapshots and stop after session cleanup', () => {
  let states = new Map([[1, { user: { name: 'Local' } }]]);
  let latestParticipants = [];
  const { provider, session } = makeSession({
    onAwarenessChange: () => {
      latestParticipants = getPresenceParticipants(states, provider.awareness.clientID);
    },
  });

  provider.awareness.emit('change');
  assert.deepEqual(latestParticipants.map(person => person.name), ['Local']);

  states = new Map([...states, [2, { user: { name: 'Remote' } }]]);
  provider.awareness.emit('change');
  assert.deepEqual(latestParticipants.map(person => person.name), ['Local', 'Remote']);

  states.delete(2);
  provider.awareness.emit('change');
  assert.deepEqual(latestParticipants.map(person => person.name), ['Local']);

  session.dispose();
  states = new Map([[3, { user: { name: 'Late participant' } }]]);
  provider.awareness.emit('change');
  assert.deepEqual(latestParticipants.map(person => person.name), ['Local']);
});

test('explicit unavailable-room rejection immediately disposes every session resource', () => {
  const { calls, provider, session } = makeSession();
  provider.emit('connection-close', { code: 1011, reason: 'Document history unavailable' });

  assert.equal(session.disposed, true);
  assert.deepEqual(calls, {
    binding: 1, provider: 1, doc: 1, style: 1, awarenessNull: 1,
    unavailable: 1, status: [],
  });
  assert.equal(provider.listenerCount('status'), 0);
  assert.equal(provider.listenerCount('sync'), 0);
  assert.equal(provider.listenerCount('connection-error'), 0);
  assert.equal(provider.listenerCount('connection-close'), 0);
  assert.equal(provider.awareness.listenerCount('change'), 0);
});

test('the same teardown path releases the prior session on file switch and unmount', () => {
  for (const lifecycleEnd of ['file switch', 'component unmount']) {
    const { calls, session } = makeSession();
    session.dispose();
    assert.equal(session.disposed, true, lifecycleEnd);
    assert.deepEqual(calls, {
      binding: 1, provider: 1, doc: 1, style: 1, awarenessNull: 1,
      unavailable: 0, status: [],
    }, lifecycleEnd);
  }
});

test('repeated teardown is safe and does not destroy resources twice', () => {
  const { calls, session } = makeSession();
  assert.doesNotThrow(() => {
    session.dispose();
    session.dispose();
  });
  assert.equal(calls.binding, 1);
  assert.equal(calls.provider, 1);
  assert.equal(calls.doc, 1);
  assert.equal(calls.style, 1);
  assert.equal(calls.awarenessNull, 1);
});

test('late events from a disposed or superseded session cannot update current state', () => {
  let current = true;
  const { calls, provider, session } = makeSession({ isCurrent: () => current });
  const lateStatusCallback = provider.listeners('status')[0];
  session.dispose();
  lateStatusCallback({ status: 'connected' });
  assert.deepEqual(calls.status, []);

  const second = makeSession({ isCurrent: () => current });
  const staleSessionCallback = second.provider.listeners('status')[0];
  current = false;
  staleSessionCallback({ status: 'connected' });
  assert.deepEqual(second.calls.status, []);
  second.session.dispose();
});

test('unavailable room view remains read-only and hides collaborator presence', () => {
  const view = getRoomUiState({
    file: 'script.js', connection: 'unavailable', synced: false, unavailable: true,
  }, true);
  assert.equal(view.status, 'unavailable');
  assert.equal(view.editorReadOnly, true);
  assert.equal(view.showCollaborators, false);
});

test('generic WebSocket disconnection is not classified as unavailable history', () => {
  assert.equal(isUnavailableRoomClose({ code: 1006, reason: '' }), false);
  assert.equal(isUnavailableRoomClose({ code: 1011, reason: 'Document history unavailable' }), true);

  const { calls, provider, session } = makeSession();
  provider.emit('connection-close', { code: 1006, reason: '' });
  provider.emit('status', { status: 'disconnected' });
  assert.equal(session.disposed, false);
  assert.equal(calls.unavailable, 0);
  assert.deepEqual(calls.status, [{ status: 'disconnected' }]);
  session.dispose();
});
