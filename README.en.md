# my-obsidian

Run the **official Obsidian renderer (unmodified)** inside a web browser, backed by a self-hosted Node.js service providing the vault file API.

[繁體中文說明文件請見 README.md](README.md)

Runs the `app.js` bundle extracted from your own locally installed Obsidian (byte-for-byte identical to the official release), replacing outer Electron/Node dependencies with 13 lightweight shims. This is neither a rewritten markdown editor nor a remote desktop / VNC stream.

```
Verified: Obsidian 1.14.4 · macOS · Node 22 · 335 Unit Tests · 21 End-to-End Harnesses
```

> **⚠️ Unofficial Project — No Affiliation with Obsidian.**
> Obsidian's code, name, and trademarks **belong entirely to Obsidian (Dynalist Inc.)**. This repository **does not contain or distribute** any Obsidian proprietary code; the renderer bundle is extracted locally on your machine from your own installed copy of the official Obsidian desktop application. **Intended for personal use on your own machine and vault only.** Serving the renderer to third parties requires explicit permission from Obsidian. This software is provided under the MIT license on an "AS IS" basis without warranties; **always back up your vault before using it**. See **[`NOTICE.md`](NOTICE.md)** for full terms and disclosures.

---

## Table of Contents

- [What It Is / What It Is Not](#what-it-is--what-it-is-not)
- [Quick Start](#quick-start)
- [First Launch Experience](#first-launch-experience)
- [Daily Operation](#daily-operation)
- [Security](#security)
- [Capabilities](#capabilities)
- [Known Limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Licensing and Disclaimers](#licensing-and-disclaimers)
- [Project Architecture](#project-architecture)
- [Verification (Developers)](#verification-developers)

---

## What It Is / What It Is Not

| | |
|---|---|
| **What It Is** | A Node.js service turning a local vault into a browser-accessible web application, retaining the official Obsidian desktop UI and community plugin ecosystem. |
| **What It Is Not** | A rewritten markdown editor; a look-alike UI built with web frameworks; a VNC/remote desktop stream; an official Obsidian product. |

Because the core application code is Obsidian's official bundle, you get native Obsidian behavior while our shim layer bridges host services (file system, menus, multi-window popouts, clipboard, printing, and plugin loading).

---

## Quick Start

### Prerequisites

- **macOS** (currently supported platform; Windows/Linux are not yet officially validated)
- **Official Obsidian Desktop App installed** (<https://obsidian.md>) and launched at least once
- **Node.js 22+**
- An Obsidian vault directory (or an empty directory; Obsidian will initialize `.obsidian/`)
- Browser: Chromium-based (Chrome, Edge, Brave) or Safari. (Running `npm run check:*` harnesses requires a Chromium-based browser)

> **Important:** Back up your vault first or start with a test copy. The service possesses full read and write access to the specified vault directory.

### Steps

```bash
# 1. Install server dependencies
npm --prefix packages/server ci

# 2. Extract the Obsidian renderer bundle
#    Auto-detects your installed Obsidian app (including auto-updated bundles) into vendor/
npm run vendor

# 3. Verify your environment
npm run doctor -- --vault /path/to/your-vault

# 4. Start the service
npm start -- --vault /path/to/your-vault

# 5. Open http://127.0.0.1:3000/ and complete the one-time consent screen
```

You can also specify the vault path using the `MYOBS_VAULT` environment variable, which supports tilde expansion (e.g. `~/my-vault`).

### Version Compatibility

The shim layer has been thoroughly validated against **Obsidian 1.14.4**. Both `npm run vendor` and `npm run doctor` will display a warning if a different version is detected. While most minor versions will boot and work, compatibility is not guaranteed. If an Obsidian auto-update prevents boot, please report an issue with your version number (found in `vendor/obsidian/package.json`).

To extract from a specific archive manually:

```bash
npm run vendor -- --from /path/to/obsidian.asar
# or set OBSIDIAN_ASAR=/path/to/obsidian.asar
```

Auto-detection scan priority: `/Applications/Obsidian.app`, `~/Applications/Obsidian.app`, and `~/Library/Application Support/obsidian/obsidian-<version>.asar`, selecting the highest version found.

### Common Options

```bash
npm start -- --vault <path> --port 8080
npm start -- --vault <path> --host 0.0.0.0 --auth-token "$(openssl rand -hex 24)"   # See Security section
npm start -- --vault <path> --no-watch      # Disable file watching (debugging)
npm run dev -- --vault <path>               # Dev mode: bypasses consent screen (loopback only)
```

---

## First Launch Experience

### Consent Screen

Obsidian renderer (v1.13+) verifies an acknowledgement literal on boot against the host. This project **does not bundle this string** (see [Licensing and Disclaimers](#licensing-and-disclaimers)).

On first boot without configuration:
1. **Four Mandatory Acknowledgements**: You must verify that this is an unofficial tool, accept Obsidian's terms, affirm personal use only, and acknowledge the AS IS warranty terms.
2. **Acknowledgement String Input**: The page provides a local command to extract the comparison string from your own local `vendor/obsidian/app.js`.

Once submitted, choices are written to `~/.config/my-obsidian/config.json` (mode `0600`) and take effect immediately without restarting the server. Until confirmed, `/obsidian/app.js` responds with HTTP 403.

Your vault will only gain one additional file: `.obsidian/workspace-server.json` (stored separately from the desktop version's `workspace.json` to prevent layout conflicts).

### Developer Mode: `--dev`

```bash
npm run dev -- --vault <path>
```

`--dev` bypasses the web consent screen by reading the literal directly from `vendor/obsidian/app.js` into server memory at boot. It does not write to disk or logs. **This is intended strictly for local development.**
Constraint: **Restricted to loopback interfaces only** (`127.0.0.1`, `::1`, `localhost`). Specifying `--host 0.0.0.0` with `--dev` will immediately terminate the server.

---

## Daily Operation

- **Live External Changes**: File sync services (Dropbox, iCloud, etc.), git checkouts, and external editor modifications are tracked and reconciled in real-time.
- **Plugin Hot-Reload**: Changes to `plugins/*/main.js` or `manifest.json` automatically trigger reload without data loss. (Can be disabled via `localStorage["myobs-plugin-watch"] = "off"`).
- **Conflict Copies**: Concurrent modifications against the same file on disk trigger conflict copies formatted as `<name>.conflict-<timestamp>.<ext>` and surface a non-intrusive UI notice.
- **Connection Resilience**: Network interruptions or server restarts are caught by frontend probes. During offline states, writes fail explicitly rather than quietly losing data, and changes are reconciled upon reconnection.

---

## Security

- **Bound to `127.0.0.1` by default.**
- The server possesses full read/write access to your vault and executes community plugin scripts inside the browser context. Exposing the service on `0.0.0.0` without an auth token exposes your vault to anyone on your local network.
- `--auth-token` sets a shared secret cookie (`myobs_token`). It prevents unauthorized access but is not a multi-tenant authentication system.
- Always run behind a reverse proxy (e.g. Caddy, Nginx, Cloudflare Tunnel) if TLS is needed.
- Server-side `/api/proxy` for community plugin browsing implements strict allowlists, DNS rebinding mitigation, and private network rejection.

---

## Capabilities

Core functionality provided directly by Obsidian's official renderer:
- Markdown editing and live preview, file tree explorer, split panes and tabs, global search, tags and backlinks, Graph View, Canvas, and Command Palette.
- Core plugins, themes, and CSS snippets.
- **Community Plugins**: Loading, enabling, browsing, installing, updating, and uninstalling.
- **Multi-Window Popouts**: Detached windows share the same application instance and state.
- **Collapsible Application Menu Bar, Context Menus, and Print / Export to PDF**.
- **External change detection and reconciliation**, conflict copy notifications, and offline resilience.
- Desktop and tablet responsive layouts (maintains desktop layout at $\ge 600$px; mobile fallback under $<600$px); installable as a PWA.

---

## Known Limitations

- **No System Shell / Child Process Execution**: While `child_process` can be imported for compatibility, process spawning (`exec`, `spawn`, etc.) is rejected for security. Templater JS user scripts work, but CLI/shell commands do not.
- **System Tray, Global Hotkeys, CLI, and Protocol URI (`obsidian://`)**: Unavailable due to browser sandbox constraints.
- **Sync / Publish**: Official account features are not supported.
- **Popout Window Auto-Restore**: Browsers require a user gesture to open popouts; restored windows are offered as a single-click restore bar on reload.
- **Concurrent Collaborative Editing**: Uses single-writer model with conflict copies; no OT/CRDT real-time multi-user editing.

---

## Troubleshooting

Run `npm run doctor -- --vault <path>` first to run preflight checks.

| Symptom | Cause | Solution |
|---|---|---|
| `npm run vendor` says Obsidian not found | Not installed in standard locations | Install Obsidian or specify path via `--from <path/to/obsidian.asar>` |
| Warning: "Obsidian x.y.z not yet verified" | Installed version is newer than 1.14.4 | Usually works fine; if boot fails, file an issue with version info |
| Doctor says vendor hash mismatch | Extraction incomplete or modified | Re-run `npm run vendor -- --force` |
| `/obsidian/app.js` returns 403 | Consent has not been confirmed | Open `http://127.0.0.1:3000/` and complete the consent screen |
| Stuck on loading screen | Terms string mismatch or vault path unreadable | Check console; re-run `npm run vendor`, delete `~/.config/my-obsidian/config.json`, and re-confirm |
| Server exits immediately on startup | Missing vault path or missing `vendor/` | Check output of `npm run doctor` |
| Plugin hot reload not triggering | Feature disabled in local storage | Remove `localStorage["myobs-plugin-watch"]` |
| Harness reports `MYOBS_LIVE_VAULT is not set` | Fail-closed safety guard | Set `MYOBS_LIVE_VAULT` to your real vault, and test against a copy |

---

## Licensing and Disclaimers

> Read the full declaration in **[`NOTICE.md`](NOTICE.md)**.

**Ownership: Obsidian belongs to Obsidian.**
- This project is an **independent, unofficial project** and has **no affiliation, sponsorship, or endorsement** from Obsidian (Dynalist Inc.).
- Obsidian's software, code, trademarks, and assets remain the exclusive property of Obsidian.
- This repository **does not contain or distribute** Obsidian proprietary binaries or source code. The vendor directory is populated locally on your machine and excluded via `.gitignore`.
- Obsidian is proprietary software subject to its official Terms of Service: <https://obsidian.md/terms>.

**Terms Acknowledgement and Scope of Use.**
- The acknowledgement literal comparison is not bypassed or hardcoded in this repository; it is provided directly by the user on first launch.
- Designed strictly for **personal use on your own machine and vault**. Providing the renderer to third parties over public or hosted environments may be subject to Obsidian's terms and requires explicit permission from Obsidian.

**Warranty Disclaimer.**
- This software is distributed under the MIT License on an **"AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND**. The authors and contributors disclaim all liability for any direct or indirect damages, data loss, or vault corruption arising from the use of this project.

The source code in this repository is licensed under the **MIT License** (see [`LICENSE`](LICENSE)). The MIT License applies solely to the original code in this repository; content in `vendor/` remains subject to Obsidian's own licensing terms.

---

## Project Architecture

```
packages/server/     Fastify backend: /api/fs, /v/*, /api/watch, /api/proxy, /api/plugins, PWA
packages/shim/       13 classic scripts replacing Electron/Node dependencies
packages/runtime/    index.html, consent page, platform bridge, popout, menu, print, resilience
tools/               21 zero-dependency CDP test harnesses for automated browser verification
scripts/             fetch-obsidian.mjs (ASAR unpacker), start.mjs (launcher & doctor)
docs/                DESIGN.md, CONTRACTS.md, HANDOFF.md, PLUGINS.md, TODO.md
packages/shim/GAPS.md Detailed documentation of shim behaviors and approximations
NOTICE.md            Ownership, terms, and liability disclaimer
```

---

## Verification (Developers)

```bash
npm --prefix packages/server ci
npm test                        # 335 unit tests
npm run check:spike -- --vault <copy>  # 10 boot & fs assertions
```

All test harnesses require a fresh vault copy and a configured `MYOBS_LIVE_VAULT` fail-closed environment variable. See `docs/HANDOFF.md` for full test suite execution details.
