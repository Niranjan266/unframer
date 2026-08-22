/**
 * The web UI, served inline by the export server.
 *
 * Kept as a single self-contained document with no build step and no external
 * requests — it would be a poor look for a tool whose entire purpose is
 * removing third-party dependencies from a page to then load a CDN framework of
 * its own.
 */

export { EXPORT_CODE_HTML } from './ui-exportcode.js';

export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unframer</title>
<style>
  :root {
    --ground:#f1f4f3; --surface:#fff; --surface-2:#e9eeec;
    --ink:#101817; --ink-2:#3a4a47; --muted:#687874; --line:#d6deda;
    --accent:#0b6f5e; --accent-ink:#fff; --warn:#a83e22; --ok:#0b6f5e;
    --radius:10px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground:#0b100f; --surface:#131b1a; --surface-2:#1b2523;
      --ink:#e7eeec; --ink-2:#b6c5c1; --muted:#859893; --line:#243130;
      --accent:#4fd0b4; --accent-ink:#06201b; --warn:#f0866a; --ok:#4fd0b4;
    }
  }
  * { box-sizing:border-box }
  body {
    margin:0; background:var(--ground); color:var(--ink);
    font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .wrap { max-width:760px; margin:0 auto; padding:36px 24px 80px }
  nav { display:flex; gap:18px; margin-bottom:28px; font-size:.9rem }
  nav a { color:var(--muted); text-decoration:none; padding-bottom:4px }
  nav a.on { color:var(--ink); font-weight:600; border-bottom:2px solid var(--accent) }
  h1 { font-size:2rem; letter-spacing:-.03em; margin:0 0 6px }
  .lede { color:var(--ink-2); margin:0 0 32px }
  form { background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); padding:22px }
  label { display:block; font-size:.82rem; font-weight:600; letter-spacing:.02em; margin-bottom:6px }
  input[type=url], input[type=number] {
    width:100%; padding:11px 13px; border:1px solid var(--line); border-radius:8px;
    background:var(--ground); color:var(--ink); font:inherit; font-size:.95rem;
  }
  input:focus-visible, button:focus-visible, select:focus-visible {
    outline:2px solid var(--accent); outline-offset:2px;
  }
  .row { display:flex; gap:14px; flex-wrap:wrap; margin-top:16px }
  .row > div { flex:1; min-width:150px }
  select {
    width:100%; padding:11px 13px; border:1px solid var(--line); border-radius:8px;
    background:var(--ground); color:var(--ink); font:inherit; font-size:.95rem;
  }
  button {
    margin-top:20px; width:100%; padding:13px; border:0; border-radius:8px;
    background:var(--accent); color:var(--accent-ink); font:inherit; font-weight:600;
    cursor:pointer;
  }
  button:disabled { opacity:.55; cursor:not-allowed }
  .hint { font-size:.8rem; color:var(--muted); margin-top:6px }
  #panel { margin-top:28px; display:none }
  #panel.on { display:block }
  .card { background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); padding:20px; margin-bottom:16px }
  .status { display:flex; align-items:center; gap:10px; font-weight:600; margin-bottom:14px }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--muted); flex:none }
  .dot.running { background:var(--accent); animation:pulse 1.1s ease-in-out infinite }
  .dot.done { background:var(--ok) }
  .dot.failed { background:var(--warn) }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
  @media (prefers-reduced-motion:reduce) { .dot.running { animation:none } }
  #log {
    font:12.5px/1.7 ui-monospace,Menlo,Consolas,monospace; color:var(--ink-2);
    max-height:220px; overflow-y:auto; background:var(--ground);
    border:1px solid var(--line); border-radius:8px; padding:12px; white-space:pre-wrap;
  }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:1px; background:var(--line); border:1px solid var(--line); border-radius:8px; overflow:hidden; margin-bottom:16px }
  .stat { background:var(--surface); padding:12px 14px }
  .stat b { display:block; font-size:1.25rem; letter-spacing:-.02em; font-variant-numeric:tabular-nums }
  .stat span { font-size:.7rem; text-transform:uppercase; letter-spacing:.09em; color:var(--muted) }
  a.download {
    display:block; text-align:center; padding:13px; border-radius:8px;
    background:var(--accent); color:var(--accent-ink); font-weight:600; text-decoration:none;
  }
  .warn { border-left:3px solid var(--warn); padding:10px 14px; background:var(--surface-2); border-radius:0 8px 8px 0; font-size:.87rem; margin-top:10px }
  .err { color:var(--warn); font-weight:600 }
  footer { margin-top:36px; font-size:.8rem; color:var(--muted) }
</style>
</head>
<body>
<div class="wrap">
  <nav><a href="/" class="on">Quick export</a><a href="/exportcode">Export code</a></nav>
  <h1>Unframer</h1>
  <p class="lede">Convert a published Framer site into portable HTML, CSS and JavaScript you can host anywhere.</p>

  <form id="form">
    <label for="url">Framer site URL</label>
    <input id="url" name="url" type="url" required placeholder="https://your-site.framer.website/" autocomplete="url">
    <p class="hint">Export sites you own or are authorised to export.</p>

    <div class="row">
      <div>
        <label for="assetMode">Assets</label>
        <select id="assetMode">
          <option value="offline">Download everything (portable)</option>
          <option value="hotlink">Link to Framer's CDN (faster)</option>
        </select>
      </div>
      <div>
        <label for="maxPages">Page limit</label>
        <input id="maxPages" type="number" min="1" max="100" value="25">
      </div>
    </div>

    <div class="row">
      <div>
        <label for="baseUrl">Your final domain <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
        <input id="baseUrl" type="url" placeholder="https://example.com">
        <p class="hint">Rewrites canonical, og:url and social images. Without it they are removed.</p>
      </div>
    </div>

    <button id="submit" type="submit">Export site</button>
  </form>

  <div id="panel">
    <div class="card">
      <div class="status"><span class="dot" id="dot"></span><span id="statusText">Queued</span></div>
      <div id="stats" class="stats" hidden></div>
      <div id="log"></div>
      <div id="warnings"></div>
      <div id="action" style="margin-top:16px"></div>
    </div>
  </div>

  <footer>Removes platform tracking and watermarks, compiles animations to CSS, and rewrites every asset path.</footer>
</div>

<script>
(function () {
  var form = document.getElementById('form');
  var submit = document.getElementById('submit');
  var panel = document.getElementById('panel');
  var log = document.getElementById('log');
  var dot = document.getElementById('dot');
  var statusText = document.getElementById('statusText');
  var stats = document.getElementById('stats');
  var action = document.getElementById('action');
  var warnings = document.getElementById('warnings');
  var seen = 0;

  function reset() {
    log.textContent = ''; action.innerHTML = ''; warnings.innerHTML = '';
    stats.innerHTML = ''; stats.hidden = true; seen = 0;
  }

  function stat(value, label) {
    return '<div class="stat"><b>' + value + '</b><span>' + label + '</span></div>';
  }

  // A hotlinked two-page export is around 30 KB, which reads as "0.0 MB" if
  // megabytes are the only unit on offer.
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function render(job) {
    dot.className = 'dot ' + job.status;
    statusText.textContent = {
      queued: 'Queued', running: 'Exporting…', done: 'Export complete', failed: 'Export failed'
    }[job.status] || job.status;

    for (var i = seen; i < job.progress.length; i++) {
      log.textContent += job.progress[i].message + '\\n';
    }
    seen = job.progress.length;
    log.scrollTop = log.scrollHeight;

    if (job.summary) {
      stats.hidden = false;
      stats.innerHTML =
        stat(job.summary.pagesExported, 'Pages') +
        stat(job.summary.totalArtifactsRemoved, 'Artifacts removed') +
        stat(job.summary.totalAnimationRules, 'Animation rules') +
        stat(job.summary.assetsDownloaded || job.summary.uniqueAssets, 'Assets');

      var list = (job.summary.warnings || []).filter(function (w) {
        return w.indexOf('svg-templates') === -1;
      });
      warnings.innerHTML = list.slice(0, 6).map(function (w) {
        return '<div class="warn">' + w.replace(/[<>&]/g, '') + '</div>';
      }).join('');
    }

    if (job.status === 'done' && job.downloadUrl) {
      var size = job.zipBytes ? ' (' + fmtBytes(job.zipBytes) + ')' : '';
      action.innerHTML = '<a class="download" href="' + job.downloadUrl + '">Download ZIP' + size + '</a>';
      submit.disabled = false;
    }
    if (job.status === 'failed') {
      action.innerHTML = '<p class="err">' + (job.error || 'Something went wrong.') + '</p>';
      submit.disabled = false;
    }
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    reset();
    panel.classList.add('on');
    submit.disabled = true;
    dot.className = 'dot running';
    statusText.textContent = 'Submitting…';

    fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: document.getElementById('url').value,
        assetMode: document.getElementById('assetMode').value,
        maxPages: Number(document.getElementById('maxPages').value),
        baseUrl: document.getElementById('baseUrl').value || undefined
      })
    })
    .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
    .then(function (res) {
      if (!res.ok) {
        dot.className = 'dot failed';
        statusText.textContent = 'Export failed';
        action.innerHTML = '<p class="err">' + (res.body.error || 'Request rejected.') + '</p>';
        submit.disabled = false;
        return;
      }
      render(res.body);
      var es = new EventSource('/api/jobs/' + res.body.id + '/events');
      es.onmessage = function (ev) {
        var job = JSON.parse(ev.data);
        render(job);
        if (job.status === 'done' || job.status === 'failed') es.close();
      };
      es.onerror = function () { es.close(); submit.disabled = false; };
    })
    .catch(function (err) {
      dot.className = 'dot failed';
      statusText.textContent = 'Export failed';
      action.innerHTML = '<p class="err">' + err.message + '</p>';
      submit.disabled = false;
    });
  });
})();
</script>
</body>
</html>`;
