'use strict';
// Tharka relay: phone <-> relay <-> PC. The PC connects OUT to /pc over a WebSocket; phone requests are forwarded to it.
// Nothing is stored. Message text is never logged.
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const MAX_BODY = 200 * 1024;
const TIMEOUT_MS = 25_000;
const HEARTBEAT_MS = 20_000;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const same = (given, secretHash) => crypto.timingSafeEqual(sha(given), secretHash);

function createRelay({ pcToken, phoneToken, timeoutMs = TIMEOUT_MS, log = () => {} }) {
  if (String(pcToken || '').length < 16 || String(phoneToken || '').length < 16) throw new Error('PC_TOKEN and PHONE_TOKEN must both be at least 16 characters.');
  const pcHash = sha(pcToken);
  const phoneHash = sha(phoneToken);
  const fails = new Map(); // ip -> { n, since }
  let pc = null; // current WebSocket
  const pending = new Map(); // id -> { res, timer }

  const limited = (ip) => {
    const f = fails.get(ip);
    if (!f) return false;
    if (Date.now() - f.since > 60_000) { fails.delete(ip); return false; }
    return f.n >= 10;
  };
  const fail = (ip) => {
    const f = fails.get(ip) || { n: 0, since: Date.now() };
    f.n++;
    fails.set(ip, f);
  };
  const sweep = setInterval(() => { for (const [ip, f] of fails) if (Date.now() - f.since > 60_000) fails.delete(ip); }, 60_000);
  sweep.unref();

  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  // Behind Render's proxy the socket address is the proxy; the proxy appends the real client to X-Forwarded-For (take the last entry, which a client cannot forge).
const ipOf = (req) => { const x = String(req.headers['x-forwarded-for'] || '').split(',').map((v) => v.trim()).filter(Boolean); return x.length ? x[x.length - 1] : (req.socket.remoteAddress || '?'); };

  function failAll(code, error) {
    for (const [id, p] of pending) { clearTimeout(p.timer); pending.delete(id); json(p.res, code, { error }); }
  }

  async function readBody(req) {
    let n = 0;
    const parts = [];
    for await (const ch of req) { n += ch.length; if (n > MAX_BODY) throw Object.assign(new Error('Too large'), { code: 413 }); parts.push(ch); }
    return Buffer.concat(parts).toString('utf8');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/health') return json(res, 200, { ok: true, pc: !!pc });
      const ip = ipOf(req);
      if (limited(ip)) return json(res, 429, { error: 'Too many wrong tokens. Wait a minute.' });
      const given = req.headers['x-token'] || url.searchParams.get('t') || '';
      if (!same(given, phoneHash)) { fail(ip); return json(res, 401, { error: 'Bad token' }); }
      url.searchParams.delete('t');
      const path = url.pathname + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : '');
      if (!pc || pc.readyState !== 1) return json(res, 503, { error: 'Your PC is offline. Start Tharka and enable the relay.' });
      let body = '';
      if (req.method === 'POST') body = await readBody(req);
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { if (pending.delete(id)) json(res, 504, { error: 'The PC did not answer in time.' }); }, timeoutMs);
      pending.set(id, { res, timer });
      res.on('close', () => { const p = pending.get(id); if (p) { clearTimeout(p.timer); pending.delete(id); } });
      try { pc.send(JSON.stringify({ id, method: req.method, path, body })); } catch { clearTimeout(timer); pending.delete(id); json(res, 503, { error: 'Your PC is offline.' }); }
    } catch (err) {
      if (res.headersSent) return res.end();
      json(res, err.code === 413 ? 413 : 500, { error: err.code === 413 ? 'Too large' : 'Relay error' });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const ip = ipOf(req);
    const url = new URL(req.url, 'http://x');
    const refuse = (line) => { socket.write(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    if (url.pathname !== '/pc') return refuse('404 Not Found');
    if (limited(ip)) return refuse('429 Too Many Requests');
    if (!same(req.headers['x-pc-token'] || '', pcHash)) { fail(ip); return refuse('401 Unauthorized'); }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (pc && pc !== ws) { try { pc.close(4000, 'replaced'); } catch { /* gone */ } }
      pc = ws;
      ws.alive = true;
      log('pc connected');
      ws.on('pong', () => { ws.alive = true; });
      ws.on('message', (data) => {
        let m;
        try { m = JSON.parse(String(data)); } catch { return; }
        const p = m && pending.get(m.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(m.id);
        const status = Number.isInteger(m.status) && m.status >= 100 && m.status < 600 ? m.status : 502;
        p.res.writeHead(status, { 'Content-Type': String(m.type || 'application/json').slice(0, 100), 'Cache-Control': 'no-store' });
        p.res.end(typeof m.body === 'string' ? m.body : JSON.stringify(m.body ?? ''));
      });
      ws.on('close', () => { if (pc === ws) { pc = null; failAll(503, 'Your PC went offline.'); log('pc disconnected'); } });
      ws.on('error', () => {});
    });
  });

  const beat = setInterval(() => {
    if (!pc) return;
    if (pc.alive === false) { try { pc.terminate(); } catch { /* gone */ } return; }
    pc.alive = false;
    try { pc.ping(); } catch { /* gone */ }
  }, HEARTBEAT_MS);
  beat.unref();

  server.on('close', () => { clearInterval(beat); clearInterval(sweep); });
  return { server, pcConnected: () => !!pc && pc.readyState === 1 };
}

function main() {
  const { PC_TOKEN, PHONE_TOKEN } = process.env;
  let relay;
  try { relay = createRelay({ pcToken: PC_TOKEN, phoneToken: PHONE_TOKEN, log: (m) => console.log(m) }); } catch (err) { console.error(err.message); process.exit(1); }
  const port = Number(process.env.PORT) || 10000;
  relay.server.listen(port, '0.0.0.0', () => console.log(`Tharka relay listening on ${port}`));
}

if (require.main === module) main();
module.exports = { createRelay };
