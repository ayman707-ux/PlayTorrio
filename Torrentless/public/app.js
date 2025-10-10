const form = document.getElementById('searchForm');
const queryInput = document.getElementById('query');
const statusEl = document.getElementById('status');
const externalLink = document.getElementById('externalLink');
const htmlInput = document.getElementById('htmlInput');
const parseHtmlBtn = document.getElementById('parseHtmlBtn');
const resultsSec = document.getElementById('results');
const tbody = document.getElementById('tbody');
const resultsTitle = document.getElementById('resultsTitle');
const pageLabel = document.getElementById('pageLabel');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');

let currentQuery = '';
let currentPage = 1;

function setStatus(msg) {
  statusEl.textContent = msg || '';
}

function renderResults(data) {
  const items = data.items || [];
  resultsTitle.textContent = `Results for "${data.query}"`;
  tbody.innerHTML = '';

  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:#a4acc4;">No results found.</td></tr>';
  } else {
    for (const it of items) {
      const tr = document.createElement('tr');

      const titleTd = document.createElement('td');
      titleTd.innerHTML = `
        <div class="title">
          <a href="${it.pageUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(it.title)}</a>
          ${it.category ? `<small>${escapeHtml(it.category)}</small>` : ''}
        </div>`;

      const sizeTd = document.createElement('td');
      sizeTd.textContent = it.size || '';

      const sTd = document.createElement('td');
      sTd.innerHTML = `<span class="seeds">${it.seeds ?? ''}</span>`;

      const lTd = document.createElement('td');
      lTd.innerHTML = `<span class="leechers">${it.leechers ?? ''}</span>`;

      const ageTd = document.createElement('td');
      ageTd.textContent = it.age || '';

      const actionsTd = document.createElement('td');
      actionsTd.innerHTML = `
        <div class="actions">
          <a href="${it.magnet}" title="Open magnet link">Open</a>
          <button type="button" data-magnet="${encodeURIComponent(it.magnet)}">Copy</button>
        </div>`;

      tr.appendChild(titleTd);
      tr.appendChild(sizeTd);
      tr.appendChild(sTd);
      tr.appendChild(lTd);
      tr.appendChild(ageTd);
      tr.appendChild(actionsTd);
      tbody.appendChild(tr);
    }
  }

  resultsSec.hidden = false;
  pageLabel.textContent = `Page ${data.page}`;
  prevBtn.disabled = data.page <= 1;
  nextBtn.disabled = !(data.pagination && data.pagination.hasNext);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function runSearch(query, page = 1) {
  currentQuery = query;
  currentPage = page;
  setStatus('Searching…');
  resultsSec.hidden = true;
  externalLink.hidden = false;
  externalLink.href = buildExternalUrl(query, page);

  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(query)}&page=${page}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    renderResults(data);
    setStatus('');
  } catch (err) {
    console.error(err);
  setStatus('Server search blocked. Trying proxy…');
    // Try proxying the HTML and parsing client-side
    try {
      const proxyUrl = `/api/proxy?q=${encodeURIComponent(query)}&page=${page}`;
      const resp = await fetch(proxyUrl);
      if (!resp.ok) throw new Error(`Proxy HTTP ${resp.status}`);
      const html = await resp.text();
      const parsed = parseHtmlDocument(html);
      renderResults({ query, page, items: parsed, pagination: { hasNext: false } });
      setStatus('');
    } catch (e2) {
      console.error(e2);
      setStatus('Proxy also blocked. Open the external link or paste HTML below.');
    }
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = queryInput.value.trim();
  if (!q) return;
  runSearch(q, 1);
});

prevBtn.addEventListener('click', () => {
  if (currentPage > 1) runSearch(currentQuery, currentPage - 1);
});
nextBtn.addEventListener('click', () => {
  runSearch(currentQuery, currentPage + 1);
});

// Deep-link support: allow visiting /?q=batman
const params = new URLSearchParams(location.search);
if (params.has('q')) {
  queryInput.value = params.get('q') || '';
  if (queryInput.value) runSearch(queryInput.value, parseInt(params.get('page') || '1', 10) || 1);
}

// Copy button handler (event delegation)
tbody.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-magnet]');
  if (!btn) return;
  const magnet = decodeURIComponent(btn.getAttribute('data-magnet'));
  try {
    await navigator.clipboard.writeText(magnet);
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = 'Copy'), 1000);
  } catch (_) {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = magnet;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = 'Copy'), 1000);
  }
});

function buildExternalUrl(query, page) {
  const u = new URL('https://uindex.org/search.php');
  u.searchParams.set('search', query);
  u.searchParams.set('c', '0');
  if (page && page > 1) u.searchParams.set('page', String(page));
  return u.toString();
}

// Local HTML parser fallback
parseHtmlBtn?.addEventListener('click', () => {
  const html = (htmlInput?.value || '').trim();
  if (!html) {
    setStatus('Paste HTML first.');
    return;
  }
  try {
    const items = parseHtmlDocument(html);
    renderResults({ query: currentQuery || '(pasted HTML)', page: currentPage || 1, items, pagination: { hasNext: false } });
    setStatus(`Parsed ${items.length} items from pasted HTML.`);
  } catch (e) {
    console.error(e);
    setStatus('Failed to parse pasted HTML. Ensure you copied the full page HTML.');
  }
});

function parseHtmlDocument(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const rows = doc.querySelectorAll('table.maintable > tbody > tr');
  const items = [];
  rows.forEach((row) => {
    const tds = row.querySelectorAll('td');
    if (tds.length < 5) return;
    const category = (tds[0]?.querySelector('a')?.textContent || '').trim();
    const magnetEl = tds[1]?.querySelector('a[href^="magnet:"]');
    const titleEl = tds[1]?.querySelector("a[href^='/details.php']");
    const title = titleEl?.textContent?.trim() || '';
    const rel = titleEl?.getAttribute('href') || '';
    const pageUrl = rel ? new URL(rel, 'https://uindex.org').toString() : '';
    const age = (tds[1]?.querySelector('div.sub')?.textContent || '').trim();
    const size = (tds[2]?.textContent || '').trim();
    const seeds = parseInt((tds[3]?.textContent || '0').replace(/[^\d]/g, ''), 10) || 0;
    const leechers = parseInt((tds[4]?.textContent || '0').replace(/[^\d]/g, ''), 10) || 0;
    const magnet = magnetEl?.getAttribute('href') || '';
    if (title && magnet) items.push({ title, magnet, pageUrl, category, size, seeds, leechers, age });
  });
  return items;
}
