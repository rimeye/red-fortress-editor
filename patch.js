/* ============================================================================
   Jackal level editor — ROM patcher (level repack + lives + boss HP)
   Depends on JackalROM (rom.js).

   NOTE on mapper 2 (UNROM): the LAST 16KB PRG bank is hard-wired to
   $C000-$FFFF (the "fixed" bank holding all game code). So when we need
   more banks for level data we must INSERT them *before* the original
   fixed bank (bank 7) and move bank 7 to the end. All absolute ROM
   offsets inside the fixed bank therefore shift by (newBanks * 16KB).
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rom.js'));
  else root.JackalPatch = factory(root.JackalROM);
})(typeof self !== 'undefined' ? self : this, function (J) {
  'use strict';

  const GROUP_A = [0, 1, 3, 4];
  const GROUP_B = [2, 5];

  const FIXED_BANK_ROM = 0x1C010;
  const FIXED_BANK_END = 0x20010;
  const BANK_SWITCH_FIX_OFF = 0x1C3C9;
  const BANK_SWITCH_FIX = [0x98, 0xEA, 0xEA, 0x8D, 0x00, 0x80, 0x8D, 0x00, 0x80, 0x60];
  const SPAWN_BANK_SITES = [0x1DC2C, 0x1DD1A];
  // After the level-load / per-frame spawn check (JSR Label978 @$F081), the game
  // jumps straight into the sprite-processing loop (JMP $DD9C) while the SPAWN
  // bank is still active. In the original, spawn bank === bank 6 === AI bank, so
  // this was harmless. After relocating spawn tables to a new bank, the AI
  // dispatch (subExecuteCodeViaIndirectJump at $CAB1) would jump to bank-6 AI
  // code while the spawn bank is mapped at $8000 -> crash. Fix: redirect that
  // JMP through a tiny helper in fixed-bank free space that switches back to
  // bank 6 (the AI/sprite bank) before entering the sprite loop.
  const SPAWN_LEAK_JMP_OFF = 0x1DC33;            // JMP $DD9C after JSR $F081
  const SPAWN_LEAK_JMP_FIX = [0x4C, 0xD1, 0xFD]; // JMP $FDD1
  const HELPER1_OFF = 0x1FDE1;                   // fixed-bank free space (0xFF)
  const HELPER1 = [0xA0, 0x06, 0x20, 0xB5, 0xC3, 0x4C, 0x9C, 0xDD]; // LDY #6; JSR $C3B5; JMP $DD9C
  // The second spawn-check caller (per-frame level update) JSRs Label978 and then
  // keeps running AI/jeep code, but the spawn bank is still mapped. Original spawn
  // bank === 6 === AI bank so it was fine; after repack it is NOT. Route that JSR
  // through a helper that switches back to bank 6 before returning.
  const CALLER2_JSR_OFF = 0x1DD1E;                // JSR $F081 (Label978) in caller #2
  const CALLER2_JSR_FIX = [0x20, 0xD9, 0xFD];     // JSR $FDD9 (HELPER2)
  const HELPER2_OFF = 0x1FDE9;                    // 9 bytes of free space after HELPER1
  const HELPER2 = [0x20, 0x81, 0xF0, 0xA0, 0x06, 0x20, 0xB5, 0xC3, 0x60]; // JSR $F081; LDY #6; JSR $C3B5; RTS
  // Per-level spawn bank routing. With 6 levels the spawn tables can exceed one
  // 16KB bank (≈36KB -> 3 banks), so the game must select the spawn bank per
  // level instead of the hardcoded "LDY #$06". We add a 6-entry table in
  // fixed-bank free space and route the two spawn-bank loads through a helper
  // that does: LDX CurrentLevel; LDY tblSpawnBank,X; JSR $C3B5; RTS.
  const TBL_SPAWN_BANK_OFF = 0x1FFB4;               // 6-byte per-level spawn bank table (CPU $FFA4)
  const HELPER3_OFF = 0x1FFBA;                      // spawn-bank helper (CPU $FFAA)
  const HELPER3 = [0xA6, 0x30, 0xBC, 0xA4, 0xFF, 0x20, 0xB5, 0xC3, 0x60]; // LDX $30; LDY $FFA4,X; JSR $C3B5; RTS

  const SPAWN_BANK_LOAD_SITES = [0x1DC2B, 0x1DD19]; // "LDY #$06; JSR $C3B5" (5 bytes each)
  const SPAWN_BANK_LOAD_FIX = [0x20, 0xAA, 0xFF, 0xEA, 0xEA]; // JSR $FFAA; NOP; NOP
  // L6 laser turret: extend spawn position table from 2 to 8 entries.
  // Original tables (2 bytes each) are too small; relocate to bank6 free space
  // and repoint the two "LDA tbl...Y" operands so up to 8 turrets spawn correctly.
  const L6_TURRET_TABLE_OFF = 0x1BF87;              // bank6 free space (137 bytes)
  const L6_TURRET_LB_LDA_OP = 0x1B694;              // operand of LDA $B6AE,Y
  const L6_TURRET_UB_LDA_OP = 0x1B69A;              // operand of LDA $B6B0,Y
  const L6_TURRET_POS_LB = [0xD2, 0x2E, 0x40, 0x80, 0xC0, 0x00, 0x40, 0x80];
  const L6_TURRET_POS_UB = [0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01];
  // LDA operands that read each boss spawn position table (LB/UB/V).
  const POS_TABLES = [
    { id: 'l2boss', tables: [
      { kind: 'LB', lda: 0x18FEB },
      { kind: 'UB', lda: 0x18FF1 },
    ] },
    { id: 'l3boss', tables: [
      { kind: 'LB', lda: 0x197B8 },
      { kind: 'UB', lda: 0x197BE },
      { kind: 'V',  lda: 0x197C4 },
    ] },
    { id: 'l5door', tables: [
      { kind: 'LB', lda: 0x1AF4C },   // af3b: LDA $af75,Y → 操作数 0x1AF4C
      { kind: 'UB', lda: 0x1AF52 },   // af41: LDA $af79,Y → 操作数 0x1AF52（原来写成 0x1AF51 = opcode，写盘会砸掉指令）
    ] },
    { id: 'l6turret', tables: [
      { kind: 'LB', lda: 0x1B694 },
      { kind: 'UB', lda: 0x1B69A },
    ] },
  ];
  const POS_ENTRIES = J.POS_MAX;                           // positions per boss
  // 原版表长度（反汇编实测，与 BOSS_COUNT 默认值一致）：
  //   l2boss $900A/$900E ×4、l3boss $97EA/$97F0/$97F6 ×6、
  //   l5door $AF75/$AF79 ×4、l6turret $B6AE/$B6B0 ×2
  const POS_VANILLA_COUNT = { l2boss: 4, l3boss: 6, l5door: 4, l6turret: 2 };
  const POS_TABLE_BASE = 0x1FDF2;                   // fixed-bank free space (after HELPER2)

  // Sprite runtime parameter extension.  The original game reads the common
  // health table at two fixed-bank sites.  Per-level overrides are stored in
  // a small dedicated data bank and the fixed-bank helper resolves them at
  // object initialization time, falling back to the native table when the
  // entry is zero.
  const SPRITE_PARAM_META_OFF = 0x1FFC4;             // after HELPER3
  const SPRITE_PARAM_HELPER_OFF = 0x1FFC9;
  const SPRITE_PARAM_MAGIC = [0x4A, 0x53, 0x50, 0x31]; // "JSP1"
  const SPRITE_PARAM_DATA_OFFSET = 0x80;             // keep bank-switch header clear
  const SPRITE_PARAM_DATA_SIZE = SPRITE_PARAM_DATA_OFFSET + 6 * 0x80;
  const SPRITE_PARAM_HOOK_SITES = J.SPRITE_RUNTIME_PARAMS.health.hookSites;

  function buildSpriteHealthHelper(paramBank) {
    const code = [
      0x84, 0xF6,                   // STY $F6 (object type; restore Y before RTS)
      0xB9, 0x42, 0xFA,             // LDA $FA42,Y (native health)
      0x48,                         // PHA (native value)
      0xA5, 0x30, 0x18, 0x69, 0x80, 0x85, 0xF9, // ptr high = $80 + current level
      0xA9, 0x00, 0x85, 0xF8,       // ptr low = 0
      0xA0, paramBank, 0x20, 0xB5, 0xC3, // switch to parameter bank
      0xA4, 0xF6, 0xB1, 0xF8,       // LDA ($F8),Y
      0xF0, 0x00,                   // BEQ fallback (offset filled below)
      0x38, 0xE9, 0x01, 0x29, 0x7F, // decode health+1
      0x85, 0xF7,
      0x68,                         // native value
      0x29, 0x80, 0x05, 0xF7,       // preserve native boss flag
      0x48,                         // save resolved value while restoring bank
      0xA0, 0x06, 0x20, 0xB5, 0xC3,
      0xA4, 0xF6, 0x68, 0x60,       // restore object type in Y, return resolved value
    ];
    const branch = code.indexOf(0xF0) + 1;
    const fallback = code.length;
    code[branch] = fallback - (branch + 1);
    code.push(
      0x68,                         // native value
      0x48,                         // preserve it while restoring bank
      0xA0, 0x06, 0x20, 0xB5, 0xC3,
      0xA4, 0xF6, 0x68, 0x60,
    );
    return code;
  }

  function spriteParamOverridesPresent(edit) {
    const levels = edit && edit.spriteParams && edit.spriteParams.levels;
    if (!Array.isArray(levels)) return false;
    return levels.some(levelMap => levelMap && Object.values(levelMap).some(v => v && v.health != null));
  }

  function buildSpriteParamData(edit) {
    const out = new Uint8Array(SPRITE_PARAM_DATA_SIZE);
    for (let k = 0; k < 8; k++) out[k] = k;
    const levels = edit.spriteParams.levels || [];
    for (let l = 0; l < 6; l++) {
      const map = levels[l] || {};
      for (const key of Object.keys(map)) {
        const type = Number(key);
        const value = map[key] && map[key].health;
        if (!Number.isInteger(type) || type < 0 || type >= 0x80 || value == null) continue;
        out[SPRITE_PARAM_DATA_OFFSET + l * 0x80 + type] = clamp(value, 0, 127) + 1;
      }
    }
    return out;
  }

  function readSpriteParams(rom, fix) {
    const global = {};
    for (let type = 0; type < 0x80; type++) {
      global[type] = { health: rom[fix(J.ENEMY_HEALTH_BASE + type)] & 0x7F };
    }
    const levels = Array.from({ length: 6 }, () => ({}));
    const meta = fix(SPRITE_PARAM_META_OFF);
    const hasMagic = SPRITE_PARAM_MAGIC.every((v, i) => rom[meta + i] === v);
    const paramBank = hasMagic ? rom[meta + 4] : 0xFF;
    if (hasMagic && paramBank < (rom[4] || 8)) {
      const base = J.PRG_BASE + paramBank * J.BANK_SIZE + SPRITE_PARAM_DATA_OFFSET;
      for (let l = 0; l < 6; l++) {
        for (let type = 0; type < 0x80; type++) {
          const encoded = rom[base + l * 0x80 + type];
          if (encoded) levels[l][type] = { health: encoded - 1 };
        }
      }
    }
    const defaults = { global: JSON.parse(JSON.stringify(global)) };
    return { global, levels, defaults, boss: {} };
  }

  function syncSpriteBossParams(edit) {
    if (!edit || !edit.spriteParams) return;
    edit.spriteParams.boss = {};
    for (const b of J.BOSS_HP) {
      edit.spriteParams.boss[b.id] = {
        health: edit.bossHp && edit.bossHp[b.id],
        count: edit.bossCount && edit.bossCount[b.id],
        pos: edit.bossPos && edit.bossPos[b.id]
          ? { x: edit.bossPos[b.id].x.slice(), y: edit.bossPos[b.id].y ? edit.bossPos[b.id].y.slice() : null }
          : null,
      };
    }
  }

  function clamp(v, lo, hi) { v = v | 0; if (isNaN(v)) v = lo; return Math.max(lo, Math.min(hi, v)); }

  function parseScreenList(rom, listBase) {
    const bytes = []; let i = listBase;
    while (true) {
      const y = rom[i]; bytes.push(y); i++;
      if (y === 0xEF) break;
      if (y === 0xF0 || y === 0xF1 || y === 0xF2) { bytes.push(rom[i]); i++; }
      else { bytes.push(rom[i]); bytes.push(rom[i + 1]); i += 2; }
      if (bytes.length > 512) break;
    }
    return bytes;
  }
  function parseSpawnTables(rom) {
    // Level data may live in the original bank 6 or in relocated banks after a
    // repack (extra screens). Screen counts and addresses are read from the
    // patched pointer tables so both vanilla and repacked ROMs load correctly.
    const totalBanks = rom[4] || 8;
    const shift = Math.max(0, totalBanks - 8) * J.BANK_SIZE;
    const fix = o => (o >= FIXED_BANK_ROM && o < FIXED_BANK_END ? o + shift : o);
    const read16 = o => rom[o] | (rom[o + 1] << 8);
    // Per-level spawn bank (repack writes a 6-entry table in fixed-bank free
    // space). Vanilla ROMs (<=8 banks) and legacy repacks without the table
    // fall back to the single immediate operand at the first spawn site.
    const spawnBankOf = l => {
      if (totalBanks > 8) {
        const v = rom[fix(TBL_SPAWN_BANK_OFF + l)];
        if (v !== 0xFF && v < totalBanks) return v;
      }
      return rom[fix(SPAWN_BANK_SITES[0])];
    };
    const out = [];
    for (let l = 0; l < 6; l++) {
      const idxA = read16(fix(J.PTR.screenLoadIndex + l * 2));
      const layoutA = read16(fix(J.PTR.layoutData + l * 2));
      const n = layoutA - idxA; // idx length == number of screens
      const spawnA = read16(fix(J.PTR.spawnAddress + l * 2));
      const sBase = J.bankRom(spawnBankOf(l), 0x8000);
      const spawns = [];
      for (let s = 0; s < n; s++) {
        const p = read16(sBase + (spawnA - 0x8000) + s * 2);
        if (p < 0x8000 || p >= 0xC000) spawns.push(null);
        else spawns.push(parseScreenList(rom, sBase + (p - 0x8000)));
      }
      out.push(spawns);
    }
    return out;
  }
  function serializeSpawnTable(spawns, baseAddr) {
    const n = spawns.length;
    const lists = spawns.map(s => (s && s.length ? s.slice() : [0xEF]));
    const headerLen = n * 2;
    const body = [];
    for (let s = 0; s < n; s++) body.push.apply(body, lists[s]);
    const table = new Uint8Array(headerLen + body.length);
    for (let s = 0; s < n; s++) {
      let off = headerLen; for (let k = 0; k < s; k++) off += lists[k].length;
      const abs = baseAddr + off;
      table[s * 2] = abs & 0xFF; table[s * 2 + 1] = (abs >> 8) & 0xFF;
    }
    for (let k = 0; k < body.length; k++) table[headerLen + k] = body[k];
    return table;
  }
  function serializeLevelData(e) {
    const idx = Uint8Array.from(e.idx);
    const layout = new Uint8Array(e.layoutBlocks.length * 128);
    for (let b = 0; b < e.layoutBlocks.length; b++)
      for (let k = 0; k < 128; k++) layout[b * 128 + k] = e.layoutBlocks[b][k];
    return { idx, layout, def: Uint8Array.from(e.def), pal: Uint8Array.from(e.pal) };
  }
  function sizeOf(d) { return d.idx.length + d.layout.length + d.def.length + d.pal.length; }
  function spawnSize(spawns) { return spawns.length * 2 + spawns.reduce((a, s) => a + (s && s.length ? s.length : 1), 0); }

  // 去重 layout 块（基于副本，不动底层 edit）。不同屏如果引用完全相同的块（例如
  // 加长后的大片空白屏共用同一空白块），去重后只保留一份，从而让单关能塞进 16KB
  // bank，支持加长到引擎滚动上限（129 屏）。游戏以 blockIndex*128 寻址，去重
  // 只改变屏幕指向哪个块索引，与 idx 重映射后的写回顺序一致，因此安全。
  function dedupeLevelCopy(e) {
    const idx = e.idx.slice();
    const layoutBlocks = [];
    const sigMap = new Map(), remap = new Map();
    for (let b = 0; b < e.layoutBlocks.length; b++) {
      const blk = e.layoutBlocks[b];
      if (!blk) { remap.set(b, -1); continue; }
      const sig = blk.join(',');
      if (sigMap.has(sig)) remap.set(b, sigMap.get(sig));
      else { sigMap.set(sig, layoutBlocks.length); remap.set(b, layoutBlocks.length); layoutBlocks.push(blk.slice()); }
    }
    for (let s = 0; s < idx.length; s++) {
      const nb = remap.get(idx[s]);
      if (nb != null && nb >= 0) idx[s] = nb;
    }
    return Object.assign({}, e, { idx, layoutBlocks });
  }

  function loadEditFromROM(rom) {
    // Reads level data via the pointer tables (0x1D004 etc.) and the layout
    // bank table. Vanilla ROMs use the original addresses; repacked ROMs
    // (extra screens) point into the relocated banks. Screen count = idx
    // length = layoutAddr - idxAddr; def/pal sizes come from adjacent pointers.
    const totalBanks = rom[4] || 8;
    const shift = Math.max(0, totalBanks - 8) * J.BANK_SIZE;
    const fix = o => (o >= FIXED_BANK_ROM && o < FIXED_BANK_END ? o + shift : o);
    const read16 = o => rom[o] | (rom[o + 1] << 8);
    const edit = { lives: rom[fix(J.LIVES_OFFSET)], copyrightLines: parseCopyrightLines(rom),
    bossHp: {}, bossCount: {}, bossPos: {}, bossCompanions: {}, bossCompanionWeaponReq: {}, spriteParams: readSpriteParams(rom, fix), levels: [], palettes: [] };
    for (const b of J.BOSS_HP) edit.bossHp[b.id] = rom[fix(b.offsets[0])] & 0x7F;
    for (const b of J.BOSS_COUNT) edit.bossCount[b.id] = b.fixed ? b.defaultValue : rom[b.offset];
    for (const b of (J.BOSS_COMPANIONS || [])) {
      const site = b.sites && b.sites[0];
      edit.bossCompanions[b.id] = site && rom[site.offset - 1] === site.opcode ? rom[site.offset] : b.defaultValue;
      const gate = b.weaponGate && b.weaponGate[0];
      edit.bossCompanionWeaponReq[b.id] = gate && rom[gate.offset - 1] === gate.opcode
        ? rom[gate.offset] : b.defaultWeaponLevel;
    }
    // Boss 出现位置表：必须从 ROM 真实读取（以前直接套用 uniformPos 默认值，
    // 导致刚载入 ROM 时编辑器显示的 boss 位置就是错的，保存后还会把原版位置写坏）。
    // 每个表由一条 LDA $addr,Y 指令读取；操作数即表的 CPU 地址：
    //   $8000-$BFFF → 与该 LDA 同 bank；$C000+ → 固定 bank（重打包后整体后移 shift）
    for (const id in J.BOSS_POS_DEFAULT) {
      const d = J.BOSS_POS_DEFAULT[id];
      const t = POS_TABLES.find(p => p.id === id);
      const vanillaN = POS_VANILLA_COUNT[id] || 0;
      const x = d.x.slice();
      const y = d.y ? d.y.slice() : null;
      if (t) {
        const readTable = (tb) => {
          const cpu = rom[tb.lda] | (rom[tb.lda + 1] << 8);
          let off, n;
          if (cpu >= 0xC000) {                       // 已被本工具重定位到固定 bank
            off = FIXED_BANK_ROM + shift + (cpu - 0xC000);
            n = POS_ENTRIES;
          } else {                                    // 原版表，在该 LDA 所在 bank 内
            const bank = Math.floor((tb.lda - J.PRG_BASE) / J.BANK_SIZE);
            off = J.PRG_BASE + bank * J.BANK_SIZE + (cpu - 0x8000);
            n = vanillaN;
          }
          if (off < 0 || off + n > rom.length || n <= 0) return null;
          return Array.from(rom.subarray(off, off + n));
        };
        const lb = t.tables.find(tb => tb.kind === 'LB');
        const ub = t.tables.find(tb => tb.kind === 'UB');
        const vv = t.tables.find(tb => tb.kind === 'V');
        const LB = lb ? readTable(lb) : null;
        const UB = ub ? readTable(ub) : null;
        const V  = vv ? readTable(vv) : null;
        if (LB) {
          const n = LB.length;
          for (let i = 0; i < POS_ENTRIES; i++) {
            const k = i < n ? i : (i % n);           // 超出原版长度就循环复用，加数量时不会出垃圾值
            x[i] = (LB[k] | ((UB && UB[k] != null ? UB[k] : 0) << 8)) & 0x1FF;
          }
        }
        if (y && V && V.length) {
          const n = V.length;
          for (let i = 0; i < POS_ENTRIES; i++) y[i] = V[i < n ? i : (i % n)] & 0xFF;
        }
      }
      edit.bossPos[id] = { x, y };
    }
    const spawns = parseSpawnTables(rom);
    for (let l = 0; l < 6; l++) {
      const idxA = read16(fix(J.PTR.screenLoadIndex + l * 2));
      const layoutA = read16(fix(J.PTR.layoutData + l * 2));
      const defA = read16(fix(J.PTR.def32x32 + l * 2));
      const palA = read16(fix(J.PTR.palette + l * 2));
      const bank = rom[fix(J.PTR.layoutBank + l)];
      const n = layoutA - idxA;                       // number of screens
      const layoutLen = (defA - layoutA);             // blocks * 128
      const defLen = palA - defA;                     // tiles * 16
      // pal covers the FULL tile range (common tiles 0..offset-1 are shared with
      // level 0), so its length is at least the level-specific tiles + offset.
      const palLen = Math.max(J.LEVELS[l].palLen, Math.round(defLen / 16) + J.TILE_OFFSET[l]);
      const base = J.bankRom(bank, 0x8000);
      const idx = Array.from(rom.subarray(base + (idxA - 0x8000), base + (idxA - 0x8000) + n));
      const layout = Array.from(rom.subarray(base + (layoutA - 0x8000), base + (layoutA - 0x8000) + layoutLen));
      const def = Array.from(rom.subarray(base + (defA - 0x8000), base + (defA - 0x8000) + defLen));
      const pal = Array.from(rom.subarray(base + (palA - 0x8000), base + (palA - 0x8000) + palLen));
      const layoutBlocks = [];
      for (let b = 0; b < layoutLen / 128; b++) layoutBlocks.push(layout.slice(b * 128, b * 128 + 128));
      edit.levels.push({ idx, layoutBlocks, def, pal, spawns: spawns[l] });
    }
    for (let l = 0; l < 6; l++) {
      const base = fix(J.LEVEL_PALETTE_BASE) + l * 0x23 + 2;
      edit.palettes.push(Array.from(rom.subarray(base, base + 32)));
    }
    syncSpriteBossParams(edit);
    return edit;
  }
  // ---------- 标题画面 credits（署名） ----------
  // credits 数据在 bank 0 $B387（CPU 地址），格式：
  // [20 xx PPU地址][文字 tiles][FE/FD 20 xx][文字]... [FF 结束]
  const TITLE_CREDITS_ROM = J.bankRom(0, J.TITLE_CREDITS_OFFSET);

  function parseTitleCredits(rom) {
    const rows = [];
    let p = TITLE_CREDITS_ROM;
    while (true) {
      const b = rom[p];
      if (b === 0xFF) break;
      const ppu = (b << 8) | rom[p + 1];
      p += 2;
      const tiles = [];
      while (true) {
        const t = rom[p];
        if (t === 0xFE || t === 0xFD || t === 0xFF) break;
        tiles.push(t); p++;
      }
      const sep = rom[p]; // FE / FD / FF
      rows.push({ ppu, text: tiles.map(J.TITLE_FONT.tileToChar).join(''), sep });
      if (sep === 0xFF) break;
      p++; // 跳过 FE/FD
    }
    return rows;
  }

  function serializeTitleCredits(rows) {
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      out.push(r.ppu >> 8, r.ppu & 0xFF);
      for (const ch of r.text) out.push(J.TITLE_FONT.charToTile(ch));
      const sep = (i < rows.length - 1) ? (r.sep === 0xFE ? 0xFE : 0xFD) : 0xFF;
      out.push(sep);
    }
    return out;
  }


  // ---------- 标题画面版权文字（最下方 4 行，bank 4） ----------
  // 4 行：每行由控制码(0x8d/0x98/0x8b/0x98)开头，文字 tile 到下一控制码
  const COPYRIGHT_LINES = [
    { ctrl: 0x8d, rom: 0x0 + 0, start: 0xB49D, len: 13 }, // © KONAMI 1988（PLAY SELECT 上方）
    { ctrl: 0x8d, rom: 0x0 + 0, start: 0xB4D2, len: 15 }, // TM AND ©1988
    { ctrl: 0x98, rom: 0x0 + 0, start: 0xB4E2, len: 26 }, // KONAMI INDUSTRY CO.,LTD.
    { ctrl: 0x8b, rom: 0x0 + 0, start: 0xB4FD, len: 13 }, // LICENSED BY
    { ctrl: 0x98, rom: 0x0 + 0, start: 0xB50B, len: 24 }, // NINTENDO OF AMERICA INC.
  ].map(l => ({ ...l, rom: J.bankRom(4, l.start) }));

  function copyTileToChar(x) {
    if (x === 0x00) return ' ';
    if (x >= 0x01 && x <= 0x0A) return String.fromCharCode(x - 0x01 + 48); // 0x01-0x0A = 数字 0-9（标题字体）
    if (x === 0x0B) return '©';
    if (x >= 0x11 && x <= 0x2A) return String.fromCharCode(x - 0x11 + 65);
    if (x === 0x0c) return ','; if (x === 0x0d) return '-'; if (x === 0x0e) return '.'; if (x === 0x0f) return "'"; if (x === 0x10) return '!';
    return '?';
  }
  function copyCharToTile(c) {
    const u = c.toUpperCase();
    if (u === ' ') return 0x00;
    if (u >= 'A' && u <= 'Z') return 0x11 + (u.charCodeAt(0) - 65);
    if (u >= '0' && u <= '9') return 0x01 + (u.charCodeAt(0) - 48); // 0-9 -> 0x01-0x0A（标题字体）
    if (u === ',') return 0x0C; if (u === '-') return 0x0D; if (u === '.') return 0x0E; if (u === "'") return 0x0F; if (u === '!') return 0x10;
    if (u === '©') return 0x0B;
    return 0x00;
  }
  // 解析 4 行版权文字
  function parseCopyrightLines(rom) {
    return COPYRIGHT_LINES.map(l => {
      let s = '';
      for (let i = 0; i < l.len; i++) s += copyTileToChar(rom[l.rom + i]);
      return s;
    });
  }
  // 写回 4 行版权文字（保留控制码，不足用空格填充行长度）
  function writeCopyrightLines(rom, lines) {
    for (let li = 0; li < 4; li++) {
      const l = COPYRIGHT_LINES[li];
      const text = (lines && lines[li] != null ? String(lines[li]) : '');
      for (let i = 0; i < l.len; i++) {
        rom[l.rom + i] = i < text.length ? copyCharToTile(text[i]) : 0x00;
      }
    }
  }

  // 战区缺失时从原版补齐（屏数一致才对齐；作者的有效战区不动）
  function ensureBossWarValid(baseEdit, edit){
    if(!baseEdit || !edit || !edit.levels) return;
    for(let l = 0; l < 6; l++){
      const e = edit.levels[l], b = baseEdit.levels[l];
      if(!e || !b || e.idx.length !== b.idx.length) continue;
      let boss = -1;
      for(let s = e.spawns.length - 1; s >= 0; s--){
        const L = e.spawns[s];
        if(L && L.indexOf(0xF0) >= 0){ boss = s; break; }
      }
      let valid = false;
      if(boss >= 0 && e.spawns[boss]){
        const list = e.spawns[boss];
        let i = 0;
        while(i < list.length){
          const y = list[i];
          if(y === 0xEF) break;
          if(y === 0xF0 || y === 0xF1 || y === 0xF2){ i += 2; continue; }
          valid = true; break;
        }
      }
      if(valid) continue;
      let bossB = -1;
      for(let s = b.spawns.length - 1; s >= 0; s--){
        const L = b.spawns[s];
        if(L && L.indexOf(0xF0) >= 0){ bossB = s; break; }
      }
      if(bossB < 0) continue;
      const screens = [bossB];
      if(l !== 1){ for(let s = bossB + 1; s < b.idx.length; s++) screens.push(s); }
      for(const s of screens){
        e.spawns[s] = b.spawns[s] ? b.spawns[s].slice() : null;
        e.layoutBlocks[e.idx[s]] = b.layoutBlocks[b.idx[s]].slice();
      }
    }
  }

  function buildPatchedROM(origRom, edit) {
    const read16 = (o) => origRom[o] | (origRom[o + 1] << 8);
    const fixIn = (o) => o; // 原版 ROM 无偏移
    syncSpriteBossParams(edit);
    // 原位写入优先：只要数据能塞进原版槽位（banks 4/5 关卡数据 + bank 6 spawn 区），
    // 就覆盖原地址写入，ROM 保持 8 bank。这样游戏里所有代码路径——无论走指针表
    // （0x1D004/0x1DBFE/0x1F1F0）还是硬编码银行（LDY #$04/$05/$06）——读到的都是新数据，
    // 不会出现“部分路径读新 bank、部分路径读旧 bank”的混搭（旧 repack 把数据挪到
    // 7/8/9 号 bank，而 L5 门/L6 炮台的硬编码路径仍读 4/5/6，导致 boss 区图块/碰撞错乱、死机）。
    let repack = false;
    let baseEdit = null;
    if (!baseEdit) baseEdit = loadEditFromROM(origRom);
    // 构建基准必须从内嵌原版（8-bank）出发；app 层已保证这一点。
    // 无改动快速路径：什么都没改（原版直接导出）时返回原 ROM 逐字节拷贝。
    // 序列化往返会给末尾屏补空 spawn 表等无关差异，原版生成一下必须原封不动。
    if (edit !== baseEdit) {
      const sameLevels = edit.levels.length === 6 && baseEdit.levels.length === 6 &&
        edit.levels.every((e, l) => {
          const b = baseEdit.levels[l];
          return JSON.stringify(e.idx) === JSON.stringify(b.idx) &&
                 JSON.stringify(e.layoutBlocks) === JSON.stringify(b.layoutBlocks) &&
                 JSON.stringify(e.spawns) === JSON.stringify(b.spawns) &&
                 JSON.stringify(e.def) === JSON.stringify(b.def) &&
                 JSON.stringify(e.pal) === JSON.stringify(b.pal);
        });
      const sameGlob = sameLevels &&
        JSON.stringify(edit.bossHp || {}) === JSON.stringify(baseEdit.bossHp || {}) &&
        JSON.stringify(edit.bossCount || {}) === JSON.stringify(baseEdit.bossCount || {}) &&
        JSON.stringify(edit.bossCompanions || {}) === JSON.stringify(baseEdit.bossCompanions || {}) &&
        JSON.stringify(edit.bossCompanionWeaponReq || {}) === JSON.stringify(baseEdit.bossCompanionWeaponReq || {}) &&
        JSON.stringify(edit.bossPos || {}) === JSON.stringify(baseEdit.bossPos || {}) &&
        JSON.stringify(edit.spriteParams || {}) === JSON.stringify(baseEdit.spriteParams || {}) &&
        JSON.stringify(edit.lives ?? null) === JSON.stringify(baseEdit.lives ?? null) &&
        JSON.stringify(edit.copyrightLines || []) === JSON.stringify(baseEdit.copyrightLines || []) &&
        JSON.stringify(edit.palettes || []) === JSON.stringify(baseEdit.palettes || []);
      if (sameGlob) return new Uint8Array(origRom);
    }
    // 一律走重打包（16-bank）输出：实测这条路径在真机/模拟器上稳定（改版 77 同款）。
    // 8-bank 原位写入看似更接近原版，但用户实测会出现“第1关走两步死机、第5关黑屏”，
    // 因此不再使用。repackROM 会把关卡数据移到 bank 7+、补丁 PTR/layoutBank/生成表读取
    // 路径，输出与旧版 16-bank 格式一致。
    // boss 战区兜底：只有战区"缺失"（无 0xF0 标记 / boss 屏精灵全空）才从原版还原——
    // 作者自己画的战区（有标记且有精灵）原样保留，绝不覆盖。
    ensureBossWarValid(baseEdit, edit);
    const rom2 = repackROM(origRom, edit);
    writeCopyrightLines(rom2, edit.copyrightLines);
    return rom2;
  }

  function patchSpriteHealthRuntime(rom, edit, shift, paramBank) {
    const fix = o => (o >= FIXED_BANK_ROM && o < FIXED_BANK_END ? o + shift : o);
    const hasOverrides = spriteParamOverridesPresent(edit);
    const helperAt = fix(SPRITE_PARAM_HELPER_OFF);
    const metaAt = fix(SPRITE_PARAM_META_OFF);
    const cpu = 0xC000 + (SPRITE_PARAM_HELPER_OFF - FIXED_BANK_ROM);
    if (hasOverrides) {
      if (paramBank == null || paramBank > 0xFF) {
        throw new Error('精灵参数覆盖表没有可用的数据 bank');
      }
      const helper = buildSpriteHealthHelper(paramBank);
      const fixedEnd = FIXED_BANK_END + shift;
      if (helperAt + helper.length > fixedEnd) {
        throw new Error('精灵参数运行时代码超出固定 bank 可用空间');
      }
      rom.set(SPRITE_PARAM_MAGIC, metaAt);
      rom[metaAt + 4] = paramBank & 0xFF;
      rom.set(helper, helperAt);
      for (const site of SPRITE_PARAM_HOOK_SITES) {
        const at = fix(site);
        const isNative = rom[at] === 0xB9 && rom[at + 1] === 0x42 && rom[at + 2] === 0xFA;
        const isHook = rom[at] === 0x20 && rom[at + 1] === (cpu & 0xFF) && rom[at + 2] === ((cpu >> 8) & 0xFF);
        if (!isNative && !isHook) throw new Error('无法识别精灵生命值读取点 $' + site.toString(16).toUpperCase());
        rom.set([0x20, cpu & 0xFF, (cpu >> 8) & 0xFF], at);
      }
    } else {
      // Clearing all per-level overrides must also remove a previous generated
      // hook when the user reloads an already patched ROM and clears them.
      rom.fill(0xFF, metaAt, metaAt + SPRITE_PARAM_MAGIC.length + 1);
      for (const site of SPRITE_PARAM_HOOK_SITES) {
        const at = fix(site);
        const isNative = rom[at] === 0xB9 && rom[at + 1] === 0x42 && rom[at + 2] === 0xFA;
        const isHook = rom[at] === 0x20 && rom[at + 1] === (cpu & 0xFF) && rom[at + 2] === ((cpu >> 8) & 0xFF);
        if (!isNative && !isHook) throw new Error('无法恢复精灵生命值读取点 $' + site.toString(16).toUpperCase());
        rom.set([0xB9, 0x42, 0xFA], at);
      }
    }
  }

  // apply lives + boss HP. shift = fixed-bank offset shift (0 for in-place).
  function applyCheatPatches(rom, edit, shift, options) {
    options = options || {};
    const fix = o => (o >= FIXED_BANK_ROM && o < FIXED_BANK_END ? o + shift : o);
    rom[fix(J.LIVES_OFFSET)] = clamp(edit.lives, 1, 255);
    const health = edit.spriteParams && edit.spriteParams.global;
    if (health) {
      for (let type = 0; type < 0x80; type++) {
        const value = health[type] && health[type].health;
        if (value == null) continue;
        const at = fix(J.ENEMY_HEALTH_BASE + type);
        rom[at] = (rom[at] & 0x80) | (clamp(value, 0, 127) & 0x7F);
      }
    }
    for (const b of J.BOSS_HP) {
      const v = clamp(edit.bossHp[b.id] != null ? edit.bossHp[b.id] : b.defaultValue, 0, 127);
      for (const o of b.offsets) rom[fix(o)] = 0x80 | (v & 0x7F); // bit7 = boss flag, low 7 bits = HP
    }
    if (edit.bossCount) {
      for (const b of J.BOSS_COUNT) {
        if (b.fixed || b.offset == null) continue;
        const v = clamp(edit.bossCount[b.id] != null ? edit.bossCount[b.id] : b.defaultValue, 1, b.max != null ? b.max : 128);
        rom[b.offset] = v;
      }
    }
    // Boss 伴随是运行时生成：只改 Boss 代码中的 LDA #$XX 操作数，
    // 不写入任何关卡地图 spawn，也不创建编辑器画布对象。
    for (const b of (J.BOSS_COMPANIONS || [])) {
      for (const site of (b.sites || [])) {
        const at = site.offset;
        if (rom[at - 1] !== site.opcode) {
          throw new Error('无法识别第' + (b.level + 1) + '关 Boss 伴随投放点 $' + (at - 1).toString(16).toUpperCase());
        }
        const selected = edit.bossCompanions && edit.bossCompanions[b.id];
        const allowed = Array.isArray(b.types) && b.types.includes(selected);
        rom[at] = (allowed ? selected : b.defaultValue) & 0x7F;
      }
      for (const gate of (b.weaponGate || [])) {
        const at = gate.offset;
        if (rom[at - 1] !== gate.opcode) {
          throw new Error('无法识别第' + (b.level + 1) + '关 Boss 伴随火力判断点 $' + (at - 1).toString(16).toUpperCase());
        }
        const req = edit.bossCompanionWeaponReq && edit.bossCompanionWeaponReq[b.id];
        rom[at] = Math.max(0, Math.min(3, Number.isFinite(req) ? req : (b.defaultWeaponLevel || 0)));
      }
    }
    // Boss spawn position tables: write edit.bossPos into fixed-bank free space (16 entries each)
    if (edit.bossPos) {
      let posPtr = POS_TABLE_BASE;
      for (const t of POS_TABLES) {
        const pos = edit.bossPos[t.id];
        if (!pos) continue;
        for (const tb of t.tables) {
          const vals = [];
          for (let i = 0; i < POS_ENTRIES; i++) {
            if (tb.kind === 'LB') vals.push((pos.x[i] & 0xFF));
            else if (tb.kind === 'UB') vals.push(((pos.x[i] >> 8) & 0xFF));
            else if (tb.kind === 'V') vals.push((pos.y[i] & 0xFF));
          }
          rom.set(vals, fix(posPtr)); // fixed bank shifts on repack
          const cpu = 0xC000 + (posPtr - FIXED_BANK_ROM); // fixed bank CPU addr
          rom[tb.lda] = cpu & 0xFF;
          rom[tb.lda + 1] = (cpu >> 8) & 0xFF;
          posPtr += POS_ENTRIES;
        }
      }
    }
    if (edit.palettes) {
      const origPals = [];
      for (let l = 0; l < 6; l++) {
        const base = fix(J.LEVEL_PALETTE_BASE) + l * 0x23 + 2;
        origPals.push(Array.from(rom.subarray(base, base + 32)));
        for (let k = 0; k < 32; k++) rom[base + k] = edit.palettes[l][k] & 0x3F;
      }
      // 同步更新 Helipad 闪烁调色板流与 F2 boss 换色流：否则走到飞机场/boss 屏
      // 游戏从这些流重载旧颜色，玩家改的全局颜色被"恢复"（Bank7 $D6FE/$D854）。
      // 按「原默认色值 → 用户新色」映射替换；闪烁专用色（不在默认表）保留。
      syncPaletteStreams(rom, edit, fix, origPals);
    }
    patchSpriteHealthRuntime(rom, edit, shift, options.paramBank);
  }

  // Helipad 闪烁流（每关 3×19B，PPU 头 + 16 色 + FE）与 F2 boss 换色流。
  // ROM 偏移 = CPU $D6FE/$D854 系 + 0x10010（与 LEVEL_PALETTE_BASE 同换算）。
  const HELIPAD_STREAMS = [0x1D70E, 0x1D747, 0x1D780, 0x1D7B9, 0x1D7F2, 0x1D82B];
  const HELIPAD_LEN = 0x39;
  const F2_STREAMS = [ // [levelIdx, offset, len]
    [0, 0x1D864, 0x13], // L1 BossSprite (SPR)
    [2, 0x1D877, 0x13], // L3 BossBG
    [4, 0x1D88A, 0x23], // L5 BossPal (BG+SPR)
    [5, 0x1D8AD, 0x13], // L6 BuildingBossBG
  ];

  // 扫描 PPU 更新流：`3F xx` + N 色 + `FE`，xx 低 4 位 = 调色板组起点（0=BG 10=SPR）。
  // 颜色按映射替换（映射 miss 保留原值——闪烁/boss 专用色）。
  function syncPaletteStreams(rom, edit, fix, origPals) {
    for (let l = 0; l < 6; l++) {
      const userPal = edit.palettes[l];
      if (!userPal || !origPals[l]) continue;
      // 值映射：原默认色 c -> 用户新色（同值多槽位取首次出现）
      const mapBG = new Map(), mapSPR = new Map();
      for (let k = 0; k < 16; k++) if (!mapBG.has(origPals[l][k])) mapBG.set(origPals[l][k], userPal[k] & 0x3F);
      for (let k = 16; k < 32; k++) if (!mapSPR.has(origPals[l][k])) mapSPR.set(origPals[l][k], userPal[k] & 0x3F);
      const mapOf = ppu => (ppu >= 0x10) ? mapSPR : mapBG;

      const streams = [[fix(HELIPAD_STREAMS[l]), HELIPAD_LEN]];
      for (const f of F2_STREAMS) if (f[0] === l) streams.push([fix(f[1]), f[2]]);
      for (const [start, len] of streams) {
        let i = 0;
        while (i < len - 1) {
          if (rom[start + i] !== 0x3F) { i++; continue; }
          const ppu = rom[start + i + 1], map = mapOf(ppu);
          i += 2;
          while (i < len && rom[start + i] !== 0xFE) {
            const nv = map.get(rom[start + i]);
            if (nv != null) rom[start + i] = nv;
            i++;
          }
          i++; // skip FE
        }
      }
    }
  }

  function repackROM(baseRom, edit) {
    // 去重 layout 块（副本），让加长（大片相同空白屏）能塞进单 bank；不动底层 edit。
    const packedLevels = edit.levels.map(lvl => dedupeLevelCopy(lvl));
    const levelData = packedLevels.map(e => serializeLevelData(e));
    const hasSpriteOverrides = spriteParamOverridesPresent(edit);

    const baseBank = 7;
    let nextBank = baseBank;
    const layoutBank = [0,0,0,0,0,0], layoutAddr = [0,0,0,0,0,0];
    const bankContents = {};
    function placeGroup(levels) {
      let cur = null, used = 0;
      for (const l of levels) {
        const sz = sizeOf(levelData[l]);
        if (!cur || used + sz > 0x4000) {
          cur = nextBank++; used = 8; bankContents[cur] = [];
          if (used + sz > 0x4000) throw new Error('第 ' + (l + 1) + ' 关数据超过单个 16KB bank 上限（约 129 屏），请减少该关的屏数');
        }
        layoutBank[l] = cur; layoutAddr[l] = 0x8000 + used; used += sz;
        bankContents[cur].push(l);
      }
    }
    placeGroup(GROUP_A);
    placeGroup(GROUP_B);

    let sBank = nextBank, sUsed = 8;
    const spawnBank = [], spawnAddr = [];
    for (let l = 0; l < 6; l++) {
      const sz = spawnSize(packedLevels[l].spawns);
      if (sUsed + sz > 0x4000) { sBank++; sUsed = 8; }
      spawnBank[l] = sBank; spawnAddr[l] = 0x8000 + sUsed; sUsed += sz;
    }
    // Keep the runtime override table in its own switchable bank.  It is only
    // allocated when the editor has at least one per-level override.
    const paramBank = hasSpriteOverrides ? sBank + 1 : null;
    const highestBank = Math.max(sBank, nextBank - 1, paramBank == null ? -1 : paramBank);
    const dataBanks = highestBank - baseBank + 1;
    const totalBanks = 8 + dataBanks;
    // FCEUX (and other strict emulators) require UNROM PRG to be a power of two.
    const paddedBanks = Math.pow(2, Math.ceil(Math.log2(totalBanks)));
    const shift = (paddedBanks - 8) * J.BANK_SIZE;
    const spawnTables = packedLevels.map((e, l) => serializeSpawnTable(e.spawns, spawnAddr[l]));

    const newRom = new Uint8Array(J.PRG_BASE + paddedBanks * J.BANK_SIZE);
    newRom.fill(0xFF); // pad unused banks
    newRom.set(baseRom.subarray(0, 16));
    newRom[4] = paddedBanks;
    for (let b = 0; b < 7; b++) {
      // Jackal_custom/16-bank ROMs keep the runtime AI bank immediately before
      // the fixed bank (bank 14), while bank 6 is occupied by relocated level
      // data. Put that custom AI bank back into output bank 6; otherwise the
      // L5 boss gray-turret bullet routine silently reverts to the wrong code.
      const baseBanks = baseRom[4] || 8;
      const srcBank = (b === 6 && baseBanks > 8) ? (baseBanks - 2) : b;
      const src = J.PRG_BASE + srcBank * J.BANK_SIZE;
      newRom.set(baseRom.subarray(src, src + J.BANK_SIZE), J.PRG_BASE + b * J.BANK_SIZE);
    }
    const dstFixed = J.PRG_BASE + (paddedBanks - 1) * J.BANK_SIZE;
    // The fixed bank is always the LAST bank of any valid UNROM image. When the
    // editor reloads an already-repacked ROM (二次生成), baseRom may be 16/32
    // banks, so the fixed bank is NOT at FIXED_BANK_ROM (0x1C010) — it is at the
    // end of the file. Read it from there so rebuilding from a patched ROM works.
    const baseBanks = baseRom[4] || 8;
    const baseFixedOff = J.PRG_BASE + (baseBanks - 1) * J.BANK_SIZE;
    newRom.set(baseRom.subarray(baseFixedOff, baseFixedOff + J.BANK_SIZE), dstFixed);

    for (let b = baseBank; b <= highestBank; b++) {
      const bankBase = J.PRG_BASE + b * J.BANK_SIZE;
      for (let k = 0; k < 8; k++) newRom[bankBase + k] = k;
    }
    for (const b in bankContents) {
      const bankBase = J.PRG_BASE + (+b) * J.BANK_SIZE;
      let off = 8;
      for (const l of bankContents[b]) {
        const d = levelData[l];
        newRom.set(d.idx, bankBase + off); off += d.idx.length;
        newRom.set(d.layout, bankBase + off); off += d.layout.length;
        newRom.set(d.def, bankBase + off); off += d.def.length;
        newRom.set(d.pal, bankBase + off); off += d.pal.length;
      }
    }
    for (let l = 0; l < 6; l++) {
      const bankBase = J.PRG_BASE + spawnBank[l] * J.BANK_SIZE;
      newRom.set(spawnTables[l], bankBase + (spawnAddr[l] - 0x8000));
    }
    if (paramBank != null) {
      const bankBase = J.PRG_BASE + paramBank * J.BANK_SIZE;
      newRom.set(buildSpriteParamData(edit), bankBase);
    }

    const fix = o => (o >= FIXED_BANK_ROM && o < FIXED_BANK_END ? o + shift : o);
    applyCheatPatches(newRom, edit, shift, { paramBank });

    // Boss/末段运行时代码原本把屏号写死为原版地图位置。
    // 地图缩短或增加后，Boss 屏都会移动，因此所有相关比较必须写入
    // 当前 packedLevels 中实际的 0xF0 Boss 屏号，而不能只处理加长。
    const bossScreenOf = level => {
      const sp = packedLevels[level] && packedLevels[level].spawns;
      if (!sp) return 0;
      for (let s = sp.length - 1; s >= 0; s--) {
        if (sp[s] && sp[s].indexOf(0xF0) >= 0) return s & 0xFF;
      }
      return Math.max(0, (packedLevels[level]?.idx?.length || 1) - 2) & 0xFF;
    };
    const bossScreens = [bossScreenOf(2), bossScreenOf(4), bossScreenOf(5)];
    // All known original runtime checks that compare CurrentLevelScreen to a
    // fixed boss/last-screen number.  Keep the level-specific mechanic, but
    // replace only the screen operand; ordinary fixed-position mechanisms
    // (L3 laser screen 7/8, L6 escalator screen 10) remain untouched.
    const dynamicScreenOperands = [
      [6, 0x15E5, bossScreens[0]], // L3 spread-turret normal/boss cutoff
      [6, 0x391D, bossScreens[2]], // L6 gray-turret explosion/boss check
      [6, 0x3DCA, bossScreens[1]], // L5 gray-turret boss bullet mode
      [7, 0x2D62, bossScreens[2]], // L6 boss-area bullet handling
      [7, 0x2EE2, bossScreens[2]], // L6 boss-area projectile handling
    ];
    for (const [bank, off, value] of dynamicScreenOperands) {
      // Bank 7 is the fixed runtime bank and is moved to the final output bank
      // when the ROM is repacked; Bank 6 remains the AI bank at its data slot.
      const at = (bank === 7 ? dstFixed : J.PRG_BASE + bank * J.BANK_SIZE) + off;
      if (at < newRom.length) newRom[at] = value;
    }

    for (let l = 0; l < 6; l++) {
      const idxLen = packedLevels[l].idx.length;
      const layoutLen = packedLevels[l].layoutBlocks.length * 128;
      const defLen = levelData[l].def.length;
      J.write16(newRom, fix(J.PTR.screenLoadIndex + l * 2), layoutAddr[l]);
      J.write16(newRom, fix(J.PTR.layoutData + l * 2), layoutAddr[l] + idxLen);
      J.write16(newRom, fix(J.PTR.def32x32 + l * 2), layoutAddr[l] + idxLen + layoutLen);
      J.write16(newRom, fix(J.PTR.palette + l * 2), layoutAddr[l] + idxLen + layoutLen + defLen);
      J.write16(newRom, fix(J.PTR.spawnAddress + l * 2), spawnAddr[l]);
      newRom[fix(J.PTR.layoutBank + l)] = layoutBank[l];
    }
    newRom.set(BANK_SWITCH_FIX, fix(BANK_SWITCH_FIX_OFF));
    // Per-level spawn bank table + helper (replaces the single-bank "LDY #$06"
    // that only worked while all spawn tables fit in one bank).
    for (let l = 0; l < 6; l++) newRom[fix(TBL_SPAWN_BANK_OFF + l)] = spawnBank[l];
    newRom.set(HELPER3, fix(HELPER3_OFF));
    for (const site of SPAWN_BANK_LOAD_SITES) newRom.set(SPAWN_BANK_LOAD_FIX, fix(site));

    // Restore bank 6 before the sprite loop after the spawn check (fixes the
    // spawn-bank leak that crashes the AI dispatch in repacked ROMs).
    newRom.set(HELPER1, fix(HELPER1_OFF));
    newRom.set(HELPER2, fix(HELPER2_OFF));
    newRom.set(SPAWN_LEAK_JMP_FIX, fix(SPAWN_LEAK_JMP_OFF));
    newRom.set(CALLER2_JSR_FIX, fix(CALLER2_JSR_OFF));

    return newRom;
  }

  return { parseSpawnTables, serializeSpawnTable, loadEditFromROM, buildPatchedROM, clamp,
    parseTitleCredits, serializeTitleCredits, parseCopyrightLines, writeCopyrightLines, dedupeLevelCopy };
});
