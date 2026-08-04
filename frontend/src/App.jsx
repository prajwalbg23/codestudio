// frontend/src/App.jsx
import { useState, useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { MonacoBinding } from 'y-monaco';
import { FileCode2, Plus, Trash2, FolderCode, Users, UserPlus, Files, User } from 'lucide-react';
import './App.css';

function App() {
  const editorRef = useRef(null);
  
  // States
  const [currentUser, setCurrentUser] = useState(null);
  const [members, setMembers] = useState([]);
  const [activeTab, setActiveTab] = useState('files');
  
  const [fileList, setFileList] = useState([]);
  const [activeFile, setActiveFile] = useState('');
  const [isEditorReady, setIsEditorReady] = useState(false);
  
  const [newFileName, setNewFileName] = useState('');
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberColor, setNewMemberColor] = useState('#3b82f6');
  
  const [activeUsers, setActiveUsers] = useState([]);

  const providerRef = useRef(null);
  const bindingRef = useRef(null);

  const fetchFiles = async () => {
    try {
      const res = await fetch('http://localhost:3001/api/files');
      const files = await res.json();
      setFileList(files);
      if (files.length > 0 && !activeFile) setActiveFile(files[0]);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchMembers = async () => {
    try {
      const res = await fetch('http://localhost:3001/api/members');
      const data = await res.json();
      setMembers(data);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchFiles();
    fetchMembers();
  }, []);

  const handleCreateFile = async (e) => {
    e.preventDefault();
    if (!newFileName.trim()) return;
    try {
      const res = await fetch('http://localhost:3001/api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newFileName.trim() }),
      });
      if (res.ok) {
        const name = newFileName.trim();
        setNewFileName('');
        await fetchFiles();
        setActiveFile(name);
      } else {
        alert((await res.json()).error);
      }
    } catch (err) { console.error(err); }
  };

  const handleDeleteFile = async (e, fileName) => {
    e.stopPropagation();
    if (!confirm(`Delete ${fileName}?`)) return;
    try {
      const res = await fetch(`http://localhost:3001/api/files/${fileName}`, { method: 'DELETE' });
      if (res.ok) {
        if (activeFile === fileName) setActiveFile('');
        await fetchFiles();
      }
    } catch (err) { console.error(err); }
  };

  const handleCreateMember = async (e) => {
    e.preventDefault();
    if (!newMemberName.trim()) return;
    try {
      const res = await fetch('http://localhost:3001/api/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newMemberName.trim(), color: newMemberColor }),
      });
      if (res.ok) {
        setNewMemberName('');
        await fetchMembers();
      } else {
        alert((await res.json()).error);
      }
    } catch (err) { console.error(err); }
  };

  const handleDeleteMember = async (e, id) => {
    e.stopPropagation();
    if (!confirm(`Remove this team member?`)) return;
    try {
      const res = await fetch(`http://localhost:3001/api/members/${id}`, { method: 'DELETE' });
      if (res.ok) await fetchMembers();
    } catch (err) { console.error(err); }
  };

  useEffect(() => {
    if (activeFile && isEditorReady && currentUser) {
      providerRef.current?.destroy();
      bindingRef.current?.destroy();

      const ydoc = new Y.Doc();
      const provider = new WebsocketProvider('ws://localhost:3001', activeFile, ydoc);
      const ytext = ydoc.getText('monaco');
      
      const binding = new MonacoBinding(
        ytext,
        editorRef.current.getModel(),
        new Set([editorRef.current]),
        provider.awareness
      );

      // Set user awareness for cursor tracking
      provider.awareness.setLocalStateField('user', {
        name: currentUser.name,
        color: currentUser.color
      });

      provider.awareness.on('change', () => {
        const states = Array.from(provider.awareness.getStates().values());
        const users = states.map(s => s.user).filter(Boolean);
        // deduplicate by name just in case a user has multiple tabs
        const uniqueUsers = [];
        const seen = new Set();
        for (const u of users) {
          if (!seen.has(u.name)) {
            seen.add(u.name);
            uniqueUsers.push(u);
          }
        }
        setActiveUsers(uniqueUsers);
      });

      providerRef.current = provider;
      bindingRef.current = binding;
    }
    
    return () => {
      providerRef.current?.destroy();
      bindingRef.current?.destroy();
    };
  }, [activeFile, isEditorReady, currentUser]);

  if (!currentUser) {
    return (
      <div className="App-container">
        <div className="auth-overlay">
          <div className="auth-modal">
            <h2>Welcome to CodeStudio</h2>
            <p>Select your profile to join the collaboration session.</p>
            
            {members.length > 0 ? (
              <div className="profile-list">
                {members.map(m => (
                  <button key={m._id} className="profile-btn" onClick={() => setCurrentUser(m)}>
                    <div className="profile-color-dot" style={{ color: m.color, backgroundColor: m.color }}></div>
                    <span style={{ flexGrow: 1, textAlign: 'left' }}>{m.name}</span>
                    <User size={18} opacity={0.5} />
                  </button>
                ))}
              </div>
            ) : (
              <p style={{ color: '#ef4444', marginBottom: '1rem' }}>No team members exist yet. Please create one below.</p>
            )}

            <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '1.5rem', marginTop: '1rem' }}>
              <h3 style={{ margin: '0 0 1rem 0', fontSize: '1rem' }}>Create Profile</h3>
              <form className="input-group" onSubmit={handleCreateMember}>
                <input type="color" className="color-input" value={newMemberColor} onChange={(e) => setNewMemberColor(e.target.value)} />
                <input type="text" className="text-input" placeholder="Your Name" value={newMemberName} onChange={(e) => setNewMemberName(e.target.value)} />
                <button type="submit" className="action-btn"><UserPlus size={18} /></button>
              </form>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="App-container">
      <div className="sidebar">
        <div className="sidebar-header">
          <FolderCode size={24} color="#3b82f6" />
          <h1 className="sidebar-title">CodeStudio</h1>
        </div>

        <div className="sidebar-tabs">
          <button className={`sidebar-tab ${activeTab === 'files' ? 'active' : ''}`} onClick={() => setActiveTab('files')}>
            <Files size={16} /> Files
          </button>
          <button className={`sidebar-tab ${activeTab === 'team' ? 'active' : ''}`} onClick={() => setActiveTab('team')}>
            <Users size={16} /> Team
          </button>
        </div>

        {activeTab === 'files' ? (
          <>
            <form className="input-group" onSubmit={handleCreateFile}>
              <input type="text" className="text-input" placeholder="New file (e.g. main.js)" value={newFileName} onChange={(e) => setNewFileName(e.target.value)} />
              <button type="submit" className="action-btn"><Plus size={18} /></button>
            </form>
            <ul className="item-list">
              {fileList.map(fileName => (
                <li key={fileName} className={`list-item ${fileName === activeFile ? 'active' : ''}`} onClick={() => setActiveFile(fileName)}>
                  <div className="list-item-left"><FileCode2 size={16} /><span>{fileName}</span></div>
                  <button className="delete-btn" onClick={(e) => handleDeleteFile(e, fileName)} title="Delete file"><Trash2 size={14} /></button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <form className="input-group" onSubmit={handleCreateMember}>
              <input type="color" className="color-input" value={newMemberColor} onChange={(e) => setNewMemberColor(e.target.value)} />
              <input type="text" className="text-input" placeholder="New Member" value={newMemberName} onChange={(e) => setNewMemberName(e.target.value)} />
              <button type="submit" className="action-btn"><UserPlus size={18} /></button>
            </form>
            <ul className="item-list">
              {members.map(m => (
                <li key={m._id} className="list-item">
                  <div className="list-item-left">
                    <div className="profile-color-dot" style={{ color: m.color, backgroundColor: m.color, width: 12, height: 12 }}></div>
                    <span>{m.name}</span>
                  </div>
                  <button className="delete-btn" onClick={(e) => handleDeleteMember(e, m._id)} title="Remove member"><Trash2 size={14} /></button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="editor-container">
        {activeUsers.length > 0 && activeFile && (
          <div className="active-users-panel">
            <h4>Active Users</h4>
            {activeUsers.map((u, idx) => (
              <div key={idx} className="active-user">
                <div className="profile-color-dot" style={{ color: u.color, backgroundColor: u.color, width: 10, height: 10 }}></div>
                {u.name} {u.name === currentUser.name && '(You)'}
              </div>
            ))}
          </div>
        )}
        
        {activeFile ? (
          <Editor
            height="100%"
            theme="vs-dark"
            path={activeFile}
            options={{
              minimap: { enabled: false },
              fontSize: 14,
              fontFamily: "'Inter', 'Consolas', monospace",
              padding: { top: 16 }
            }}
            onMount={(editor) => {
              editorRef.current = editor;
              setIsEditorReady(true);
            }}
          />
        ) : (
          <div className="empty-state">
            <FolderCode size={48} opacity={0.5} />
            <p>Select a file to start editing, or create a new one.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;