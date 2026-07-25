# Decision Log — Blubber OS

---

## 2026-07-25

### DECISION: The in-app Claude Code installer is not Starter-Kit-gated
**What:** "Install it for me" renders on the onboarding notfound branch for every user, free or paid.
**Why:** Not a pricing call — a structural one. The kit marker lives at `~/.claude/.blubber-kit.json`, inside the very directory whose absence defines that branch. `kit` is therefore always false there, so a gated button could never render on the one screen it exists for. The previous code was written as kit-gated AND wired to no UI at all, meaning kit buyers got the identical link-and-good-luck screen as free users.
**Alternatives considered:** Keep it gated and give paid users a different entry point later (rejected — there is no other screen where "Claude Code is missing" is true). Leave it link-only and just improve the copy (rejected — "go install this yourself" is a brutal first screen for a product whose pitch is that it's easier than the terminal).
**Implications:** Removes a kit selling point. Removes the largest drop-off in the funnel. Verified on a virgin profile that detect returns `kit:false` here, which is the receipt.
**Reversible:** Yes — easy, but re-gating restores a bug, not a feature.

### DECISION: Use Anthropic's native installer, not npm
**What:** `/api/onboarding/install-claude` runs `irm https://claude.ai/install.ps1 | iex` (Windows) or `curl -fsSL https://claude.ai/install.sh | bash`, replacing `npm install -g @anthropic-ai/claude-code`.
**Why:** The npm path assumed node+npm exist because server.js used to be spawned with system node. The self-contained build ships its own runtime — confirmed by launching the packaged app with node and npm absent from PATH. On the clean machine this route exists to serve, npm isn't there and the install failed at step one.
**Alternatives considered:** winget (not on all Windows installs, no mac/linux story). Bundle Node just to run npm (adds weight to fix a problem the native installer doesn't have). Detect npm and fall back (extra branch for a path that is strictly worse).
**Implications:** Does pipe a remote script into a shell, which some AV/locked-down setups block. Accepted against "guaranteed failure on a clean machine" — and a blocked download surfaces as real stderr in the stream the user is already watching. npm remains the documented manual fallback for anyone who already has Node 22+.
**Reversible:** Yes — easy, one STEPS array.

### DECISION: Fix the indexer freeze by yielding + slicing, not by moving it off-thread
**What:** `runIndexerYielding()` plus a byte cap inside `indexFile()`, rather than a worker thread or child process.
**Why:** The freeze is the event loop being held, and yielding releases it. A worker thread would mean moving SQLite access across a thread boundary — a much larger change to the one store every screen reads, for the same user-visible outcome. Measured result: worst-case request latency during a full 2.17 GB cold index went 14.80s → 0.49s.
**Alternatives considered:** Worker thread (bigger blast radius, touches db.ts singleton). Index lazily per-screen (leaves the dashboard wrong for longer). Show a progress bar and keep the freeze (treats the symptom, and the server is still dead meanwhile).
**Implications:** The walk takes marginally longer in wall-clock because it hands the thread back constantly. Irrelevant — it's background work and nothing awaits it.
**Reversible:** Yes — easy. `runIndexer` (sync) is untouched and still exported.

### DECISION: Don't run the real Claude Code installer during verification
**What:** The installer command was proven by running its exact shape through cmd.exe with `iex` swapped for `Measure-Object`, confirming the pipe survives `spawn(shell:true)` and claude.ai returns a real 110-line script. The actual install was not executed.
**Why:** Dame's machine already has a working Claude Code setup. Running the native installer against it risks changing his live install to prove a code path.
**Implications:** One link in the chain — the installer actually completing — is proven by inference, not execution. Logged as open item 9. Needs one click inside the disposable temp profile.
**Reversible:** N/A — a verification-scope call.

---

## 2026-07-22 and earlier
See `docs/ai-context.md` "Launch decisions (locked)" and the session archives in
`docs/sessions/`. This log starts 2026-07-25; earlier decisions were recorded inline
in ai-context.md rather than here.
