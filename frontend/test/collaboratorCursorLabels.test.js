import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import { createCollaboratorCursorLabels } from '../src/collaboratorCursorLabels.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.document = dom.window.document;

function makeEditor(ytext) {
  const widgets = new Map();
  let layoutCalls = 0;
  const model = {
    getPositionAt(index) {
      const before = ytext.toString().slice(0, index).split('\n');
      return { lineNumber: before.length, column: before.at(-1).length + 1 };
    },
  };
  return {
    widgets,
    get layoutCalls() { return layoutCalls; },
    getModel: () => model,
    addContentWidget: widget => widgets.set(widget.getId(), widget),
    removeContentWidget: widget => widgets.delete(widget.getId()),
    layoutContentWidget: () => { layoutCalls += 1; },
  };
}

function selectionAt(ydoc, ytext, index) {
  const position = Y.createRelativePositionFromTypeIndex(ytext, index);
  return { anchor: position, head: position };
}

function makeHarness({ trackObservers = false } = {}) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('monaco');
  ytext.insert(0, 'first\nsecond');
  const observers = new Set();
  if (trackObservers) {
    const observe = ytext.observe.bind(ytext);
    const unobserve = ytext.unobserve.bind(ytext);
    ytext.observe = observer => { observers.add(observer); observe(observer); };
    ytext.unobserve = observer => { observers.delete(observer); unobserve(observer); };
  }
  const editor = makeEditor(ytext);
  const awareness = {
    clientID: 1,
    states: new Map([[1, { user: { name: 'Local', color: '#222222' } }]]),
    getStates() { return this.states; },
  };
  const monaco = { editor: { ContentWidgetPositionPreference: { ABOVE: 1 } } };
  const labels = createCollaboratorCursorLabels({ editor, monaco, awareness, ydoc, ytext });
  return { ydoc, ytext, editor, awareness, labels, observers };
}

test('cursor labels map Awareness client IDs to names, colors, and live head positions', () => {
  const { ydoc, ytext, editor, awareness, labels } = makeHarness();
  awareness.states.set(42, {
    user: { name: '  Alice  ', color: '#ff2200' },
    selection: selectionAt(ydoc, ytext, 8),
  });

  labels.update();
  assert.equal(labels.size, 1);
  const widget = editor.widgets.get('codestudio.remote-cursor.42');
  assert.ok(widget);
  assert.equal(widget.getDomNode().textContent, 'Alice');
  assert.equal(widget.getDomNode().style.backgroundColor, 'rgb(255, 34, 0)');
  assert.deepEqual(widget.getPosition().position, { lineNumber: 2, column: 3 });

  awareness.states.set(42, {
    user: { name: 'Alicia', color: '#00aa55' },
    selection: selectionAt(ydoc, ytext, 3),
  });
  labels.update();
  assert.equal(editor.widgets.size, 1, 'the same Awareness client keeps one widget');
  assert.equal(widget.getDomNode().textContent, 'Alicia');
  assert.equal(widget.getDomNode().style.backgroundColor, 'rgb(0, 170, 85)');
  assert.deepEqual(widget.getPosition().position, { lineNumber: 1, column: 4 });

  labels.dispose();
  ydoc.destroy();
});

test('missing or invalid identity data does not create cursor labels', () => {
  const { ydoc, ytext, editor, awareness, labels } = makeHarness();
  const cursor = selectionAt(ydoc, ytext, 2);
  awareness.states.set(2, { user: { color: '#00aa55' }, selection: cursor });
  awareness.states.set(3, { user: { name: 'No color', color: 'red' }, selection: cursor });
  awareness.states.set(4, { user: { name: 'No cursor', color: '#00aa55' } });
  labels.update();
  assert.equal(editor.widgets.size, 0);
  assert.equal(labels.size, 0);
  labels.dispose();
  ydoc.destroy();
});

test('participant departure removes its label and reconnect restores it from fresh Awareness', () => {
  const { ydoc, ytext, editor, awareness, labels } = makeHarness();
  awareness.states.set(17, {
    user: { name: 'Remote', color: '#3366cc' },
    selection: selectionAt(ydoc, ytext, 1),
  });
  labels.update();
  assert.equal(labels.size, 1);

  awareness.states.delete(17);
  labels.update();
  assert.equal(labels.size, 0);
  assert.equal(editor.widgets.size, 0);

  awareness.states.set(17, {
    user: { name: 'Remote', color: '#3366cc' },
    selection: selectionAt(ydoc, ytext, 6),
  });
  labels.update();
  assert.equal(labels.size, 1);
  assert.equal(editor.widgets.get('codestudio.remote-cursor.17').getDomNode().textContent, 'Remote');

  labels.clear();
  assert.equal(labels.size, 0);
  assert.equal(editor.widgets.size, 0);
  labels.dispose();
  ydoc.destroy();
});

test('Y.Text insertions and deletions move a remote cursor label without Awareness changes', () => {
  const { ydoc, ytext, editor, awareness, labels } = makeHarness();
  const remoteState = {
    user: { name: 'Remote', color: '#3366cc' },
    selection: selectionAt(ydoc, ytext, 8),
  };
  awareness.states.set(17, remoteState);
  labels.update();
  const widget = editor.widgets.get('codestudio.remote-cursor.17');
  assert.deepEqual(widget.getPosition().position, { lineNumber: 2, column: 3 });
  const awarenessSnapshot = awareness.states.get(17);
  const beforeInsertLayouts = editor.layoutCalls;

  ytext.insert(7, '++');
  assert.strictEqual(awareness.states.get(17), awarenessSnapshot);
  assert.deepEqual(widget.getPosition().position, { lineNumber: 2, column: 5 });
  assert.ok(editor.layoutCalls > beforeInsertLayouts, 'the Y.Text observer relayouts the widget');

  ytext.delete(7, 2);
  assert.strictEqual(awareness.states.get(17), awarenessSnapshot);
  assert.deepEqual(widget.getPosition().position, { lineNumber: 2, column: 3 });
  labels.dispose();
  ydoc.destroy();
});

test('disposing cursor labels unregisters the Y.Text observer and blocks later widget updates', () => {
  const { ydoc, ytext, editor, awareness, labels, observers } = makeHarness({ trackObservers: true });

  const remoteState = {
    user: { name: 'Remote', color: '#3366cc' },
    selection: selectionAt(ydoc, ytext, 2),
  };
  awareness.states.set(17, remoteState);
  labels.update();
  assert.equal(observers.size, 1, 'one text observer is registered per controller');
  const previousLayouts = editor.layoutCalls;

  labels.dispose();
  assert.equal(observers.size, 0);
  ytext.insert(0, 'changed after dispose');
  labels.update();
  assert.equal(editor.layoutCalls, previousLayouts, 'disposed labels do not update widgets');
  assert.equal(editor.widgets.size, 0);
  labels.dispose();
  ydoc.destroy();
});
