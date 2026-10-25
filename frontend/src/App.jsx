// frontend/src/App.jsx
import { useState, useEffect, useRef, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { MonacoBinding } from 'y-monaco';
import {
  FileCode2,
  FileJson2,
  FileText,
  Plus,
  Trash2,
  FolderCode,
  FolderPlus,
  Users,
  UserPlus,
  Files,
  Search,
  Menu,
  X,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import CommandPalette from './components/CommandPalette.jsx';
import CollaboratorPresence from './components/CollaboratorPresence.jsx';
import ProjectTree from './components/ProjectTree.jsx';
import EditorToolbar from './components/EditorToolbar.jsx';
import OutputPanel from './components/OutputPanel.jsx';
import { backendHttpUrl, backendWebSocketUrl } from './backendConfig.js';
import { createCollaborationSession, getRoomUiState } from './collaborationLifecycle.js';
import { getPresenceParticipants, getVisiblePresenceParticipants } from './collaboratorPresence.js';
import { buildProjectTree, filterProjectTree } from './projectTree.js';
import { registerCodeSnippetProviders } from './codeSnippets.js';
import { getSelectedFileLanguage, resolveFileLanguage } from './fileLanguage.js';
import { handleWorkspaceShortcut } from './workspaceInteractions.js';
import { hashEditorText, isConfirmedPersistedRevision } from './durableRevision.js';
import {
  canUseLocalSearchSnapshot,
  getProjectNavigationStatus,
  mergeProjectSearchResults,
  resolveProjectSearchMatch,
} from './projectSearch.js';
import './App.css';

const apiErrorMessage = async (response, fallback) => {
  if (response.status >= 500) return fallback;

  try {
    const body = await response.json();
    return typeof body.error === 'string' ? body.error : fallback;
  } catch {
    return fallback;
  }
};

const FileTypeIcon = ({ name, size = 16 }) => {
  const extension = name.split('.').pop()?.toLowerCase();
  if (extension === 'json') return <FileJson2 size={size} aria-hidden="true" />;
  if (['md', 'markdown', 'txt'].includes(extension)) return <FileText size={size} aria-hidden="true" />;
  return <FileCode2 size={size} aria-hidden="true" />;
};

function App() {
  const editorRef = useRef(null);
  
  // States
  const [currentUser, setCurrentUser] = useState(null);
  const [members, setMembers] = useState([]);
  const [activeTab, setActiveTab] = useState('files');
  
  const [fileList, setFileList] = useState([]);
  const [folderList, setFolderList] = useState([]);
  const [activeFile, setActiveFile] = useState('');
  const [isEditorReady, setIsEditorReady] = useState(false);
  const [fileSearch, setFileSearch] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [selectedFolder, setSelectedFolder] = useState('');
  const [expandedFolders, setExpandedFolders] = useState(() => new Set());
  const [mobileExplorerOpen, setMobileExplorerOpen] = useState(false);
  const [fileLanguage, setFileLanguage] = useState({ file: '', ...resolveFileLanguage('') });
  const [paletteMode, setPaletteMode] = useState(null);
  const [outputEntries, setOutputEntries] = useState([]);
  const [outputOpen, setOutputOpen] = useState(false);
  const [outputCollapsed, setOutputCollapsed] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [outputTab, setOutputTab] = useState('output');
  
  const [newFileName, setNewFileName] = useState('');
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberColor, setNewMemberColor] = useState('#3b82f6');
  
  const [activeUsers, setActiveUsers] = useState([]);
  const [fileLoadState, setFileLoadState] = useState('loading');
  const [memberLoadState, setMemberLoadState] = useState('loading');
  const [operationNotice, setOperationNotice] = useState(null);
  const [roomState, setRoomState] = useState({ file: '', connection: 'disconnected', synced: false, initialSyncComplete: false, unavailable: false });
  const [pendingProjectNavigation, setPendingProjectNavigation] = useState(null);
  const [persistedRevision, setPersistedRevision] = useState(null);
  const [editorText, setEditorText] = useState('');
  const [hashedEditorText, setHashedEditorText] = useState(null);

  const providerRef = useRef(null);
  const bindingRef = useRef(null);
  const collaborationSessionRef = useRef(null);
  const outputSequenceRef = useRef(0);

  const addOutput = useCallback((message, level = 'info', source = 'CodeStudio') => {
    const timestamp = Date.now();
    setOutputEntries(entries => {
      const previous = entries.at(-1);
      if (previous && previous.message === message && previous.level === level && previous.source === source
        && timestamp - previous.timestamp < 4000) {
        return [...entries.slice(0, -1), { ...previous, count: previous.count + 1 }];
      }
      const entry = { id: ++outputSequenceRef.current, timestamp, message, level, source, count: 1 };
      return [...entries, entry].slice(-200);
    });
  }, []);

  const openPalette = useCallback(mode => {
    setPaletteMode(mode);
    setMobileExplorerOpen(false);
  }, []);

  const closePalette = useCallback(() => setPaletteMode(null), []);

  useEffect(() => {
    let current = true;
    setHashedEditorText(null);
    hashEditorText(editorText).then(hash => {
      if (current && editorRef.current?.getModel()?.getValue() === editorText) {
        setHashedEditorText({ source: editorText, hash });
      }
    }).catch(() => { if (current) setHashedEditorText(null); });
    return () => { current = false; };
  }, [editorText]);

  const fetchFiles = useCallback(async () => {
    try {
      setFileLoadState('loading');
      const [res, foldersRes] = await Promise.all([
        fetch(`${backendHttpUrl}/api/files`),
        fetch(`${backendHttpUrl}/api/folders`),
      ]);
      if (!res.ok || !foldersRes.ok) throw new Error('Project list request failed');
      const [files, folders] = await Promise.all([res.json(), foldersRes.json()]);
      if (!Array.isArray(files) || !Array.isArray(folders)) throw new Error('Invalid project list response');
      setFileList(files);
      setFolderList(folders);
      setSelectedFolder(current => current && folders.includes(current) ? current : '');
      if (files.length > 0) setActiveFile(current => current || files[0]);
      setFileLoadState(files.length === 0 && folders.length === 0 ? 'empty' : 'populated');
    } catch (err) {
      console.error(err);
      setFileLoadState('error');
      addOutput('Could not load the file list. Check the backend connection.', 'error', 'Files');
    }
  }, [addOutput]);

  const fetchMembers = useCallback(async () => {
    try {
      setMemberLoadState('loading');
      const res = await fetch(`${backendHttpUrl}/api/members`);
      if (!res.ok) throw new Error('Team list request failed');
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('Invalid team list response');
      setMembers(data);
      setMemberLoadState(data.length === 0 ? 'empty' : 'populated');
    } catch (err) {
      console.error(err);
      setMemberLoadState('error');
      addOutput('Could not load profile labels. Check the backend connection.', 'error', 'Profiles');
    }
  }, [addOutput]);

  useEffect(() => {
    fetchFiles();
    fetchMembers();
  }, [fetchFiles, fetchMembers]);

  useEffect(() => {
    if (!activeFile) {
      setFileLanguage({ file: '', ...resolveFileLanguage('') });
      setActiveUsers([]);
      setRoomState({ file: '', connection: 'disconnected', synced: false, initialSyncComplete: false, unavailable: false });
      setIsEditorReady(false);
      editorRef.current = null;
      return undefined;
    }

    let cancelled = false;
    const fallback = resolveFileLanguage(activeFile);
    setFileLanguage({ file: activeFile, ...fallback });

    const loadLanguage = async () => {
      try {
        const response = await fetch(`${backendHttpUrl}/api/files/${encodeURIComponent(activeFile)}`);
        if (!response.ok) return;
        const metadata = await response.json();
        if (!cancelled) {
          setFileLanguage({ file: activeFile, ...resolveFileLanguage(activeFile, metadata?.language) });
        }
      } catch {
        // The extension mapping keeps editor language useful when metadata is unavailable.
      }
    };

    loadLanguage();
    return () => { cancelled = true; };
  }, [activeFile]);

  useEffect(() => {
    setPersistedRevision(null);
    if (!activeFile || roomState.file !== activeFile || !roomState.synced
      || roomState.unavailable || roomState.connection !== 'connected' || !isEditorReady) {
      return undefined;
    }

    let cancelled = false;
    const fileName = activeFile;
    const refreshPersistedRevision = async () => {
      try {
        const response = await fetch(`${backendHttpUrl}/api/files/${encodeURIComponent(fileName)}/revisions/latest`);
        if (!response.ok) return;
        const revision = await response.json();
        const currentModel = editorRef.current?.getModel();
        const currentText = currentModel?.getValue();
        const currentHash = typeof currentText === 'string' ? await hashEditorText(currentText) : null;
        if (!cancelled && currentModel && currentModel.getValue() === currentText
          && currentHash === revision.sourceHash) {
          setPersistedRevision({ fileName, ...revision });
        }
      } catch {
        // A failed confirmation leaves Run disabled; the next poll can retry.
      }
    };

    refreshPersistedRevision();
    const timer = window.setInterval(refreshPersistedRevision, 750);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeFile, roomState.file, roomState.connection, roomState.synced, roomState.unavailable, isEditorReady]);

  const handleCreateFile = async (e) => {
    e.preventDefault();
    if (!newFileName.trim()) return;
    const name = [selectedFolder, newFileName.trim()].filter(Boolean).join('/');
    try {
      const res = await fetch(`${backendHttpUrl}/api/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        setNewFileName('');
        await fetchFiles();
        if (selectedFolder) setExpandedFolders(current => new Set([...current, selectedFolder]));
        setPendingProjectNavigation(null);
        setActiveFile(name);
        setOperationNotice({ type: 'success', message: `Created ${name}.` });
        addOutput(`Created ${name}.`, 'success', 'Files');
      } else {
        const message = await apiErrorMessage(res, 'Could not create the file.');
        setOperationNotice({ type: 'error', message });
        addOutput(message, 'error', 'Files');
      }
    } catch (err) {
      console.error(err);
      setOperationNotice({ type: 'error', message: 'Could not reach the backend to create the file.' });
      addOutput('Could not reach the backend to create the file.', 'error', 'Files');
    }
  };

  const handleCreateFolder = async (e) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    const folderPath = [selectedFolder, newFolderName.trim()].filter(Boolean).join('/');
    try {
      const response = await fetch(`${backendHttpUrl}/api/folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: folderPath }),
      });
      if (!response.ok) {
        const message = await apiErrorMessage(response, 'Could not create the folder.');
        setOperationNotice({ type: 'error', message });
        addOutput(message, 'error', 'Folders');
        return;
      }

      setNewFolderName('');
      await fetchFiles();
      setSelectedFolder(folderPath);
      setExpandedFolders(current => new Set([...current, selectedFolder, folderPath]));
      setOperationNotice({ type: 'success', message: `Created folder ${folderPath}.` });
      addOutput(`Created folder ${folderPath}.`, 'success', 'Folders');
    } catch (error) {
      console.error(error);
      setOperationNotice({ type: 'error', message: 'Could not reach the backend to create the folder.' });
      addOutput('Could not reach the backend to create the folder.', 'error', 'Folders');
    }
  };

  const handleSelectFolder = useCallback(folderPath => {
    setSelectedFolder(folderPath);
    setExpandedFolders(current => {
      const next = new Set(current);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  }, []);

  const handleDeleteFile = async (e, fileName) => {
    e.stopPropagation();
    if (!confirm(`Delete ${fileName}?`)) return;
    try {
      const res = await fetch(`${backendHttpUrl}/api/files/${encodeURIComponent(fileName)}`, { method: 'DELETE' });
      if (res.ok) {
        if (activeFile === fileName) {
          setPendingProjectNavigation(null);
          setActiveFile('');
        }
        await fetchFiles();
        setOperationNotice({ type: 'success', message: `Deleted ${fileName}.` });
        addOutput(`Deleted ${fileName}.`, 'success', 'Files');
      } else {
        const message = await apiErrorMessage(res, 'Could not delete the file.');
        setOperationNotice({ type: 'error', message });
        addOutput(message, 'error', 'Files');
      }
    } catch (err) {
      console.error(err);
      setOperationNotice({ type: 'error', message: 'Could not reach the backend to delete the file.' });
      addOutput('Could not reach the backend to delete the file.', 'error', 'Files');
    }
  };

  const handleCreateMember = async (e) => {
    e.preventDefault();
    if (!newMemberName.trim()) return;
    try {
      const res = await fetch(`${backendHttpUrl}/api/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newMemberName.trim(), color: newMemberColor }),
      });
      if (res.ok) {
        setNewMemberName('');
        await fetchMembers();
        setOperationNotice({ type: 'success', message: 'Profile label created.' });
        addOutput('Profile label created.', 'success', 'Profiles');
      } else {
        const message = await apiErrorMessage(res, 'Could not create the team member.');
        setOperationNotice({ type: 'error', message });
        addOutput(message, 'error', 'Profiles');
      }
    } catch (err) {
      console.error(err);
      setOperationNotice({ type: 'error', message: 'Could not reach the backend to create the team member.' });
      addOutput('Could not reach the backend to create the profile label.', 'error', 'Profiles');
    }
  };

  const handleDeleteMember = async (e, id) => {
    e.stopPropagation();
    if (!confirm(`Remove this team member?`)) return;
    try {
      const res = await fetch(`${backendHttpUrl}/api/members/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.ok) {
        await fetchMembers();
        setOperationNotice({ type: 'success', message: 'Team member removed.' });
        addOutput('Profile label removed.', 'success', 'Profiles');
      } else {
        const message = await apiErrorMessage(res, 'Could not remove the team member.');
        setOperationNotice({ type: 'error', message });
        addOutput(message, 'error', 'Profiles');
      }
    } catch (err) {
      console.error(err);
      setOperationNotice({ type: 'error', message: 'Could not reach the backend to remove the team member.' });
      addOutput('Could not reach the backend to remove the profile label.', 'error', 'Profiles');
    }
  };

  useEffect(() => {
    if (activeFile && isEditorReady && currentUser) {
      setActiveUsers([]);
      setRoomState({ file: activeFile, connection: 'connecting', synced: false, initialSyncComplete: false, unavailable: false });
      addOutput(`Opening collaboration session for ${activeFile}.`, 'info', 'Collaboration');
      const ydoc = new Y.Doc();
      const provider = new WebsocketProvider(backendWebSocketUrl, activeFile, ydoc);
      const ytext = ydoc.getText('monaco');
      
      const binding = new MonacoBinding(
        ytext,
        editorRef.current.getModel(),
        new Set([editorRef.current]),
        provider.awareness
      );

      // Set user awareness for cursor tracking
      provider.awareness.setLocalStateField('user', {
        id: currentUser._id,
        name: currentUser.name,
        color: currentUser.color
      });

      const cursorStyle = document.createElement('style');
      cursorStyle.dataset.codestudioRemoteCursors = 'true';
      document.head.appendChild(cursorStyle);
      const safeColor = color => /^#[\da-f]{6}$/i.test(color || '') ? color : '#8aa4c7';
      const onAwarenessChange = () => {
        const states = provider.awareness.getStates();
        const users = getPresenceParticipants(states, provider.awareness.clientID);
        setActiveUsers(users);
        cursorStyle.textContent = users
          .filter(user => !user.isCurrentSession && Number.isSafeInteger(user.clientId))
          .map(user => {
            const color = safeColor(user.color);
            return `.yRemoteSelection-${user.clientId}{background-color:${color}44;outline:1px solid ${color}66}.yRemoteSelectionHead-${user.clientId}{position:relative;border-left:2px solid ${color};border-top:1px solid ${color};border-bottom:1px solid ${color};box-sizing:border-box}.yRemoteSelectionHead-${user.clientId}::after{content:"";position:absolute;left:-3px;top:-4px;width:6px;height:6px;border:1px solid ${color};border-radius:50%;background:${color}}`;
          }).join('\n');

        const nextPeers = new Map(users.filter(user => !user.isCurrentSession).map(user => [user.clientId, user]));
        if (presenceInitialized) {
          for (const [clientId, user] of nextPeers) {
            if (!remotePeers.has(clientId)) {
              addOutput(`${user.name || 'A collaborator'} joined session ${clientId.toString(36)}.`, 'info', 'Collaboration');
            }
          }
          for (const [clientId, user] of remotePeers) {
            if (!nextPeers.has(clientId)) {
              addOutput(`${user.name || 'A collaborator'} left session ${clientId.toString(36)}.`, 'info', 'Collaboration');
            }
          }
        } else {
          presenceInitialized = true;
        }
        remotePeers = nextPeers;
      };

      let hasConnected = false;
      let hasSynced = false;
      let connectionInterrupted = false;
      let presenceInitialized = false;
      let remotePeers = new Map();
      const onStatus = ({ status }) => {
        if (status === 'connected') {
          if (hasConnected && connectionInterrupted) {
            addOutput('WebSocket reconnected; waiting for Yjs synchronization.', 'info', 'Collaboration');
          }
          hasConnected = true;
          setRoomState(current => ({ ...current, file: activeFile, connection: 'connected', synced: false }));
        } else if (status === 'connecting' || status === 'disconnected') {
          setActiveUsers([]);
          if (status === 'disconnected' && hasConnected && !connectionInterrupted) {
            connectionInterrupted = true;
            addOutput('Collaboration connection interrupted; reconnecting automatically.', 'warning', 'Collaboration');
          }
          setRoomState(current => ({
            ...current,
            file: activeFile,
            connection: hasConnected ? 'reconnecting' : status,
            synced: false,
          }));
        }
      };
      const onSync = isSynced => {
        if (isSynced) {
          onAwarenessChange();
          addOutput(hasSynced
            ? 'Yjs document resynchronized with the collaboration session.'
            : 'Yjs document synchronized; durable revision confirmation is checked separately.', 'success', 'Collaboration');
          hasSynced = true;
          connectionInterrupted = false;
          hasConnected = true;
          setRoomState(current => ({ ...current, file: activeFile, connection: 'connected', synced: true, initialSyncComplete: true }));
        } else {
          setActiveUsers([]);
          setRoomState(current => ({
            ...current,
            file: activeFile,
            connection: hasConnected ? 'reconnecting' : 'connecting',
            synced: false,
          }));
        }
      };
      const onConnectionError = () => {
        addOutput('WebSocket connection failed; CodeStudio will retry.', 'warning', 'Collaboration');
      };

      let session;
      session = createCollaborationSession({
        provider,
        binding,
        ydoc,
        cursorStyle,
        isCurrent: () => collaborationSessionRef.current === session,
        onAwarenessChange,
        onStatus,
        onSync,
        onConnectionError,
        onUnavailable: () => {
          setActiveUsers([]);
          setRoomState({ file: activeFile, connection: 'unavailable', synced: false, initialSyncComplete: false, unavailable: true });
          setIsEditorReady(false);
          editorRef.current = null;
          addOutput('The server marked this room history unavailable. Editing is blocked; disk persistence status is unknown.', 'error', 'Collaboration');
        },
        onDisposed: () => {
          if (collaborationSessionRef.current === session) collaborationSessionRef.current = null;
          if (providerRef.current === provider) providerRef.current = null;
          if (bindingRef.current === binding) bindingRef.current = null;
        },
      });
      collaborationSessionRef.current = session;

      providerRef.current = provider;
      bindingRef.current = binding;
      onAwarenessChange();
      return () => session.dispose();
    }

    return undefined;
  }, [activeFile, isEditorReady, currentUser, addOutput]);

  const readCurrentText = useCallback(() => editorRef.current?.getModel()?.getValue() || '', []);
  const searchProject = useCallback(async (searchOptions, signal) => {
    const hasEditorModel = Boolean(editorRef.current?.getModel());
    const canSearchEditorSnapshot = canUseLocalSearchSnapshot({ activeFile, roomState, hasEditorModel });
    const requestBody = { ...searchOptions };
    if (canSearchEditorSnapshot) requestBody.excludeFileName = activeFile;

    const response = await fetch(`${backendHttpUrl}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal,
    });
    if (!response.ok) throw new Error('Project search request failed');
    const data = await response.json();
    if (!Array.isArray(data.results) || !Array.isArray(data.unavailableFiles)) {
      throw new Error('Invalid project search response');
    }
    return mergeProjectSearchResults(data, {
      activeFile: canSearchEditorSnapshot ? activeFile : '',
      activeText: canSearchEditorSnapshot ? readCurrentText() : null,
      query: searchOptions.query,
      caseSensitive: searchOptions.caseSensitive,
      wholeWord: searchOptions.wholeWord,
      files: fileList,
    });
  }, [activeFile, fileList, roomState, readCurrentText]);

  const handleOpenFile = useCallback(fileName => {
    setPendingProjectNavigation(null);
    setActiveFile(fileName);
    setMobileExplorerOpen(false);
    setPaletteMode(null);
  }, []);
  const navigateToMatch = useCallback(match => {
    if (!match) return;
    if (match.searchQuery) {
      if (match.fileName !== activeFile && !fileList.includes(match.fileName)) {
        addOutput('That search result is no longer in the project file list.', 'warning', 'Search');
        return;
      }
      setPendingProjectNavigation(match);
      if (match.fileName !== activeFile) setActiveFile(match.fileName);
      setMobileExplorerOpen(false);
      setPaletteMode(null);
      return;
    }
    const editor = editorRef.current;
    if (!editor) return;
    editor.revealLineInCenter(match.lineNumber);
    editor.setPosition({ lineNumber: match.lineNumber, column: match.column });
    editor.focus();
    setPaletteMode(null);
  }, [activeFile, fileList, addOutput]);

  useEffect(() => {
    const pending = pendingProjectNavigation;
    const navigationStatus = getProjectNavigationStatus(pending, activeFile, roomState);
    if (navigationStatus === 'waiting') return;
    if (navigationStatus === 'unavailable') {
      setPendingProjectNavigation(null);
      addOutput(`Could not open the search result because ${activeFile} has unavailable history.`, 'warning', 'Search');
      return;
    }

    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!model) return;
    const target = resolveProjectSearchMatch(model.getValue(), pending);
    setPendingProjectNavigation(null);
    if (!target) {
      addOutput('That search result changed before the document synchronized. Search again for the latest text.', 'warning', 'Search');
      return;
    }
    editor.revealLineInCenter(target.lineNumber);
    editor.setPosition({ lineNumber: target.lineNumber, column: target.column });
    editor.focus();
  }, [activeFile, pendingProjectNavigation, roomState, addOutput]);

  useEffect(() => {
    const onKeyDown = event => {
      handleWorkspaceShortcut(event, {
        paletteOpen: Boolean(paletteMode),
        explorerOpen: mobileExplorerOpen,
        closePalette,
        closeExplorer: () => setMobileExplorerOpen(false),
        openFiles: () => openPalette('files'),
        findText: () => openPalette('content'),
        searchProject: () => openPalette('project'),
        toggleOutput: () => setOutputOpen(open => !open),
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [paletteMode, mobileExplorerOpen, closePalette, openPalette]);

  if (!currentUser) {
    return (
      <div className="App-container">
        <main className="profile-screen">
          <div className="profile-modal">
            <div className="profile-brand"><FolderCode size={26} aria-hidden="true" /><span>CodeStudio</span></div>
            <p className="profile-eyebrow">Collaborative coding</p>
            <h1>Choose a profile label</h1>
            <p className="profile-description">Your name and color identify you in shared editor sessions. Profiles are labels, not authenticated accounts.</p>
            {operationNotice && <div className={`operation-notice ${operationNotice.type}`} role={operationNotice.type === 'error' ? 'alert' : 'status'}>{operationNotice.message}</div>}
            
            {memberLoadState === 'loading' ? (
              <p role="status">Loading profile labels…</p>
            ) : memberLoadState === 'error' ? (
              <p role="alert" className="list-message error">Could not load profile labels. Check that the backend is running, then retry.</p>
            ) : members.length > 0 ? (
              <div className="profile-list">
                {members.map(m => (
                  <button key={m._id} className="profile-btn" onClick={() => setCurrentUser(m)}>
                    <div className="profile-color-dot" style={{ color: m.color, backgroundColor: m.color }}></div>
                    <span style={{ flexGrow: 1, textAlign: 'left' }}>{m.name}</span>
                    <span className="profile-action">Use profile</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="profile-empty">No profile labels yet. Create one to identify yourself in a shared session.</p>
            )}

            <div className="profile-create">
              <h2>Create a profile label</h2>
              <form className="input-group" onSubmit={handleCreateMember}>
                <label className="visually-hidden" htmlFor="profile-color">Profile color</label>
                <input id="profile-color" type="color" className="color-input" value={newMemberColor} onChange={(e) => setNewMemberColor(e.target.value)} />
                <label className="visually-hidden" htmlFor="profile-name">Your name</label>
                <input id="profile-name" type="text" className="text-input" placeholder="Your Name" value={newMemberName} onChange={(e) => setNewMemberName(e.target.value)} />
                <button type="submit" className="action-btn" aria-label="Create profile label"><UserPlus size={18} /><span>Create profile</span></button>
              </form>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const projectTree = filterProjectTree(buildProjectTree(fileList, folderList), fileSearch);
  const selectedLanguage = getSelectedFileLanguage(activeFile, fileLanguage);
  const currentRoomState = activeFile && roomState.file === activeFile
    ? roomState
    : { file: activeFile, connection: activeFile ? 'connecting' : 'disconnected', synced: false, initialSyncComplete: false, unavailable: false };
  const roomUiState = getRoomUiState(currentRoomState, isEditorReady);
  const currentRoomStatus = roomUiState.status;
  const statusLabel = {
    connected: 'Connected', connecting: 'Connecting', synchronizing: 'Synchronizing',
    reconnecting: 'Reconnecting', disconnected: 'Disconnected', unavailable: 'History unavailable', idle: 'No file open',
  }[currentRoomStatus];
  const editorReadOnly = roomUiState.editorReadOnly;
  const hasConfirmedEditorRevision = hashedEditorText?.source === editorText
    && isConfirmedPersistedRevision(persistedRevision, activeFile, {
      source: hashedEditorText.source,
      sourceHash: hashedEditorText.hash,
    });
  const executionUnavailableReason = 'Execution is disabled until a supported isolation runtime can be verified on this machine.';
  const runDisabledReason = !activeFile
    ? 'Open a JavaScript file to prepare a run.'
    : roomUiState.unavailable
    ? 'This room history is unavailable.'
      : selectedLanguage.id !== 'javascript'
        ? 'Only JavaScript execution is planned for the first release.'
    : roomUiState.editorReadOnly
      ? 'Connect and synchronize this room before preparing a run.'
        : !globalThis.crypto?.subtle || typeof TextEncoder === 'undefined'
          ? 'This browser cannot securely confirm the exact persisted editor text.'
          : !hasConfirmedEditorRevision
            ? 'Waiting for the backend to confirm this exact editor text is durably persisted.'
            : executionUnavailableReason;
  const visibleUsers = roomUiState.showCollaborators
    ? getVisiblePresenceParticipants(activeUsers, currentRoomStatus)
    : [];

  return (
    <div className="App-container">
      <header className="workspace-header">
        <button
          type="button"
          className="mobile-explorer-toggle"
          onClick={() => setMobileExplorerOpen(open => !open)}
          aria-label={mobileExplorerOpen ? 'Close explorer' : 'Open explorer'}
          aria-expanded={mobileExplorerOpen}
          aria-controls="workspace-explorer"
        >
          {mobileExplorerOpen ? <X size={19} /> : <Menu size={19} />}
        </button>
        <div className="brand-lockup"><FolderCode size={22} aria-hidden="true" /><span>CodeStudio</span></div>
        <div className="workspace-context">
          <span className="workspace-context-label">Shared coding session</span>
          <span className="context-divider" aria-hidden="true">/</span>
          <strong title={activeFile || 'No file selected'}>{activeFile || 'No file selected'}</strong>
        </div>
        <div className={`connection-indicator ${currentRoomStatus}`} role="status" aria-live="polite">
          <span className="connection-dot" aria-hidden="true" />
          <span className="connection-label">{statusLabel}</span>
        </div>
        {roomUiState.showCollaborators && <CollaboratorPresence participants={visibleUsers} connectionStatus={currentRoomStatus} />}
        <div className="profile-chip" title="Selected collaboration profile">
          <span className="profile-color-dot" style={{ backgroundColor: currentUser.color }} aria-hidden="true" />
          <span>{currentUser.name}</span>
        </div>
        <div className="workspace-actions">
          <button type="button" className="toolbar-action" onClick={() => openPalette('files')} title="Open file (Ctrl/⌘ P)"><Search size={15} /> <span>Open file</span></button>
          <button type="button" className="toolbar-action" onClick={() => openPalette('content')} title="Find in active file (Ctrl/⌘ Shift F)"><Search size={15} /> <span>Find text</span></button>
          <button type="button" className="toolbar-action" onClick={() => setOutputOpen(open => !open)} aria-pressed={outputOpen} title="Toggle Output (Ctrl/⌘ J)"><ChevronUp size={15} /> <span>Output</span></button>
        </div>
      </header>

      {mobileExplorerOpen && <button className="explorer-backdrop" type="button" aria-label="Close explorer" onClick={() => setMobileExplorerOpen(false)} />}

      <div className="workspace-body">
      <aside className={`sidebar ${mobileExplorerOpen ? 'mobile-open' : ''}`} id="workspace-explorer" aria-label="Workspace navigation">
        <div className="sidebar-header">
          <div>
            <h2 className="sidebar-title">Explorer</h2>
            <p className="sidebar-subtitle">Files and profile labels</p>
          </div>
        </div>

        <div className="sidebar-tabs" aria-label="Explorer sections">
          <button type="button" aria-pressed={activeTab === 'files'} className={`sidebar-tab ${activeTab === 'files' ? 'active' : ''}`} onClick={() => setActiveTab('files')}>
            <Files size={16} /> Files
          </button>
          <button type="button" aria-pressed={activeTab === 'team'} className={`sidebar-tab ${activeTab === 'team' ? 'active' : ''}`} onClick={() => setActiveTab('team')}>
            <Users size={16} /> Profiles
          </button>
        </div>

        {operationNotice && <div className={`operation-notice ${operationNotice.type}`} role={operationNotice.type === 'error' ? 'alert' : 'status'}>{operationNotice.message}</div>}

        {activeTab === 'files' ? (
          <>
            <label className="search-box" htmlFor="file-search"><Search size={15} aria-hidden="true" /><input id="file-search" type="search" placeholder="Find a file" value={fileSearch} onChange={e => setFileSearch(e.target.value)} /></label>
            <button type="button" className="project-root-target" aria-pressed={!selectedFolder}
              onClick={() => setSelectedFolder('')}>
              <FolderCode size={14} aria-hidden="true" /> Project root
            </button>
            <div className="project-create-target">Creating in <strong>{selectedFolder || 'Project root'}</strong></div>
            <form className="input-group create-file-form" onSubmit={handleCreateFile}>
              <label className="visually-hidden" htmlFor="new-file-name">New file name</label>
              <input id="new-file-name" type="text" className="text-input" placeholder="e.g. main.js" value={newFileName} onChange={(e) => setNewFileName(e.target.value)} />
              <button type="submit" className="action-btn" aria-label="Create file"><Plus size={18} /><span>New file</span></button>
            </form>
            <form className="input-group create-folder-form" onSubmit={handleCreateFolder}>
              <label className="visually-hidden" htmlFor="new-folder-name">New folder name</label>
              <input id="new-folder-name" type="text" className="text-input" placeholder="New folder" value={newFolderName} onChange={event => setNewFolderName(event.target.value)} />
              <button type="submit" className="action-btn" aria-label="Create folder"><FolderPlus size={17} /><span>Folder</span></button>
            </form>
            {fileLoadState === 'loading' && fileList.length === 0 && folderList.length === 0 && <p className="list-message" role="status">Loading project…</p>}
            {fileLoadState === 'error' && <p className="list-message error" role="alert">Could not load project files and folders. Check that the backend is running, then retry.</p>}
            {fileLoadState === 'empty' && <p className="list-message">No files or folders yet. Create one to get started.</p>}
            {fileLoadState === 'populated' && fileSearch.trim() && projectTree.files.length === 0 && projectTree.folders.length === 0
              && <p className="list-message">No files or folders match “{fileSearch}”.</p>}
            <ProjectTree
              tree={projectTree}
              activeFile={activeFile}
              selectedFolder={selectedFolder}
              expandedFolders={expandedFolders}
              FileIcon={FileTypeIcon}
              onSelectFolder={handleSelectFolder}
              onOpenFile={fileName => { setPendingProjectNavigation(null); setActiveFile(fileName); setMobileExplorerOpen(false); }}
              onDeleteFile={handleDeleteFile}
            />
          </>
        ) : (
          <>
            <p className="section-helper">Profile labels identify people in awareness and cursor presence. They are not accounts or workspace access.</p>
            <form className="input-group" onSubmit={handleCreateMember}>
              <label className="visually-hidden" htmlFor="member-color">Member color</label>
              <input id="member-color" type="color" className="color-input" value={newMemberColor} onChange={(e) => setNewMemberColor(e.target.value)} />
              <label className="visually-hidden" htmlFor="member-name">New member name</label>
              <input id="member-name" type="text" className="text-input" placeholder="New Member" value={newMemberName} onChange={(e) => setNewMemberName(e.target.value)} />
              <button type="submit" className="action-btn" aria-label="Create profile label"><UserPlus size={18} /><span>Add profile</span></button>
            </form>
            <ul className="item-list">
              {memberLoadState === 'loading' && <li className="list-message" role="status">Loading profile labels…</li>}
              {memberLoadState === 'error' && <li className="list-message error" role="alert">Could not load profile labels. Check that the backend is running, then retry.</li>}
              {memberLoadState === 'empty' && <li className="list-message">No profile labels yet. Add one to identify yourself.</li>}
              {members.map(m => (
                <li key={m._id} className="list-item">
                  <div className="list-item-left">
                    <div className="profile-color-dot" style={{ color: m.color, backgroundColor: m.color, width: 12, height: 12 }}></div>
                    <span>{m.name}</span>
                  </div>
                  <button className="delete-btn" onClick={(e) => handleDeleteMember(e, m._id)} aria-label={`Remove ${m.name}`} title="Remove member"><Trash2 size={14} /></button>
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
      <main className="editor-container">
        <div className="editor-tabbar">
          {activeFile ? (
            <div className="editor-tab" role="group" aria-label={`Active file: ${activeFile}`} title={activeFile}>
              <FileTypeIcon name={activeFile} size={15} />
              <span className="editor-tab-name">{activeFile}</span>
              <span className="language-label">{selectedLanguage.label}</span>
            </div>
          ) : <div className="editor-tab empty-tab">No file open</div>}
          <div className="editor-tabbar-status">
            <span className={`mini-status-dot ${currentRoomStatus}`} aria-hidden="true" />
            {currentRoomStatus === 'connected' ? 'Live sync' : currentRoomStatus === 'connecting' ? 'Connecting' : currentRoomStatus === 'synchronizing' ? 'Synchronizing' : currentRoomStatus === 'reconnecting' ? 'Reconnecting' : currentRoomStatus === 'unavailable' ? 'Recovery blocked' : currentRoomStatus === 'idle' ? 'Choose a file' : 'Offline'}
          </div>
        </div>
        <EditorToolbar
          activeFile={activeFile}
          languageLabel={selectedLanguage.label}
          openPalette={openPalette}
          outputOpen={outputOpen}
          setOutputOpen={setOutputOpen}
          roomStatus={currentRoomStatus}
          persistedRevision={hasConfirmedEditorRevision ? persistedRevision : null}
          executionUnavailableReason={runDisabledReason}
        />
        {activeFile && currentRoomState.unavailable ? (
          <div className="empty-state room-unavailable" role="alert"><FolderCode size={48} opacity={0.5} /><p>“{activeFile}” is unavailable because the server marked its history as unsafe to recover. Editing is blocked to avoid showing an empty or partial document.</p></div>
        ) : activeFile ? (
          <>
          <div className="editor-host">
            <Editor
              height="100%"
              theme="vs-dark"
              path={activeFile}
              language={selectedLanguage.id}
              options={{
                readOnly: editorReadOnly,
                minimap: { enabled: false },
                fontSize: 14,
                fontFamily: "'DM Mono', 'Consolas', monospace",
                padding: { top: 16 }
              }}
              onMount={(editor, monaco) => {
                registerCodeSnippetProviders(monaco);
                editorRef.current = editor;
                setEditorText(editor.getValue());
                setIsEditorReady(true);
              }}
              onChange={value => setEditorText(value || '')}
            />
          </div>
          </>
        ) : (
          <div className="empty-state">
            <FolderCode size={48} opacity={0.5} />
            <p>Select a file to start editing, or create a new one.</p>
          </div>
        )}
      </main>
      </div>
      {outputOpen && <OutputPanel
        entries={outputEntries} activeTab={outputTab} onSelectTab={setOutputTab}
        onClear={() => setOutputEntries([])} onClose={() => setOutputOpen(false)}
        collapsed={outputCollapsed} expanded={outputExpanded}
        onToggleCollapse={() => setOutputCollapsed(value => !value)}
        onToggleExpand={() => setOutputExpanded(value => !value)}
      />}
      {paletteMode && <CommandPalette
        mode={paletteMode} files={fileList} activeFile={activeFile} onClose={closePalette}
        onOpenFile={handleOpenFile} readCurrentText={readCurrentText} onNavigate={navigateToMatch}
        searchProject={searchProject}
      />}
    </div>
  );
}

export default App;
