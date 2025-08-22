import express from 'express';
import cors from 'cors';
import { nanoid } from 'nanoid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 5179;

app.use(express.json());
app.use(cors({
  origin: true,
  credentials: false,
  allowedHeaders: ['Content-Type', 'X-Player-Id']
}));

// Identify the player (for now, header or fall back to 'anon')
app.use((req, _res, next) => {
  req.playerId = req.get('X-Player-Id') || 'anon';
  next();
});

// -------- Data + state --------------------------------------------------
const DB_PATH = path.join(__dirname, 'data', 'drop-tables.json');
const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));

// Global state (keep pity & idempotency global for now)
const state = {
  balance: { COIN: 9000 },   // legacy (not used after we switch to per-user)
  inventory: [],             // legacy (stop using for per-user flows)
  pity: { legendarySince: 0 },
  idempo: new Map(),
  pendingOpens: new Map()    // playerId -> { results:[...], packId, idempotencyKey, openedAt }
};

// Per-user storage
const USERS_DIR = path.join(__dirname, 'data', 'users');
if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR, { recursive: true });

function userFile(playerId) {
  return path.join(USERS_DIR, `${playerId}.json`);
}
function loadInventory(playerId) {
  const f = userFile(playerId);
  if (!fs.existsSync(f)) {
    const fresh = { balance: { COIN: 1000 }, items: [] }; // seed for testing
    fs.writeFileSync(f, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function saveInventory(playerId, inv) {
  fs.writeFileSync(userFile(playerId), JSON.stringify(inv, null, 2));
}

// -------- Helpers -------------------------------------------------------
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

// -------- Routes --------------------------------------------------------

// Packs list
app.get('/api/packs', (req, res) => {
  res.json({ packs: db.packs });
});

// Inventory (per-user)
app.get('/api/inventory', (req, res) => {
  const inv = loadInventory(req.playerId);
  res.json({ balance: inv.balance, items: inv.items });
});

// OPEN PACK
app.post('/api/packs/open', (req, res)=>{
  const { packId, idempotencyKey } = req.body || {};
  if (!packId || !idempotencyKey) {
    return res.status(400).json({ error:'packId and idempotencyKey are required' });
  }

  // Idempotency
  const key = String(idempotencyKey);
  const requestHash = hashRequest({ packId });
  if (state.idempo.has(key)) {
    const entry = state.idempo.get(key);
    if (entry.requestHash !== requestHash) {
      return res.status(409).json({ error:'idempotency key reused with different request' });
    }
    return res.json(entry.response);
  }

  // Intercept final JSON to stash "pending open" for this player
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    try {
      const results = body && body.results;
      if (Array.isArray(results) && results.length) {
        // Guard: don't overwrite existing pending if the user hasn't collected yet
        if (!state.pendingOpens.has(req.playerId)) {
          state.pendingOpens.set(req.playerId, {
            packId,
            idempotencyKey: key,
            openedAt: Date.now(),
            results   // array of items as returned below
          });
        }
      }
    } catch {}
    return originalJson(body);
  };

  // Validate pack & funds (per-user)
  const pack = db.packs.find(p=>p.id===packId);
  if (!pack) return res.status(400).json({ error:'Unknown packId' });

  const inv = loadInventory(req.playerId);
  if ((inv.balance.COIN || 0) < pack.price.amount) {
    return res.status(402).json({ error:'Insufficient funds' });
  }

  // Charge once per pack
  inv.balance.COIN -= pack.price.amount;
  saveInventory(req.playerId, inv);

  // Generate 5 pulls (dupe detection vs this user's inventory)
  const table  = db.dropTables.find(t=>t.id===pack.tableId);
  const pullsN = 5;
  const results = [];

  // Avoid repeats *within this opening*
  const openingSeenIds = new Set();

  function pickItemForRarity(rarity){
    const pool = db.items.filter(i=>i.rarity === rarity);
    const fresh = pool.filter(i=>!openingSeenIds.has(i.id));
    const list  = fresh.length ? fresh : pool;
    const picked = list[Math.floor(Math.random()*list.length)];
    openingSeenIds.add(picked.id);
    return picked;
  }

  for (let i=0; i<pullsN; i++){
    const rarity = pickRarity(table);
    const item   = pickItemForRarity(rarity);
    const isDupe = inv.items.some(x=>x.itemId === item.id);

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
      balance: inv.balance,
      dupeCredit: { COIN: 0 } // (optional) compute/credit later on /collection/add if you want
    },
    pity: { legendarySince: state.pity.legendarySince }
  };

  state.idempo.set(key, { requestHash, response });
  res.json(response);
});

// ADD TO COLLECTION (consume pending results)
app.post('/api/collection/add', (req, res) => {
  const { itemIds = [] } = req.body || {};
  const pending = state.pendingOpens.get(req.playerId); // { results:[...] } or undefined
  if (!pending || !Array.isArray(pending.results) || !pending.results.length) {
    return res.status(400).json({ error: 'No pending items to collect.' });
  }
  const allowed = new Set(pending.results.map(it => it.itemId));
  const toAddIds = itemIds.filter(id => allowed.has(id));
  if (!toAddIds.length) {
    return res.status(400).json({ error: 'No matching pending items.' });
  }

  const inv = loadInventory(req.playerId);
  const byId = new Map(pending.results.map(it => [it.itemId, it]));

  // Move allowed items into inventory (allowing duplicates for now)
  toAddIds.forEach(id => {
    const it = byId.get(id);
    if (it) {
      inv.items.push({
        itemId: it.itemId,
        name:   it.name,
        rarity: it.rarity,
        artUrl: it.artUrl
      });
    }
  });

  // Clear pending once collected (even if partial)
  state.pendingOpens.delete(req.playerId);

  saveInventory(req.playerId, inv);
  res.json({ ok: true, inventory: inv });
});

// --- DEV endpoints (per-user) ------------------------------------------
app.post('/api/dev/grant', (req, res) => {
  const amount = Number(req.body?.amount ?? 1000);
  const inv = loadInventory(req.playerId);
  inv.balance.COIN += isNaN(amount) ? 0 : amount;
  saveInventory(req.playerId, inv);
  res.json({ balance: inv.balance });
});

// DEV: reset THIS player's data (balance, items, pending)
app.post('/api/dev/reset', (req, res) => {
  const playerId = req.playerId || 'anon';

  const fresh = { balance: { COIN: 1000 }, items: [] };
  saveInventory(playerId, fresh);

  // clear any pending results for this player
  state.pendingOpens.delete(playerId);

  res.json({ ok: true, playerId, inventory: fresh });
});

// -----------------------------------------------------------------------
app.listen(PORT, ()=> console.log('Mock backend http://localhost:'+PORT));
