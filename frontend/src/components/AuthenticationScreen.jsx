import { useState } from 'react';
import { FolderCode } from 'lucide-react';

export default function AuthenticationScreen({ backendHttpUrl, onAuthenticated }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  const submit = async event => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError('');
    try {
      const response = await fetch(`${backendHttpUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (!response.ok) {
        setError(response.status === 401 ? 'Username or password was not accepted.' : 'Sign-in is temporarily unavailable.');
        return;
      }
      const session = await response.json();
      if (typeof session.token !== 'string' || !session.user?.id || !session.user?.username) {
        setError('The server returned an invalid sign-in response.');
        return;
      }
      setPassword('');
      onAuthenticated(session);
    } catch {
      setError('Could not reach the backend to sign in.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="App-container">
      <main className="profile-screen">
        <section className="profile-modal" aria-labelledby="auth-title">
          <div className="profile-brand"><FolderCode size={26} aria-hidden="true" /><span>CodeStudio</span></div>
          <p className="profile-eyebrow">Workspace access</p>
          <h1 id="auth-title">Sign in</h1>
          <p className="profile-description">Use an account provisioned by your workspace administrator.</p>
          {error && <p className="operation-notice error" role="alert">{error}</p>}
          <form className="auth-form" onSubmit={submit}>
            <label htmlFor="auth-username">Username</label>
            <input id="auth-username" className="text-input" autoComplete="username" required
              value={username} onChange={event => setUsername(event.target.value)} />
            <label htmlFor="auth-password">Password</label>
            <input id="auth-password" className="text-input" type="password" autoComplete="current-password" required
              value={password} onChange={event => setPassword(event.target.value)} />
            <button className="action-btn" type="submit" disabled={pending}>
              {pending ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}
