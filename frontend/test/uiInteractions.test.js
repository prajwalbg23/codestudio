import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { JSDOM } from 'jsdom';
import React from 'react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { handleWorkspaceShortcut } from '../src/workspaceInteractions.js';
import { getRoomUiState } from '../src/collaborationLifecycle.js';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Event = dom.window.Event;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });

const { act, useState } = React;
const { createRoot } = await import('react-dom/client');
let vite;
let CommandPalette;
let EditorToolbar;
let OutputPanel;

before(async () => {
  vite = await createServer({
    root: frontendRoot,
    configFile: false,
    plugins: [react()],
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  ({ default: CommandPalette } = await vite.ssrLoadModule('/src/components/CommandPalette.jsx'));
  ({ default: EditorToolbar } = await vite.ssrLoadModule('/src/components/EditorToolbar.jsx'));
  ({ default: OutputPanel } = await vite.ssrLoadModule('/src/components/OutputPanel.jsx'));
});

after(async () => {
  await vite?.close();
  dom.window.close();
});

function mount(element) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function makeKeyEvent(key, options = {}) {
  const matchedSelectors = new Set(options.matches || []);
  let prevented = false;
  return {
    key,
    ctrlKey: options.ctrlKey ?? true,
    metaKey: options.metaKey ?? false,
    shiftKey: options.shiftKey ?? false,
    altKey: options.altKey ?? false,
    target: {
      closest: selector => selector.split(', ').some(part => matchedSelectors.has(part)) ? {} : null,
    },
    preventDefault: () => { prevented = true; },
    get defaultPrevented() { return prevented; },
  };
}

test('workspace shortcuts open palettes and toggle Output from Monaco, but leave ordinary text inputs alone', () => {
  const actions = [];
  const handlers = {
    paletteOpen: false,
    explorerOpen: false,
    openFiles: () => actions.push('files'),
    findText: () => actions.push('find'),
    toggleOutput: () => actions.push('output'),
  };
  const cases = [
    [makeKeyEvent('p', { matches: ['textarea', '.monaco-editor'] }), 'files'],
    [makeKeyEvent('f', { shiftKey: true, matches: ['textarea', '.monaco-editor'] }), 'find'],
    [makeKeyEvent('j', { matches: ['textarea', '.monaco-editor'] }), 'output'],
  ];
  for (const [event, expected] of cases) {
    handleWorkspaceShortcut(event, handlers);
    assert.equal(actions.at(-1), expected);
    assert.equal(event.defaultPrevented, true);
  }

  const inputEvent = makeKeyEvent('p', { matches: ['input'] });
  handleWorkspaceShortcut(inputEvent, handlers);
  assert.deepEqual(actions, ['files', 'find', 'output']);
  assert.equal(inputEvent.defaultPrevented, false);

  const modifiedEvent = makeKeyEvent('j', { altKey: true });
  handleWorkspaceShortcut(modifiedEvent, handlers);
  assert.equal(actions.length, 3);
});

test('Escape closes the command palette first and closes the mobile explorer when no palette is open', () => {
  const actions = [];
  const paletteEvent = makeKeyEvent('Escape');
  handleWorkspaceShortcut(paletteEvent, {
    paletteOpen: true,
    explorerOpen: true,
    closePalette: () => actions.push('palette'),
    closeExplorer: () => actions.push('explorer'),
  });
  assert.deepEqual(actions, ['palette']);
  assert.equal(paletteEvent.defaultPrevented, true);

  const explorerEvent = makeKeyEvent('Escape');
  handleWorkspaceShortcut(explorerEvent, {
    paletteOpen: false,
    explorerOpen: true,
    closePalette: () => actions.push('palette'),
    closeExplorer: () => actions.push('explorer'),
  });
  assert.deepEqual(actions, ['palette', 'explorer']);
  assert.equal(explorerEvent.defaultPrevented, false);
});

test('command palette focuses search, filters files, opens a result, and closes from its controls', () => {
  const opened = [];
  const closed = [];
  function PaletteHarness() {
    const [open, setOpen] = useState(true);
    if (!open) return null;
    return React.createElement(CommandPalette, {
      mode: 'files',
      files: ['alpha.js', 'beta.json', 'notes.md'],
      activeFile: 'alpha.js',
      onClose: () => { closed.push('close'); setOpen(false); },
      onOpenFile: name => { opened.push(name); setOpen(false); },
      readCurrentText: () => '',
      onNavigate: () => {},
    });
  }

  const mounted = mount(React.createElement(PaletteHarness));

  try {
    assert.equal(mounted.container.querySelector('[role="dialog"]')?.getAttribute('aria-modal'), 'true');
    const input = mounted.container.querySelector('#palette-query');
    assert.equal(document.activeElement, input, 'search receives focus when the palette opens');
    assert.equal(mounted.container.querySelectorAll('[aria-label="Matching files"] .palette-result').length, 3);

    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      valueSetter.call(input, ' BETA ');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    assert.deepEqual([...mounted.container.querySelectorAll('[aria-label="Matching files"] .palette-result span')].map(node => node.textContent), ['beta.json']);

    act(() => mounted.container.querySelector('.palette-result').click());
    assert.deepEqual(opened, ['beta.json']);
    assert.equal(mounted.container.querySelector('[role="dialog"]'), null, 'opening a result closes the palette');
  } finally {
    mounted.unmount();
  }

  const closeButtonMount = mount(React.createElement(PaletteHarness));
  try {
    act(() => closeButtonMount.container.querySelector('[aria-label="Close search"]').click());
    assert.equal(closeButtonMount.container.querySelector('[role="dialog"]'), null);
  } finally {
    closeButtonMount.unmount();
  }

  const backdropMount = mount(React.createElement(PaletteHarness));
  try {
    act(() => backdropMount.container.querySelector('.palette-backdrop').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
    assert.equal(backdropMount.container.querySelector('[role="dialog"]'), null);
    assert.deepEqual(closed, ['close', 'close']);
  } finally {
    backdropMount.unmount();
  }
});

test('project search debounces input, shows partial results, and passes search context into navigation', async () => {
  const calls = [];
  const navigated = [];
  function ProjectPaletteHarness() {
    const [open, setOpen] = useState(true);
    if (!open) return null;
    return React.createElement(CommandPalette, {
      mode: 'project',
      files: ['main.js', 'broken.js'],
      activeFile: 'main.js',
      onClose: () => setOpen(false),
      onOpenFile: () => {},
      readCurrentText: () => '',
      onNavigate: match => { navigated.push(match); setOpen(false); },
      searchProject: async (options, signal) => {
        calls.push({ ...options, signal });
        return {
          results: [{ fileName: 'main.js', lineNumber: 3, column: 5, snippet: '  Needle found();' }],
          unavailableFiles: ['broken.js'],
          truncated: false,
        };
      },
    });
  }

  const mounted = mount(React.createElement(ProjectPaletteHarness));
  try {
    const input = mounted.container.querySelector('#palette-query');
    assert.equal(document.activeElement, input);
    const optionLabels = [...mounted.container.querySelectorAll('.project-search-options label')];
    act(() => {
      optionLabels.find(label => label.textContent.includes('Case sensitive')).querySelector('input').click();
      optionLabels.find(label => label.textContent.includes('Whole word')).querySelector('input').click();
    });
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'Needle');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => new Promise(resolve => setTimeout(resolve, 300)));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].caseSensitive, true);
    assert.equal(calls[0].wholeWord, true);
    assert.match(mounted.container.textContent, /Results may be incomplete/);
    assert.match(mounted.container.textContent, /broken\.js/);
    assert.match(mounted.container.textContent, /main\.js:3:5/);

    act(() => mounted.container.querySelector('[aria-label="Project search matches"] button').click());
    assert.equal(navigated.length, 1);
    assert.equal(navigated[0].searchQuery, 'Needle');
    assert.deepEqual(navigated[0].searchOptions, { caseSensitive: true, wholeWord: true });
    assert.equal(mounted.container.querySelector('[role="dialog"]'), null);
  } finally {
    mounted.unmount();
  }
});

test('project search reports an empty result set', async () => {
  function EmptySearchHarness() {
    return React.createElement(CommandPalette, {
      mode: 'project', files: [], activeFile: '', onClose: () => {}, onOpenFile: () => {},
      readCurrentText: () => '', onNavigate: () => {},
      searchProject: async () => ({ results: [], unavailableFiles: [], truncated: false }),
    });
  }
  const mounted = mount(React.createElement(EmptySearchHarness));
  try {
    const input = mounted.container.querySelector('#palette-query');
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'missing');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => new Promise(resolve => setTimeout(resolve, 300)));
    assert.match(mounted.container.textContent, /No matches found/);
  } finally {
    mounted.unmount();
  }
});

test('stale project search responses cannot replace newer results', async () => {
  const pending = [];
  function StaleSearchHarness() {
    return React.createElement(CommandPalette, {
      mode: 'project', files: [], activeFile: '', onClose: () => {}, onOpenFile: () => {},
      readCurrentText: () => '', onNavigate: () => {},
      searchProject: (options, signal) => new Promise(resolve => pending.push({ query: options.query, signal, resolve })),
    });
  }

  const mounted = mount(React.createElement(StaleSearchHarness));
  try {
    const input = mounted.container.querySelector('#palette-query');
    const setQuery = value => act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    setQuery('first');
    await act(async () => new Promise(resolve => setTimeout(resolve, 300)));
    assert.equal(pending.length, 1);

    setQuery('second');
    assert.equal(pending[0].signal.aborted, true);
    await act(async () => new Promise(resolve => setTimeout(resolve, 300)));
    assert.equal(pending.length, 2);

    await act(async () => {
      pending[1].resolve({ results: [{ fileName: 'new.js', lineNumber: 1, column: 1, snippet: 'second result' }], unavailableFiles: [] });
      await Promise.resolve();
    });
    await act(async () => {
      pending[0].resolve({ results: [{ fileName: 'old.js', lineNumber: 1, column: 1, snippet: 'first stale result' }], unavailableFiles: [] });
      await Promise.resolve();
    });
    assert.match(mounted.container.textContent, /second result/);
    assert.doesNotMatch(mounted.container.textContent, /first stale result/);
  } finally {
    mounted.unmount();
  }
});

test('editor toolbar exposes the Output control independently of header actions', () => {
  function ToolbarHarness() {
    const [outputOpen, setOutputOpen] = useState(false);
    return React.createElement(EditorToolbar, {
      activeFile: 'main.js',
      languageLabel: 'JavaScript',
      openPalette: () => {},
      outputOpen,
      setOutputOpen,
    });
  }
  const mounted = mount(React.createElement(ToolbarHarness));
  try {
    const toolbar = mounted.container.querySelector('[role="toolbar"][aria-label="Editor actions"]');
    const output = toolbar?.querySelector('.editor-output-toggle');
    assert.ok(output, 'Output is rendered in the editor toolbar, outside hidden header actions');
    assert.equal(output.getAttribute('aria-pressed'), 'false');
    assert.match(output.getAttribute('aria-label'), /activity panel/i);
    act(() => output.click());
    assert.equal(output.getAttribute('aria-pressed'), 'true');
    act(() => output.click());
    assert.equal(output.getAttribute('aria-pressed'), 'false');
  } finally {
    mounted.unmount();
  }
});

test('execution controls stay disabled without verified isolation and explain the limitation', () => {
  const reason = 'Execution is disabled until a supported isolation runtime can be verified on this machine.';
  const mounted = mount(React.createElement(EditorToolbar, {
    activeFile: 'main.js', languageLabel: 'JavaScript', openPalette: () => {},
    outputOpen: false, setOutputOpen: () => {}, persistedRevision: null,
    executionUnavailableReason: reason,
  }));
  try {
    const run = mounted.container.querySelector('[aria-label="Run JavaScript (unavailable)"]');
    const stop = mounted.container.querySelector('[aria-label="Stop program (not running)"]');
    assert.equal(run.disabled, true);
    assert.equal(stop.disabled, true);
    assert.equal(run.title, reason);
    assert.match(mounted.container.querySelector('.execution-status').textContent, /isolation runtime can be verified/i);
    assert.match(mounted.container.textContent, /isolation runtime can be verified/i);
  } finally {
    mounted.unmount();
  }
});

test('Program Output is separate from CodeStudio activity and states that no code ran', () => {
  const mounted = mount(React.createElement(OutputPanel, {
    entries: [], activeTab: 'program', onSelectTab: () => {}, onClear: () => {},
    onClose: () => {}, collapsed: false, expanded: false,
    onToggleCollapse: () => {}, onToggleExpand: () => {},
  }));
  try {
    assert.match(mounted.container.textContent, /Program execution is unavailable/);
    assert.match(mounted.container.textContent, /No code has been run/);
    assert.doesNotMatch(mounted.container.textContent, /No activity yet/);
  } finally {
    mounted.unmount();
  }
});

test('Output panel controls clear, collapse, expand, reopen, hide, and describe activity honestly', () => {
  function Harness() {
    const [open, setOpen] = useState(true);
    const [collapsed, setCollapsed] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [entries, setEntries] = useState([{ id: 1, timestamp: 0, source: 'Files', message: 'Loaded workspace', level: 'info', count: 1 }]);
    return React.createElement('div', null,
      open && React.createElement(OutputPanel, {
        entries,
        activeTab: 'output',
        onSelectTab: () => {},
        onClear: () => setEntries([]),
        onClose: () => setOpen(false),
        collapsed,
        expanded,
        onToggleCollapse: () => setCollapsed(value => !value),
        onToggleExpand: () => setExpanded(value => !value),
      }),
    );
  }

  const mounted = mount(React.createElement(Harness));
  try {
    const panel = () => mounted.container.querySelector('.output-panel');
    assert.match(panel().getAttribute('aria-label'), /activity.*not program output/i);
    assert.match(panel().textContent, /does not execute code/i);
    assert.match(panel().textContent, /Loaded workspace/);

    act(() => mounted.container.querySelector('[aria-label="Clear output"]').click());
    assert.match(panel().textContent, /No activity yet/);
    assert.match(panel().textContent, /does not execute code/i);

    act(() => mounted.container.querySelector('[aria-label="Collapse output panel"]').click());
    assert.equal(panel().classList.contains('collapsed'), true);
    assert.equal(panel().querySelector('.output-panel-content'), null);

    act(() => mounted.container.querySelector('[aria-label="Expand output panel"]').click());
    assert.equal(panel().classList.contains('collapsed'), false);

    const heightButton = panel().querySelector('[aria-label="Expand output panel height"]');
    assert.ok(heightButton);
    act(() => heightButton.click());
    assert.equal(panel().classList.contains('expanded'), true);
    act(() => panel().querySelector('[aria-label="Reduce output panel height"]').click());
    assert.equal(panel().classList.contains('expanded'), false);

    act(() => panel().querySelector('[aria-label="Hide output panel"]').click());
    assert.equal(panel(), null);
  } finally {
    mounted.unmount();
  }
});

test('connection and synchronization statuses remain distinct and unsafe history stays read-only', () => {
  const connecting = getRoomUiState({ file: 'a.js', connection: 'connecting', synced: false, unavailable: false }, true);
  assert.equal(connecting.status, 'connecting');
  assert.equal(connecting.editorReadOnly, true);

  const syncing = getRoomUiState({ file: 'a.js', connection: 'connected', synced: false, unavailable: false }, true);
  assert.equal(syncing.status, 'synchronizing');
  assert.equal(syncing.editorReadOnly, true);

  const connected = getRoomUiState({ file: 'a.js', connection: 'connected', synced: true, unavailable: false }, true);
  assert.equal(connected.status, 'connected');
  assert.equal(connected.editorReadOnly, false);

  const unavailable = getRoomUiState({ file: 'a.js', connection: 'unavailable', synced: false, unavailable: true }, true);
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.editorReadOnly, true);
  assert.equal(unavailable.showCollaborators, false);
});
