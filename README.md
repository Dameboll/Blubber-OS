<div align="center">

<img src="public/brand/flubber-logo-transparent.png" width="130" alt="Blubber" />

# Blubber-OS

**A living desktop companion for Claude Code.**

Blubber is a 3D character who lives on your machine, watches your real Claude Code activity, and turns it into a world: live dashboards, agents at workstations, a real terminal, analytics, music, a pet. Your agent work, with a face.

<!-- Dame: drop real screenshots into docs/screenshots/ with these exact names -->
![Blubber-OS dashboard](docs/screenshots/dashboard.png)

</div>

---

## What this is

Claude Code is a terminal. Powerful, but it looks like a log file. Blubber-OS is a desktop app that sits on top of your existing Claude Code setup and gives it a body.

It reads the transcripts Claude Code already writes to `~/.claude/projects/` and turns them into live, real data. Nothing on screen is faked: token usage comes from your actual sessions, the activity feed comes from your actual tool calls, and the terminal tabs run the actual `claude` CLI. Blubber (the character) reacts to all of it in real time, rendered live in 3D through one shared WebGL host.

The Community Edition in this repo is the full app. Free, no feature gates on the shell. It assumes you already know Claude Code; it injects your existing setup and gets out of the way. If you have zero Claude Code history, Demo Mode gives you the whole tour with canned data.

## The screens

| Screen | What it does |
|---|---|
| **Dashboard** | Hero Blubber, system status, quick actions, a terminal preview, and a live usage pill row fed by your real session data. |
| **Terminal** | Real PTY terminal tabs running the `claude` CLI, streamed over a local WebSocket into xterm.js. Tabs persist across navigation; sessions are cleaned up when you close them. |
| **Agents** | An agent control center. Spawn agents, watch them work at mini workstations, see a live activity feed and your top agents ranked from real usage. |
| **Projects** | Your actual project folders, sorted by real recency, plus templates and a New Project scaffold. |
| **Analytics** | Token usage, tool runs, and trends rolled up from your indexed `~/.claude` transcripts into local SQLite. Real numbers or an honest "not enough data yet", never filler. |
| **Memory** | Surfaces the identity and memory files your Claude Code setup already keeps (`~/.claude/USER.md`, `PERSONA.md`, `SOUL.md`). |
| **Music** | A local music player with EQ and an audio-reactive Blubber visualizer. Drop tracks in the `music/` folder. |
| **Pet** | A virtual pet Blubber with real needs, care streaks, and quests, backed by its own SQLite store. Comes with an arcade (Snake, Pong, Connect Four, Memory Match, Reaction Tap, Blubber Toss). |
| **Academy** | The in-app course. Ships locked in v1 with a waitlist. See [Paid extras](#paid-extras) below. |
| **Settings** | General settings, reduce-effects toggle, the Starter Kit installer, replay setup, and a master reset. |

<!-- Dame: more screenshots -->
![Agents screen](docs/screenshots/agents.png)
![Terminal](docs/screenshots/terminal.png)

## Requirements

- **Windows.** Built and tested on Windows 10/11. The terminal layer has a POSIX code path, but Mac/Linux are untested and the installer target is Windows-only for now.
- **Node.js 20+** and npm.
- **Claude Code installed** (the `claude` CLI on your PATH) if you want real data and working terminal tabs. Not required for Demo Mode.

## Quick start

```bash
git clone https://github.com/Dameboll/Blubber-OS.git
cd Blubber-OS
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

That's it. No accounts, no keys, no config required for the core app.

**If port 3000 is taken:** `PORT=3001 npm run dev` (the server will tell you the same thing if it hits the conflict).

**If `npm run dev` throws a `NODE_MODULE_VERSION` mismatch:** the postinstall step rebuilds the two native modules (better-sqlite3, node-pty) for Electron on machines that have a native build toolchain. Flip them back to your system Node with:

```bash
npm run rebuild:system-node
```

### Desktop app

The browser tab is the default dev experience, but a real desktop shell exists:

```bash
npm run electron:dev     # run the app in an Electron window
npm run build            # production Next.js build (required before packaging)
npm run electron:build   # package a Windows NSIS installer into dist-electron/
```

The Electron shell spawns the same `server.js` the dev script runs and points a window at it. Same app, no divergence.

## First run

1. **Intro cinematic.** Blubber forms up on a small stage, once, ever. Skippable at any time, and skipped entirely under `prefers-reduced-motion`.
2. **Inject your setup.** Blubber checks for `~/.claude` on your machine:
   - **Found with history:** one click injects it. The indexer scans your transcripts and the dashboard lights up with your real stats.
   - **Found but empty:** clean slate, straight to the dashboard. Your data shows up as you use Claude Code.
   - **Not found:** you get a link to install Claude Code, or a button to try Demo Mode.
3. **Dashboard.** From then on the app boots straight in.

You can replay the whole setup flow any time from Settings.

## Demo mode

No Claude Code? No history? Append `?demo=1` to the URL:

```
http://localhost:3000/?demo=1
```

The whole app runs on a bundled, clearly badged demo dataset. The choice persists across reloads; `?demo=0` turns it off.

## Configuration

The core app needs zero environment variables. There are exactly two, both optional, both for the Academy waitlist cloud sync:

```bash
cp .env.example .env.local
```

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL for the hosted waitlist. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The public anon key (safe to expose by design; RLS only allows inserts). |

Without them, waitlist signups fall back to a local SQLite table and everything else works exactly the same.

## Paid extras

The app in this repo is free and complete. Two optional products exist on top of it:

- **Starter Kit ($39.99).** For people new to Claude Code: a starter `CLAUDE.md`, 10 agents, 10 skills, guides, and a project folder scaffold, with a Blubber-guided install built into Settings (point it at your extracted kit folder and it installs into `~/.claude` for you). Sold on the FlubberOS store: **[Get the Starter Kit](#)** <!-- Dame: replace # with the live Shopify store URL -->
- **Blubber Academy ($99 All Access tier).** A hands-on in-app course for going from "I have Claude Code installed" to actually running agents. Currently waitlist-only; it ships bundled with All Access and is never sold standalone. Join the waitlist from the Academy tab in the app.

Neither is required. The Community Edition is not a trial.

## Security notes

This app runs a local server with a real terminal attached, so the boundaries are deliberate and worth knowing:

- **Loopback only.** The server binds the literal `127.0.0.1`, not `localhost` (which can resolve elsewhere). It is unreachable from other devices on your network.
- **Token-authed terminal socket.** The PTY WebSocket requires a per-process random token on every connection, compared with a timing-safe check. The token is handed out only through a same-origin endpoint that foreign pages cannot read, so a malicious tab in your browser cannot drive your terminal.
- **Sessions die with the socket.** If a tab or connection disappears, its PTY sessions are killed rather than orphaned.
- **Local data.** Stats live in SQLite files under `data/`, on your disk. The app reads your `~/.claude` transcripts to build them; it does not modify your Claude Code setup. The two exceptions are things you explicitly trigger: the terminal (which runs the real `claude` CLI) and the Starter Kit installer (which copies kit files into `~/.claude` when you point it at a kit folder).
- **Network calls.** The only outbound call the app itself makes is the optional Academy waitlist signup (an email you typed, sent to Supabase, only if the env vars are set). Everything else is local.

## FAQ

**Does this replace Claude Code?**
No. It's a companion. Claude Code does the work; Blubber-OS is the living skin on top of it. The terminal tabs literally run your installed `claude` CLI.

**Does it send my code or transcripts anywhere?**
No. Indexing is local, the database is local, the server only listens on loopback. See the security notes above.

**My dashboard is empty. Broken?**
Probably just a fresh `~/.claude`. Stats build up as you actually use Claude Code. If you have history and it still looks empty, re-run the inject from Settings.

**Mac or Linux?**
Not yet. Windows first. The code is closer to portable than not (the PTY layer already has a POSIX branch), so if you want to champion a port, open an issue.

**Is Blubber himself open source?**
The code is Apache-2.0. The character is not; see below.

**Something's broken.**
[Open an issue](https://github.com/Dameboll/Blubber-OS/issues). The bug template takes two minutes.

## Contributing

PRs welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; the short version is: run the e2e suite before you submit, and leave the brand assets alone.

## License

Code is licensed under [Apache-2.0](LICENSE).

**Brand assets are not.** The Blubber character, the logo, and the wordmark (everything in `public/brand/`, plus the character design itself) are not covered by the code license and may not be reused commercially. Fork the code, build on it, ship things with it. Just don't ship Blubber's face as your product.
