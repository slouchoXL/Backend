import express from 'express';
import cors from 'cors';
import { nanoid } from 'nanoid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import 'dotenv/config';
import { jwtVerify } from 'jose';
import { createClient } from '@supabase/supabase-js';

/* -------------------- Supabase Admin (server-side) -------------------- */
const SUPABASE_URL        = (process.env.SUPABASE_URL || '').trim();
const SUPA_SERVICE_ROLE   = (process.env.SUPABASE_SERVICE_ROLE || '').trim(); // NEVER expose to client
const SUPABASE_JWT_SECRET = (process.env.SUPABASE_JWT_SECRET || '').trim();

// IMPORTANT: only create a client if both envs are present
let supaAdmin = null;
if (!SUPABASE_URL || !SUPA_SERVICE_ROLE) {
  console.warn('[supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE env vars!');
} else {
  supaAdmin = createClient(SUPABASE_URL, SUPA_SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

/* small helper so DB fns can bail early with a clear error */
function requireAdmin() {
  if (!supaAdmin) {
    const err = new Error('Supabase admin client not initialized — check SUPABASE_URL and SUPABASE_SERVICE_ROLE env vars on the server.');
    err.code = 'NO_SUPABASE_ADMIN';
    throw err;
  }
  return supaAdmin;
}

/* -------------------- Node/Express bootstrap ------------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 5179;

app.use(express.json());
app.use(cors({
  origin: true, // echo request origin
  credentials: false,
  allowedHeaders: ['Content-Type', 'X-Player-Id', 'Authorization'],
  methods: ['GET', 'POST', 'OPTIONS']
}));

/* -------------------- Auth middleware -------------------------------- */
const JWT_KEY = SUPABASE_JWT_SECRET ? new TextEncoder().encode(SUPABASE_JWT_SECRET) : null;

async function authMiddleware(req, _res, next) {
  req.user = null;
  req.playerId = req.get('X-Player-Id') || 'anon';

  const auth = req.get('authorization') || req.get('Authorization');
  if (!auth?.startsWith('Bearer ') || !JWT_KEY) return next();

  const token = auth.slice(7).trim();
  if (!token) return next();

  try {
    const { payload } = await jwtVerify(token, JWT_KEY);
    const sub = payload?.sub || payload?.user_id;
    if (sub) {
      req.user = payload;
      req.playerId = sub; // Supabase user id
    }
  } catch {
    // invalid token → keep fallback id
  }
  next();
}
app.use(authMiddleware);

/* -------------------- In-memory global state ------------------------- */
const DB_PATH = path.join(__dirname, 'data', 'drop-tables.json');
const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));

const state = {
  balance: { COIN: 9000 },
  inventory: [],
  pity: { legendarySince: 0 },
  idempo: new Map(),
  pendingOpens: new Map()
};

const CANON_DIR = path.join(__dirname, 'data', 'canon');

function loadCanonFile(name) {
  return JSON.parse(fs.readFileSync(path.join(CANON_DIR, name), 'utf8'));
}

const canon = {
  eps:        loadCanonFile('eps.json'),
  fragments:  loadCanonFile('fragments.json'),
  unreleased: loadCanonFile('unreleased.json'),
  characters: loadCanonFile('characters.json')
};

// --- Hot-reload canon on file changes ---
function reloadCanon() {
  try {
    const next = {
      eps:        loadCanonFile('eps.json'),
      fragments:  loadCanonFile('fragments.json'),
      unreleased: loadCanonFile('unreleased.json'),
      characters: loadCanonFile('characters.json')
    };
    canon.eps = next.eps;
    canon.fragments = next.fragments;
    canon.unreleased = next.unreleased;
    canon.characters = next.characters;
    console.log('[catalog] canon reloaded');
  } catch (err) {
    console.error('[catalog] reload failed:', err.message);
  }
}

let reloadTimer = null;
try {
  fs.watch(CANON_DIR, { persistent: true }, () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(reloadCanon, 150); // debounce
  });
  console.log('[catalog] watching', CANON_DIR);
} catch (err) {
  console.warn('[catalog] watch unavailable:', err.message);
}

/* -------------------- Local JSON storage (anon fallback) ------------- */
const USERS_DIR = path.join(__dirname, 'data', 'users');
if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR, { recursive: true });

function userFile(playerId) {
  return path.join(USERS_DIR, `${playerId}.json`);
}
function loadInventory(playerId) {
  const f = userFile(playerId);
  if (!fs.existsSync(f)) {
    const fresh = { balance: { COIN: 1000 }, items: [] };
    fs.writeFileSync(f, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function saveInventory(playerId, inv) {
  fs.writeFileSync(userFile(playerId), JSON.stringify(inv, null, 2));
}

/* -------------------- Utilities ------------------------------------- */
function isUUID(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ''));
}
function hashRequest(body){ return JSON.stringify(body); }

function pickRarity(table){
  const pityRow = table.rows.find(r => r.rarity === 'legendary' && r.pityEvery);
  if (pityRow && state.pity.legendarySince + 1 >= pityRow.pityEvery) {
    state.pity.legendarySince = 0;
    return 'legendary';
  }
  const total = table.rows.reduce((s,r)=>s+r.weight,0);
  const roll  = Math.random() * total;
  let acc = 0;
  for (const row of table.rows) {
    acc += row.weight;
    if (roll <= acc) {
      if (row.rarity === 'legendary') state.pity.legendarySince = 0;
      else state.pity.legendarySince++;
      return row.rarity;
    }
  }
  return table.rows[0].rarity;
}

/* -------------------- DB helpers (Supabase) -------------------------- */
async function dbEnsureProfile(userId) {
  const sb = requireAdmin();
  const { error: upErr } = await sb
    .from('profiles')
    .upsert({ user_id: userId }, { onConflict: 'user_id', ignoreDuplicates: true });
  if (upErr) throw upErr;
}

async function dbGetInventory(userId) {
  const sb = requireAdmin();
  await dbEnsureProfile(userId);

  const [{ data: prof, error: profErr }, { data: items, error: itemsErr }] = await Promise.all([
    sb.from('profiles')
      .select('coin_balance')
      .eq('user_id', userId)
      .maybeSingle(),
    sb.from('inventory_items')
      .select('item_id, name, rarity, art_url, qty, acquired_at')
      .eq('owner_id', userId)
      .order('acquired_at', { ascending: true })
  ]);

  if (profErr)  throw profErr;
  if (itemsErr) throw itemsErr;

  return {
    balance: { COIN: prof?.coin_balance ?? 0 },
    items: (items || []).map(it => ({
      itemId: it.item_id,
      name:   it.name,
      rarity: it.rarity,
      artUrl: it.art_url,
      qty:    it.qty,
      acquiredAt: it.acquired_at
    }))
  };
}

function computeProgress(inv, canon) {
  const owned = new Set((inv.items || []).map(it => it.itemId));

  const songs = [];
  const eps = [];
  const singles = [];
  const fragments = [];
  const characters = [];

  const epsList = (canon?.eps?.eps) || [];
  for (const ep of epsList) {
    const songList = (ep?.songs) || [];
    let songsComplete = 0;

    for (const song of songList) {
      const stems = (song?.stems) || [];
      const ownedStems = stems.filter(s => owned.has(s.id)).length;
      const totalStems = stems.length;
      const complete = totalStems > 0 && ownedStems === totalStems;
      if (complete) songsComplete++;
      songs.push({
        id: song?.id || null,
        name: song?.name || null,
        ownedStems,
        totalStems,
        complete,
        epId: ep?.id || null
      });
    }

    const coverOwned = !!(ep?.cover?.id && owned.has(ep.cover.id));
    const epComplete = songList.length > 0 && songsComplete === songList.length && coverOwned;
    eps.push({
      id: ep?.id || null,
      name: ep?.name || null,
      songsComplete,
      totalSongs: songList.length,
      coverOwned,
      complete: epComplete
    });

    if (epComplete && ep?.character?.id) {
      characters.push({
        id: ep.character.id,
        name: ep.character.name || ep.character.id,
        unlocked: true,
        source: ep.id
      });
    }
  }

  // Singles can be either { id, name, stems, cover, character } OR { id, name, song:{stems}, cover, character }
  const singlesList = (canon?.eps?.singles) || [];
  for (const s of singlesList) {
    const stemArray = (s?.stems) || (s?.song?.stems) || [];
    const ownedStems = stemArray.filter(st => owned.has(st.id)).length;
    const totalStems = stemArray.length;
    const coverOwned = !!(s?.cover?.id && owned.has(s.cover.id));
    const complete = totalStems > 0 && ownedStems === totalStems && coverOwned;

    singles.push({
      id: s?.id || null,
      name: s?.name || null,
      ownedStems,
      totalStems,
      coverOwned,
      complete
    });

    if (complete && s?.character?.id) {
      characters.push({
        id: s.character.id,
        name: s.character.name || s.character.id,
        unlocked: true,
        source: s.id
      });
    }
  }

  const fragChars = (canon?.fragments?.characters) || [];
  for (const char of fragChars) {
    const frags = (char?.fragments) || [];
    const ownedCount = frags.filter(f => owned.has(f.id)).length;
    const total = frags.length;
    const complete = total > 0 && ownedCount === total;

    fragments.push({
      characterId: char?.id || null,
      name: char?.name || null,
      owned: ownedCount,
      total,
      complete
    });

    if (complete && char?.id) {
      characters.push({
        id: char.id,
        name: char.name || char.id,
        unlocked: true,
        source: 'fragments'
      });
    }
  }

  return { songs, eps, singles, fragments, characters };
}

async function materializeUnlocks(userId, inv, canon) {
  const sb = requireAdmin();
  // current unlocked set
  const { data: existing, error: exErr } = await sb
    .from('unlocked_characters')
    .select('char_id')
    .eq('owner_id', userId);
  if (exErr) throw exErr;
  const have = new Set((existing || []).map(r => r.char_id));

  // recompute
  const prog = computeProgress(inv, canon);

  // candidates: EP/SINGLE completions
  const newly = [];

  for (const ep of prog.eps) {
    if (ep.complete) {
      const epDef = (canon.eps.eps || []).find(e => e.id === ep.id);
      if (epDef?.character && !have.has(epDef.character.id)) {
        newly.push({ char_id: epDef.character.id, source: `EP:${ep.id}` });
      }
    }
  }

  for (const s of prog.singles) {
    if (s.complete) {
      const sDef = (canon.eps.singles || []).find(x => x.id === s.id);
      if (sDef?.character && !have.has(sDef.character.id)) {
        newly.push({ char_id: sDef.character.id, source: `SINGLE:${s.id}` });
      }
    }
  }

  // fragment-based
  for (const f of prog.fragments) {
    if (f.complete && !have.has(f.characterId)) {
      newly.push({ char_id: f.characterId, source: `FRAGMENTS:${f.characterId}` });
    }
  }

  if (!newly.length) return { inserted: 0 };

  const rows = newly.map(n => ({
    owner_id: userId,
    char_id: n.char_id,
    source: n.source
  }));
  const { error: insErr } = await sb
    .from('unlocked_characters')
    .upsert(rows, { onConflict: 'owner_id,char_id' });
  if (insErr) throw insErr;
  return { inserted: rows.length };
}


async function dbIncBalance(userId, delta) {
  const sb = requireAdmin();
  // Try RPC if present
  const { data, error } = await sb.rpc('inc_balance', { p_user: userId, p_delta: delta });
  if (!error) return data;

  // Fallback
  const { data: prof, error: selErr } = await sb
    .from('profiles').select('coin_balance').eq('user_id', userId).maybeSingle();
  if (selErr) throw selErr;
  const next = (prof?.coin_balance ?? 0) + delta;
  const { error: updErr } = await sb
    .from('profiles').update({ coin_balance: next }).eq('user_id', userId);
  if (updErr) throw updErr;
  return next;
}
async function dbDebitBalance(userId, amount) {
  if (amount <= 0) return;
  return dbIncBalance(userId, -amount);
}

async function dbAddInventoryItems(userId, items) {
  if (!items?.length) return;
  const sb = requireAdmin();

  // shape items for the RPC
  const payload = items.map(it => ({
    item_id: it.itemId,
    name: it.name,
    rarity: it.rarity,
    art_url: it.artUrl ?? null,
    qty: it.qty ?? 1
  }));

  const { data, error } = await sb.rpc('add_inventory_items', {
    p_owner: userId,
    p_items: payload
  });
  if (error) throw error;
  return data; // { added, duplicates }
}

// Pending opens stored per user (one active at a time)
async function dbSetPendingOpen(userId, payload) {
  const sb = requireAdmin();
  const { error } = await sb
    .from('pending_opens')
    .upsert({ owner_id: userId, items: payload }, { onConflict: 'owner_id' });
  if (error) throw error;
}

async function dbGetPendingOpen(userId) {
  const sb = requireAdmin();
  const { data, error } = await sb
    .from('pending_opens')
    .select('items')
    .eq('owner_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data?.items || null;
}

async function dbClearPendingOpen(userId) {
  const sb = requireAdmin();
  const { error } = await sb
    .from('pending_opens')
    .delete()
    .eq('owner_id', userId);
  if (error) throw error;
}

/* -------------------- Debug: env + db + whoami ----------------------- */
app.get('/api/debug/db-deep', async (_req, res) => {
  try {
    if (!SUPABASE_URL || !SUPA_SERVICE_ROLE) {
      return res.status(500).json({ ok:false, phase:'env', error:'Missing SUPABASE_URL or SERVICE_ROLE' });
    }

    const testUser = '00000000-0000-0000-0000-000000000000'; // dummy UUID
    const up1 = await supaAdmin
      .from('profiles')
      .upsert({ user_id: testUser }, { onConflict: 'user_id', ignoreDuplicates: true });

    if (up1.error) {
      return res.status(500).json({
        ok:false,
        phase:'profiles_upsert',
        code: up1.error.code,
        message: up1.error.message,
        hint: up1.error.hint || null
      });
    }

    const sel2 = await supaAdmin
      .from('inventory_items')
      .select('item_id', { count: 'exact', head: true });

    if (sel2.error) {
      return res.status(500).json({
        ok:false,
        phase:'inventory_items_exists',
        code: sel2.error.code,
        message: sel2.error.message,
        hint: sel2.error.hint || null
      });
    }

    const sel3 = await supaAdmin
      .from('pending_opens')
      .select('owner_id', { count: 'exact', head: true });

    if (sel3.error) {
      return res.status(500).json({
        ok:false,
        phase:'pending_opens_exists',
        code: sel3.error.code,
        message: sel3.error.message,
        hint: sel3.error.hint || null
      });
    }

    return res.json({ ok:true, phases:['profiles_upsert','inventory_items_exists','pending_opens_exists'] });
  } catch (e) {
    return res.status(500).json({ ok:false, phase:'unexpected', error: String(e?.message || e) });
  }
});

app.get('/api/debug/env', (_req, res) => {
  res.json({
    node: process.version,
    has_SUPABASE_URL:        !!SUPABASE_URL,
    has_SUPABASE_SERVICE_ROLE: !!SUPA_SERVICE_ROLE,
    has_SUPABASE_JWT_SECRET: !!SUPABASE_JWT_SECRET,
    SUPABASE_URL_len:        SUPABASE_URL ? SUPABASE_URL.length : 0,
    SERVICE_ROLE_len:        SUPA_SERVICE_ROLE ? SUPA_SERVICE_ROLE.length : 0,
    jwt_secret_len:          SUPABASE_JWT_SECRET ? SUPABASE_JWT_SECRET.length : 0
  });
});

app.get('/api/debug/db', async (_req, res) => {
  try {
    const sb = requireAdmin();
    const [p, i, po] = await Promise.all([
      sb.from('profiles').select('user_id, coin_balance').limit(1),
      sb.from('inventory_items').select('owner_id, item_id').limit(1),
      sb.from('pending_opens').select('owner_id').limit(1)
    ]);
    res.json({
      ok: true,
      profiles_ok: !p.error,
      inventory_items_ok: !i.error,
      pending_opens_ok: !po.error,
      samples: {
        profiles: p.data || [],
        inventory_items: i.data || [],
        pending_opens: po.data || []
      }
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e), code: e.code || null });
  }
});

// View dupe shards + guarantee tokens for current user
app.get('/api/debug/dupes', async (req, res) => {
  try {
    if (!isUUID(req.playerId)) {
      // anon users don't have DB rows; just echo zeros
      return res.json({
        userId: req.playerId,
        shards: 0,
        guarantee_tokens: 0,
        dup_item_kinds: 0,
        dup_total_qty_over_1: 0
      });
    }

    const sb = requireAdmin();
    await dbEnsureProfile(req.playerId);

    // profile tokens
    const { data: prof, error: profErr } = await sb
      .from('profiles')
      .select('coin_balance, guarantee_tokens')
      .eq('user_id', req.playerId)
      .maybeSingle();
    if (profErr) throw profErr;

    // dupe bank shards
    const { data: bank, error: bankErr } = await sb
      .from('dupe_bank')
      .select('shards')
      .eq('owner_id', req.playerId)
      .maybeSingle();
    if (bankErr) throw bankErr;

    // quick duplicate overview (how many item_ids have qty > 1, and total extra copies)
    const { data: inv, error: invErr } = await sb
      .from('inventory_items')
      .select('qty')
      .eq('owner_id', req.playerId);
    if (invErr) throw invErr;

    const dup_item_kinds = (inv || []).filter(r => (r.qty ?? 1) > 1).length;
    const dup_total_qty_over_1 = (inv || []).reduce((sum, r) => sum + Math.max((r.qty ?? 1) - 1, 0), 0);

    return res.json({
      userId: req.playerId,
      shards: bank?.shards ?? 0,
      guarantee_tokens: prof?.guarantee_tokens ?? 0,
      dup_item_kinds,
      dup_total_qty_over_1
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/debug/whoami', (req, res) => {
  res.json({
    playerId: req.playerId,
    authed: !!req.user,
    userSub: req.user?.sub || null,
    sawAuthorization: !!req.get('authorization'),
    sawXPlayerId: !!req.get('x-player-id'),
  });
});

/* -------------------- Routes ---------------------------------------- */
// Packs list (public)
app.get('/api/packs', (_req, res) => {
  res.json({ packs: db.packs });
});

app.get('/api/catalog', (_req, res) => {
  res.json(canon);
});

// Inventory (per-user; Supabase for authed UUID; JSON for anon)
// Inventory (per-user; Supabase for authed UUID; JSON for anon)
app.get('/api/inventory', async (req, res) => {
  try {
    let inv;
    if (isUUID(req.playerId)) {
      inv = await dbGetInventory(req.playerId);
    } else {
      inv = loadInventory(req.playerId);
    }

    const progress = computeProgress(inv, canon);
    return res.json({ ...inv, progress });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});


// OPEN PACK (adds guarantee token consumption + one new item if available)
app.post('/api/packs/open', async (req, res) => {
  try {
    const { packId, idempotencyKey } = req.body || {};
    if (!packId || !idempotencyKey) {
      return res.status(400).json({ error:'packId and idempotencyKey are required' });
    }

    const key = String(idempotencyKey);
    const requestHash = hashRequest({ packId });
    if (state.idempo.has(key)) {
      const entry = state.idempo.get(key);
      if (entry.requestHash !== requestHash) {
        return res.status(409).json({ error:'idempotency key reused with different request' });
      }
      return res.json(entry.response);
    }

    const pack = db.packs.find(p => p.id === packId);
    if (!pack) return res.status(400).json({ error:'Unknown packId' });

    let inv;
    if (isUUID(req.playerId)) {
      inv = await dbGetInventory(req.playerId);
      if ((inv?.balance?.COIN || 0) < pack.price.amount) {
        return res.status(402).json({ error:'Insufficient funds' });
      }
      await dbDebitBalance(req.playerId, pack.price.amount);
    } else {
      inv = loadInventory(req.playerId);
      if ((inv.balance.COIN || 0) < pack.price.amount) {
        return res.status(402).json({ error:'Insufficient funds' });
      }
      inv.balance.COIN -= pack.price.amount;
      saveInventory(req.playerId, inv);
    }

    const table   = db.dropTables.find(t => t.id === pack.tableId);
    const pullsN  = 5;
    const results = [];
    const openingSeenIds = new Set();

    // --- NEW: consume a guarantee token (if any)
    let guarantee = false;
    if (isUUID(req.playerId)) {
      const sb = requireAdmin();
      const { data: used, error: gErr } = await sb.rpc('consume_guarantee_token', { p_owner: req.playerId });
      if (gErr) console.warn('consume_guarantee_token failed:', gErr.message);
      guarantee = !!used;
    }

    // helper sets
    const ownedIds = new Set((inv.items || []).map(x => x.itemId));

    function pickAnyByRarity(rarity, excludeIds) {
      const pool  = db.items.filter(i => i.rarity === rarity && !excludeIds.has(i.id));
      if (pool.length === 0) return null;
      return pool[Math.floor(Math.random() * pool.length)];
    }

    function pickNewItemPreferRarity(rarity, excludeIds) {
      // try chosen rarity first
      const poolR = db.items.filter(i => i.rarity === rarity && !ownedIds.has(i.id) && !excludeIds.has(i.id));
      if (poolR.length > 0) return poolR[Math.floor(Math.random() * poolR.length)];
      // broaden to any rarity but still new
      const poolAll = db.items.filter(i => !ownedIds.has(i.id) && !excludeIds.has(i.id));
      if (poolAll.length === 0) return null;
      return poolAll[Math.floor(Math.random() * poolAll.length)];
    }

    function pickItemForRarity(rarity){
      const pool  = db.items.filter(i => i.rarity === rarity);
      const fresh = pool.filter(i => !openingSeenIds.has(i.id));
      const list  = fresh.length ? fresh : pool;
      const picked = list[Math.floor(Math.random() * list.length)];
      openingSeenIds.add(picked.id);
      return picked;
    }

    for (let i = 0; i < pullsN; i++){
      const rarity = pickRarity(table);

      let item = null;
      if (guarantee) {
        item = pickNewItemPreferRarity(rarity, openingSeenIds);
        guarantee = false; // only one slot per open
      }
      if (!item) {
        item = pickAnyByRarity(rarity, openingSeenIds) || db.items.find(i => i.rarity === rarity);
      }
      if (!item) continue; // edge case: nothing available

      openingSeenIds.add(item.id);
      const isDupe = (inv.items || []).some(x => x.itemId === item.id);
      results.push({
        itemId: item.id,
        name:   item.name,
        rarity: item.rarity,
        artUrl: item.artUrl,
        kind:   item.kind,
        isDupe
      });
    }

    const openingId = 'op_' + nanoid(6);
    const response = {
      openingId,
      pack: { id: pack.id, name: pack.name, price: pack.price },
      results,
      economy: {
        balance: { COIN: (inv?.balance?.COIN || 0) - pack.price.amount },
        dupeCredit: { COIN: 0 }
      },
      pity: { legendarySince: state.pity.legendarySince }
      // (optional in future) guaranteeApplied: originally consumed above
    };

    if (isUUID(req.playerId)) {
      await dbSetPendingOpen(req.playerId, {
        packId,
        idempotencyKey: key,
        openedAt: Date.now(),
        results
      });
    } else {
      if (!state.pendingOpens.has(req.playerId)) {
        state.pendingOpens.set(req.playerId, {
          packId, idempotencyKey: key, openedAt: Date.now(), results
        });
      }
    }

    state.idempo.set(key, { requestHash, response });
    return res.json(response);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// ADD TO COLLECTION (consume pending → inventory)
app.post('/api/collection/add', async (req, res) => {
  try {
    const { itemIds = [] } = req.body || {};
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({ error: 'No itemIds provided.' });
    }

    let pending;
    if (isUUID(req.playerId)) {
      pending = await dbGetPendingOpen(req.playerId);
    } else {
      pending = state.pendingOpens.get(req.playerId);
    }
    if (!pending?.results?.length) {
      return res.status(400).json({ error: 'No pending items to collect.' });
    }

    const allowed  = new Set(pending.results.map(it => it.itemId));
    const toAddIds = itemIds.filter(id => allowed.has(id));
    if (!toAddIds.length) {
      return res.status(400).json({ error: 'No matching pending items.' });
    }

    const mapById = new Map(pending.results.map(it => [it.itemId, it]));
    const itemsToAdd = toAddIds.map(id => mapById.get(id)).filter(Boolean);

    if (isUUID(req.playerId)) {
      // Map pending items → RPC payload (one call handles dupes via qty)
      const payloadItems = itemsToAdd.map(it => ({
        itemId: it.itemId,
        name:   it.name,
        rarity: it.rarity,
        artUrl: it.artUrl,
        qty:    1
      }));

        const sb = requireAdmin();
        const { data, error } = await sb.rpc('add_items_and_award_shards', {
          p_owner: req.playerId,
          p_items: payloadItems
        });
        if (error) throw error;
      await dbClearPendingOpen(req.playerId);
        
        let inv = await dbGetInventory(req.playerId);
        await materializeUnlocks(req.playerId, inv, canon);
        inv = await dbGetInventory(req.playerId);

      // Return updated inventory
      const inv = await dbGetInventory(req.playerId);
      return res.json({ ok: true, inventory: inv });
    } else {
      // anon fallback — just keep JSON file
      const inv = loadInventory(req.playerId);
      inv.items.push(...itemsToAdd);
      state.pendingOpens.delete(req.playerId);
      saveInventory(req.playerId, inv);
      return res.json({ ok: true, inventory: inv });
    }
  } catch (e) {
    console.error("collection/add error:", e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/* -------------------- DEV endpoints ---------------------------------- */
app.post('/api/dev/grant', async (req, res) => {
  try {
    const amount = Number(req.body?.amount ?? 1000);
    if (isNaN(amount)) return res.status(400).json({ error:'amount must be a number' });

    if (isUUID(req.playerId)) {
      const newBal = await dbIncBalance(req.playerId, amount);
      return res.json({ balance: { COIN: newBal } });
    } else {
      const inv = loadInventory(req.playerId);
      inv.balance.COIN += amount;
      saveInventory(req.playerId, inv);
      return res.json({ balance: inv.balance });
    }
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/dev/reset', async (req, res) => {
  const playerId = req.playerId || 'anon';
  try {
    if (isUUID(playerId)) {
      const sb = requireAdmin();
      await dbEnsureProfile(playerId);
      await sb.from('profiles').update({ coin_balance: 1000 }).eq('user_id', playerId);
      await sb.from('inventory_items').delete().eq('owner_id', playerId);
      await dbClearPendingOpen(playerId);
      const inv = await dbGetInventory(playerId);
      return res.json({ ok: true, playerId, inventory: inv });
    } else {
      const fresh = { balance: { COIN: 1000 }, items: [] };
      saveInventory(playerId, fresh);
      state.pendingOpens.delete(playerId);
      return res.json({ ok: true, playerId, inventory: fresh });
    }
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/* -------------------- Start ------------------------------------------ */
app.listen(PORT, ()=> console.log('Mock backend http://localhost:'+PORT));
