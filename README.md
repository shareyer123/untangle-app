# Untangle (run-only build)

Offline master schedule for a lab. Electron + SQLite. This repo holds only the built app and a
**fake** sample database. No network access at runtime.

## First time

```
git clone https://github.com/shareyer123/untangle-app.git %USERPROFILE%\untangle
cd %USERPROFILE%\untangle
npm install --no-save electron@44.9.3
```

Then double-click `Start Untangle.bat`. It runs `git pull` and starts the app.

## Your data

- First start opens a copy of the fake sample (`demo.sqlite`).
- **File → Open / Import…** opens your own SQLite file. The app backs it up first, then remembers it.
  Copy the real database somewhere outside this folder (for example `Documents\Untangle\`) and open the copy.
- `config.json`, `*.sqlite` and `backups\` are never committed, so `git pull` never touches them.
