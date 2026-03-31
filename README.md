# computer-use-mcp

An MCP server that gives AI assistants full macOS desktop control: screenshots, mouse, keyboard, scrolling, and app management. Works with any MCP host — Claude Code, OpenCode, or your own agent.

> **Requires Claude.app** — the server loads two native binaries bundled inside `/Applications/Claude.app`. You don't need to be running Claude Desktop to use this server, but the app must be installed.

## What it does

The server exposes 24 tools covering everything needed to operate a macOS desktop:

| Category | Tools |
|---|---|
| Vision | `screenshot`, `zoom` |
| Mouse | `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `mouse_move`, `left_click_drag`, `left_mouse_down`, `left_mouse_up`, `scroll` |
| Keyboard | `key`, `hold_key`, `type` |
| Clipboard | `read_clipboard`, `write_clipboard` |
| Apps | `request_access`, `open_application`, `list_granted_applications`, `switch_display` |
| Utility | `cursor_position`, `wait`, `computer_batch` |

Screenshots are captured at full Retina resolution and scaled to fit model constraints (≤1568px, ≤1.15MP). Click coordinates from the model are automatically mapped back to logical screen coordinates for CGEvent dispatch.

## Permission tiers

App access is tiered by category, matching the behaviour of Claude Code's built-in computer use:

| Tier | Applies to | What the model can do |
|---|---|---|
| View-only | Browsers (Safari, Chrome, Firefox, Edge, Arc, Brave…), trading platforms | Screenshot only |
| Click-only | Terminals (Terminal, iTerm, Ghostty, Warp), IDEs (VS Code, Cursor, JetBrains…) | Click and scroll, no typing |
| Full control | Everything else | All actions |

## Use cases

- **Test native apps** — compile a macOS or iOS target, launch it, click through every screen, and screenshot error states, all in one conversation.
- **Reproduce visual bugs** — resize windows to trigger layout regressions, capture the broken state, patch the CSS, verify the fix.
- **Drive GUI-only tools** — interact with design tools, hardware panels, simulators, or any app without a CLI or API.
- **End-to-end UI flows** — walk through onboarding, checkout, or admin flows and report what you find.

## Requirements

- macOS (Apple Silicon or Intel)
- Node.js 18+
- [Claude.app](https://claude.ai/download) installed at `/Applications/Claude.app`
- **Accessibility** and **Screen Recording** permissions granted to the process that spawns the server (your terminal app or IDE)

## Installation

```bash
git clone https://github.com/NicolaivdSmagt/computer-use-mcp.git
cd computer-use-mcp
npm install
```

## Enable in Claude Code

Add the server to `~/.claude.json`:

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "node",
      "args": ["/absolute/path/to/computer-use-mcp/index.js"]
    }
  }
}
```

Restart Claude Code. The tools appear as `mcp__computer-use__*` in your session.

## Enable in OpenCode

Add to your OpenCode config (`~/.config/opencode/config.json` or equivalent):

```json
{
  "mcp": {
    "servers": {
      "computer-use": {
        "command": "node",
        "args": ["/absolute/path/to/computer-use-mcp/index.js"]
      }
    }
  }
}
```

## Granting macOS permissions

The server checks both permissions at startup and exits with a clear error if either is missing.

1. Open **System Settings → Privacy & Security → Accessibility** — add and enable your terminal app (or the app that launches the server).
2. Open **System Settings → Privacy & Security → Screen Recording** — do the same.

Permissions are inherited by child processes, so you only need to grant them to the parent process once.

## Session model

Every session starts with an empty allowlist. Call `request_access` first with the apps you need:

```
request_access(apps: ["Safari"], reason: "Navigate to the app and verify the onboarding flow")
```

The response tells you the tier granted for each app. From that point, Claude can call `open_application`, `screenshot`, and the interaction tools that the tier permits. The allowlist resets when the server process exits.

## How it works

The server wraps two native NAPI binaries bundled inside Claude.app:

- **`computer_use.node`** — screenshot capture (`captureExcluding`, `captureRegion`), display enumeration, app management, TCC permission checks. Its async methods require the macOS run loop to be drained explicitly; the server handles this internally.
- **`claude-native-binding.node`** — mouse events (`moveMouse`, `mouseButton`, `mouseScroll`), keyboard (`keys`, `typeText`), cursor position, frontmost app info.

No Electron, no AppleScript, no Accessibility API polling. Both binaries dispatch real CGEvents directly into the macOS event system.
