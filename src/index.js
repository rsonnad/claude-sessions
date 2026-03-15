// Claude Sessions API — Cloudflare Worker + D1
// Stores and retrieves Claude Code session transcripts.
// Serves the search/display UI at GET /
// Auth: Bearer token — set via `wrangler secret put AUTH_TOKEN` or change below.

const AUTH_TOKEN = 'alpaca-sessions-2026';

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);

    // GET / — serve the UI (no auth required)
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return new Response(UI_HTML(url.origin), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // Auth check for all API routes
    const auth = request.headers.get('Authorization');
    if (auth !== `Bearer ${AUTH_TOKEN}`) {
      return json({ error: 'unauthorized' }, 401);
    }

    // POST /sessions — save a session (INSERT OR REPLACE — idempotent)
    if (request.method === 'POST' && url.pathname === '/sessions') {
      const body = await request.json();
      const id = body.id || crypto.randomUUID();

      await env.DB.prepare(`
        INSERT OR REPLACE INTO sessions (id, project, model, started_at, ended_at, duration_mins, summary, transcript, token_count, cost_usd, tags)
        VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        body.project || null,
        body.model || null,
        body.started_at || null,
        body.ended_at || null,
        body.duration_mins || null,
        body.summary || null,
        body.transcript || null,
        body.token_count || null,
        body.cost_usd || null,
        body.tags || null
      ).run();

      return json({ ok: true, id });
    }

    // GET /sessions — list sessions
    if (request.method === 'GET' && url.pathname === '/sessions') {
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const project = url.searchParams.get('project');
      const search = url.searchParams.get('search');
      const dateFrom = url.searchParams.get('from');
      const dateTo = url.searchParams.get('to');

      let query = 'SELECT id, project, model, started_at, ended_at, duration_mins, summary, token_count, cost_usd, tags FROM sessions';
      let countQuery = 'SELECT COUNT(*) as total FROM sessions';
      const params = [];
      const countParams = [];
      const conditions = [];

      if (project) {
        conditions.push('project = ?');
        params.push(project);
        countParams.push(project);
      }
      if (search) {
        conditions.push('(summary LIKE ? OR transcript LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
        countParams.push(`%${search}%`, `%${search}%`);
      }
      if (dateFrom) {
        conditions.push("COALESCE(started_at, ended_at) >= ?");
        params.push(dateFrom);
        countParams.push(dateFrom);
      }
      if (dateTo) {
        conditions.push("COALESCE(started_at, ended_at) <= ?");
        params.push(dateTo + ' 23:59:59');
        countParams.push(dateTo + ' 23:59:59');
      }

      const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
      query += where + ' ORDER BY COALESCE(started_at, ended_at) DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);
      countQuery += where;

      const [result, countResult] = await Promise.all([
        env.DB.prepare(query).bind(...params).all(),
        env.DB.prepare(countQuery).bind(...countParams).all()
      ]);
      const total = countResult.results[0]?.total || 0;
      return json({ sessions: result.results, count: result.results.length, total, limit, offset });
    }

    // GET /sessions/:id — get full session with transcript
    if (request.method === 'GET' && url.pathname.startsWith('/sessions/')) {
      const id = url.pathname.split('/sessions/')[1];
      const result = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first();
      if (!result) return json({ error: 'not found' }, 404);
      return json(result);
    }

    // GET /projects — list distinct project names
    if (request.method === 'GET' && url.pathname === '/projects') {
      const result = await env.DB.prepare(
        "SELECT DISTINCT project FROM sessions WHERE project IS NOT NULL AND project != '' ORDER BY project"
      ).all();
      return json(result.results.map(r => r.project));
    }

    // GET /stats — aggregate stats (cap durations at < 1440 to exclude outliers)
    if (request.method === 'GET' && url.pathname === '/stats') {
      const result = await env.DB.prepare(`
        SELECT
          COUNT(*) as total_sessions,
          SUM(token_count) as total_tokens,
          SUM(cost_usd) as total_cost,
          SUM(CASE WHEN duration_mins < 1440 THEN duration_mins ELSE 0 END) as total_minutes,
          AVG(token_count) as avg_tokens,
          AVG(CASE WHEN duration_mins < 1440 THEN duration_mins ELSE NULL END) as avg_duration
        FROM sessions
      `).first();
      return json(result);
    }

    // POST /fix-timestamps — repair ended_at for bulk-imported sessions
    if (request.method === 'POST' && url.pathname === '/fix-timestamps') {
      const body = await request.json();
      if (!body.import_time || !body.import_end) {
        return json({ error: 'import_time and import_end required' }, 400);
      }

      const withDuration = await env.DB.prepare(`
        UPDATE sessions
        SET ended_at = datetime(started_at, '+' || duration_mins || ' minutes')
        WHERE ended_at BETWEEN ? AND ?
          AND started_at IS NOT NULL
          AND duration_mins IS NOT NULL
          AND duration_mins > 0
      `).bind(body.import_time, body.import_end).run();

      const withoutDuration = await env.DB.prepare(`
        UPDATE sessions
        SET ended_at = started_at
        WHERE ended_at BETWEEN ? AND ?
          AND started_at IS NOT NULL
          AND (duration_mins IS NULL OR duration_mins = 0)
      `).bind(body.import_time, body.import_end).run();

      return json({
        ok: true,
        fixed_with_duration: withDuration.meta?.changes || 0,
        fixed_without_duration: withoutDuration.meta?.changes || 0
      });
    }

    // POST /fix-projects — backfill clean project names from messy paths
    if (request.method === 'POST' && url.pathname === '/fix-projects') {
      // Fix paths like "Khangtsen//claude/worktrees/..." → "Khangtsen"
      const worktreeResult = await env.DB.prepare(`
        UPDATE sessions
        SET project = SUBSTR(project, 1, INSTR(project, '/') - 1)
        WHERE project LIKE '%/%'
          AND project NOT LIKE '%CodingProjects%'
          AND LENGTH(SUBSTR(project, 1, INSTR(project, '/') - 1)) > 0
      `).run();

      // Fix paths still containing CodingProjects
      const codingResult = await env.DB.prepare(`
        UPDATE sessions
        SET project = SUBSTR(
          project,
          INSTR(project, 'CodingProjects/') + 15,
          CASE
            WHEN INSTR(SUBSTR(project, INSTR(project, 'CodingProjects/') + 15), '/') > 0
            THEN INSTR(SUBSTR(project, INSTR(project, 'CodingProjects/') + 15), '/') - 1
            ELSE LENGTH(SUBSTR(project, INSTR(project, 'CodingProjects/') + 15))
          END
        )
        WHERE project LIKE '%CodingProjects/%'
      `).run();

      return json({
        ok: true,
        worktree_fixed: worktreeResult.meta?.changes || 0,
        coding_fixed: codingResult.meta?.changes || 0
      });
    }

    return json({ error: 'not found' }, 404);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

// ── Embedded UI ─────────────────────────────────────────────────
// Self-contained HTML page served at GET /
// Uses the Worker's own origin as the API base URL.

function UI_HTML(origin) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Sessions</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'DM Sans', sans-serif;
      background: #faf9f6;
      color: #1a1a1a;
      min-height: 100vh;
    }
    .container { max-width: 900px; margin: 0 auto; padding: 2rem 1.5rem; }
    .header { margin-bottom: 2rem; }
    .header h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 0.25rem; }
    .header p { color: #666; font-size: 0.9rem; }
    .stats-bar {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .stat-card {
      background: #fff;
      border: 1px solid #e8e5e0;
      border-radius: 10px;
      padding: 1rem 1.25rem;
    }
    .stat-card .label { font-size: 0.75rem; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.25rem; }
    .stat-card .value { font-size: 1.5rem; font-weight: 700; }
    .stat-card .value.small { font-size: 1.1rem; }
    .filter-bar {
      display: flex;
      gap: 0.75rem;
      margin-bottom: 1.5rem;
      flex-wrap: wrap;
    }
    .filter-bar select,
    .filter-bar input[type="text"],
    .filter-bar input[type="date"] {
      font-family: 'DM Sans', sans-serif;
      font-size: 0.875rem;
      padding: 0.6rem 0.85rem;
      border: 1px solid #d4d0c8;
      border-radius: 8px;
      background: #fff;
      outline: none;
      transition: border-color 0.15s;
    }
    .filter-bar input:focus { border-color: #b8a88a; }
    .filter-bar input[type="text"] { flex: 1; min-width: 180px; }
    .filter-bar input[type="date"] { width: 150px; }
    .btn {
      font-family: 'DM Sans', sans-serif;
      font-size: 0.875rem;
      font-weight: 600;
      padding: 0.6rem 1.25rem;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-primary { background: #1a1a1a; color: #fff; }
    .btn-primary:hover { background: #333; }
    .btn-secondary { background: #e8e5e0; color: #1a1a1a; }
    .btn-secondary:hover { background: #dbd7d0; }
    .sessions-list { display: flex; flex-direction: column; gap: 0.5rem; }
    .session-card {
      background: #fff;
      border: 1px solid #e8e5e0;
      border-radius: 10px;
      padding: 1rem 1.25rem;
      transition: all 0.15s;
    }
    .session-card:hover { border-color: #c8c4bc; box-shadow: 0 1px 4px rgba(0,0,0,0.04); }
    .session-card.expanded { border-color: #b8a88a; }
    .session-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.5rem;
    }
    .session-header .share-btn {
      flex-shrink: 0;
      background: none;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 0.3rem 0.45rem;
      cursor: pointer;
      color: #aaa;
      font-size: 0.85rem;
      line-height: 1;
      transition: all 0.15s;
    }
    .session-header .share-btn:hover { color: #555; border-color: #d4d0c8; background: #f5f3ef; }
    .session-meta {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
      flex: 1;
    }
    .session-meta .date { font-weight: 600; font-size: 0.875rem; }
    .session-meta .pill {
      font-size: 0.7rem;
      font-weight: 500;
      padding: 0.2rem 0.55rem;
      border-radius: 20px;
      background: #f0ede8;
      color: #666;
    }
    .session-meta .pill.model { background: #e8f0e8; color: #3a6b3a; }
    .session-meta .pill.tokens { background: #e8e8f0; color: #3a3a6b; }
    .session-meta .pill.duration { background: #f0e8e8; color: #6b3a3a; }
    .session-summary {
      margin-top: 0.5rem;
      font-size: 0.85rem;
      color: #555;
      line-height: 1.4;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .transcript-container {
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid #e8e5e0;
      max-height: 600px;
      overflow-y: auto;
    }
    .transcript-actions {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 0.75rem;
    }
    .transcript-actions .btn {
      font-size: 0.75rem;
      padding: 0.4rem 0.85rem;
    }
    .transcript-container .msg {
      margin-bottom: 1rem;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      font-size: 0.82rem;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      position: relative;
    }
    .transcript-container .msg.user {
      background: #f0ede8;
      border-left: 3px solid #b8a88a;
    }
    .transcript-container .msg.assistant {
      background: #f7f7f7;
      border-left: 3px solid #ccc;
    }
    .transcript-container .msg .role {
      font-weight: 700;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.35rem;
      display: block;
    }
    .msg.user .role { color: #8a7a5a; }
    .msg.assistant .role { color: #888; }
    .msg .copy-btn {
      position: absolute;
      top: 0.5rem;
      right: 0.5rem;
      background: rgba(255,255,255,0.8);
      border: 1px solid #d4d0c8;
      border-radius: 5px;
      padding: 0.25rem 0.5rem;
      font-size: 0.65rem;
      font-family: 'DM Sans', sans-serif;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s;
      color: #555;
    }
    .msg:hover .copy-btn { opacity: 1; }
    .msg .copy-btn:hover { background: #fff; border-color: #b8a88a; }
    .msg .copy-btn.copied { background: #e8f0e8; border-color: #3a6b3a; color: #3a6b3a; }
    .load-more { text-align: center; margin-top: 1.5rem; }
    .pagination-info { font-size: 0.8rem; color: #888; margin-bottom: 0.75rem; }
    .loading, .empty { text-align: center; padding: 3rem; color: #888; font-size: 0.9rem; }
    .spinner {
      display: inline-block;
      width: 24px; height: 24px;
      border: 2.5px solid #e8e5e0;
      border-top-color: #1a1a1a;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
      margin-bottom: 0.5rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .full-session-view .back-link {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.85rem;
      color: #888;
      text-decoration: none;
      margin-bottom: 1.5rem;
      transition: color 0.15s;
    }
    .full-session-view .back-link:hover { color: #1a1a1a; }
    .full-session-view .session-info {
      margin-bottom: 1.5rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid #e8e5e0;
    }
    .full-session-view .session-info h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: 0.5rem; }
    .full-session-view .full-transcript .msg {
      margin-bottom: 1rem;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      font-size: 0.85rem;
      line-height: 1.7;
      white-space: pre-wrap;
      word-break: break-word;
      position: relative;
    }
    .full-session-view .full-transcript .msg.user {
      background: #f0ede8;
      border-left: 3px solid #b8a88a;
    }
    .full-session-view .full-transcript .msg.assistant {
      background: #f7f7f7;
      border-left: 3px solid #ccc;
    }
    .full-session-view .full-transcript .msg .role {
      font-weight: 700;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.35rem;
      display: block;
    }
    .full-session-view .msg.user .role { color: #8a7a5a; }
    .full-session-view .msg.assistant .role { color: #888; }
    .full-session-view .msg .copy-btn {
      position: absolute;
      top: 0.5rem;
      right: 0.5rem;
      background: rgba(255,255,255,0.8);
      border: 1px solid #d4d0c8;
      border-radius: 5px;
      padding: 0.25rem 0.5rem;
      font-size: 0.65rem;
      font-family: 'DM Sans', sans-serif;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s;
      color: #555;
    }
    .full-session-view .msg:hover .copy-btn { opacity: 1; }
    .full-session-view .msg .copy-btn:hover { background: #fff; border-color: #b8a88a; }
    .full-session-view .msg .copy-btn.copied { background: #e8f0e8; border-color: #3a6b3a; color: #3a6b3a; }
    @media (max-width: 600px) {
      .filter-bar { flex-direction: column; }
      .filter-bar input[type="date"] { width: 100%; }
      .stats-bar { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Claude Sessions</h1>
      <p>Browse and search past Claude Code conversations</p>
    </div>
    <div class="stats-bar" id="stats-bar">
      <div class="stat-card"><div class="label">Sessions</div><div class="value" id="stat-sessions">--</div></div>
      <div class="stat-card"><div class="label">Total Tokens</div><div class="value small" id="stat-tokens">--</div></div>
      <div class="stat-card"><div class="label">Total Hours</div><div class="value" id="stat-hours">--</div></div>
      <div class="stat-card"><div class="label">Avg Duration</div><div class="value" id="stat-avg">--</div></div>
    </div>
    <div class="filter-bar">
      <select id="project-filter" style="min-width:130px;">
        <option value="">All projects</option>
      </select>
      <input type="text" id="search-input" placeholder="Search sessions..." />
      <input type="date" id="date-from" title="From date" />
      <input type="date" id="date-to" title="To date" />
      <button class="btn btn-primary" onclick="applyFilters()">Search</button>
      <button class="btn btn-secondary" onclick="clearFilters()">Clear</button>
    </div>
    <div id="sessions-container">
      <div class="loading"><div class="spinner"></div><br>Loading sessions...</div>
    </div>
    <div class="load-more" id="load-more" style="display:none;">
      <div class="pagination-info" id="pagination-info"></div>
      <button class="btn btn-secondary" onclick="loadMore()">Load More</button>
    </div>
  </div>
  <script>
    const API = '${origin}';
    const TOKEN = '${AUTH_TOKEN}';
    const LIMIT = 50;
    let currentOffset = 0;
    let totalSessions = 0;
    let sessions = [];
    let expandedId = null;
    let transcriptCache = {};
    const headers = { 'Authorization': 'Bearer ' + TOKEN };

    async function api(path) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await fetch(API + path, { headers, signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) throw new Error('API error: ' + res.status);
        return res.json();
      } catch (e) {
        clearTimeout(timeout);
        if (e.name === 'AbortError') throw new Error('Request timed out — the API may be blocked by a browser extension. Try disabling your ad blocker.');
        throw e;
      }
    }

    async function loadStats() {
      try {
        const s = await api('/stats');
        document.getElementById('stat-sessions').textContent = (s.total_sessions || 0).toLocaleString();
        document.getElementById('stat-tokens').textContent = s.total_tokens ? (s.total_tokens / 1e6).toFixed(1) + 'M' : '0';
        document.getElementById('stat-hours').textContent = s.total_minutes ? (s.total_minutes / 60).toFixed(1) : '0';
        document.getElementById('stat-avg').textContent = s.avg_duration ? Math.round(s.avg_duration) + 'm' : '--';
      } catch (e) { console.error('Stats error:', e); }
    }

    async function loadProjects() {
      try {
        var projects = await api('/projects');
        var sel = document.getElementById('project-filter');
        projects.forEach(function(p) {
          var opt = document.createElement('option');
          opt.value = p;
          opt.textContent = p;
          sel.appendChild(opt);
        });
      } catch (e) { console.error('Projects error:', e); }
    }

    function buildQuery() {
      const params = new URLSearchParams();
      params.set('limit', LIMIT);
      params.set('offset', currentOffset);
      const project = document.getElementById('project-filter').value;
      const search = document.getElementById('search-input').value.trim();
      const from = document.getElementById('date-from').value;
      const to = document.getElementById('date-to').value;
      if (project) params.set('project', project);
      if (search) params.set('search', search);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      return '/sessions?' + params.toString();
    }

    async function loadSessions(append) {
      const container = document.getElementById('sessions-container');
      if (!append) {
        container.innerHTML = '<div class="loading"><div class="spinner"></div><br>Loading sessions...</div>';
        sessions = [];
        currentOffset = 0;
      }
      try {
        const data = await api(buildQuery());
        totalSessions = data.total || 0;
        sessions = append ? sessions.concat(data.sessions) : data.sessions;
        currentOffset = sessions.length;
        renderSessions();
      } catch (e) {
        container.innerHTML = '<div class="empty" style="white-space:normal;max-width:500px;margin:0 auto;"><strong>Failed to load sessions</strong><br><span style="font-size:0.82rem;color:#999;">' + escHtml(e.message) + '</span></div>';
      }
    }

    function renderSessions() {
      const container = document.getElementById('sessions-container');
      if (!sessions.length) {
        container.innerHTML = '<div class="empty">No sessions found.</div>';
        document.getElementById('load-more').style.display = 'none';
        return;
      }
      container.innerHTML = '<div class="sessions-list">' + sessions.map(function(s) {
        var rawDate = s.started_at || s.ended_at;
        var date = rawDate ? new Date(rawDate.includes('Z') || rawDate.includes('+') ? rawDate : rawDate + 'Z') : null;
        var dateStr = date && !isNaN(date) ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Date unknown';
        var timeStr = date && !isNaN(date) ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
        var project = s.project || 'unknown';
        var model = s.model ? s.model.replace('claude-', '').split('-202')[0] : '';
        var durMins = s.duration_mins;
        if (!durMins && s.started_at && s.ended_at) durMins = Math.max(1, Math.round((new Date(s.ended_at) - new Date(s.started_at)) / 60000));
        var duration = durMins && durMins < 1440 ? durMins + 'm' : '';
        var tokens = s.token_count ? (s.token_count / 1000).toFixed(0) + 'k' : '';
        var summary = (s.summary || '').substring(0, 120);
        var isExpanded = expandedId === s.id;
        return '<div class="session-card ' + (isExpanded ? 'expanded' : '') + '">' +
          '<div class="session-header">' +
            '<div class="session-meta" onclick="toggleSession(\\'' + s.id + '\\')" style="cursor:pointer;">' +
              '<span class="date">' + dateStr + ' ' + timeStr + '</span>' +
              '<span class="pill">' + project + '</span>' +
              (model ? '<span class="pill model">' + model + '</span>' : '') +
              (duration ? '<span class="pill duration">' + duration + '</span>' : '') +
              (tokens ? '<span class="pill tokens">' + tokens + ' tokens</span>' : '') +
            '</div>' +
            '<button class="share-btn" onclick="event.stopPropagation(); openSessionView(\\'' + s.id + '\\')" title="Open full session">&#x2197;</button>' +
          '</div>' +
          (summary ? '<div class="session-summary" onclick="toggleSession(\\'' + s.id + '\\')" style="cursor:pointer;">' + escHtml(summary) + '</div>' : '') +
          (isExpanded ? '<div class="transcript-container" id="transcript-' + s.id + '"><div class="loading"><div class="spinner"></div></div></div>' : '') +
        '</div>';
      }).join('') + '</div>';

      var loadMoreEl = document.getElementById('load-more');
      if (sessions.length < totalSessions) {
        loadMoreEl.style.display = 'block';
        document.getElementById('pagination-info').textContent = 'Showing ' + sessions.length + ' of ' + totalSessions + ' sessions';
      } else {
        loadMoreEl.style.display = 'none';
      }
      if (expandedId) loadTranscript(expandedId);
    }

    function toggleSession(id) {
      expandedId = expandedId === id ? null : id;
      renderSessions();
    }

    async function loadTranscript(id) {
      var el = document.getElementById('transcript-' + id);
      if (!el) return;
      if (transcriptCache[id]) { el.innerHTML = renderTranscript(transcriptCache[id], id); return; }
      try {
        var data = await api('/sessions/' + id);
        transcriptCache[id] = data.transcript || '';
        el.innerHTML = renderTranscript(data.transcript || '', id);
      } catch (e) { el.innerHTML = '<div class="empty">Failed to load transcript.</div>'; }
    }

    function renderTranscript(text, sessionId) {
      if (!text) return '<div class="empty">No transcript available.</div>';
      var actions = '<div class="transcript-actions"><button class="btn btn-secondary" onclick="event.stopPropagation(); copyFullSession(\\'' + sessionId + '\\')">Copy Full Session</button></div>';
      var parts = text.split(/\\n---\\n/);
      var msgIndex = 0;
      var msgs = parts.map(function(part) {
        part = part.trim();
        if (!part) return '';
        var isUser = part.startsWith('## User');
        var role = isUser ? 'user' : 'assistant';
        var content = part.replace(/^## (User|Assistant)\\n?/, '').trim();
        var display = content.length > 3000 ? content.substring(0, 3000) + '\\n\\n... [truncated]' : content;
        var idx = msgIndex++;
        return '<div class="msg ' + role + '"><span class="role">' + role + '</span><button class="copy-btn" onclick="event.stopPropagation(); copyMsg(this, \\'' + sessionId + '\\', ' + idx + ')">Copy</button>' + escHtml(display) + '</div>';
      }).filter(Boolean).join('');
      return actions + msgs;
    }

    function getMessages(sessionId) {
      var text = transcriptCache[sessionId];
      if (!text) return [];
      return text.split(/\\n---\\n/).map(function(part) {
        part = part.trim();
        if (!part) return null;
        var isUser = part.startsWith('## User');
        return { role: isUser ? 'User' : 'Assistant', content: part.replace(/^## (User|Assistant)\\n?/, '').trim() };
      }).filter(Boolean);
    }

    function copyMsg(btn, sessionId, idx) {
      var msgs = getMessages(sessionId);
      if (!msgs[idx]) return;
      navigator.clipboard.writeText(msgs[idx].content).then(function() {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
      });
    }

    function copyFullSession(sessionId) {
      var msgs = getMessages(sessionId);
      if (!msgs.length) return;
      var full = msgs.map(function(m) { return '### ' + m.role + '\\n\\n' + m.content; }).join('\\n\\n---\\n\\n');
      navigator.clipboard.writeText(full).then(function() {
        var btn = event.target;
        btn.textContent = 'Copied!';
        setTimeout(function() { btn.textContent = 'Copy Full Session'; }, 1500);
      });
    }

    function openSessionView(id) { window.location.href = '?session=' + id; }

    async function showFullSessionView(id) {
      var container = document.querySelector('.container');
      container.innerHTML = '<div class="full-session-view"><a href="?" class="back-link">&larr; All sessions</a><div id="full-session-content"><div class="loading"><div class="spinner"></div><br>Loading session...</div></div></div>';
      document.title = 'Claude Session';
      try {
        var data = await api('/sessions/' + id);
        transcriptCache[id] = data.transcript || '';
        var rawDate = data.started_at || data.ended_at;
        var date = rawDate ? new Date(rawDate.includes('Z') || rawDate.includes('+') ? rawDate : rawDate + 'Z') : null;
        var dateStr = date && !isNaN(date) ? date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
        var model = data.model ? data.model.replace('claude-', '').split('-202')[0] : '';
        var project = data.project || '';
        var tokens = data.token_count ? (data.token_count / 1000).toFixed(0) + 'k tokens' : '';
        var durMins = data.duration_mins;
        if (!durMins && data.started_at && data.ended_at) durMins = Math.max(1, Math.round((new Date(data.ended_at) - new Date(data.started_at)) / 60000));
        var duration = durMins && durMins < 1440 ? durMins + 'm' : '';
        var pills = [project, model, duration, tokens].filter(Boolean).map(function(p) {
          return '<span class="pill" style="font-size:0.72rem;padding:0.2rem 0.55rem;border-radius:20px;background:#f0ede8;color:#666;margin-right:0.35rem;">' + escHtml(p) + '</span>';
        }).join('');
        var parts = (data.transcript || '').split(/\\n---\\n/);
        var msgIdx = 0;
        var msgs = parts.map(function(part) {
          part = part.trim();
          if (!part) return '';
          var isUser = part.startsWith('## User');
          var role = isUser ? 'user' : 'assistant';
          var content = part.replace(/^## (User|Assistant)\\n?/, '').trim();
          var idx = msgIdx++;
          return '<div class="msg ' + role + '"><span class="role">' + role + '</span><button class="copy-btn" onclick="event.stopPropagation(); copyMsg(this, \\'' + id + '\\', ' + idx + ')">Copy</button>' + escHtml(content) + '</div>';
        }).filter(Boolean).join('');
        document.getElementById('full-session-content').innerHTML =
          '<div class="session-info"><h2>' + dateStr + '</h2><div>' + pills + '</div>' +
          (data.summary ? '<p style="margin-top:0.5rem;font-size:0.85rem;color:#555;">' + escHtml(data.summary) + '</p>' : '') +
          '<div class="transcript-actions" style="margin-top:0.75rem;"><button class="btn btn-secondary" onclick="copyFullSession(\\'' + id + '\\')">Copy Full Session</button></div></div>' +
          '<div class="full-transcript">' + (msgs || '<div class="empty">No transcript available.</div>') + '</div>';
        document.title = 'Session — ' + (dateStr || id);
      } catch (e) {
        document.getElementById('full-session-content').innerHTML = '<div class="empty">Failed to load session.<br><span style="font-size:0.82rem;color:#999;">' + escHtml(e.message) + '</span></div>';
      }
    }

    function escHtml(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function applyFilters() { expandedId = null; transcriptCache = {}; loadSessions(false); }
    function clearFilters() {
      document.getElementById('search-input').value = '';
      document.getElementById('date-from').value = '';
      document.getElementById('date-to').value = '';
      expandedId = null; transcriptCache = {}; loadSessions(false);
    }
    function loadMore() { loadSessions(true); }
    document.getElementById('search-input').addEventListener('keydown', function(e) { if (e.key === 'Enter') applyFilters(); });

    var urlParams = new URLSearchParams(window.location.search);
    var singleSessionId = urlParams.get('session');
    if (singleSessionId) { showFullSessionView(singleSessionId); } else { loadStats(); loadProjects(); loadSessions(); }
  </script>
</body>
</html>`;
}
