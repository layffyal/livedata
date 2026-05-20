#!/usr/bin/env node
'use strict';
/*
 * Phantom U — Live Metrics Dashboard
 * ----------------------------------
 * A standalone web app that shows Phantom U's social reach. It serves a
 * single page and, on every page load, force-pulls fresh follower / view
 * counts from bundle.social.
 *
 * Covers TikTok, Instagram and YouTube via bundle.social.
 *
 * REQUIREMENTS
 *   - Node.js 18+ (built-in fetch + http). No npm install needed.
 *   - TikTok / Instagram / YouTube connected in the bundle.social dashboard.
 *
 * RUN
 *   BUNDLE_SOCIAL_API_KEY=your-key  node server.js
 *   then open  http://localhost:7842
 *
 * Optional env:
 *   PORT           port to listen on (default 7842)
 *   DASH_USER      Basic-Auth username (default "phantom")
 *   DASH_PASSWORD  Basic-Auth password. When set, the whole dashboard is
 *                  password-protected. Leave unset for an open local run.
 *
 * REFRESH BEHAVIOUR
 *   Each page load asks bundle.social to force a fresh pull from the
 *   platforms. bundle.social caps force requests at (teams x 5) per day,
 *   and this app makes one per connected platform. Once the cap is hit,
 *   it automatically falls back to the most recent data bundle.social
 *   already has (refreshed on their side every ~24h) and labels it as
 *   such — the page never breaks, it just stops forcing.
 *
 *   config.json -> "minRefreshSeconds" throttles this: refreshes that
 *   arrive within that window reuse the last result instead of forcing
 *   again, so a few rapid reloads don't burn the daily quota. Set it to 0
 *   to force on literally every load.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = 'https://api.bundle.social/api/v1';
const KEY = process.env.BUNDLE_SOCIAL_API_KEY;
const PORT = process.env.PORT || 7842;
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// Basic-Auth gate. Active only when DASH_PASSWORD is set, so local runs
// stay open while the cloud deployment is locked down.
const AUTH_USER = process.env.DASH_USER || 'phantom';
const AUTH_PASS = process.env.DASH_PASSWORD || '';

// Platforms bundle.social can report on, in display order.
// `unit` is how the follower count is labelled on that platform.
const PLATFORMS = [
  { type: 'TIKTOK', label: 'TikTok', unit: 'followers' },
  { type: 'INSTAGRAM', label: 'Instagram', unit: 'followers' },
  { type: 'YOUTUBE', label: 'YouTube', unit: 'subscribers' },
];

const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/* ---------- auth ---------- */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function isAuthed(req) {
  if (!AUTH_PASS) return true; // gate disabled when no password configured
  const m = /^Basic (.+)$/i.exec(req.headers['authorization'] || '');
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  return safeEqual(decoded.slice(0, i), AUTH_USER) &&
         safeEqual(decoded.slice(i + 1), AUTH_PASS);
}

/* ---------- bundle.social REST ---------- */
async function bs(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(API + pathname, {
    method,
    headers: {
      'x-api-key': KEY,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`${method} ${pathname} -> ${res.status} ${text.slice(0, 150)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Most recent analytics snapshot from an items array.
function pickLatest(items) {
  if (!Array.isArray(items) || !items.length) return null;
  return items.slice().sort((a, b) =>
    new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)
  )[0];
}

/* ---------- assemble the metrics ---------- */
async function buildMetrics() {
  if (!KEY) throw new Error('BUNDLE_SOCIAL_API_KEY is not set');

  // 1. Resolve the team.
  let teamId = CONFIG.teamId;
  let teamName = '';
  if (!teamId) {
    const teams = (await bs('/team/')).items || [];
    if (!teams.length) throw new Error('No teams found on this bundle.social account');
    teamId = teams[0].id;
    teamName = teams[0].name || '';
  }

  // 2. Which accounts are connected.
  const team = await bs('/team/' + encodeURIComponent(teamId));
  teamName = teamName || team.name || 'Phantom U';
  const accounts = {};
  for (const a of (team.socialAccounts || [])) accounts[a.type] = a;

  // 3. Pull each supported platform: force first, fall back to latest.
  const platforms = [];
  for (const p of PLATFORMS) {
    const goal = num(CONFIG.goals && CONFIG.goals[p.type]);
    const acct = accounts[p.type];
    if (!acct) {
      platforms.push({ name: p.label, unit: p.unit, handle: '', followers: 0,
        views: 0, goal, status: 'not connected', asOf: null });
      continue;
    }
    const handle = acct.username ? '@' + String(acct.username).replace(/^@/, '') : '';
    let followers = 0, views = 0, status = '', asOf = null;
    try {
      const rec = await bs('/analytics/social-account/force',
        { method: 'POST', body: { teamId, platformType: p.type } });
      followers = num(rec.followers);
      views = num(rec.views);
      asOf = rec.updatedAt || rec.createdAt || null;
      status = 'forced';
    } catch (e) {
      try {
        const q = `?teamId=${encodeURIComponent(teamId)}&platformType=${p.type}`;
        const latest = pickLatest((await bs('/analytics/social-account' + q)).items);
        followers = latest ? num(latest.followers) : 0;
        views = latest ? num(latest.views) : 0;
        asOf = latest ? (latest.updatedAt || latest.createdAt || null) : null;
        status = e.status === 429
          ? 'force limit reached — showing latest'
          : 'showing latest';
      } catch (e2) {
        status = 'error: ' + e2.message;
      }
    }
    platforms.push({ name: p.label, unit: p.unit, handle, followers, views, goal, status, asOf });
  }

  return { team: teamName, generatedAt: new Date().toISOString(), platforms };
}

/* ---------- throttle + in-flight de-dupe ---------- */
let last = { at: 0, data: null };
let inFlight = null;

function getMetrics() {
  const minMs = num(CONFIG.minRefreshSeconds) * 1000;
  if (last.data && Date.now() - last.at < minMs) {
    return Promise.resolve({ ...last.data, throttled: true });
  }
  if (inFlight) return inFlight;
  inFlight = buildMetrics()
    .then(d => { last = { at: Date.now(), data: d }; return d; })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/* ---------- HTTP server ---------- */
const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  // /health stays open so the host can ping it; everything else is gated.
  if (url !== '/health' && !isAuthed(req)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Phantom U", charset="UTF-8"',
      'content-type': 'text/plain',
    });
    return res.end('Authentication required');
  }

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(HTML);
  }
  if (url === '/api/metrics') {
    try {
      const data = await getMetrics();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  // Serve brand font files dropped into phantom-live/fonts/ (e.g. English Towne).
  if (url.startsWith('/fonts/')) {
    try {
      const buf = fs.readFileSync(path.join(__dirname, 'fonts', path.basename(url)));
      const ext = path.extname(url).slice(1).toLowerCase();
      const types = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };
      res.writeHead(200, {
        'content-type': types[ext] || 'application/octet-stream',
        'cache-control': 'max-age=86400',
      });
      return res.end(buf);
    } catch {
      res.writeHead(404); return res.end('not found');
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Phantom live dashboard running on http://localhost:${PORT}`);
  console.log(`Password protection: ${AUTH_PASS ? 'ON' : 'OFF (set DASH_PASSWORD to enable)'}`);
  if (!KEY) console.warn('WARNING: BUNDLE_SOCIAL_API_KEY is not set — /api/metrics will error.');
});
