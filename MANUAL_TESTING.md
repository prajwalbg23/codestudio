# CodeStudio manual verification guide

This guide uses a **separate temporary data folder** for the manual check. It does not use or change the project's existing `backend/db.json`, `backend/yjs_db`, Yjs recovery reports, backups, or migration artifacts. It does not enable code execution.

Keep the app on this computer. The commands below bind the backend and Vite to `127.0.0.1`; do not replace that address with `0.0.0.0` or enable LAN access. Profile names are collaboration labels, not authenticated accounts.

## 1. Start the backend with disposable data

Open **PowerShell window 1** and run:

```powershell
Set-Location D:\codestudio\backend
$manualData = Join-Path $env:TEMP ("CodeStudio-Manual-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $manualData | Out-Null
$env:CODESTUDIO_DATA_DIR = $manualData
$env:PORT = '3001'
Write-Host "Disposable test data: $manualData"
node .\server.js
```

Leave this window open while testing. The backend should print that it is listening at `http://127.0.0.1:3001`. The temporary folder contains the JSON store and Yjs histories for this check only.

If startup reports that port 3001 is already in use, **do not stop an unknown process**. Stop here or use the alternate-port instructions below. Do not start a second backend on the same port.

## 2. Start the frontend on its approved local origin

Open **PowerShell window 2** and run:

```powershell
Set-Location D:\codestudio\frontend
$env:VITE_BACKEND_URL = 'http://127.0.0.1:3001'
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Open the URL printed by Vite. It should be `http://127.0.0.1:5173/`. If the command says the port is occupied, stop rather than using a different port: only the configured default Vite origins are allowed by the backend.

On the profile screen, create two temporary labels, for example **Manual Alice** and **Manual Bob**. In browser window 1 choose Manual Alice. Open a second browser window (not just another tab if you want to keep the test clear), visit the same URL, and choose Manual Bob. These labels only identify the two editor sessions.

## 3. Verify collaboration

1. In the first window, use **New file** to create `manual-stability-check.js`.
2. Select that file in the second window.
3. Wait until both windows show **Connected** and the editor is available. If either says Disconnected, Connecting, Reconnecting, or History unavailable, wait briefly; do not type until it is Connected and synchronized.
4. In window 1, type `const check = 'from Alice';` in the editor. Confirm the same text appears in window 2.
5. In window 2, append a new line containing `// from Bob`. Confirm the new line appears in window 1.
6. Look for both profile labels in the collaborator area. Try placing the caret in each window and confirm remote cursor/presence updates if shown.

Expected result: both windows show the same text and both sessions appear as collaborators. No program should run; Run/Stop remain disabled.

## 4. Verify persisted recovery after a backend restart

Use only the disposable file created above.

1. First verify the backend knows the filename by opening `http://127.0.0.1:3001/api/files/manual-stability-check.js`. Expect `{"language":"javascript"}`. Then open `http://127.0.0.1:3001/api/files/manual-stability-check.js/revisions/latest`. This exact URL ends in `/revisions/latest` and returns JSON with a `revisionId` such as `yrev1_...` and a `sourceHash`. Copy the complete `revisionId` value somewhere temporary. A `File not found` response on either URL means the active backend data folder does not contain this file record (or the filename in the URL differs); do not recreate the file or edit any history while diagnosing. A 404 saying no persisted revision is available means the file exists but its Yjs history has no persisted update yet. Do not restart until the latest-revision endpoint returns 200.
2. Close **both browser windows** so their Yjs sessions disconnect.
3. In PowerShell window 1, stop the backend with **Ctrl+C**. Do not delete or edit the temporary data folder.
4. In that same window, confirm the same temporary data directory is still selected, then start the backend again:

   ```powershell
   Write-Host "Restart data directory: $env:CODESTUDIO_DATA_DIR"
   if (-not (Test-Path (Join-Path $env:CODESTUDIO_DATA_DIR 'db.json'))) { throw 'The disposable database file is missing; stop and restore the original data-directory path.' }
   node .\server.js
   ```

   The PowerShell variables still point to the same temporary folder if you kept window 1 open. If you closed that terminal, start a new PowerShell window, set `$env:CODESTUDIO_DATA_DIR` to the exact `Disposable test data` path printed earlier, and confirm its `db.json` exists before starting. Do not create a new empty directory for the restart: the JSON file list and Yjs history must come from the same temporary directory used before stopping.
5. Open the frontend URL in a fresh browser window, choose a profile if asked, open `manual-stability-check.js`, and wait for connection/synchronization.
6. Before checking revisions, open `http://127.0.0.1:3001/api/files/manual-stability-check.js` again. Expect `{"language":"javascript"}`. If this returns `File not found`, stop: the restarted backend is using a different data directory or the requested filename is wrong. Close it with Ctrl+C, restore the original printed `CODESTUDIO_DATA_DIR` value, verify that directory's `db.json` exists, and restart. Do not recreate the file as a workaround.
7. Reopen the exact `/revisions/latest` URL from step 1. Expect HTTP 200 and the same `revisionId` and `sourceHash` as before the restart. To check a specific revision, copy the complete returned ID (including `yrev1_`) and append it after `/revisions/` in the file URL. Do not include brackets, quotes, or the word `latest`. Expect HTTP 200 and matching revision metadata.

Expected result: the file contains both Alice’s and Bob’s edits after the backend restart. If it does not, stop and keep the temporary data folder intact for diagnosis.

The backend uses the **filename**, not the file’s internal ID, in these paths. The file metadata endpoint is `/api/files/<filename>`; revision endpoints are `/api/files/<filename>/revisions/latest` and `/api/files/<filename>/revisions/<revisionId>`. `/revisions/latest` asks for the current latest revision; the specific route requires the exact ID returned in the JSON. Sending a malformed ID to the specific-revision route returns `400 Invalid document revision identifier`; an unknown but correctly formatted ID returns 404. Do not ask the backend to accept an arbitrary ID.

## 5. Check local binding and HTTP origin rules

Run these commands in another PowerShell window while the backend is running:

```powershell
Get-NetTCPConnection -LocalPort 3001 -State Listen | Select-Object LocalAddress, LocalPort
```

Expected listener address: `127.0.0.1`. If it shows `0.0.0.0`, a LAN address, or another unexpected address, stop the backend with Ctrl+C and report it.

An approved frontend origin should receive HTTP 200:

```powershell
(Invoke-WebRequest -Uri 'http://127.0.0.1:3001/api/files' -Headers @{ Origin = 'http://127.0.0.1:5173' }).StatusCode
```

Expected result: `200`.

An unapproved origin should receive HTTP 403. This uses a made-up Origin header sent to your own loopback backend; it does not visit or contact that domain:

```powershell
try {
  $response = Invoke-WebRequest -Uri 'http://127.0.0.1:3001/api/files' -Headers @{ Origin = 'http://example.invalid' }
  "Unexpected HTTP status: $($response.StatusCode)"
} catch {
  "Expected rejection: HTTP $([int]$_.Exception.Response.StatusCode)"
}
```

Expected result: `Expected rejection: HTTP 403`. An Origin allowlist and loopback binding reduce browser/network exposure; they do not authenticate users or protect against another process already running on this computer.

WebSocket origin acceptance/rejection is checked by the automated backend tests below. The two-window collaboration check confirms the legitimate browser connection works. Do not try to expose the backend to the public internet to test this.

## 6. Run the automated checks

These commands use the project’s existing scripts and dependencies. Backend reliability tests create their own temporary data directory; they do not run migration or activation against the project’s Yjs files.

In PowerShell, run:

```powershell
Set-Location D:\codestudio\backend
npm test
```

Then run:

```powershell
Set-Location D:\codestudio\frontend
npm test
npm run lint
npm run build
```

Expected result: each command exits successfully. The build may print a bundle-size warning; that warning is separate from whether the build succeeds.

## 7. Finish safely

1. Close the browser windows.
2. Stop the backend and frontend with Ctrl+C in their terminal windows.
3. Keep the printed temporary data folder if anything failed. If everything worked, you may leave it in place; it is separate from the project’s histories and recovery artifacts.

Do not run the Yjs migration or activation scripts as part of this guide. Code execution remains disabled.

## If you need a different backend port

Only do this if you know port 3001 is already occupied and can safely use a different unused port. Stop the test backend first. In PowerShell window 1, keep the same `$manualData` value and run:

```powershell
$env:PORT = '3002'
node .\server.js
```

In PowerShell window 2, set the matching local backend URL before starting Vite:

```powershell
$env:VITE_BACKEND_URL = 'http://127.0.0.1:3002'
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Use port 3002 in the API and listener-check URLs above as well. The Vite origin remains port 5173.
