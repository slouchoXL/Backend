import express from 'express';
import cors from 'cors';
import { nanoid } from 'nanoid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5179;
app.use(cors());
app.use(express.json());

const db = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'drop-tables.json')));
const state = {
  balance: { COIN: 9000 },
  inventory: [],
  pity: { legendarySince: 0 },
  idempo: new Map()
};

function pickRarity(table){
  const pityRow = table.rows.find(r => r.rarity === 'legendary' && r.pityEvery);
  if (pityRow && state.pity.legendarySince + 1 >= pityRow.pityEvery) {
    state.pity.legendarySince = 0;
    return 'legendary';
  }
  const total = table.rows.reduce((s,r)=>s+r.weight,0);
  const roll = Math.random() * total;
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

function hashRequest(body){ return JSON.stringify(body); }

app.post('/api/packs/open', (req, res)=>{
  const { packId, idempotencyKey } = req.body || {};
  if (!packId || !idempotencyKey) {
    return res.status(400).json({ error:'packId and idempotencyKey are required' });
  }

  // ----- Idempotency -----
  const key = String(idempotencyKey);
  const requestHash = hashRequest({ packId });
  if (state.idempo.has(key)) {
    const entry = state.idempo.get(key);
    if (entry.requestHash !== requestHash) {
      return res.status(409).json({ error:'idempotency key reused with different request' });
    }
    return res.json(entry.response);
  }

  // ----- Pack & funds -----
  const pack = db.packs.find(p=>p.id===packId);
  if (!pack) return res.status(400).json({ error:'Unknown packId' });
  if ((state.balance.COIN||0) < pack.price.amount) {
    return res.status(402).json({ error:'Insufficient funds' });
  }

  // charge once per pack
  state.balance.COIN -= pack.price.amount;

  const table   = db.dropTables.find(t=>t.id===pack.tableId);
  const pullsN  = 5; // fixed 5 cards per pack (per our spec)
  const results = [];
  let dupeCoins = 0;

  // To reduce repeats *within the same pack*, remember what we just pulled
  const openingSeenIds = new Set();

  // Helper: pick an item for a given rarity trying to avoid repeats in this opening
  function pickItemForRarity(rarity){
    const pool = db.items.filter(i=>i.rarity === rarity);
    // Prefer items not seen in this opening
    const fresh = pool.filter(i=>!openingSeenIds.has(i.id));
    const list = fresh.length ? fresh : pool;
    const picked = list[Math.floor(Math.random()*list.length)];
    openingSeenIds.add(picked.id);
    return picked;
  }

  // ----- Generate 5 pulls -----
  for (let i=0; i<pullsN; i++){
    const rarity = pickRarity(table);           // updates pity counters inside
    const item   = pickItemForRarity(rarity);

    const isDupe = state.inventory.some(x=>x.itemId === item.id);
    if (!isDupe) {
      state.inventory.push({
        itemId: item.id,
        name:   item.name,
        rarity: item.rarity,
        artUrl: item.artUrl
      });
    } else {
      dupeCoins += 10; // our dupe rule
    }

    results.push({
      itemId: item.id,
      name:   item.name,
      rarity: item.rarity,
      artUrl: item.artUrl,
      isDupe
    });
  }

  // credit dupe coins once, after the 5 pulls
  if (dupeCoins > 0) state.balance.COIN += dupeCoins;

  const openingId = 'op_' + nanoid(6);
  const response = {
    openingId,
    pack: { id: pack.id, name: pack.name, price: pack.price },
    results,
    economy: {
      balance: state.balance,
      dupeCredit: { COIN: dupeCoins }
    },
    pity: { legendarySince: state.pity.legendarySince }
  };

  // remember response for idempotency
  state.idempo.set(key, { requestHash, response });
  res.json(response);
});

// --- DEV endpoints (testing only) ---
app.post('/api/dev/grant', (req, res) => {
  const amount = Number(req.body?.amount ?? 1000);
  state.balance.COIN += isNaN(amount) ? 0 : amount;
  res.json({ balance: state.balance });
});

app.post('/api/dev/reset', (req, res) => {
  state.balance = { COIN: 1000 };
  state.inventory = [];
  state.pity = { legendarySince: 0 };
  state.idempo = new Map();
  res.json({ ok: true, balance: state.balance, inventory: state.inventory, pity: state.pity });
});
app.get('/api/packs', (req, res) => {
  res.json({ packs: db.packs });
});

app.get('/api/inventory', (req, res) => {
  res.json({ balance: state.balance, items: state.inventory });
});
app.listen(PORT, ()=> console.log('Mock backend http://localhost:'+PORT));
