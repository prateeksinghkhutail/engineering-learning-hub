/* Engineering Learning Hub — catalog + viewer logic.
   No backend: topics come from topics.json, user state lives in localStorage.
   Artifacts are only ever loaded into an iframe; their HTML is never fetched-and-parsed or modified. */
(() => {
  'use strict';

  const STORE_KEY = 'elh.state.v1';
  const MAX_RECENT = 8;

  /* ---------------- state (localStorage) ---------------- */

  const defaults = () => ({ theme: 'system', favorites: [], recent: [], progress: {}, last: null });

  function loadState() {
    try {
      return Object.assign(defaults(), JSON.parse(localStorage.getItem(STORE_KEY)) || {});
    } catch {
      return defaults();
    }
  }

  let state = loadState();

  // Re-read before every write so two open tabs don't clobber each other.
  function update(fn) {
    state = loadState();
    fn(state);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* private mode etc. */ }
  }

  const isFav = (id) => state.favorites.includes(id);
  const toggleFav = (id) => update((s) => {
    s.favorites = s.favorites.includes(id) ? s.favorites.filter((f) => f !== id) : [...s.favorites, id];
  });

  /* ---------------- theme ---------------- */

  const root = document.documentElement;
  const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
  const effectiveTheme = () => root.getAttribute('data-theme') || (darkMQ.matches ? 'dark' : 'light');

  const ICON = {
    sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
    star: '<svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>',
  };

  function applyTheme() {
    if (state.theme === 'light' || state.theme === 'dark') root.setAttribute('data-theme', state.theme);
    else root.removeAttribute('data-theme');
    const btn = document.getElementById('themeBtn');
    if (btn) btn.innerHTML = effectiveTheme() === 'dark' ? ICON.sun : ICON.moon;
  }

  function initThemeToggle() {
    const btn = document.getElementById('themeBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      // Going back to the OS preference = "system", so the hub follows OS changes again.
      const sys = darkMQ.matches ? 'dark' : 'light';
      update((s) => { s.theme = next === sys ? 'system' : next; });
      applyTheme();
    });
    darkMQ.addEventListener?.('change', applyTheme);
    applyTheme();
  }

  /* ---------------- topics ---------------- */

  // Accepts "/artifacts/x.html", "artifacts/x.html" or a full URL.
  // Leading "/" is stripped so the hub also works under a sub-path (GitHub Pages project sites).
  function resolvePath(topic) {
    const p = String(topic.path || `artifacts/${topic.id}.html`).trim();
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(p) ? p : p.replace(/^\/+/, '');
  }

  async function loadTopics() {
    const res = await fetch('topics.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`topics.json: HTTP ${res.status}`);
    const raw = await res.json();
    if (!Array.isArray(raw)) throw new Error('topics.json must be a JSON array');
    const seen = new Set();
    return raw
      .filter((t) => t && t.id && t.title && !seen.has(t.id) && seen.add(t.id))
      .map((t) => ({
        ...t,
        id: String(t.id),
        category: t.category || 'Uncategorized',
        description: t.description || '',
        tags: Array.isArray(t.tags) ? t.tags : [],
        highlights: Array.isArray(t.highlights) ? t.highlights : [],
        url: resolvePath(t),
      }));
  }

  // HEAD request just to tell whether the file exists — content is never read.
  async function artifactExists(url) {
    try {
      const res = await fetch(url, { method: 'HEAD', cache: 'no-cache' });
      return res.ok;
    } catch {
      return true; // can't tell (e.g. cross-origin URL) — assume present
    }
  }

  /* ---------------- per-topic localStorage namespaces ----------------
     Each artifact was built to live on its own origin. Hosted together they share one localStorage,
     so generic keys (e.g. two artifacts both using "course-done") would leak progress between topics.
     The viewer swaps the current topic's keys in before the iframe loads and mirrors its writes back
     out, so artifact files stay byte-for-byte unchanged. Hub keys all start with "elh.". */

  const NS_PREFIX = 'elh.ns.';
  const ACTIVE_KEY = 'elh.active';
  const isHubKey = (k) => k.startsWith('elh.');

  function readNs(id) {
    try { return JSON.parse(localStorage.getItem(NS_PREFIX + id)) || {}; } catch { return {}; }
  }
  function writeNs(id, obj) {
    try { localStorage.setItem(NS_PREFIX + id, JSON.stringify(obj)); } catch { /* quota / private mode */ }
  }
  function liveArtifactKeys() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && !isHubKey(k)) keys.push(k);
    }
    return keys;
  }

  // Must run before the iframe gets its src: artifacts read storage during load.
  function activateNamespace(id) {
    try {
      const prev = localStorage.getItem(ACTIVE_KEY);
      if (prev === id) return;
      const keys = liveArtifactKeys();
      // Keys present with no owner (first run) are parked, never deleted.
      const owner = prev || '_unclaimed';
      const snap = readNs(owner);
      keys.forEach((k) => { snap[k] = localStorage.getItem(k); });
      if (keys.length) writeNs(owner, snap);
      keys.forEach((k) => localStorage.removeItem(k));
      Object.entries(readNs(id)).forEach(([k, v]) => localStorage.setItem(k, v));
      localStorage.setItem(ACTIVE_KEY, id);
    } catch { /* storage unavailable: artifacts just won't persist */ }
  }

  // The parent receives "storage" events for writes made inside the same-origin iframe.
  function mirrorNamespace(topic) {
    const file = topic.url.split('/').pop();
    window.addEventListener('storage', (e) => {
      if (e.storageArea !== localStorage || e.key === null || isHubKey(e.key)) return;
      let path = '';
      try { path = new URL(e.url).pathname; } catch { return; }
      if (!path.endsWith(file)) return; // a write from some other topic's tab
      const ns = readNs(topic.id);
      if (e.newValue === null) delete ns[e.key];
      else ns[e.key] = e.newValue;
      writeNs(topic.id, ns);
    });
  }

  const viewerHref = (id, hash = '') => `viewer.html?topic=${encodeURIComponent(id)}${hash}`;

  /* ---------------- helpers ---------------- */

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function highlight(text, q) {
    const safe = esc(text);
    if (!q) return safe;
    const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
    return safe.replace(re, '<mark>$1</mark>');
  }

  function timeAgo(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    const units = [[60, 'm'], [24, 'h'], [7, 'd'], [4.35, 'w'], [12, 'mo'], [Infinity, 'y']];
    let v = s / 60;
    for (const [n, u] of units) {
      if (v < n) return `${Math.floor(v)}${u} ago`;
      v /= n;
    }
    return '';
  }

  const progressBar = (pct) =>
    `<div class="progress" title="${pct}% read"><div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div><span>${pct}%</span></div>`;

  function showFatal(container, html) {
    container.hidden = false;
    container.innerHTML = html;
  }

  const FILE_PROTOCOL_HELP =
    'Browsers block <code>fetch()</code> on <code>file://</code>. Serve the folder instead, e.g. <code>python3 -m http.server 8000</code>, then open <code>http://localhost:8000</code>.';

  /* ================================================================
     INDEX PAGE
     ================================================================ */

  function initIndex() {
    const $ = (id) => document.getElementById(id);
    const els = {
      count: $('topicCount'), search: $('searchInput'), filters: $('filters'), catalog: $('catalog'),
      empty: $('emptyState'), cont: $('continueSection'), recent: $('recentSection'), recentList: $('recentList'),
    };

    let topics = [];
    const missing = new Set();
    let filter = 'all'; // 'all' | 'favorites' | <category>
    let query = '';

    const byId = (id) => topics.find((t) => t.id === id);
    const categories = () => [...new Set(topics.map((t) => t.category))];

    function matches(t, q) {
      if (!q) return true;
      const hay = [t.title, t.description, t.category, ...t.tags, ...t.highlights].join(' ').toLowerCase();
      return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
    }

    function renderContinue() {
      const t = state.last && byId(state.last);
      if (!t) { els.cont.hidden = true; return; }
      const p = state.progress[t.id];
      const recent = state.recent.find((r) => r.id === t.id);
      els.cont.hidden = false;
      els.cont.innerHTML = `
        <div class="continue-body">
          <p class="continue-kicker">Continue learning</p>
          <h2 class="continue-title">${esc(t.title)}</h2>
          <p class="continue-meta">${esc(t.category)}${recent ? ` · opened ${timeAgo(recent.at)}` : ''}</p>
          ${p && p.pct > 0 ? progressBar(p.pct) : ''}
        </div>
        <a class="btn" href="${viewerHref(t.id)}">${p && p.pct > 0 ? 'Resume' : 'Open'} <span aria-hidden="true">→</span></a>`;
    }

    function renderRecent() {
      const items = state.recent.filter((r) => byId(r.id) && r.id !== state.last).slice(0, 6);
      els.recent.hidden = items.length === 0;
      els.recentList.innerHTML = items
        .map((r) => `<a class="recent-chip" href="${viewerHref(r.id)}">${esc(byId(r.id).title)}<small>${timeAgo(r.at)}</small></a>`)
        .join('');
    }

    function renderFilters() {
      const favCount = topics.filter((t) => isFav(t.id)).length;
      const opts = [
        ['all', 'All', topics.length],
        ['favorites', '★ Favorites', favCount],
        ...categories().map((c) => [c, c, topics.filter((t) => t.category === c).length]),
      ];
      if (!opts.some(([v]) => v === filter)) filter = 'all';
      els.filters.innerHTML = opts
        .map(([v, label, n]) => `<button class="filter" type="button" data-filter="${esc(v)}" aria-pressed="${v === filter}">${esc(label)}<span class="count">${n}</span></button>`)
        .join('');
    }

    function card(t) {
      const p = state.progress[t.id];
      const fav = isFav(t.id);
      return `
        <article class="card">
          <div class="card-head">
            <h3 class="card-title"><a href="${viewerHref(t.id)}">${highlight(t.title, query)}</a></h3>
            <button class="icon-btn" type="button" data-fav="${esc(t.id)}" aria-pressed="${fav}"
              aria-label="${fav ? 'Remove bookmark' : 'Bookmark'}" title="${fav ? 'Remove bookmark' : 'Bookmark'}">${ICON.star}</button>
          </div>
          ${t.description ? `<p class="card-desc">${highlight(t.description, query)}</p>` : ''}
          ${t.highlights.length ? `<ul class="card-points">${t.highlights.map((h) => `<li>${highlight(h, query)}</li>`).join('')}</ul>` : ''}
          ${t.tags.length ? `<div class="tags">${t.tags.map((g) => `<span class="tag">${highlight(g, query)}</span>`).join('')}</div>` : ''}
          ${missing.has(t.id) ? `<span class="badge-missing" title="File not found">missing: ${esc(t.url)}</span>` : ''}
          <div class="card-foot">
            ${p && p.pct > 0 ? progressBar(p.pct) : '<span></span>'}
            <span class="card-open">Open guide →</span>
          </div>
        </article>`;
    }

    function renderCatalog() {
      const visible = topics.filter((t) =>
        (filter === 'all' || (filter === 'favorites' ? isFav(t.id) : t.category === filter)) && matches(t, query));

      const groups = categories()
        .map((c) => [c, visible.filter((t) => t.category === c)])
        .filter(([, list]) => list.length);

      els.catalog.innerHTML = groups
        .map(([c, list]) => `
          <section class="category">
            <h2 class="category-title">${esc(c)}<span>${list.length} ${list.length === 1 ? 'topic' : 'topics'}</span></h2>
            <div class="grid">${list.map(card).join('')}</div>
          </section>`)
        .join('');

      els.empty.hidden = visible.length > 0;
      if (!visible.length) {
        els.empty.innerHTML = filter === 'favorites' && !query
          ? 'No bookmarks yet. Tap the ☆ on a topic to save it here.'
          : `No topics match “${esc(query)}”.`;
      }
    }

    function renderAll() {
      state = loadState();
      els.count.textContent = `${topics.length} ${topics.length === 1 ? 'guide' : 'guides'} · ${categories().length} ${categories().length === 1 ? 'category' : 'categories'}`;
      renderContinue();
      renderRecent();
      renderFilters();
      renderCatalog();
    }

    /* events */
    els.search.addEventListener('input', () => { query = els.search.value.trim(); renderCatalog(); });
    els.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { els.search.value = ''; query = ''; renderCatalog(); els.search.blur(); }
      if (e.key === 'Enter') {
        const first = els.catalog.querySelector('.card-title a');
        if (first) first.click();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== els.search && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        els.search.focus();
      }
    });
    els.filters.addEventListener('click', (e) => {
      const b = e.target.closest('[data-filter]');
      if (!b) return;
      filter = b.dataset.filter;
      renderFilters();
      renderCatalog();
    });
    els.catalog.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fav]');
      if (!b) return;
      e.preventDefault();
      toggleFav(b.dataset.fav);
      renderFilters();
      renderCatalog();
    });
    // Keep in sync with other tabs, and refresh when returning via the back button (bfcache).
    window.addEventListener('storage', (e) => { if (e.key === STORE_KEY) renderAll(); });
    window.addEventListener('pageshow', (e) => { if (e.persisted) renderAll(); });

    loadTopics()
      .then((list) => {
        topics = list;
        renderAll();
        if (!topics.length) {
          showFatal(els.empty, 'No topics yet. Add an HTML file to <code>artifacts/</code> and an entry to <code>topics.json</code>.');
        }
        // Flag entries whose file hasn't been copied in yet.
        Promise.all(topics.map(async (t) => { if (!(await artifactExists(t.url))) missing.add(t.id); }))
          .then(() => { if (missing.size) renderCatalog(); });
      })
      .catch((err) => {
        console.error(err);
        els.count.textContent = '';
        showFatal(els.empty, location.protocol === 'file:'
          ? FILE_PROTOCOL_HELP
          : `Could not load <code>topics.json</code> — ${esc(err.message)}. Check the file is valid JSON.`);
      });
  }

  /* ================================================================
     VIEWER PAGE
     ================================================================ */

  function initViewer() {
    const $ = (id) => document.getElementById(id);
    const frame = $('artifactFrame');
    const msg = $('viewerMsg');
    const id = new URLSearchParams(location.search).get('topic');

    function fail(html) {
      $('topicTitle').textContent = 'Learning Hub';
      frame.hidden = true;
      showFatal(msg, html);
    }

    function setNav(el, labelEl, t, word) {
      if (!t) { el.setAttribute('aria-disabled', 'true'); el.removeAttribute('href'); return; }
      el.setAttribute('aria-disabled', 'false');
      el.href = viewerHref(t.id);
      el.title = `${word}: ${t.title}`;
      labelEl.textContent = t.title;
    }

    function renderFav() {
      const btn = $('favBtn');
      const on = isFav(id);
      btn.innerHTML = ICON.star;
      btn.setAttribute('aria-pressed', String(on));
      btn.title = on ? 'Remove bookmark' : 'Bookmark';
      btn.setAttribute('aria-label', btn.title);
    }

    /* Reading progress: observed from outside via the same-origin iframe window.
       Only listens to scroll and calls scrollTo — the artifact's DOM is never touched. */
    function trackProgress(topic) {
      let win;
      try {
        win = frame.contentWindow;
        if (!win.location.pathname.endsWith(topic.url.split('/').pop())) return; // user followed a link elsewhere
        void win.document.documentElement;
      } catch {
        return; // cross-origin artifact URL: can't observe, that's fine
      }

      const doc = win.document.documentElement;
      const save = () => {
        const max = doc.scrollHeight - win.innerHeight;
        const y = Math.round(win.scrollY);
        const pct = max > 0 ? Math.min(100, Math.round((y / max) * 100)) : 0;
        update((s) => { s.progress[topic.id] = { y, pct, at: Date.now() }; });
      };
      let timer;
      win.addEventListener('scroll', () => { clearTimeout(timer); timer = setTimeout(save, 300); }, { passive: true });
      window.addEventListener('pagehide', save);

      // Resume where the reader left off, unless the URL targets a specific #section.
      const saved = state.progress[topic.id];
      if (saved && saved.y > 0 && !location.hash) {
        let cancelled = false;
        const cancel = () => { cancelled = true; };
        ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach((ev) => win.addEventListener(ev, cancel, { once: true, passive: true }));
        const start = performance.now();
        // Wait for late layout (Mermaid, fonts, highlighting) to make the page tall enough.
        (function tick() {
          if (cancelled) return;
          const tallEnough = doc.scrollHeight - win.innerHeight >= saved.y;
          if (tallEnough || performance.now() - start > 4000) {
            win.scrollTo({ top: saved.y, behavior: 'instant' });
            return;
          }
          requestAnimationFrame(tick);
        })();
      }

      try { win.focus(); } catch { /* ignore */ } // arrow keys / space scroll the artifact immediately
    }

    if (!id) {
      fail('<strong>No topic selected</strong><span>Go back to the <a href="./">Learning Hub</a>.</span>');
      return;
    }

    loadTopics()
      .then(async (topics) => {
        const i = topics.findIndex((t) => t.id === id);
        if (i < 0) {
          fail(`<strong>Unknown topic “${esc(id)}”</strong><span>It isn’t listed in <code>topics.json</code>. <a href="./">Back to the hub</a></span>`);
          return;
        }
        const topic = topics[i];

        document.title = `${topic.title} · Learning Hub`;
        $('topicTitle').textContent = topic.title;
        $('topicCategory').textContent = topic.category;
        frame.title = topic.title;
        $('rawBtn').href = topic.url;
        setNav($('prevBtn'), $('prevLabel'), topics[i - 1], 'Previous');
        setNav($('nextBtn'), $('nextLabel'), topics[i + 1], 'Next');
        renderFav();
        $('favBtn').addEventListener('click', () => { toggleFav(id); renderFav(); });

        update((s) => {
          s.last = id;
          s.recent = [{ id, at: Date.now() }, ...s.recent.filter((r) => r.id !== id)].slice(0, MAX_RECENT);
        });

        if (!(await artifactExists(topic.url))) {
          fail(`<strong>${esc(topic.title)}: file not found</strong><span>Copy the artifact to <code>${esc(topic.url)}</code>, or fix its <code>path</code> in <code>topics.json</code>.</span>`);
          $('topicTitle').textContent = topic.title;
          return;
        }

        activateNamespace(topic.id);
        mirrorNamespace(topic);
        // Back/forward cache restores this page without re-running it; another topic may own storage now.
        window.addEventListener('pageshow', (e) => { if (e.persisted) activateNamespace(topic.id); });
        frame.addEventListener('load', () => trackProgress(topic));
        // Deep links: viewer.html?topic=kafka#partitions → artifacts/kafka.html#partitions
        frame.src = topic.url + location.hash;
      })
      .catch((err) => {
        console.error(err);
        fail(location.protocol === 'file:'
          ? `<strong>Run a local server</strong><span>${FILE_PROTOCOL_HELP}</span>`
          : `<strong>Could not load topics.json</strong><span>${esc(err.message)}</span>`);
      });
  }

  /* ---------------- boot ---------------- */

  initThemeToggle();
  if (document.body.dataset.page === 'viewer') initViewer();
  else initIndex();
})();
