/**
 * The "Export code" page.
 *
 * The full-fidelity pipeline behind a single field: keep Framer's runtime,
 * download every asset, and ship a preview server inside the result.
 *
 * The instruction not to double-click `index.html` is given prominence on
 * purpose. Browsers block ES modules over `file://`, so an unzipped export
 * opened directly loads no JavaScript and renders as a static shell — which
 * looks exactly like a broken export, and is by far the most common way this
 * goes wrong for someone.
 */

export const EXPORT_CODE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Export code</title>
<style>
  :root {
    --ground:#f1f4f3; --surface:#fff; --surface-2:#e9eeec;
    --ink:#101817; --ink-2:#3a4a47; --muted:#687874; --line:#d6deda;
    --accent:#0b6f5e; --accent-ink:#fff; --warn:#a83e22; --flag:#8a6212;
    --flag-bg:#f7ebd2; --flag-line:#dfc183;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground:#0b100f; --surface:#131b1a; --surface-2:#1b2523;
      --ink:#e7eeec; --ink-2:#b6c5c1; --muted:#859893; --line:#243130;
      --accent:#4fd0b4; --accent-ink:#06201b; --warn:#f0866a; --flag:#e0b252;
      --flag-bg:#2a2110; --flag-line:#544120;
    }
  }
  * { box-sizing:border-box }
  body {
    margin:0; background:var(--ground); color:var(--ink);
    font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .wrap { max-width:780px; margin:0 auto; padding:36px 24px 80px }
  nav { display:flex; gap:18px; margin-bottom:28px; font-size:.9rem }
  nav a { color:var(--muted); text-decoration:none; padding-bottom:4px }
  nav a.on { color:var(--ink); font-weight:600; border-bottom:2px solid var(--accent) }
  h1 { font-size:2rem; letter-spacing:-.03em; margin:0 0 6px }
  .lede { color:var(--ink-2); margin:0 0 24px }
  .caps { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-bottom:24px }
  .cap { background:var(--surface); border:1px solid var(--line); border-radius:8px; padding:12px 14px; font-size:.85rem; color:var(--ink-2) }
  .cap b { display:block; color:var(--ink); font-size:.9rem; margin-bottom:2px }
  form { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:22px }
  label { display:block; font-size:.82rem; font-weight:600; margin-bottom:6px }
  input {
    width:100%; padding:11px 13px; border:1px solid var(--line); border-radius:8px;
    background:var(--ground); color:var(--ink); font:inherit; font-size:.95rem;
  }
  input:focus-visible, button:focus-visible { outline:2px solid var(--accent); outline-offset:2px }
  .row { display:flex; gap:14px; flex-wrap:wrap; margin-top:16px }
  .row > div { flex:1; min-width:170px }
  button {
    margin-top:20px; width:100%; padding:13px; border:0; border-radius:8px;
    background:var(--accent); color:var(--accent-ink); font:inherit; font-weight:600; cursor:pointer;
  }
  button:disabled { opacity:.55; cursor:not-allowed }
  .hint { font-size:.8rem; color:var(--muted); margin-top:6px }
  #panel { margin-top:26px; display:none }
  #panel.on { display:block }
  .card { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:20px; margin-bottom:16px }
  .status { display:flex; align-items:center; gap:10px; font-weight:600; margin-bottom:14px }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--muted); flex:none }
  .dot.running { background:var(--accent); animation:pulse 1.1s ease-in-out infinite }
  .dot.done { background:var(--accent) } .dot.failed { background:var(--warn) }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
  @media (prefers-reduced-motion:reduce){ .dot.running{animation:none} }
  #log { font:12.5px/1.7 ui-monospace,Menlo,Consolas,monospace; color:var(--ink-2);
    max-height:230px; overflow-y:auto; background:var(--ground); border:1px solid var(--line);
    border-radius:8px; padding:12px; white-space:pre-wrap }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(115px,1fr)); gap:1px;
    background:var(--line); border:1px solid var(--line); border-radius:8px; overflow:hidden; margin-bottom:16px }
  .stat { background:var(--surface); padding:12px 14px }
  .stat b { display:block; font-size:1.2rem; letter-spacing:-.02em; font-variant-numeric:tabular-nums }
  .stat span { font-size:.68rem; text-transform:uppercase; letter-spacing:.09em; color:var(--muted) }
  a.download { display:block; text-align:center; padding:13px; border-radius:8px;
    background:var(--accent); color:var(--accent-ink); font-weight:600; text-decoration:none }
  .after { border-left:3px solid var(--flag); background:var(--flag-bg); border-radius:0 8px 8px 0;
    padding:14px 16px; margin-top:16px; font-size:.88rem }
  .after b { display:block; margin-bottom:4px }
  .after code { font-family:ui-monospace,Menlo,Consolas,monospace; background:var(--surface); padding:1px 5px; border-radius:4px }
  .err { color:var(--warn); font-weight:600 }
</style>
</head>
<body>
<div class="wrap">
  <nav><a href="/">Quick export</a><a href="/exportcode" class="on">Export code</a></nav>

  <h1>Export code</h1>
  <p class="lede">Paste any site URL. You get every page and its complete front-end code &mdash; HTML, CSS, JavaScript, fonts and media &mdash; working the way it does live.</p>

  <div class="caps">
    <div class="cap"><b>Any site</b>Framer sites keep full animation; others export as-is</div>
    <div class="cap"><b>Working UI</b>Buttons, navigation, menus, forms</div>
    <div class="cap"><b>Animations</b>Scroll effects, transitions, 3D visuals</div>
    <div class="cap"><b>All assets</b>Images, fonts, video, audio — downloaded</div>
    <div class="cap"><b>Runs offline</b>Includes start.bat and serve.cjs</div>
    <div class="cap"><b>Cleaned</b>No trackers, no watermark</div>
  </div>

  <form id="form">
    <label for="url">Site URL</label>
    <input id="url" type="url" required placeholder="https://example.com/" autocomplete="url">
    <p class="hint">Export sites you own or are authorised to export.</p>

    <div class="row">
      <div>
        <label for="maxPages">Page limit</label>
        <input id="maxPages" type="number" min="1" max="100" value="25">
        <p class="hint">Large sites take several minutes and can reach hundreds of MB.</p>
      </div>
      <div>
        <label for="baseUrl">Your final domain <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
        <input id="baseUrl" type="url" placeholder="https://example.com">
        <p class="hint">Rewrites canonical, og:url and social images.</p>
      </div>
    </div>

    <button id="submit" type="submit">Extract full code</button>
  </form>

  <div id="panel">
    <div class="card">
      <div class="status"><span class="dot" id="dot"></span><span id="statusText">Queued</span></div>
      <div id="stats" class="stats" hidden></div>
      <div id="log"></div>
      <div id="action" style="margin-top:16px"></div>
      <div id="after"></div>
    </div>
  </div>
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
  var after = document.getElementById('after');
  var seen = 0;

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function stat(v, l) {
    return '<div class="stat"><b>' + v + '</b><span>' + l + '</span></div>';
  }

  function render(job) {
    dot.className = 'dot ' + job.status;
    statusText.textContent = {
      queued: 'Queued', running: 'Extracting…', done: 'Export complete', failed: 'Export failed'
    }[job.status] || job.status;

    for (var i = seen; i < job.progress.length; i++) log.textContent += job.progress[i].message + '\\n';
    seen = job.progress.length;
    log.scrollTop = log.scrollHeight;

    if (job.summary) {
      stats.hidden = false;
      stats.innerHTML =
        stat(job.summary.pagesExported, 'Pages') +
        stat(job.summary.assetsDownloaded || job.summary.uniqueAssets, 'Assets') +
        stat(job.summary.totalArtifactsRemoved, 'Cleaned');
    }

    if (job.status === 'done' && job.downloadUrl) {
      action.innerHTML = '<a class="download" href="' + job.downloadUrl + '">Download code' +
        (job.zipBytes ? ' (' + fmtBytes(job.zipBytes) + ')' : '') + '</a>';
      after.innerHTML =
        '<div class="after"><b>After you unzip it</b>' +
        'Do not open <code>index.html</code> directly — browsers block JavaScript ' +
        'loaded from a file path, so the page would look static with no animation.<br><br>' +
        'Double-click <code>start.bat</code> (Windows) or run <code>node serve.cjs</code>. ' +
        'Uploading the folder to any web host works as-is.</div>';
      submit.disabled = false;
    }

    if (job.status === 'failed') {
      action.innerHTML = '<p class="err">' + (job.error || 'Something went wrong.') + '</p>';
      submit.disabled = false;
    }
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    log.textContent = ''; action.innerHTML = ''; after.innerHTML = '';
    stats.innerHTML = ''; stats.hidden = true; seen = 0;
    panel.classList.add('on');
    submit.disabled = true;
    dot.className = 'dot running';
    statusText.textContent = 'Submitting…';

    fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: document.getElementById('url').value,
        mode: 'full',
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
