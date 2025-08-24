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
    .upsert({ id: userId }, { onConflict: 'id', ignoreDuplicates: true });
  if (upErr) throw upErr;
}

async function dbGetInventory(userId) {
  const sb = requireAdmin();
  await dbEnsureProfile(userId);

  const [{ data: prof, error: profErr }, { data: items, error: itemsErr }] = await Promise.all([
    sb.from('profiles')
      .select('coin_balance')
      .eq('id', userId)
      .maybeSingle(),
    sb.from('inventory_items')
      .select('item_id, name, rarity, art_url, created_at')
      .eq('owner_id', userId)
      .order('created_at', { ascending: true })
  ]);

  if (profErr)  throw profErr;
  if (itemsErr) throw itemsErr;

  return {
    balance: { COIN: prof?.coin_balance ?? 0 },
    items: (items || []).map(it => ({
      itemId: it.item_id,
      name:   it.name,
      rarity: it.rarity,
      artUrl: it.art_url
    }))
  };
}

async function dbIncBalance(userId, delta) {
  const sb = requireAdmin();
  // Try RPC if present
  const { data, error } = await sb.rpc('inc_balance', { p_user: userId, p_delta: delta });
  if (!error) return data;

  // Fallback
  const { data: prof, error: selErr } = await sb
    .from('profiles').select('coin_balance').eq('id', userId).maybeSingle();
  if (selErr) throw selErr;
  const next = (prof?.coin_balance ?? 0) + delta;
  const { error: updErr } = await sb
    .from('profiles').update({ coin_balance: next }).eq('id', userId);
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
  const rows = items.map(it => ({
    owner_id: userId,
    item_id:  it.itemId,
    name:     it.name,
    rarity:   it.rarity,
    art_url:  it.artUrl ?? null
  }));
  const { error } = await sb.from('inventory_items').insert(rows);
  if (error) throw error;
}

// Pending opens stored per user (one active at a time)
async function dbSetPendingOpen(userId, payload) {
  const sb = requireAdmin();
  const { error } = await sb
    .from('pending_opens')
    .upsert({ owner_id: userId, data: payload }, { onConflict: 'owner_id' });
  if (error) throw error;
}
async function dbGetPendingOpen(userId) {
  const sb = requireAdmin();
  const { data, error } = await sb
    .from('pending_opens')
    .select('data')
    .eq('owner_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data?.data || null;
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
// 1) Are the env vars visible on the server?
app.get('/api/debug/env', (_req, res) => {
  res.json({
    node: process.version,
    has_SUPABASE_URL:        !!SUPABASE_URL,
    has_SUPABASE_SERVICE_ROLE: !!SUPA_SERVICE_ROLE,
    has_SUPABASE_JWT_SECRET: !!SUPABASE_JWT_SECRET,
    // lengths only; never echo secrets
    SUPABASE_URL_len:        SUPABASE_URL ? SUPABASE_URL.length : 0,
    SERVICE_ROLE_len:        SUPA_SERVICE_ROLE ? SUPA_SERVICE_ROLE.length : 0,
    jwt_secret_len:          SUPABASE_JWT_SECRET ? SUPABASE_JWT_SECRET.length : 0
  });
});

// 2) Can we talk to Supabase and see the tables?
app.get('/api/debug/db', async (_req, res) => {
  try {
    const sb = requireAdmin();
    const [p, i, po] = await Promise.all([
      sb.from('profiles').select('id, coin_balance').limit(1),
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

// (kept) 3) Who am I?
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

// Inventory (per-user; Supabase for authed UUID; JSON for anon)
app.get('/api/inventory', async (req, res) => {
  try {
    if (isUUID(req.playerId)) {
      const inv = await dbGetInventory(req.playerId);
      return res.json(inv);
    } else {
      const inv = loadInventory(req.playerId);
      return res.json(inv);
    }
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// OPEN PACK (unchanged flow; DB vs anon branch)
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
      const item   = pickItemForRarity(rarity);
      const isDupe = (inv.items || []).some(x => x.itemId === item.id);
      results.push({
        itemId: item.id,
        name:   item.name,
        rarity: item.rarity,
        artUrl: item.artUrl,
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
    const itemsToAdd = toAddIds
      .map(id => mapById.get(id))
      .filter(Boolean)
      .map(it => ({
        itemId: it.itemId,
        name:   it.name,
        rarity: it.rarity,
        artUrl: it.artUrl
      }));

    if (isUUID(req.playerId)) {
      await dbAddInventoryItems(req.playerId, itemsToAdd);
      await dbClearPendingOpen(req.playerId);
      const inv = await dbGetInventory(req.playerId);
      return res.json({ ok: true, inventory: inv });
    } else {
      const inv = loadInventory(req.playerId);
      inv.items.push(...itemsToAdd);
      state.pendingOpens.delete(req.playerId);
      saveInventory(req.playerId, inv);
      return res.json({ ok: true, inventory: inv });
    }
  } catch (e) {
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
      await sb.from('profiles').update({ coin_balance: 1000 }).eq('id', playerId);
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
