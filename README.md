# Grok WebUI

Free, self-hosted browser UI for the Grok agent on **your** machine. Speaks the official ACP protocol (`grok agent stdio`). Designed for private access (Tailscale or localhost) — not the public internet.

**Free forever.** No paid tier, no feature unlocks. Optional one-time tips via [agentmediatools.com/tip](https://agentmediatools.com/tip) if it helps.

**Downloads & setup guide:** [agentmediatools.com/webui](https://agentmediatools.com/webui)

Independent community project from Agent Media Tools. Not affiliated with or
endorsed by xAI.

## Features

- Multi-session chat history (reads `~/.grok/sessions`, continues via `session/load`)
- Live streaming of assistant text, reasoning, tool calls, and plans
- Slash-command picker (`/` autocomplete from Grok’s available commands)
- File & image attachments (upload, drag-and-drop, paste)
- Download / preview of workspace files and generated images
- Authenticated gallery for recent uploads and generated workspace files
- Restrictive, Moderate, and YOLO permission presets with in-chat Allow / Deny requests
- Persistent follow-up queue with Queue or Interrupt & send controls
- Persistent execution plans and low-latency live chat updates
- Workspace folder picker (bounded to `WORKSPACE_ROOT`)
- Model picker when the agent reports available models
- Stop / cancel in-flight turns
- Password-protected UI, same-origin CSRF guard, Tailscale-friendly bind
- First-run setup: choose username + password in the browser
- Optional tip link (does not unlock features)

## Security model

- Binds to an explicit host (setup uses Tailscale IPv4, or `127.0.0.1`) — not `0.0.0.0` by default
- Grok agent uses local `stdio` only; never exposed as a network port
- Username + scrypt-hashed password; raw password is not stored
- First visit offers setup when credentials are missing
- Sessions: random `HttpOnly`, `SameSite=Strict` cookies (default 24h)
- State-changing requests require the exact WebUI origin
- Login / setup rate limited in memory
- Working directories restricted to `WORKSPACE_ROOT` and real children
- Grok permission requests are handled according to the selected preset; protected actions can pause for an explicit Allow / Deny decision
- Browser never receives your Grok OAuth token or API key

This is a **trusted personal tool**, not a multi-user or public SaaS. Do not port-forward it to the open internet.

### Reset credentials

Remove `WEBUI_USERNAME`, `PASSWORD_SALT`, and `PASSWORD_HASH` from `.env`, then restart:

```bash
systemctl --user restart grok-webui
```

The next visit shows the setup form again.

## Setup

Prerequisites:

- Node.js 20+
- Authenticated `grok` CLI (`grok login` or `XAI_API_KEY`)
- Tailscale optional (recommended for phone / other devices)

```bash
cd /path/to/grok-webui
chmod +x ./scripts/setup.sh
./scripts/setup.sh
```

Optional env overrides before setup:

```bash
export WORKSPACE_ROOT="$HOME/projects"   # default: $HOME
export GROK_HOME="$HOME/.grok"           # default: $HOME/.grok
export PORT=4546
```

Setup writes a mode-`600` `.env`, installs a systemd user service, and starts it. Open the printed URL (e.g. `http://100.x.x.x:4546`).

## Service commands

```bash
systemctl --user status grok-webui
systemctl --user restart grok-webui
journalctl --user -u grok-webui -f
```

## Development

```bash
npm start
npm run check
npm test
```

## Usage

| Action | How |
| --- | --- |
| New chat | **＋ New chat**, pick a workspace, type a message |
| Slash commands | Type `/` |
| Attach files | 📎, drag-and-drop, or paste an image |
| Stop a run | **Stop** in the top bar |
| Activity | **Activity** rail for tools + reasoning |
| Files | Sidebar **▦ Files** for the authenticated gallery |
| Permissions | **Prefs → Agent permissions** |
| Follow-up | Send while working, then choose **Queue** or **Interrupt & send** |
| Tip | Sidebar **♡ Tip** (optional) |

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address (setup prefers Tailscale IP) |
| `PORT` | `4546` | HTTP port |
| `WORKSPACE_ROOT` | `$HOME` at setup | Allowed project root |
| `GROK_HOME` | `~/.grok` | Grok config / sessions |
| `SESSION_HOURS` | `24` | Cookie lifetime |
| `SESSION_IDLE_MS` | `1200000` (20 min) | Unload idle loaded ACP sessions (clamped 5–60 min) |
| `WEBUI_USERNAME` | optional until setup | Login username |
| `PASSWORD_SALT` / `PASSWORD_HASH` | set at setup | UI password hash |
| `GROK_BIN` | `grok` | Path to Grok CLI |

## Relation to Codex WebUI

[Codex WebUI](../codex-webui) (`:4545`) talks to `codex app-server`.  
Grok WebUI (`:4546`) talks to `grok agent stdio`. Separate services; can run side by side.

## Optional tip

If this saved you time: [agentmediatools.com/tip](https://agentmediatools.com/tip?from=grok-webui) — never required, never unlocks features.
