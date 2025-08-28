// scripts/flatten.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const CANON_DIR = path.join(__dirname, '..', 'data', 'canon');
const OUT_PATH  = path.join(__dirname, '..', 'data', 'drop-tables.json');

function loadJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function safe(val, fallback=null){ return val ?? fallback; }

function pushUnique(arr, seen, item) {
  if (seen.has(item.id)) return;
  seen.add(item.id);
  arr.push(item);
}

function main() {
  // 1) Load canon
  const eps        = loadJSON(path.join(CANON_DIR, 'eps.json'));
  const fragments  = loadJSON(path.join(CANON_DIR, 'fragments.json'));
  const unreleased = loadJSON(path.join(CANON_DIR, 'unreleased.json'));
  const characters = loadJSON(path.join(CANON_DIR, 'characters.json'));

  // 2) Build flat items
  const items = [];
  const seen  = new Set();

  // EPs
  for (const ep of eps.eps || []) {
    // stems
    for (const song of ep.songs || []) {
      for (const st of song.stems || []) {
        pushUnique(items, seen, {
          id: st.id,
          name: st.name,
          rarity: st.rarity || 'common',
          kind: 'stem',
          artUrl: null
        });
      }
    }
    // cover (packable rare)
    if (ep.cover) {
      pushUnique(items, seen, {
        id: ep.cover.id,
        name: ep.cover.name,
        rarity: ep.cover.rarity || 'rare',
        kind: 'cover',
        artUrl: safe(ep.cover.image, null)
      });
    }
  }

  // Singles in eps.json (if present)
  for (const s of eps.singles || []) {
    for (const st of s.song?.stems || []) {
      pushUnique(items, seen, {
        id: st.id,
        name: st.name,
        rarity: st.rarity || 'common',
        kind: 'stem',
        artUrl: null
      });
    }
    if (s.cover) {
      pushUnique(items, seen, {
        id: s.cover.id,
        name: s.cover.name,
        rarity: s.cover.rarity || 'rare',
        kind: 'cover',
        artUrl: safe(s.cover.image, null)
      });
    }
  }

  // Fragments (packable common)
  for (const ch of fragments.characters || []) {
    for (const f of ch.fragments || []) {
      pushUnique(items, seen, {
        id: f.id,
        name: f.name,
        rarity: f.rarity || 'common',
        kind: 'fragment',
        artUrl: null
      });
    }
  }

    // Unreleased (packable epic)
    // BEFORE: for (const u of unreleased.items || []) {
    for (const u of unreleased.unreleased || []) {
      pushUnique(items, seen, {
        id: u.id, name: u.name, rarity: u.rarity || 'epic',
        kind: 'unreleased', artUrl: u.image ?? null
      });
    }

    // Golden characters (packable legendary)
    // BEFORE: for (const g of characters.items || []) {
    for (const g of characters.goldenCharacters || []) {
      pushUnique(items, seen, {
        id: g.id, name: g.name, rarity: g.rarity || 'legendary',
        kind: 'character', artUrl: g.image ?? null
      });
    }


  // 3) Merge into existing drop-tables.json (keep packs/dropTables)
  const existing = loadJSON(OUT_PATH);
  const next = {
    ...existing,
    items
  };
    
    const byKind = items.reduce((m,it)=> (m[it.kind]=(m[it.kind]||0)+1, m), {});
    console.log('[flatten] counts:', byKind);


  fs.writeFileSync(OUT_PATH, JSON.stringify(next, null, 2));
  console.log(`[flatten] wrote ${items.length} items to ${OUT_PATH}`);
}

main();
