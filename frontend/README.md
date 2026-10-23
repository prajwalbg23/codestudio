# CodeStudio frontend

The frontend is a local React application built with Vite. The backend runs separately on port `3001` by default.

## Run locally

1. In a terminal, start the backend with `node server.js` from `backend`.
2. In a second terminal, run these commands from `frontend`:

   ```sh
   npm install
   npm run dev
   ```

3. Open the local URL printed by Vite.

The frontend connects to `http://127.0.0.1:3001` for HTTP and derives `ws://127.0.0.1:3001` for collaboration by default. To use a different local backend port, set the optional, non-secret Vite variable `VITE_BACKEND_URL` before starting Vite, for example:

```sh
VITE_BACKEND_URL=http://127.0.0.1:3002 npm run dev
```

On PowerShell:

```powershell
$env:VITE_BACKEND_URL = 'http://127.0.0.1:3002'
npm run dev
```

Use an `http://` endpoint on `localhost` or `127.0.0.1`; the WebSocket endpoint is derived as `ws://`. The backend binds only to IPv4 loopback. HTTP and WebSocket requests from browser pages are allowed only from Vite's default development origins (`http://localhost:5173` and `http://127.0.0.1:5173`) or preview origins (`http://localhost:4173` and `http://127.0.0.1:4173`). Vite reads the backend value at startup, so restart the dev server after changing it. Do not put secrets in frontend environment variables: Vite exposes `VITE_` values to browser code.

## Workspace controls

- `Ctrl/⌘ P` opens the file quick switcher.
- `Ctrl/⌘ Shift F` searches text in the active file only. It does not open or search other collaborative rooms.
- `Ctrl/⌘ J` toggles the activity Output panel.
- `Escape` closes the active dialog or mobile explorer drawer.

Output shows CodeStudio activity. The workspace does not execute code, and the Problems view does not provide compiler diagnostics.

## Checks

From `frontend`, run `npm test` for the focused built-in Node tests, `npm run build` for a production build, and `npm run lint` for ESLint.

## JavaScript execution status

Run and Stop are present as disabled controls until a supported local isolation runtime can be verified. CodeStudio does not fall back to running collaborator code as an unrestricted backend child process. The backend reports the unavailable capability and rejects execution requests without launching a process.
