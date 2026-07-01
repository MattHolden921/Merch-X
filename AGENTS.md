# AGENTS.md

## Project Source Of Truth

- Before planning or editing this repo, read `PROJECT_SPEC.md`.
- Treat `PROJECT_SPEC.md` as the living product and logic reference.
- When changing workflows, APIs, database schema, integrations, uploads, calculations, deployment assumptions, or page responsibilities, update `PROJECT_SPEC.md` in the same change.
- If the implementation and `PROJECT_SPEC.md` disagree, treat the code as current truth, then update the spec.
- Keep `README.md` for setup/storage basics and `DESIGN.md` for visual/design guidance.

## Local Development Server

- On Windows/Codex desktop, start the app outside the sandbox so the in-app browser can keep using it after the tool call finishes.
- Use PowerShell with `Start-Process -WindowStyle Hidden`, set `PORT=3010`, and keep the working directory at the repo root:

```powershell
$env:PORT='3010'
Start-Process -FilePath node -ArgumentList 'server.js' -WorkingDirectory 'C:\Users\Matth\OneDrive\Personal Documents Desktop\Merch X' -WindowStyle Hidden
Start-Sleep -Seconds 2
Invoke-WebRequest -UseBasicParsing http://localhost:3010/pnl.html | Select-Object -ExpandProperty StatusCode
```

- If the sandbox blocks the background server or the browser gets `ERR_CONNECTION_REFUSED`, rerun the same startup command with escalated permissions.
