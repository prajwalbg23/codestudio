// frontend/src/App.jsx
import { useState, useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { MonacoBinding } from 'y-monaco';
import './App.css';

function App() {
  const editorRef = useRef(null);
  const [fileList, setFileList] = useState([]);
  const [activeFile, setActiveFile] = useState('');
  const [isEditorReady, setIsEditorReady] = useState(false);

  const providerRef = useRef(null);
  const bindingRef = useRef(null);

  useEffect(() => {
    fetch('http://localhost:3001/api/files')
      .then(res => res.json())
      .then(files => {
        setFileList(files);
        if (files.length > 0) {
          setActiveFile(files[0]);
        }
      });
  }, []);

  useEffect(() => {
    if (activeFile && isEditorReady) {
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

      providerRef.current = provider;
      bindingRef.current = binding;
    }
  }, [activeFile, isEditorReady]);

  return (
    <div className="App-container">
      <div className="sidebar">
        <h3 style={{ paddingLeft: '15px' }}>Files</h3>
        <ul>
          {fileList.map(fileName => (
            <li key={fileName} onClick={() => setActiveFile(fileName)}
              style={{
                cursor: 'pointer',
                padding: '5px 15px',
                backgroundColor: fileName === activeFile ? '#333' : 'transparent',
              }}>
              {fileName}
            </li>
          ))}
        </ul>
      </div>
      <div className="editor-container">
        <Editor
          height="100%"
          theme="vs-dark"
          path={activeFile}
          onMount={(editor) => {
            editorRef.current = editor;
            setIsEditorReady(true);
          }}
        />
      </div>
    </div>
  );
}

export default App;