// netlify/functions/export.js
// POST https://your-site.netlify.app/.netlify/functions/export
// Dipanggil dari Chrome Extension saat user klik Export
// → sanitize data (hapus token) → push data.json ke GitHub repo

const GITHUB_API = 'https://api.github.com';

// ── Sanitize: HAPUS token & email sebelum ke GitHub ───────────────
function sanitizePayload(data) {
  const clean = JSON.parse(JSON.stringify(data)); // deep clone
  delete clean.token;
  if (clean.account) {
    delete clean.account.email;
  }
  // Kalau ada nested token di servers (scan data format)
  if (clean.servers && typeof clean.servers === 'object') {
    for (const key of Object.keys(clean.servers)) {
      const s = clean.servers[key];
      if (s && s.token) delete s.token;
    }
  }
  clean.exported_at = new Date().toISOString();
  return clean;
}

// ── Push file ke GitHub via API ───────────────────────────────────
async function pushToGitHub(data) {
  const owner   = process.env.GITHUB_OWNER;   // username GitHub lo
  const repo    = process.env.GITHUB_REPO;    // nama repo lo
  const branch  = process.env.GITHUB_BRANCH || 'main';
  const token   = process.env.GITHUB_TOKEN;   // GitHub Personal Access Token
  const path    = 'data/servers.json';

  const headers = {
    'Authorization': `token ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'discord-dashboard-netlify'
  };

  // 1. Get SHA file lama (diperlukan untuk update)
  let sha = null;
  try {
    const getRes = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
      { headers }
    );
    if (getRes.ok) {
      const existing = await getRes.json();
      sha = existing.sha;
    }
  } catch (_) {}

  // 2. Encode content ke base64
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');

  // 3. Commit file baru ke repo
  const body = {
    message: `chore: update servers data ${new Date().toISOString()}`,
    content,
    branch,
    ...(sha ? { sha } : {})
  };

  const putRes = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`,
    { method: 'PUT', headers, body: JSON.stringify(body) }
  );

  if (!putRes.ok) {
    const err = await putRes.json();
    throw new Error(`GitHub API error: ${JSON.stringify(err)}`);
  }

  return await putRes.json();
}

// ── Netlify Function Handler ──────────────────────────────────────
exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Export-Key',
  };

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  // ── Auth check ─────────────────────────────────────────────────
  const exportKey = event.headers['x-export-key'] || event.headers['X-Export-Key'];
  if (!process.env.EXPORT_SECRET_KEY || exportKey !== process.env.EXPORT_SECRET_KEY) {
    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Unauthorized' })
    };
  }

  // ── Parse body ─────────────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (_) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }

  if (!payload || !payload.servers) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing servers field in payload' })
    };
  }

  // ── Sanitize + Push ────────────────────────────────────────────
  try {
    const safeData = sanitizePayload(payload);
    await pushToGitHub(safeData);

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        exported_at: safeData.exported_at,
        total_servers: safeData.total_servers || Object.keys(safeData.servers || {}).length
      })
    };
  } catch (e) {
    console.error('[export fn error]', e);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: e.message })
    };
  }
};
