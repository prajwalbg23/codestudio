import * as Y from 'yjs';

const validColor = color => typeof color === 'string' && /^#[\da-f]{6}$/i.test(color);

export function createCollaboratorCursorLabels({ editor, monaco, awareness, ydoc, ytext }) {
  const widgets = new Map();
  let disposed = false;

  function removeWidget(clientId, widget) {
    try {
      editor.removeContentWidget(widget);
    } catch {
      // The DOM node is still removed even if Monaco has already disposed its editor.
    } finally {
      widget.node.remove();
      widgets.delete(clientId);
    }
  }

  function update() {
    if (disposed) return;
    const model = editor.getModel();
    const desired = new Map();

    if (model) {
      for (const [clientId, state] of awareness.getStates()) {
        if (!Number.isSafeInteger(clientId) || clientId === awareness.clientID) continue;
        const name = typeof state?.user?.name === 'string' ? state.user.name.trim() : '';
        const color = state?.user?.color;
        const head = state?.selection?.head;
        const anchor = state?.selection?.anchor;
        if (!name || !validColor(color) || !head || !anchor) continue;

        try {
          const absolute = Y.createAbsolutePositionFromRelativePosition(head, ydoc);
          if (!absolute || absolute.type !== ytext || !Number.isSafeInteger(absolute.index)) continue;
          const position = model.getPositionAt(absolute.index);
          if (!position) continue;
          desired.set(clientId, { name, color, position });
        } catch {
          // Ignore awareness positions that are malformed or do not belong to this document.
        }
      }
    }

    for (const [clientId, widget] of widgets) {
      if (!desired.has(clientId)) removeWidget(clientId, widget);
    }

    for (const [clientId, participant] of desired) {
      let widget = widgets.get(clientId);
      if (!widget) {
        const node = document.createElement('div');
        node.className = 'remote-cursor-label';
        node.setAttribute('aria-hidden', 'true');
        widget = {
          node,
          position: participant.position,
          getId: () => `codestudio.remote-cursor.${clientId}`,
          getDomNode: () => node,
          getPosition: () => ({
            position: widget.position,
            preference: [monaco.editor.ContentWidgetPositionPreference.ABOVE],
          }),
        };
        widgets.set(clientId, widget);
        editor.addContentWidget(widget);
      }

      widget.position = participant.position;
      widget.node.textContent = participant.name;
      widget.node.style.backgroundColor = participant.color;
      widget.node.style.borderColor = participant.color;
      editor.layoutContentWidget(widget);
    }
  }

  function clear() {
    if (disposed) return;
    for (const [clientId, widget] of widgets) removeWidget(clientId, widget);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      ytext.unobserve(update);
    } finally {
      for (const [clientId, widget] of widgets) removeWidget(clientId, widget);
    }
  }

  ytext.observe(update);

  return { update, clear, dispose, get size() { return widgets.size; } };
}
