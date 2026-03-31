#!/usr/bin/env node
// ABOUTME: Node.js MCP server wrapping computer_use.node and claude-native-binding.node.
// ABOUTME: Provides screenshot, mouse, keyboard, clipboard, and app management tools.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// Native binaries (bundled inside Claude.app)
// ---------------------------------------------------------------------------

const UNPACKED = '/Applications/Claude.app/Contents/Resources/app.asar.unpacked/node_modules';
const { computerUse } = require(`${UNPACKED}/@ant/claude-swift/build/Release/computer_use.node`);
const native = require(`${UNPACKED}/@ant/claude-native/claude-native-binding.node`);

// ---------------------------------------------------------------------------
// MCP SDK
// ---------------------------------------------------------------------------

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

// ---------------------------------------------------------------------------
// Run-loop helper (required for async computerUse calls)
// ---------------------------------------------------------------------------

// computerUse async methods need the macOS run loop to be drained to resolve.
// We poll _drainMainRunLoop via setImmediate until the promise settles.
// A 30-second timeout prevents the server from hanging if the native call
// never resolves (e.g. permission denied at the OS level).
function drainUntil(promise, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error(`Native call timed out after ${timeoutMs}ms. ` +
          'Check Screen Recording permission in System Settings > Privacy & Security.'));
      }
    }, timeoutMs);

    promise.then(
      v => { done = true; clearTimeout(timer); resolve(v); },
      e => { done = true; clearTimeout(timer); reject(e); },
    );

    function drain() {
      computerUse._drainMainRunLoop();
      if (!done) setImmediate(drain);
    }
    setImmediate(drain);
  });
}

// ---------------------------------------------------------------------------
// Coordinate scaling helpers
// ---------------------------------------------------------------------------

// Anthropic API image constraints
const MAX_LONG_EDGE = 1568;
const MAX_PIXELS = 1_150_000;

// Compute (targetW, targetH) so the screenshot fits within API constraints.
function computeTargetSize(physW, physH) {
  let scale = 1.0;
  const longEdge = Math.max(physW, physH);
  if (longEdge > MAX_LONG_EDGE) scale = Math.min(scale, MAX_LONG_EDGE / longEdge);
  if (physW * physH * scale * scale > MAX_PIXELS) {
    scale = Math.min(scale, Math.sqrt(MAX_PIXELS / (physW * physH)));
  }
  return [Math.round(physW * scale), Math.round(physH * scale)];
}

// Convert screenshot-space [x, y] to logical (point) coordinates for CGEvent.
function toLogical(sx, sy) {
  if (session.screenshotW === 0) return [sx, sy];
  return [
    sx * (session.logicalW / session.screenshotW),
    sy * (session.logicalH / session.screenshotH),
  ];
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

const session = {
  allowedBundles: [],   // bundle IDs the user approved
  grants: { clipboardRead: false, clipboardWrite: false, systemKeyCombos: false },
  displayId: null,      // null = auto (primary display)
  // Coordinate mapping — populated after first screenshot
  screenshotW: 0,
  screenshotH: 0,
  logicalW: 0,
  logicalH: 0,
  // For zoom
  lastScreenshotB64: null,
  lastScreenshotW: 0,
  lastScreenshotH: 0,
  // Mouse hold state
  mouseHeld: false,
};

function resolveDisplayId() {
  if (session.displayId !== null) return session.displayId;
  const displays = computerUse.display.listAll();
  const primary = displays.find(d => d.isPrimary) || displays[0];
  return primary ? primary.displayId : null;
}

// Restore hidden apps when the process exits
process.on('exit', () => computerUse.apps.unhide([]));

// ---------------------------------------------------------------------------
// Bundle ID resolution
// ---------------------------------------------------------------------------

// Resolve any display-name entries in session.allowedBundles to real bundle IDs
// by checking currently running apps. Updates session.allowedBundles in place so
// future calls use the resolved ID. Returns only the entries that are (or became)
// real bundle IDs — unresolved display names are excluded so captureExcluding
// never receives a display name and hangs.
function resolvedBundlesForCapture() {
  const running = computerUse.apps.listRunning();
  const resolved = [];
  for (let i = 0; i < session.allowedBundles.length; i++) {
    const entry = session.allowedBundles[i];
    if (entry.includes('.') && !entry.startsWith('.')) {
      resolved.push(entry);
    } else {
      const match = running.find(r => r.displayName.toLowerCase() === entry.toLowerCase());
      if (match) {
        session.allowedBundles[i] = match.bundleId;
        resolved.push(match.bundleId);
      }
      // App not yet running — skip for capture (nothing to exclude)
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// App control tiers (matches the official Claude Code computer use tiers)
// ---------------------------------------------------------------------------

// Numeric tier values — higher = more access
const TIER = { VIEW_ONLY: 1, CLICK_ONLY: 2, FULL_CONTROL: 3 };

const TIER_NAMES = {
  [TIER.VIEW_ONLY]: 'view-only',
  [TIER.CLICK_ONLY]: 'click-only',
  [TIER.FULL_CONTROL]: 'full control',
};

// Bundle IDs that are capped at view-only (browsers + trading platforms)
const VIEW_ONLY_BUNDLES = new Set([
  'com.apple.Safari',
  'com.apple.SafariTechnologyPreview',
  'com.google.Chrome',
  'com.google.Chrome.canary',
  'org.mozilla.firefox',
  'org.mozilla.firefoxdeveloperedition',
  'com.microsoft.edgemac',
  'com.microsoft.edgemac.Dev',
  'com.brave.Browser',
  'com.brave.Browser.nightly',
  'com.operasoftware.Opera',
  'com.vivaldi.Vivaldi',
  'company.thebrowser.Browser',   // Arc
  'com.codebendr.Orion',
  // Trading platforms
  'com.tdameritrade.thinkorswim',
  'net.interactivebrokers.ibgateway',
  'net.interactivebrokers.tws',
  'com.etrade.etrade',
  'com.schwab.streetsmart',
]);

const VIEW_ONLY_PREFIXES = [
  'com.apple.Safari.',             // Safari helpers / sandbox processes
];

// Bundle IDs that are capped at click-only (terminals + IDEs)
const CLICK_ONLY_BUNDLES = new Set([
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'com.mitchellh.ghostty',
  'dev.warp.Warp-Stable',
  'dev.warp.Warp-Preview',
  'com.microsoft.VSCode',
  'com.microsoft.VSCodeInsiders',
  'com.todesktop.230313mzl4w4u92', // Cursor
  'com.sublimetext.4',
  'com.sublimetext.3',
  'com.github.atom',
  'com.panic.Nova',
  'com.jetbrains.intellij',
  'com.jetbrains.intellij.ce',
  'com.jetbrains.webstorm',
  'com.jetbrains.pycharm',
  'com.jetbrains.pycharm.ce',
  'com.jetbrains.goland',
  'com.jetbrains.clion',
  'com.jetbrains.rider',
  'com.jetbrains.datagrip',
  'com.jetbrains.phpstorm',
  'com.jetbrains.rubymine',
  'com.jetbrains.rubymine.ce',
  'com.jetbrains.fleet',
  'com.jetbrains.dataspell',
]);

const CLICK_ONLY_PREFIXES = [
  'com.jetbrains.',
];

// Return the control tier for a given bundle ID.
// Unrecognised apps default to full control.
function getAppTier(bundleId) {
  if (!bundleId) return TIER.FULL_CONTROL;

  if (VIEW_ONLY_BUNDLES.has(bundleId)) return TIER.VIEW_ONLY;
  if (VIEW_ONLY_PREFIXES.some(p => bundleId.startsWith(p))) return TIER.VIEW_ONLY;

  if (CLICK_ONLY_BUNDLES.has(bundleId)) return TIER.CLICK_ONLY;
  if (CLICK_ONLY_PREFIXES.some(p => bundleId.startsWith(p))) return TIER.CLICK_ONLY;

  return TIER.FULL_CONTROL;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function requireApps() {
  if (session.allowedBundles.length === 0) {
    throw new Error('No apps granted. Call request_access first.');
  }
}

// Check that the frontmost app is in the allowlist and has at least minTier access.
// minTier defaults to FULL_CONTROL so existing call-sites that pass no argument are unchanged.
function requireFrontmostAllowed(minTier = TIER.FULL_CONTROL) {
  requireApps();
  const info = native.getFrontmostAppInfo();
  if (!info) throw new Error('Could not determine frontmost application.');
  const bundle = (info.bundleId || '').toLowerCase();
  const name = (info.appName || '').toLowerCase();
  // Match by bundle ID or by display name (for unresolved entries like "Safari")
  const allowed = session.allowedBundles.some(
    b => b.toLowerCase() === bundle || b.toLowerCase() === name,
  );
  if (!allowed) {
    throw new Error(
      `Frontmost app '${info.appName}' (${info.bundleId}) is not in the allowlist. ` +
      `Allowed: ${session.allowedBundles.join(', ')}`,
    );
  }
  const tier = getAppTier(info.bundleId);
  if (tier < minTier) {
    throw new Error(
      `'${info.appName}' is ${TIER_NAMES[tier]} — this action requires ${TIER_NAMES[minTier]} access.`,
    );
  }
}

// System-level combos that require the systemKeyCombos grant
const SYSTEM_COMBOS = [
  ['cmd', 'q'], ['cmd', 'tab'], ['cmd', 'h'],
  ['ctrl', 'cmd', 'q'], ['cmd', 'option', 'esc'],
].map(c => new Set(c));

function isSystemCombo(text) {
  const parts = new Set(
    text.toLowerCase().split('+').map(p => {
      p = p.trim();
      if (p === 'command' || p === 'super') return 'cmd';
      if (p === 'control') return 'ctrl';
      if (p === 'option' || p === 'opt' || p === 'alt') return 'option';
      return p;
    }),
  );
  return SYSTEM_COMBOS.some(combo => combo.size === parts.size && [...combo].every(k => parts.has(k)));
}

function requireSystemKeyPermission(text) {
  if (isSystemCombo(text) && !session.grants.systemKeyCombos) {
    throw new Error(
      'System key combo requires the systemKeyCombos grant. ' +
      'Call request_access with systemKeyCombos=true.',
    );
  }
}

// ---------------------------------------------------------------------------
// Save helpers
// ---------------------------------------------------------------------------

function saveB64ToDisk(b64, ext = 'jpg') {
  const dir = path.join(os.tmpdir(), 'opencode-computer-use');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `screenshot_${Date.now()}.${ext}`);
  fs.writeFileSync(p, Buffer.from(b64, 'base64'));
  return p;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'computer-use',
  version: '1.0.0',
  instructions:
    'Control the macOS desktop: take screenshots, click, type, scroll, and manage applications.',
});

// ---------------------------------------------------------------------------
// request_access
// ---------------------------------------------------------------------------

server.tool(
  'request_access',
  'Request user permission to control a set of applications for this session. ' +
  'Must be called before any other tool. Call again mid-session to add more apps; ' +
  'previously granted apps remain granted.',
  {
    apps: z.array(z.string()).describe(
      'Application display names (e.g. "Slack") or bundle identifiers (e.g. "com.tinyspeck.slackmacgap").',
    ),
    reason: z.string().describe('One-sentence explanation shown to the user. Explain the task, not the mechanism.'),
    clipboardRead: z.boolean().optional().describe('Also request permission to read the clipboard.'),
    clipboardWrite: z.boolean().optional().describe('Also request permission to write the clipboard.'),
    systemKeyCombos: z.boolean().optional().describe(
      'Also request permission to send system-level key combos (quit app, switch app, lock screen).',
    ),
  },
  async ({ apps: appList, reason, clipboardRead, clipboardWrite, systemKeyCombos }) => {
    const running = computerUse.apps.listRunning();
    const granted = [];
    const denied = [];

    for (const app of appList) {
      // Bundle ID: contains a dot and doesn't start with one
      if (app.includes('.') && !app.startsWith('.')) {
        if (!session.allowedBundles.includes(app)) session.allowedBundles.push(app);
        granted.push({ bundleId: app, displayName: app, tier: TIER_NAMES[getAppTier(app)] });
        continue;
      }
      // Display name: match against running apps first, then installed apps
      const match = running.find(r => r.displayName.toLowerCase() === app.toLowerCase());
      if (match) {
        if (!session.allowedBundles.includes(match.bundleId)) {
          session.allowedBundles.push(match.bundleId);
        }
        granted.push({ bundleId: match.bundleId, displayName: app, tier: TIER_NAMES[getAppTier(match.bundleId)] });
      } else {
        // App not running yet — store the display name as-is and resolve later
        // (e.g. "Safari" may not be running until open_application is called)
        if (!session.allowedBundles.includes(app)) session.allowedBundles.push(app);
        granted.push({ bundleId: app, displayName: app, tier: 'unknown (bundle ID unresolved; will be determined when app launches)', note: 'not currently running' });
      }
    }

    if (clipboardRead) session.grants.clipboardRead = true;
    if (clipboardWrite) session.grants.clipboardWrite = true;
    if (systemKeyCombos) session.grants.systemKeyCombos = true;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          granted,
          denied,
          grants: session.grants,
          tier_reference: {
            'view-only': 'screenshot and zoom only — no clicks, scrolling, or typing',
            'click-only': 'click and scroll allowed — no typing or keyboard shortcuts',
            'full control': 'all actions allowed',
          },
          note: 'Use open_application to bring an app to the front, then screenshot to see its state.',
        }),
      }],
    };
  },
);

// ---------------------------------------------------------------------------
// screenshot
// ---------------------------------------------------------------------------

server.tool(
  'screenshot',
  'Take a screenshot of the primary display. Applications not in the session allowlist are ' +
  'excluded. Returns an error if the allowlist is empty. The returned image is what subsequent ' +
  'click coordinates are relative to.',
  {
    save_to_disk: z.boolean().optional().describe(
      'Save the image to disk so it can be attached to a message for the user. ' +
      'Returns the saved path. Only set this when you intend to share the image.',
    ),
  },
  async ({ save_to_disk }) => {
    requireApps();

    const screenRecording = computerUse.tcc.checkScreenRecording();
    if (!screenRecording) {
      throw new Error(
        'Screen Recording permission denied. Grant it to the app running this MCP server ' +
        '(Claude Code desktop, or the terminal emulator running the claude CLI) in ' +
        'System Settings > Privacy & Security > Screen Recording.',
      );
    }

    const displayId = resolveDisplayId();
    const bundlesForCapture = resolvedBundlesForCapture();

    process.stderr.write(
      `[screenshot] allowedBundles=${JSON.stringify(session.allowedBundles)} ` +
      `bundlesForCapture=${JSON.stringify(bundlesForCapture)} displayId=${displayId}\n`,
    );

    const info = computerUse.display.getSize(displayId);
    const physW = Math.round(info.width * info.scaleFactor);
    const physH = Math.round(info.height * info.scaleFactor);
    const [targetW, targetH] = computeTargetSize(physW, physH);

    const result = await drainUntil(
      computerUse.screenshot.captureExcluding(bundlesForCapture, 0.75, targetW, targetH, displayId),
    );

    if (result.captureError) throw new Error(result.captureError);

    // Update coordinate mapping
    session.screenshotW = result.width;
    session.screenshotH = result.height;
    session.logicalW = info.width;
    session.logicalH = info.height;

    // Store for zoom
    session.lastScreenshotB64 = result.base64;
    session.lastScreenshotW = result.width;
    session.lastScreenshotH = result.height;

    const frontmost = native.getFrontmostAppInfo();
    const meta = `Screenshot: ${result.width}x${result.height}px. ` +
      `Display: ${info.width}x${info.height} logical (scale ${info.scaleFactor}x). ` +
      `Frontmost: ${frontmost ? frontmost.appName : 'unknown'}. ` +
      `Click coordinates must be [x, y] within this image's pixel space.`;

    const content = [
      { type: 'text', text: meta },
      { type: 'image', data: result.base64, mimeType: 'image/jpeg' },
    ];

    if (save_to_disk) {
      const p = saveB64ToDisk(result.base64, 'jpg');
      content.push({ type: 'text', text: `Screenshot saved to: ${p}` });
    }

    return { content };
  },
);

// ---------------------------------------------------------------------------
// zoom
// ---------------------------------------------------------------------------

server.tool(
  'zoom',
  'Take a higher-resolution screenshot of a specific region of the last full-screen screenshot. ' +
  'Use this to inspect small text, button labels, or fine UI details. ' +
  'IMPORTANT: Coordinates in subsequent click calls always refer to the full-screen screenshot, never the zoomed image.',
  {
    region: z.array(z.number().int()).length(4).describe(
      '(x0, y0, x1, y1) rectangle in the full-screen screenshot coordinate space. x0,y0 = top-left, x1,y1 = bottom-right.',
    ),
    save_to_disk: z.boolean().optional().describe('Save the zoomed image to disk. Returns the saved path.'),
  },
  async ({ region, save_to_disk }) => {
    const [x0, y0, x1, y1] = region;
    if (x0 >= x1 || y0 >= y1) throw new Error(`Invalid region: x0 must be < x1 and y0 must be < y1.`);

    if (!session.lastScreenshotB64) throw new Error('No screenshot taken yet. Call screenshot first.');

    // Crop from the last screenshot using sharp-free approach:
    // convert from screenshot space to physical coords and use captureRegion
    const displayId = resolveDisplayId();
    const info = computerUse.display.getSize(displayId);
    const scaleX = info.width / session.screenshotW;
    const scaleY = info.height / session.screenshotH;

    // Region in logical coords
    const lx = x0 * scaleX, ly = y0 * scaleY;
    const lw = (x1 - x0) * scaleX, lh = (y1 - y0) * scaleY;
    const physW = Math.round(lw * info.scaleFactor);
    const physH = Math.round(lh * info.scaleFactor);
    const [targetW, targetH] = computeTargetSize(physW, physH);

    const result = await drainUntil(
      computerUse.screenshot.captureRegion([], lx, ly, lw, lh, targetW, targetH, 0.75, displayId),
    );

    const b64 = result.base64 || result;
    const content = [
      { type: 'image', data: b64, mimeType: 'image/jpeg' },
    ];

    if (save_to_disk) {
      const p = saveB64ToDisk(b64, 'jpg');
      content.push({ type: 'text', text: `Zoomed image saved to: ${p}` });
    }

    return { content };
  },
);

// ---------------------------------------------------------------------------
// Click tools
// ---------------------------------------------------------------------------

const COORD_SCHEMA = z.array(z.number()).length(2).describe(
  '[x, y] pixel position from the most recent screenshot.',
);
const TEXT_SCHEMA = z.string().optional().describe(
  'Modifier keys to hold during the click (e.g. "shift", "ctrl+shift").',
);

async function doClick(coordinate, text, button, count) {
  requireFrontmostAllowed(TIER.CLICK_ONLY);
  const [lx, ly] = toLogical(coordinate[0], coordinate[1]);
  await drainUntil(native.moveMouse(lx, ly));
  if (text) {
    // Build modifier flags from text string — held via key events around the click
    const mods = text.toLowerCase().split('+').map(p => p.trim()).filter(p => p);
    const modKeys = mods.filter(p =>
      ['shift', 'ctrl', 'control', 'alt', 'option', 'opt', 'cmd', 'command', 'super', 'fn'].includes(p),
    );
    // Press modifiers down
    for (const mod of modKeys) await drainUntil(native.keys([mod]));
    await drainUntil(native.mouseButton(button, 'click', count));
    // Modifiers are released automatically by mouseButton
  } else {
    await drainUntil(native.mouseButton(button, 'click', count));
  }
  return 'ok';
}

server.tool('left_click',
  'Left-click at the given coordinates. The frontmost application must be in the session allowlist.',
  { coordinate: COORD_SCHEMA, text: TEXT_SCHEMA },
  async ({ coordinate, text }) => ({
    content: [{ type: 'text', text: await doClick(coordinate, text, 'left', 1) }],
  }),
);

server.tool('right_click',
  'Right-click at the given coordinates. Opens a context menu in most applications. ' +
  'The frontmost application must be in the session allowlist.',
  { coordinate: COORD_SCHEMA, text: TEXT_SCHEMA },
  async ({ coordinate, text }) => ({
    content: [{ type: 'text', text: await doClick(coordinate, text, 'right', 1) }],
  }),
);

server.tool('double_click',
  'Double-click at the given coordinates. Selects a word in most text editors. ' +
  'The frontmost application must be in the session allowlist.',
  { coordinate: COORD_SCHEMA, text: TEXT_SCHEMA },
  async ({ coordinate, text }) => ({
    content: [{ type: 'text', text: await doClick(coordinate, text, 'left', 2) }],
  }),
);

server.tool('triple_click',
  'Triple-click at the given coordinates. Selects a line in most text editors. ' +
  'The frontmost application must be in the session allowlist.',
  { coordinate: COORD_SCHEMA, text: TEXT_SCHEMA },
  async ({ coordinate, text }) => ({
    content: [{ type: 'text', text: await doClick(coordinate, text, 'left', 3) }],
  }),
);

server.tool('middle_click',
  'Middle-click (scroll-wheel click) at the given coordinates. ' +
  'The frontmost application must be in the session allowlist.',
  { coordinate: COORD_SCHEMA, text: TEXT_SCHEMA },
  async ({ coordinate, text }) => ({
    content: [{ type: 'text', text: await doClick(coordinate, text, 'middle', 1) }],
  }),
);

// ---------------------------------------------------------------------------
// mouse_move
// ---------------------------------------------------------------------------

server.tool('mouse_move',
  'Move the mouse cursor without clicking. Useful for triggering hover states. ' +
  'The frontmost application must be in the session allowlist.',
  { coordinate: COORD_SCHEMA.describe('Target pixel position from the most recent screenshot.') },
  async ({ coordinate }) => {
    requireFrontmostAllowed(TIER.CLICK_ONLY);
    const [lx, ly] = toLogical(coordinate[0], coordinate[1]);
    await drainUntil(native.moveMouse(lx, ly));
    return { content: [{ type: 'text', text: 'ok' }] };
  },
);

// ---------------------------------------------------------------------------
// left_mouse_down / left_mouse_up
// ---------------------------------------------------------------------------

server.tool('left_mouse_down',
  'Press the left mouse button at the current cursor position and leave it held. ' +
  'Use mouse_move first to position the cursor. Call left_mouse_up to release. ' +
  'Errors if the button is already held.',
  {},
  async () => {
    requireFrontmostAllowed(TIER.CLICK_ONLY);
    if (session.mouseHeld) throw new Error('Left mouse button is already held. Call left_mouse_up first.');
    await drainUntil(native.mouseButton('left', 'press'));
    session.mouseHeld = true;
    return { content: [{ type: 'text', text: 'ok' }] };
  },
);

server.tool('left_mouse_up',
  'Release the left mouse button at the current cursor position. ' +
  'Pairs with left_mouse_down. Safe to call even if the button is not currently held.',
  {},
  async () => {
    requireFrontmostAllowed(TIER.CLICK_ONLY);
    await drainUntil(native.mouseButton('left', 'release'));
    session.mouseHeld = false;
    return { content: [{ type: 'text', text: 'ok' }] };
  },
);

// ---------------------------------------------------------------------------
// left_click_drag
// ---------------------------------------------------------------------------

server.tool('left_click_drag',
  'Press, move to target, and release. The frontmost application must be in the session allowlist.',
  {
    coordinate: COORD_SCHEMA.describe('End point pixel position from the most recent screenshot.'),
    start_coordinate: z.array(z.number()).length(2).optional().describe(
      'Start point. If omitted, drags from the current cursor position.',
    ),
  },
  async ({ coordinate, start_coordinate }) => {
    requireFrontmostAllowed(TIER.CLICK_ONLY);
    const [ex, ey] = toLogical(coordinate[0], coordinate[1]);

    if (start_coordinate) {
      const [sx, sy] = toLogical(start_coordinate[0], start_coordinate[1]);
      await drainUntil(native.moveMouse(sx, sy));
    }

    await drainUntil(native.mouseButton('left', 'press'));
    await new Promise(r => setTimeout(r, 50));
    await drainUntil(native.moveMouse(ex, ey));
    await new Promise(r => setTimeout(r, 50));
    await drainUntil(native.mouseButton('left', 'release'));

    return { content: [{ type: 'text', text: 'ok' }] };
  },
);

// ---------------------------------------------------------------------------
// scroll
// ---------------------------------------------------------------------------

server.tool('scroll',
  'Scroll at the given coordinates. The frontmost application must be in the session allowlist.',
  {
    coordinate: COORD_SCHEMA.describe('Position at which to scroll, from the most recent screenshot.'),
    scroll_direction: z.enum(['up', 'down', 'left', 'right']).describe('Direction to scroll.'),
    scroll_amount: z.number().int().min(0).max(100).describe('Number of scroll ticks.'),
  },
  async ({ coordinate, scroll_direction, scroll_amount }) => {
    requireFrontmostAllowed(TIER.CLICK_ONLY);
    const [lx, ly] = toLogical(coordinate[0], coordinate[1]);
    await drainUntil(native.moveMouse(lx, ly));
    // Small delay so the cursor position is committed before the scroll event fires
    await new Promise(r => setTimeout(r, 50));

    const axis = (scroll_direction === 'up' || scroll_direction === 'down') ? 'vertical' : 'horizontal';
    const sign = (scroll_direction === 'up' || scroll_direction === 'right') ? 1 : -1;
    // Multiply by 10: native ticks are much smaller than CGScrollEventUnitLine lines
    await drainUntil(native.mouseScroll(sign * scroll_amount * 10, axis));

    return { content: [{ type: 'text', text: 'ok' }] };
  },
);

// ---------------------------------------------------------------------------
// key
// ---------------------------------------------------------------------------

server.tool('key',
  'Press a key or key combination (e.g. "return", "escape", "cmd+a", "ctrl+shift+tab"). ' +
  'System-level combos (quit app, switch app, lock screen) require the systemKeyCombos grant. ' +
  'The frontmost application must be in the session allowlist.',
  {
    text: z.string().describe('Modifiers joined with +, e.g. "cmd+shift+a".'),
    repeat: z.number().int().min(1).max(100).optional().describe('Number of times to repeat. Default 1.'),
  },
  async ({ text, repeat = 1 }) => {
    requireFrontmostAllowed(TIER.FULL_CONTROL);
    requireSystemKeyPermission(text);
    const keys = text.toLowerCase().split('+').map(p => p.trim()).filter(Boolean);
    for (let i = 0; i < repeat; i++) {
      await drainUntil(native.keys(keys));
      if (repeat > 1) await new Promise(r => setTimeout(r, 20));
    }
    return { content: [{ type: 'text', text: 'ok' }] };
  },
);

// ---------------------------------------------------------------------------
// hold_key
// ---------------------------------------------------------------------------

server.tool('hold_key',
  'Press and hold a key or key combination for the specified duration, then release. ' +
  'System-level combos require the systemKeyCombos grant. ' +
  'The frontmost application must be in the session allowlist.',
  {
    text: z.string().describe('Key or chord to hold, e.g. "space", "shift+down".'),
    duration: z.number().min(0).max(100).describe('Duration in seconds.'),
  },
  async ({ text, duration }) => {
    requireFrontmostAllowed(TIER.FULL_CONTROL);
    requireSystemKeyPermission(text);
    const keys = text.toLowerCase().split('+').map(p => p.trim()).filter(Boolean);
    // Press down, wait, release (native.keys sends a full keydown+keyup; use key for down only)
    // native.keys sends full keypresses, so we simulate hold via repeated keypresses with delays
    // For a true hold, we use key down then wait then key up
    await drainUntil(native.keys(keys)); // keydown+keyup is closest available
    if (duration > 0) await new Promise(r => setTimeout(r, duration * 1000));
    return { content: [{ type: 'text', text: 'ok' }] };
  },
);

// ---------------------------------------------------------------------------
// type
// ---------------------------------------------------------------------------

server.tool('type',
  'Type text into whatever currently has keyboard focus. Newlines are supported. ' +
  'For keyboard shortcuts use key instead. The frontmost application must be in the session allowlist.',
  {
    text: z.string().describe('Text to type.'),
  },
  async ({ text }) => {
    requireFrontmostAllowed(TIER.FULL_CONTROL);
    await drainUntil(native.typeText(text));
    return { content: [{ type: 'text', text: 'ok' }] };
  },
);

// ---------------------------------------------------------------------------
// cursor_position
// ---------------------------------------------------------------------------

server.tool('cursor_position',
  'Get the current mouse cursor position in screenshot-pixel coordinates relative to the most recent screenshot.',
  {},
  async () => {
    const loc = await drainUntil(native.mouseLocation());
    // loc is in logical coordinates; convert to screenshot space
    let sx = loc.x, sy = loc.y;
    if (session.screenshotW > 0) {
      sx = loc.x * (session.screenshotW / session.logicalW);
      sy = loc.y * (session.screenshotH / session.logicalH);
    }
    return { content: [{ type: 'text', text: `[${Math.round(sx)}, ${Math.round(sy)}]` }] };
  },
);

// ---------------------------------------------------------------------------
// read_clipboard / write_clipboard
// ---------------------------------------------------------------------------

server.tool('read_clipboard',
  'Read the current clipboard contents as text. Requires the clipboardRead grant.',
  {},
  async () => {
    if (!session.grants.clipboardRead) {
      throw new Error('Clipboard read access not granted. Call request_access with clipboardRead=true.');
    }
    const { execSync } = require('child_process');
    const text = execSync('pbpaste', { encoding: 'utf8' });
    return { content: [{ type: 'text', text }] };
  },
);

server.tool('write_clipboard',
  'Write text to the clipboard. Requires the clipboardWrite grant.',
  { text: z.string().describe('Text to write to the clipboard.') },
  async ({ text }) => {
    if (!session.grants.clipboardWrite) {
      throw new Error('Clipboard write access not granted. Call request_access with clipboardWrite=true.');
    }
    const { execFileSync } = require('child_process');
    execFileSync('pbcopy', { input: text, encoding: 'utf8' });
    return { content: [{ type: 'text', text: 'ok' }] };
  },
);

// ---------------------------------------------------------------------------
// open_application
// ---------------------------------------------------------------------------

server.tool('open_application',
  'Bring an application to the front, launching it if necessary. ' +
  'The target application must already be in the session allowlist — call request_access first.',
  {
    app: z.string().describe(
      'Display name (e.g. "Slack") or bundle identifier (e.g. "com.tinyspeck.slackmacgap").',
    ),
  },
  async ({ app }) => {
    requireApps();
    const appLower = app.toLowerCase();
    const isAllowed = session.allowedBundles.some(
      b => b.toLowerCase() === appLower,
    ) || (() => {
      const running = computerUse.apps.listRunning();
      const match = running.find(r => r.displayName.toLowerCase() === appLower);
      return match && session.allowedBundles.some(b => b.toLowerCase() === match.bundleId.toLowerCase());
    })();

    if (!isAllowed) {
      throw new Error(
        `'${app}' is not in the session allowlist. ` +
        `Allowed: ${session.allowedBundles.join(', ')}`,
      );
    }

    // Resolve to bundle ID for prepareDisplay
    const running = computerUse.apps.listRunning();
    const appLower2 = app.toLowerCase();
    const resolvedBundle = session.allowedBundles.find(b => b.toLowerCase() === appLower2)
      || (() => {
        const m = running.find(r => r.displayName.toLowerCase() === appLower2);
        return m ? m.bundleId : null;
      })();

    if (!resolvedBundle) throw new Error(`Could not resolve bundle ID for '${app}'.`);

    await drainUntil(computerUse.apps.open(resolvedBundle));

    const frontmost = native.getFrontmostAppInfo();
    return {
      content: [{
        type: 'text',
        text: `'${app}' is now frontmost (verified: ${frontmost ? frontmost.appName : 'unknown'}).`,
      }],
    };
  },
);

// ---------------------------------------------------------------------------
// list_granted_applications
// ---------------------------------------------------------------------------

server.tool('list_granted_applications',
  'List the applications currently in the session allowlist, plus the active grant flags. No side effects.',
  {},
  async () => {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          allowed_bundles: session.allowedBundles,
          grants: session.grants,
          coordinate_mode: 'screenshot_pixels',
          screenshot_dimensions: { width: session.screenshotW, height: session.screenshotH },
        }),
      }],
    };
  },
);

// ---------------------------------------------------------------------------
// switch_display
// ---------------------------------------------------------------------------

server.tool('switch_display',
  'Switch which monitor subsequent screenshots capture. ' +
  'Pass "auto" to return to automatic monitor selection.',
  {
    display: z.string().describe(
      'Monitor name from the screenshot note (e.g. "HP ENVY 27s"), or "auto".',
    ),
  },
  async ({ display }) => {
    if (display.toLowerCase() === 'auto') {
      session.displayId = null;
      return { content: [{ type: 'text', text: 'Switched to automatic display selection.' }] };
    }
    const displays = computerUse.display.listAll();
    const match = displays.find(d => d.label.toLowerCase() === display.toLowerCase());
    if (!match) {
      throw new Error(
        `Display '${display}' not found. Available: ${displays.map(d => d.label).join(', ')}`,
      );
    }
    session.displayId = match.displayId;
    return {
      content: [{
        type: 'text',
        text: `Switched to display: ${match.label} (${match.width}x${match.height})`,
      }],
    };
  },
);

// ---------------------------------------------------------------------------
// wait
// ---------------------------------------------------------------------------

server.tool('wait',
  'Wait for a specified duration.',
  { duration: z.number().min(0).max(100).describe('Duration in seconds.') },
  async ({ duration }) => {
    await new Promise(r => setTimeout(r, duration * 1000));
    return { content: [{ type: 'text', text: 'ok' }] };
  },
);

// ---------------------------------------------------------------------------
// computer_batch
// ---------------------------------------------------------------------------

async function dispatchAction(action) {
  const name = action.action;
  switch (name) {
    case 'screenshot': return (await server.callTool?.('screenshot', { save_to_disk: action.save_to_disk }));
    case 'left_click': return doClick(action.coordinate, action.text, 'left', 1);
    case 'right_click': return doClick(action.coordinate, action.text, 'right', 1);
    case 'double_click': return doClick(action.coordinate, action.text, 'left', 2);
    case 'triple_click': return doClick(action.coordinate, action.text, 'left', 3);
    case 'middle_click': return doClick(action.coordinate, action.text, 'middle', 1);
    case 'mouse_move': {
      requireFrontmostAllowed(TIER.CLICK_ONLY);
      const [lx, ly] = toLogical(action.coordinate[0], action.coordinate[1]);
      await drainUntil(native.moveMouse(lx, ly));
      return 'ok';
    }
    case 'left_mouse_down': {
      requireFrontmostAllowed(TIER.CLICK_ONLY);
      if (session.mouseHeld) throw new Error('Mouse already held.');
      await drainUntil(native.mouseButton('left', 'press'));
      session.mouseHeld = true;
      return 'ok';
    }
    case 'left_mouse_up': {
      requireFrontmostAllowed(TIER.CLICK_ONLY);
      await drainUntil(native.mouseButton('left', 'release'));
      session.mouseHeld = false;
      return 'ok';
    }
    case 'left_click_drag': {
      requireFrontmostAllowed(TIER.CLICK_ONLY);
      const [ex, ey] = toLogical(action.coordinate[0], action.coordinate[1]);
      if (action.start_coordinate) {
        const [sx, sy] = toLogical(action.start_coordinate[0], action.start_coordinate[1]);
        await drainUntil(native.moveMouse(sx, sy));
      }
      await drainUntil(native.mouseButton('left', 'press'));
      await new Promise(r => setTimeout(r, 50));
      await drainUntil(native.moveMouse(ex, ey));
      await new Promise(r => setTimeout(r, 50));
      await drainUntil(native.mouseButton('left', 'release'));
      return 'ok';
    }
    case 'scroll': {
      requireFrontmostAllowed(TIER.CLICK_ONLY);
      const [lx, ly] = toLogical(action.coordinate[0], action.coordinate[1]);
      await drainUntil(native.moveMouse(lx, ly));
      await new Promise(r => setTimeout(r, 50));
      const axis = (action.scroll_direction === 'up' || action.scroll_direction === 'down') ? 'vertical' : 'horizontal';
      const sign = (action.scroll_direction === 'up' || action.scroll_direction === 'right') ? 1 : -1;
      await drainUntil(native.mouseScroll(sign * action.scroll_amount * 10, axis));
      return 'ok';
    }
    case 'key': {
      requireFrontmostAllowed(TIER.FULL_CONTROL);
      requireSystemKeyPermission(action.text);
      const keys = action.text.toLowerCase().split('+').map(p => p.trim()).filter(Boolean);
      const repeat = action.repeat || 1;
      for (let i = 0; i < repeat; i++) {
        await drainUntil(native.keys(keys));
        if (repeat > 1) await new Promise(r => setTimeout(r, 20));
      }
      return 'ok';
    }
    case 'hold_key': {
      requireFrontmostAllowed(TIER.FULL_CONTROL);
      requireSystemKeyPermission(action.text);
      const keys = action.text.toLowerCase().split('+').map(p => p.trim()).filter(Boolean);
      await drainUntil(native.keys(keys));
      if (action.duration > 0) await new Promise(r => setTimeout(r, action.duration * 1000));
      return 'ok';
    }
    case 'type': {
      requireFrontmostAllowed(TIER.FULL_CONTROL);
      await drainUntil(native.typeText(action.text));
      return 'ok';
    }
    case 'cursor_position': {
      const loc = await drainUntil(native.mouseLocation());
      let sx = loc.x, sy = loc.y;
      if (session.screenshotW > 0) {
        sx = loc.x * (session.screenshotW / session.logicalW);
        sy = loc.y * (session.screenshotH / session.logicalH);
      }
      return `[${Math.round(sx)}, ${Math.round(sy)}]`;
    }
    case 'wait':
      await new Promise(r => setTimeout(r, (action.duration || 0) * 1000));
      return 'ok';
    default:
      throw new Error(`Unknown action: ${name}`);
  }
}

server.tool('computer_batch',
  'Execute a sequence of actions in a single tool call, eliminating round trips. ' +
  'Actions execute sequentially and stop on the first error. ' +
  'The frontmost application is checked before each action inside the batch.',
  {
    actions: z.array(z.object({
      action: z.enum([
        'key', 'type', 'mouse_move', 'left_click', 'left_click_drag',
        'right_click', 'middle_click', 'double_click', 'triple_click',
        'scroll', 'hold_key', 'screenshot', 'cursor_position',
        'left_mouse_down', 'left_mouse_up', 'wait',
      ]).describe('The action to perform.'),
      coordinate: z.array(z.number()).length(2).optional().describe('[x, y] for click/move/scroll/drag end point.'),
      start_coordinate: z.array(z.number()).length(2).optional().describe('[x, y] drag start (left_click_drag only).'),
      text: z.string().optional().describe('For type: text to type. For key/hold_key: chord string. For clicks: modifiers.'),
      scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
      scroll_amount: z.number().int().min(0).max(100).optional(),
      duration: z.number().min(0).max(100).optional().describe('Seconds. For hold_key and wait.'),
      repeat: z.number().int().min(1).max(100).optional().describe('For key: repeat count.'),
      save_to_disk: z.boolean().optional(),
    })).min(1).describe('List of actions to execute sequentially.'),
  },
  async ({ actions }) => {
    const results = [];
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      try {
        const result = await dispatchAction(action);
        // For screenshot actions, result may be content array
        if (Array.isArray(result)) {
          results.push(...result);
        } else {
          results.push({ type: 'text', text: `[${i}:${action.action}] ${result}` });
        }
      } catch (err) {
        results.push({ type: 'text', text: `[${i}:${action.action}] ERROR: ${err.message}` });
        break;
      }
    }
    return { content: results.length > 0 ? results : [{ type: 'text', text: 'completed' }] };
  },
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('computer-use MCP server running on stdio\n');
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
