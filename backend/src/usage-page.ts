import type { FastifyInstance } from 'fastify';
import { env } from './env.js';
import { queryUsage } from './usage.js';

// ─── Hidden AI token-usage report (URL-only, token-gated) ────────────────────
// Not part of the admin SPA and not in any nav. Access is by secret token in the
// URL only: /usage?key=<USAGE_TOKEN>. When USAGE_TOKEN is unset, both routes 404
// so nothing is exposed. Note: a token in a URL can appear in server/proxy logs
// and browser history — this is "unlisted + shared secret", not strong auth.

function tokenOk(key: unknown): boolean {
  const expected = env.usageToken;
  if (!expected) return false; // disabled when no token configured
  return typeof key === 'string' && key.length === expected.length && key === expected;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

export async function registerUsageRoutes(app: FastifyInstance): Promise<void> {
  // JSON report, filtered by optional ?from / ?to (YYYY-MM-DD, inclusive).
  app.get('/api/usage', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!tokenOk(q.key)) return reply.code(404).send({ error: 'not_found' });
    const report = await queryUsage({ from: q.from ?? null, to: q.to ?? null });
    return reply.send(report);
  });

  // The standalone HTML page.
  app.get('/usage', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!tokenOk(q.key)) return reply.code(404).type('text/html').send('<!doctype html><title>Not found</title>Not found');
    return reply.type('text/html').send(PAGE_HTML.replace('__KEY__', esc(q.key as string)));
  });
}

// Self-contained page: reads the key from its own URL and fetches /api/usage.
const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AI token usage</title>
<style>
  :root { color-scheme: light dark; --bg:#0c1824; --surface:#122233; --sunk:#0f1d2b; --ink:#e7eef4; --muted:#97aabb; --line:#24394d; --accent:#f4b23e; }
  @media (prefers-color-scheme: light) { :root { --bg:#eef2f5; --surface:#fff; --sunk:#f5f7f9; --ink:#10202e; --muted:#56687a; --line:#d6dee6; --accent:#a86b00; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; padding:24px 16px; }
  .wrap { max-width:1000px; margin:0 auto; display:flex; flex-direction:column; gap:18px; }
  h1 { font-size:22px; margin:0; }
  .sub { color:var(--muted); font-size:13px; margin:0; }
  .card { background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:16px; }
  .filters { display:flex; flex-wrap:wrap; gap:12px; align-items:flex-end; }
  .filters label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }
  input[type=date] { padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:var(--sunk); color:var(--ink); font:inherit; }
  button { padding:9px 16px; border:0; border-radius:8px; background:var(--accent); color:#1a1405; font-weight:600; cursor:pointer; }
  button.ghost { background:transparent; color:var(--ink); border:1px solid var(--line); }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
  .tile { background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .tile .v { font-size:24px; font-weight:700; letter-spacing:-.01em; }
  .tile .l { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.06em; margin-top:2px; }
  .tile-accent { border-color:var(--accent); }
  .tile-accent .v { color:var(--accent); }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--muted); font-size:11.5px; text-transform:uppercase; letter-spacing:.06em; font-weight:600; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  .pill { font-size:11.5px; padding:3px 9px; border-radius:999px; border:1px solid var(--line); color:var(--muted); }
  .scroll { overflow:auto; max-height:420px; }
  h2 { font-size:15px; margin:0 0 12px; }
  .muted { color:var(--muted); }
  .err { color:#e06a4a; }
</style>
</head>
<body>
<div class="wrap">
  <div>
    <h1>AI token usage &amp; cost</h1>
    <p class="sub">Tokens and estimated USD cost for every Claude call, by date and activity. Cost is estimated from per-model list prices (cache reads billed at ~10%).</p>
  </div>

  <div class="card filters">
    <label>From <input type="date" id="from" /></label>
    <label>To <input type="date" id="to" /></label>
    <button id="apply">Apply</button>
    <button class="ghost" id="clear">All time</button>
    <span id="status" class="muted" style="margin-left:auto;font-size:13px;"></span>
  </div>

  <div class="tiles" id="tiles"></div>

  <div class="card">
    <h2>By activity</h2>
    <div class="scroll"><table id="byActivity"></table></div>
  </div>

  <div class="card">
    <h2>By day</h2>
    <div class="scroll"><table id="byDay"></table></div>
  </div>

  <div class="card">
    <h2>Recent requests</h2>
    <div class="scroll"><table id="events"></table></div>
  </div>
</div>
<script>
  var KEY = "__KEY__";
  var n = function (x) { return (x || 0).toLocaleString(); };
  var usd = function (x) {
    x = x || 0;
    if (x > 0 && x < 0.01) return '$' + x.toFixed(4);
    return '$' + x.toFixed(2);
  };
  var el = function (id) { return document.getElementById(id); };

  function iso(d) { return d.toISOString().slice(0, 10); }
  // Default range: last 30 days.
  (function () {
    var today = new Date();
    var past = new Date(); past.setDate(past.getDate() - 29);
    el('from').value = iso(past);
    el('to').value = iso(today);
  })();

  function tableHTML(headers, rows) {
    var h = '<tr>' + headers.map(function (c) {
      return '<th' + (c.num ? ' class="num"' : '') + '>' + c.label + '</th>';
    }).join('') + '</tr>';
    if (!rows.length) return h + '<tr><td colspan="' + headers.length + '" class="muted">No activity in this range.</td></tr>';
    var b = rows.map(function (r) {
      return '<tr>' + r.map(function (c) {
        return '<td' + (c.num ? ' class="num"' : '') + '>' + c.html + '</td>';
      }).join('') + '</tr>';
    }).join('');
    return h + b;
  }

  function load() {
    var from = el('from').value, to = el('to').value;
    var qs = 'key=' + encodeURIComponent(KEY);
    if (from) qs += '&from=' + from;
    if (to) qs += '&to=' + to;
    el('status').textContent = 'Loading…';
    fetch('/api/usage?' + qs).then(function (r) {
      if (!r.ok) throw new Error('Request failed (' + r.status + ')');
      return r.json();
    }).then(function (d) {
      render(d);
      el('status').textContent = '';
    }).catch(function (e) {
      el('status').innerHTML = '<span class="err">' + e.message + '</span>';
    });
  }

  function render(d) {
    var t = d.totals || { requests: 0, input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    var avg = t.requests ? t.cost / t.requests : 0;
    el('tiles').innerHTML = [
      ['Total spend', usd(t.cost), 'accent'],
      ['Avg / call', usd(avg), ''],
      ['Requests', n(t.requests), ''],
      ['Total tokens', n(t.total), ''],
      ['Cache reads', n(t.cacheRead || 0), '']
    ].map(function (x) {
      return '<div class="tile' + (x[2] ? ' tile-accent' : '') + '"><div class="v">' + x[1] + '</div><div class="l">' + x[0] + '</div></div>';
    }).join('');

    el('byActivity').innerHTML = tableHTML(
      [{ label: 'Activity' }, { label: 'Requests', num: 1 }, { label: 'Input', num: 1 }, { label: 'Output', num: 1 }, { label: 'Total', num: 1 }, { label: 'Cost', num: 1 }],
      (d.byActivity || []).map(function (a) {
        return [
          { html: '<span class="pill">' + a.label + '</span>' },
          { html: n(a.totals.requests), num: 1 },
          { html: n(a.totals.input), num: 1 },
          { html: n(a.totals.output), num: 1 },
          { html: n(a.totals.total), num: 1 },
          { html: usd(a.totals.cost), num: 1 }
        ];
      })
    );

    el('byDay').innerHTML = tableHTML(
      [{ label: 'Date' }, { label: 'Requests', num: 1 }, { label: 'Input', num: 1 }, { label: 'Output', num: 1 }, { label: 'Total', num: 1 }, { label: 'Cost', num: 1 }],
      (d.byDay || []).map(function (r) {
        return [
          { html: r.date },
          { html: n(r.requests), num: 1 },
          { html: n(r.input), num: 1 },
          { html: n(r.output), num: 1 },
          { html: n(r.total), num: 1 },
          { html: usd(r.cost), num: 1 }
        ];
      })
    );

    el('events').innerHTML = tableHTML(
      [{ label: 'When' }, { label: 'Activity' }, { label: 'Model' }, { label: 'Input', num: 1 }, { label: 'Output', num: 1 }, { label: 'Total', num: 1 }, { label: 'Cost', num: 1 }],
      (d.events || []).map(function (ev) {
        return [
          { html: new Date(ev.ts).toLocaleString() },
          { html: ev.activity },
          { html: '<span class="muted">' + ev.model + '</span>' },
          { html: n(ev.input_tokens), num: 1 },
          { html: n(ev.output_tokens), num: 1 },
          { html: n(ev.total), num: 1 },
          { html: usd(ev.cost), num: 1 }
        ];
      })
    );
  }

  el('apply').addEventListener('click', load);
  el('clear').addEventListener('click', function () {
    el('from').value = ''; el('to').value = ''; load();
  });
  load();
</script>
</body>
</html>`;
