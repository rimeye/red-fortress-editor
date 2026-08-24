/* Jackal level editor — UI application */
(function () {
  'use strict';
  const J = window.JackalROM, P = window.JackalPatch, NES = window.NESPalette;

  let rom = null;        // Uint8Array 当前载入的 ROM（解析/渲染用；可能是用户载入的改版或重打包 ROM）
  let baseRom = null;    // Uint8Array 内嵌原版 8-bank ROM —— 永远作为生成 ROM 的构建基准
  let edit = null;       // edit model
  let level = 0;         // current level (0-5)
  let tool = 'brush';    // 'brush' | 'eraser' | 'pan'
  let zoom = 1.5;        // display zoom factor (0.5x - 4x)
  let selTile = 0;       // selected large tile index
  let brushSize = 1;     // brush size in tiles (1x1, 2x2, ...)
  let dragBoss = null;    // { id, k } — boss position being dragged
  let selEnemy = 1;      // selected enemy type (object ID)
  // Enemy spawn condition encoded by the Y low bit in the NES spawn table.
  // 0 = normal/any weapon level, 1 = max weapon only.
  let enemyPlaceCondition = 'normal';
  let spriteParamScope = 'global'; // 'global' or 'level'
  let enemySel = null;     // { screen, off } — selected enemy entry (move mode)
  let selStart = null;     // {x, y} drag start in canvas px
  let selRect = null;      // {x0, y0, x1, y1} canvas px
  let selecting = false;
  let clipboard = null;    // { w, h, pw, ph, tiles, enemies }
  let pasteMode = false;
  let pastePos = null;     // {x, y} paste origin in canvas px
  let screenClipboard = null; // { count, blocks, spawns, fromLevel }
  let undoStack = [];      // [{ level, snap }]
  let redoStack = [];
  let spriteCons = null;   // parsed sprite constructors (cached)
  let spritePals = null;   // per-level 32-byte palettes (cached)
  const spriteChrCache = [null, null, null, null, null, null]; // per-level sprite CHR
  // Enemy (spawn) type names for the editor panel
  const ENEMY_NAMES = {
    1:'步兵',2:'固定步兵',3:'火焰兵',4:'沼泽步兵',5:'灰炮塔·白弹',6:'灰炮塔·黄弹',
    7:'红坦克',8:'攻击艇',9:'1关Boss',0xA:'Boss坦克',0xB:'银大坦克',0xC:'桥头炮塔',
    0xD:'激光充能',0xE:'火焰坦克',0xF:'敌人吉普',0x10:'柱子·左',0x11:'步兵卡车',
    0x12:'散弹炮塔',0x13:'POW房·2人右',0x14:'POW房·2人左',0x15:'POW升级房',0x16:'POW行走',
    0x17:'5关Boss',0x18:'2关Boss头像',0x19:'POW坦克房',0x1A:'3关大艇',0x1B:'门',
    0x1C:'POW房·4人右',0x1D:'POW房·4人左',0x1E:'柱顶',0x1F:'柱子·右',
    0x20:'2关Boss',0x21:'头像·射击',0x22:'头像·待机',0x23:'5关银坦克',
    0x24:'5关红坦克',0x25:'3关Boss',0x26:'5关电门',0x27:'POW上机',
    0x28:'吉普POW触发',0x29:'潜艇',0x2A:'散弹卡车·右',0x2B:'散弹卡车·左',
    0x2C:'导弹发射器',0x2D:'沉没发射器',0x2E:'6关导弹发射器',0x2F:'落石·左',0x30:'落石·右',
    0x31:'5关Boss门',0x32:'火车',0x33:'火车车厢',0x34:'火焰流',0x35:'地雷',
    0x36:'敌弹',0x37:'炸弹',0x38:'激光',0x39:'黑白导弹',0x3A:'攻击机·定点',
    0x3B:'攻击机·任意',0x3C:'救援直升机',0x3D:'降落飞机·右',0x3E:'降落飞机·左',
    0x3F:'POW放人点',0x40:'4关Boss',0x41:'4关Boss爆炸',0x42:'4关空降兵',
    0x43:'6关武直',0x44:'电梯',0x45:'6关Boss加载',0x46:'关卡结束检测',
    0x47:'6关激光炮',0x48:'激光炮冲击',0x49:'激光炮图形',0x4A:'6关Boss堡垒',
    0x4B:'最终Boss坦克',0x4C:'Boss喷火',0x4D:'喷火尖端',0x4E:'停靠吉普/坦克',
    0x4F:'6关Boss炮塔',0x50:'星星·清屏',0x51:'星星·四方导弹',0x52:'星星·1UP',
    0x53:'藏星吉普'
  };
  let chrCache = [null, null, null, null, null, null];
  let palCache = [null, null, null, null, null, null];
  let tileImgCache = {}; // "level:tile" -> HTMLCanvasElement (32x32)
  const TILE = 32;       // pixels per large tile in the level view
  const COLS = 16, ROWS = 8; // level is 16 tiles wide x 8 tall per screen (transposed storage)

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const levelCanvas = $('levelCanvas');
  const ctx = levelCanvas.getContext('2d');

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---------- 标题版权 4 行 ----------
  const COPY_LEN = [13, 15, 26, 13, 24];
  function buildCopyrightPanel() {
    const box = $('copyrightLines');
    if (!box) return;
    box.innerHTML = '';
    const lines = edit.copyrightLines || ['', '', '', '', ''];
    for (let i = 0; i < COPY_LEN.length; i++) {
      const row = document.createElement('div');
      row.className = 'pal-row';
      row.style.gap = '4px';
      const lab = document.createElement('span');
      lab.className = 'muted';
      lab.style.fontSize = '12px';
      lab.textContent = ['顶部','版权行','公司','授权','发行'][i] || ('行' + (i + 1));
      const inp = document.createElement('input');
      inp.className = 'txt-input';
      inp.maxLength = COPY_LEN[i];
      inp.value = (lines[i] || '').trim();
      inp.placeholder = '最多 ' + COPY_LEN[i] + ' 字符';
      inp.oninput = () => {
        edit.copyrightLines[i] = inp.value;
        if (inp.value.length >= COPY_LEN[i]) statusMsg('行' + (i + 1) + ' 已满 ' + COPY_LEN[i] + ' 字符（无法再加）');
        else if (/[0-9]/.test(inp.value)) statusMsg('提示：0-9 直接输入即可，© 用 © 字符');
      };
      row.appendChild(lab);
      row.appendChild(inp);
      box.appendChild(row);
    }
  }
  function init(romBytes) {
    rom = romBytes;
    if(!baseRom) baseRom = romBytes; // 启动时载入的是内嵌原版 → 作为构建基准；之后载入的改版不再覆盖它
    if(baseRom && window.JackalGen){
      // 原版数据存档：作者「删全部」/旧改版丢了 boss 战区时，随机生成用它把战区补齐
      try { window.JackalGen.ORIG_EDIT = P.loadEditFromROM(baseRom); } catch(e) { /* 忽略 */ }
    }
    if(romBytes && romBytes[4] !== 8){
      // 载入的是重打包(16-bank) ROM：解析没问题；导出永远从内嵌原版重建为
      // 同款 16-bank 重打包格式（改版 77 验证过的稳定格式）。
      setTimeout(() => statusMsg('已载入重打包(' + romBytes[4] + ' bank) ROM · 导出时从内嵌原版重建为 16 bank'), 0);
    }
    edit = P.loadEditFromROM(rom);
    chrCache = [null,null,null,null,null,null,null];
    palCache = [null,null,null,null,null,null,null];
    tileImgCache = {}; // cleared so tiles re-render with the corrected def flip
    level = 0; selTile = 0; selEnemy = 1;
    buildCopyrightPanel();
    spriteCons = J.parseSpriteConstructors(rom);
    spritePals = J.getSpritePalettes(rom);
    if (window.JackalGen && window.JackalGen.initTemplates) window.JackalGen.initTemplates(rom);
    for (let i = 0; i < 6; i++) spriteChrCache[i] = null;
    buildLevelSelect();
    buildTilePalette();
    buildEnemyPanel();
    buildSpriteParamsPanel();
    buildPalettePanel();
    // initial panel/layer state (brush tool)
    const enemyPanel = $('enemyPanelSection');
    if (enemyPanel) enemyPanel.hidden = true;
    setSidebarTab('basic');
    refreshAll();
    updateLivesLabel();
    updateUndoButtons();
    updateZoomLabels();
    // ensure canvas is sized after first layout
    setTimeout(() => { updateSpacer(); drawLevel(); }, 0);
    updateEnemyPerScreen();
    updateOddRatio();
  }

  window.addEventListener('resize', () => { updateSpacer(); drawLevel(); });

  // ---------- CHR / palette caches ----------
  function chr(level) {
    if (!chrCache[level]) chrCache[level] = J.buildLevelCHR(rom, level);
    return chrCache[level];
  }
  function palette(level) {
    return edit.palettes[level].slice(0, 16);
  }

  function levelDef(level, tile) {
    const off = J.TILE_OFFSET[level];
    if (tile < off) return edit.levels[0].def;
    return edit.levels[level].def;
  }
  function defIndex(level, tile) {
    const off = J.TILE_OFFSET[level];
    return tile < off ? tile : tile - off;
  }
  function maxTile(level) {
    const L = J.LEVELS[level];
    return Math.min(edit.levels[level].pal.length, J.TILE_OFFSET[level] + edit.levels[level].def.length / 16) - 1;
  }
  // 每关真正的"空地"图块（来自原版直方图：L1=88/L2=79/L3=7/L4=80/L5=45/L6=7）
  function emptyGround(level) {
    const G = window.JackalGen;
    return (G && G.PRIMARY_GROUND && G.PRIMARY_GROUND[level] != null) ? G.PRIMARY_GROUND[level] : 0x35;
  }

  function spriteChr(level) {
    if (!spriteChrCache[level]) spriteChrCache[level] = J.buildSpriteCHR(rom, level);
    return spriteChrCache[level];
  }
  // BG 图块对象图标（4x4 个 8x8 = 32x32px），中心 (cx,cy)；CHR/调色板取自图标本征关卡
  function renderBGIcon(ctx, icon, cx, cy, scale) {
    const chrD = chr(icon.lvl);
    const pal = edit.palettes[icon.lvl].slice(0, 16);
    const g = (icon.pal & 3) * 4;
    const colors = [pal[0], pal[g + 1], pal[g + 2], pal[g + 3]];
    const x0 = cx - 16 * scale, y0 = cy - 16 * scale;
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (let i = 0; i < 16; i++) {
      const tx = (i & 3) * 8, ty = (i >> 2) * 8;
      const px = NES.tilePixels(chrD, icon.tiles[i]);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const c = px[y * 8 + x];
        if (!c) continue;
        const fx = x0 + (tx + x) * scale, fy = y0 + (ty + y) * scale;
        minX = Math.min(minX, fx); maxX = Math.max(maxX, fx + scale);
        minY = Math.min(minY, fy); maxY = Math.max(maxY, fy + scale);
        const rgb = NES.rgb(colors[c]);
        ctx.fillStyle = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
        ctx.fillRect(fx, fy, scale, scale);
      }
    }
    if (minX > maxX) return null;
    return { minX, maxX, minY, maxY };
  }
  // 无图形对象（纯逻辑）的占位徽章：灰底圆角方块 + 类型十六进制
  function renderPlaceholderBadge(ctx, type, cx, cy, scale) {
    const s = 10 * scale;
    ctx.fillStyle = '#555d6e';
    ctx.strokeStyle = '#9aa3b2';
    ctx.lineWidth = Math.max(1, scale * 0.75);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(cx - s / 2, cy - s / 2, s, s, 2 * scale);
    else ctx.rect(cx - s / 2, cy - s / 2, s, s);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold ' + Math.max(5, Math.round(6 * scale)) + 'px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((type & 0x7F).toString(16).toUpperCase(), cx, cy + scale * 0.5);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    return { minX: cx - s / 2, maxX: cx + s / 2, minY: cy - s / 2, maxY: cy + s / 2 };
  }
  // render one enemy sprite (image form) at canvas coords; returns bbox or null
  function renderEnemySprite(ctx, level, type, cx, cy, scale) {
    const t = type & 0x7F; // bit7 是生成标志，对象/精灵按低 7 位查
    const m = J.ENEMY_AI_MAP[t];
    if (m && m.s === null) {
      // BG 图块对象：有提取的图标走 BG_ICON，否则占位徽章
      const icon = J.BG_ICON[t];
      if (icon) return renderBGIcon(ctx, icon, cx, cy, scale);
      return renderPlaceholderBadge(ctx, t, cx, cy, scale);
    }
    const sid = m ? m.s : t; // 不在 AI 映射里的类型，直接按精灵构造器 ID 渲染
    const S = spriteCons[sid];
    if (!S || S.count === 0) return renderPlaceholderBadge(ctx, t, cx, cy, scale);
    const lv = (m && m.lvl != null) ? m.lvl : level; // 关卡专属图形用本征关卡 CHR
    const chr = spriteChr(lv);
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (const part of S.parts) {
      const dy = part[0] >= 128 ? part[0] - 256 : part[0];
      const tile = part[1], attr = part[2];
      const dx = part[3] >= 128 ? part[3] - 256 : part[3];
      const hf = (attr & 0x40) !== 0, vf = (attr & 0x80) !== 0;
      const pal = J.spritePaletteGroup(edit.palettes[lv], m ? ((attr | m.p) & 3) : (attr & 3));
      const o = tile * 16;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const sx = hf ? 7 - x : x, sy = vf ? 7 - y : y;
        const c = ((chr[o + sy] >> (7 - sx)) & 1) | (((chr[o + sy + 8] >> (7 - sx)) & 1) << 1);
        if (!c) continue;
        const px = cx + dx * scale + x * scale, py = cy + dy * scale + y * scale;
        minX = Math.min(minX, px); maxX = Math.max(maxX, px + scale);
        minY = Math.min(minY, py); maxY = Math.max(maxY, py + scale);
        const rgb = NES.rgb(pal[c]);
        ctx.fillStyle = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
        ctx.fillRect(px, py, scale, scale);
      }
    }
    if (minX > maxX) return renderPlaceholderBadge(ctx, t, cx, cy, scale);
    return { minX, maxX, minY, maxY };
  }
  // render a large tile (32x32) to a canvas
  function renderLargeTile(level, tile) {
    const c = document.createElement('canvas'); c.width = 32; c.height = 32;
    const g = c.getContext('2d');
    const img = g.createImageData(32, 32);
    const chrD = chr(level);
    const pal = palette(level);
    const def = levelDef(level, tile);
    const di = defIndex(level, tile) * 16;
    const palByte = edit.levels[level].pal[tile] & 0xFF;
    // Each 32x32 large tile covers 4 x 16x16 quadrants; its palette byte packs
    // 4 x 2-bit palette indices (upper nibble = top row, lower nibble = bottom row).
    for (let qy = 0; qy < 2; qy++) {
      for (let qx = 0; qx < 2; qx++) {
        // NES attribute-table packing: bits 6-7=TL, 4-5=TR, 2-3=BL, 0-1=BR
        const shift = (qy === 0 ? 6 : 2) - qx * 2;
        const palIdx = (palByte >> shift) & 3;
        const bgPal = pal.slice(palIdx * 4, palIdx * 4 + 4);
        const colors = [pal[0], bgPal[1], bgPal[2], bgPal[3]];
        for (let ty = qy * 2; ty < qy * 2 + 2; ty++) {
          for (let tx = qx * 2; tx < qx * 2 + 2; tx++) {
            // def rows are vertically flipped in the rendered tile (verified vs emulator)
            const tileIdx = def[di + (3 - ty) * 4 + tx];
            const px = NES.tilePixels(chrD, tileIdx);
            for (let y = 0; y < 8; y++) {
              for (let x = 0; x < 8; x++) {
                const ci = px[y * 8 + x];
                const rgb = NES.rgb(colors[ci]);
                const o = ((ty * 8 + y) * 32 + (tx * 8 + x)) * 4;
                img.data[o] = rgb[0]; img.data[o+1] = rgb[1]; img.data[o+2] = rgb[2]; img.data[o+3] = 255;
              }
            }
          }
        }
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }
  function tileImage(level, tile) {
    const key = level + ':' + tile;
    if (!tileImgCache[key]) tileImgCache[key] = renderLargeTile(level, tile);
    return tileImgCache[key];
  }

  // ---------- enemy panel ----------
  function enemyConditionFromY(y) {
    return (y & 1) ? 'maxWeapon' : 'normal';
  }

  function selectedEnemyEntry() {
    if (!enemySel || !edit || !edit.levels[level]) return null;
    const list = edit.levels[level].spawns[enemySel.screen];
    if (!list || enemySel.off < 0 || enemySel.off + 2 >= list.length) return null;
    const y = list[enemySel.off];
    if (y >= 0xF0 || y === 0xEF) return null;
    return { list, off: enemySel.off, y, type: list[enemySel.off + 2] & 0x7F };
  }

  function setSelectedEnemyCondition(condition) {
    const entry = selectedEnemyEntry();
    if (!entry) {
      enemyPlaceCondition = condition;
      return;
    }
    const next = condition === 'maxWeapon' ? (entry.y | 1) : (entry.y & 0xFE);
    if (next === entry.y) return;
    pushUndo();
    entry.list[entry.off] = next & 0xFF;
    enemyPlaceCondition = condition;
    buildEnemyPanel();
    drawLevel();
    statusMsg(condition === 'maxWeapon' ? '已设置为满级武器才出现' : '已设置为普通武器条件出现');
  }

  function buildEnemyConditionControls(box) {
    const selected = selectedEnemyEntry();
    const row = document.createElement('div');
    row.className = 'enemy-condition-row';
    const label = document.createElement('span');
    label.className = 'muted';
    label.textContent = selected ? '选中敌人出现条件' : '新放置敌人出现条件';
    const select = document.createElement('select');
    select.className = 'enemy-condition-select';
    const current = selected ? enemyConditionFromY(selected.y) : enemyPlaceCondition;
    const options = [
      ['normal', '普通条件（偶数 Y）'],
      ['maxWeapon', '满级武器才出现（奇数 Y）'],
      ['secondLoop', '二周目才出现（ROM 未确认）'],
    ];
    for (const [value, text] of options) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      opt.selected = value === current;
      if (value === 'secondLoop') opt.disabled = true;
      select.appendChild(opt);
    }
    select.value = current;
    select.title = '奇数 Y 是原版满级武器条件；二周目条件尚未找到真实 ROM 读取位';
    select.onchange = () => {
      if (select.value === 'secondLoop') {
        select.value = selected ? enemyConditionFromY(selected.y) : enemyPlaceCondition;
        statusMsg('原版未确认二周目独立生成条件，未修改数据');
        return;
      }
      setSelectedEnemyCondition(select.value);
      if (!selected) {
        buildEnemyPanel();
        statusMsg(select.value === 'maxWeapon' ? '新放置敌人将使用奇数 Y' : '新放置敌人将使用偶数 Y');
      }
    };
    row.appendChild(label);
    row.appendChild(select);
    box.appendChild(row);

    const note = document.createElement('div');
    note.className = 'enemy-condition-note';
    note.textContent = selected
      ? '当前记录 Y=$' + selected.y.toString(16).toUpperCase().padStart(2, '0') + '；奇数位由游戏在生成时检查。'
      : '这是敌人生成记录的条件，不是地图上的奇偶列位置。';
    box.appendChild(note);
  }

  function buildEnemyPanel() {
    const box = $('enemyPanel');
    if (!box) return;
    box.innerHTML = '';
    const hint = document.createElement('div');
    hint.className = 'enemy-hint';
    hint.textContent = '① 点选敌人类型 → ② 点击画布放置 · 点已有敌人选中（显示名称）后点击新位置移动 · 右键删除/取消 · Esc 取消';
    box.appendChild(hint);
    buildEnemyConditionControls(box);
    // 只保留有用的类型：ENEMY_NAMES 命名过的 + 各关 spawn 表实际出现过的类型
    const ids = new Set();
    for (const k of Object.keys(ENEMY_NAMES)) ids.add(Number(k));
    if (edit && edit.levels) for (const lv of edit.levels) {
      for (const list of lv.spawns) {
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const y = list[i];
          if (y === 0xEF || y === 0xFF) break;
          if (y === 0xF0 || y === 0xF1 || y === 0xF2) { i += 1; continue; }
          ids.add(list[i + 2] & 0x7F);
          i += 2;
        }
      }
    }
    const keys = [...ids].sort((a, b) => a - b);
    for (const id of keys) {
      const btn = document.createElement('button');
      btn.className = 'enemy-cell' + (id === selEnemy ? ' active' : '');
      const name = ENEMY_NAMES[id] || ('对象#' + id.toString(16).toUpperCase());
      btn.title = name;
      btn.dataset.enemy = id;
      const cvs = document.createElement('canvas');
      cvs.width = 26; cvs.height = 26;
      const g = cvs.getContext('2d');
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(0, 0, 26, 26);
      try {
        // 先在 64x64 离屏按原始尺寸渲染，取包围盒后等比缩放进 24x24 区域
        const off = document.createElement('canvas');
        off.width = 64; off.height = 64;
        const og = off.getContext('2d');
        const box = renderEnemySprite(og, level, id, 32, 32, 1);
        if (box) {
          const w = box.maxX - box.minX, h = box.maxY - box.minY;
          const k = Math.min(1, 24 / w, 24 / h);
          g.imageSmoothingEnabled = false;
          g.drawImage(off, box.minX, box.minY, w, h, 13 - w * k / 2, 13 - h * k / 2, w * k, h * k);
        }
      } catch (e) { /* no sprite data */ }
      const span = document.createElement('span');
      span.textContent = '#' + id.toString(16).toUpperCase() + ' ' + name;
      btn.appendChild(cvs);
      btn.appendChild(span);
      btn.onclick = () => { selEnemy = id; enemySel = null; buildEnemyPanel(); buildSpriteParamsPanel(); };
      box.appendChild(btn);
    }
  }

  function spriteParamTypeIds() {
    const ids = [];
    const map = J.SPRITE_RUNTIME_PARAMS && J.SPRITE_RUNTIME_PARAMS.health;
    if (!map) return ids;
    // 攻击机投放/攻击机对象不属于本参数面板；此前的生命值入口会让
    // 用户误以为能改变攻击机行为，因此只保留它们在“敌人”栏中的地图对象。
    const excluded = new Set([0x3A, 0x3B]);
    for (let type = 0; type < 0x80; type++) {
      const ai = J.ENEMY_AI_MAP[type];
      if (ai && ai.s != null && !excluded.has(type)) ids.push(type);
    }
    // Boss 有些是 BG/逻辑对象（s:null），但仍有真实生命值表；这些
    // 类型必须能从“精灵参数”栏目直接选中，例如 0x18、0x25、0x26。
    for (const boss of (J.BOSS_HP || [])) {
      if (boss.spriteType != null && !ids.includes(boss.spriteType)) ids.push(boss.spriteType);
    }
    ids.sort((a, b) => a - b);
    return ids;
  }

  function spriteParamBoss(type) {
    return (J.BOSS_HP || []).find(b => b.spriteType === type) || null;
  }

  function spriteParamTypeName(type) {
    if ((type & 0x7F) === 0) return '无（不生成伴随）';
    return ENEMY_NAMES[type] || ('对象#' + type.toString(16).toUpperCase());
  }

  function buildBossCompanionPanel(box) {
    const entries = J.BOSS_COMPANIONS || [];
    if (!entries.length) return;
    const title = document.createElement('div');
    title.className = 'sprite-param-section-title';
    title.textContent = 'Boss 伴随设置（运行时生成）';
    box.appendChild(title);
    const hint = document.createElement('div');
    hint.className = 'sprite-param-affected';
    hint.textContent = '按 Boss 运行流程设置伴随对象；不写入地图、不放置画布精灵。下拉列表包含普通兵种、车辆、炮台、空中单位和已确认的特殊生成对象。';
    box.appendChild(hint);
    let shownLevel = -1;
    for (const entry of entries) {
      if (entry.level !== shownLevel) {
        shownLevel = entry.level;
        const levelTitle = document.createElement('div');
        levelTitle.className = 'sprite-param-section-title boss-level-title';
        levelTitle.textContent = '第' + (shownLevel + 1) + '关 Boss 伴随选项';
        box.appendChild(levelTitle);
      }
      const row = document.createElement('div');
      row.className = 'sprite-param-row boss-runtime-row';
      const label = document.createElement('label');
      label.textContent = entry.name;
      const select = document.createElement('select');
      select.className = 'sprite-param-type';
      const current = edit.bossCompanions && edit.bossCompanions[entry.id] != null
        ? edit.bossCompanions[entry.id] : entry.defaultValue;
      if (!entry.sites || !entry.sites.length) {
        const status = document.createElement('span');
        status.className = 'boss-companion-unavailable';
        status.textContent = '原版无独立伴随投放点';
        row.appendChild(label);
        row.appendChild(status);
        box.appendChild(row);
        continue;
      }
      const types = Array.isArray(entry.types) ? entry.types.slice() : [];
      if (!types.includes(current)) types.unshift(current);
      for (const type of types) {
        const opt = document.createElement('option');
        opt.value = type;
        opt.textContent = type === 0
          ? '00 ' + spriteParamTypeName(type)
          : '#' + type.toString(16).toUpperCase().padStart(2, '0') + ' ' + spriteParamTypeName(type);
        opt.selected = type === current;
        if (!entry.types.includes(type)) opt.textContent += '（当前值）';
        select.appendChild(opt);
      }
      select.title = 'Boss 运行时伴随类型';
      select.onchange = () => {
        pushUndo();
        if (!edit.bossCompanions) edit.bossCompanions = {};
        edit.bossCompanions[entry.id] = Number(select.value) & 0x7F;
        const selectedType = Number(select.value) & 0x7F;
        statusMsg('已将' + entry.name + '改为 ' + (selectedType === 0 ? '无' : '#' + selectedType.toString(16).toUpperCase().padStart(2, '0') + ' ' + spriteParamTypeName(selectedType)));
      };
      row.appendChild(label);
      row.appendChild(select);
      box.appendChild(row);
      if (entry.sites.length > 1) {
        const siteHint = document.createElement('div');
        siteHint.className = 'boss-companion-site-hint';
        siteHint.textContent = '该伴随在 Boss 流程中有 ' + entry.sites.length + ' 个自动投放点，修改后同步生效。';
        box.appendChild(siteHint);
      }
      if (entry.table) {
        const tableHint = document.createElement('div');
        tableHint.className = 'boss-companion-site-hint';
        tableHint.textContent = '来自 ROM 的按关卡运行时伴随表，不写入地图。';
        box.appendChild(tableHint);
      }
      if (entry.weaponGate && entry.weaponGate.length) {
        const gateRow = document.createElement('div');
        gateRow.className = 'sprite-param-row boss-runtime-row';
        const gateLabel = document.createElement('label');
        gateLabel.textContent = '最低火力要求';
        const gateSelect = document.createElement('select');
        gateSelect.className = 'sprite-param-type';
        const currentReq = edit.bossCompanionWeaponReq && edit.bossCompanionWeaponReq[entry.id] != null
          ? edit.bossCompanionWeaponReq[entry.id] : (entry.defaultWeaponLevel || 0);
        for (let req = 0; req <= 3; req++) {
          const opt = document.createElement('option');
          opt.value = req;
          opt.textContent = req === 0 ? '不限制' : '至少 ' + req + ' 级';
          if (req === currentReq) opt.selected = true;
          gateSelect.appendChild(opt);
        }
        gateSelect.title = '伴随对象出现所需的玩家武器等级；原版通常为至少 2 级';
        gateSelect.onchange = () => {
          pushUndo();
          if (!edit.bossCompanionWeaponReq) edit.bossCompanionWeaponReq = {};
          edit.bossCompanionWeaponReq[entry.id] = Number(gateSelect.value) & 3;
          statusMsg('已修改' + entry.name + '的最低火力要求');
        };
        gateRow.appendChild(gateLabel);
        gateRow.appendChild(gateSelect);
        box.appendChild(gateRow);
      } else {
        const gateHint = document.createElement('div');
        gateHint.className = 'boss-companion-site-hint';
        gateHint.textContent = '最低火力：不限制（ROM 未发现独立武器等级判断）';
        box.appendChild(gateHint);
      }
    }
  }

  function spriteHealthGlobal(type) {
    const p = edit && edit.spriteParams && edit.spriteParams.global && edit.spriteParams.global[type];
    return p && p.health != null ? p.health : 0;
  }

  function spriteHealthLevelOverride(type) {
    const levels = edit && edit.spriteParams && edit.spriteParams.levels;
    const p = levels && levels[level] && levels[level][type];
    return p && p.health != null ? p.health : null;
  }

  function buildSpriteParamsPanel() {
    const box = $('spriteParamsPanel');
    if (!box) return;
    box.innerHTML = '';
    if (!edit || !edit.spriteParams) return;
    buildBossCompanionPanel(box);
    const ids = spriteParamTypeIds();
    if (!ids.length) {
      box.textContent = '当前 ROM 没有可识别的精灵运行参数。';
      return;
    }
    if (!ids.includes(selEnemy)) selEnemy = ids[0];


    const hint = document.createElement('div');
    hint.className = 'enemy-hint';
    hint.textContent = '参数按精灵类型生效；未确认真实读取位置的攻击参数不会显示。';
    box.appendChild(hint);

    const scopeRow = document.createElement('div');
    scopeRow.className = 'sprite-param-scope';
    const scopeLabel = document.createElement('span');
    scopeLabel.className = 'muted';
    scopeLabel.textContent = '作用范围';
    scopeRow.appendChild(scopeLabel);
    for (const [value, label] of [['global', '全局'], ['level', '第' + (level + 1) + '关覆盖']]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'param-scope-btn' + (spriteParamScope === value ? ' active' : '');
      btn.textContent = label;
      btn.onclick = () => { spriteParamScope = value; buildSpriteParamsPanel(); };
      scopeRow.appendChild(btn);
    }
    box.appendChild(scopeRow);

    const typeRow = document.createElement('div');
    typeRow.className = 'sprite-param-type-row';
    const typeLabel = document.createElement('span');
    typeLabel.className = 'muted';
    typeLabel.textContent = '精灵类型';
    const typeSelect = document.createElement('select');
    typeSelect.className = 'sprite-param-type';
    for (const id of ids) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = '#' + id.toString(16).toUpperCase() + ' ' + spriteParamTypeName(id);
      opt.selected = id === selEnemy;
      typeSelect.appendChild(opt);
    }
    typeSelect.onchange = () => {
      selEnemy = Number(typeSelect.value);
      buildEnemyPanel();
      buildSpriteParamsPanel();
    };
    typeRow.appendChild(typeLabel);
    typeRow.appendChild(typeSelect);
    box.appendChild(typeRow);

    const affected = document.createElement('div');
    affected.className = 'sprite-param-affected';
    const selectedAi = J.ENEMY_AI_MAP[selEnemy];
    const shared = ids.filter(id => {
      const ai = J.ENEMY_AI_MAP[id];
      return selectedAi && ai && ai.s === selectedAi.s;
    });
    affected.textContent = shared.length > 1
      ? '共享同一精灵构造器的类型：' + shared.map(id => '#' + id.toString(16).toUpperCase()).join('、')
      : '当前参数只针对类型 #' + selEnemy.toString(16).toUpperCase();
    box.appendChild(affected);

    const row = document.createElement('div');
    row.className = 'sprite-param-row';
    const label = document.createElement('label');
    label.textContent = '生命值';
    const input = document.createElement('input');
    input.type = 'number'; input.min = 0; input.max = 127; input.step = 1;
    const override = spriteHealthLevelOverride(selEnemy);
    const selectedBoss = spriteParamBoss(selEnemy);
    const nativeBossValue = selectedBoss && edit.bossHp && edit.bossHp[selectedBoss.id] != null
      ? (edit.bossHp[selectedBoss.id] & 0x7F) : null;
    input.value = spriteParamScope === 'level' && override != null
      ? override : (nativeBossValue != null ? nativeBossValue : spriteHealthGlobal(selEnemy));
    input.title = spriteParamScope === 'level' && override == null ? '当前关尚未覆盖，正在继承全局值' : '生命值 0-127';
    let undoTaken = false;
    input.onfocus = () => { undoTaken = false; };
    input.oninput = () => {
      if (!undoTaken) { pushUndo(); undoTaken = true; }
      let value = parseInt(input.value, 10);
      if (!Number.isFinite(value)) return;
      value = Math.max(0, Math.min(127, value));
      input.value = value;
      if (spriteParamScope === 'global') {
        edit.spriteParams.global[selEnemy] = { health: value };
        const boss = spriteParamBoss(selEnemy);
        if (boss) edit.bossHp[boss.id] = value;
      } else {
        const map = edit.spriteParams.levels[level] || (edit.spriteParams.levels[level] = {});
        map[selEnemy] = { health: value };
      }
      updateSpriteStats();
      statusMsg('已修改 #' + selEnemy.toString(16).toUpperCase() + ' 生命值为 ' + value + (spriteParamScope === 'level' ? '（第' + (level + 1) + '关覆盖）' : '（全局）'));
    };
    row.appendChild(label); row.appendChild(input);
    box.appendChild(row);

    const actions = document.createElement('div');
    actions.className = 'sprite-param-actions';
    if (spriteParamScope === 'level') {
      const clear = document.createElement('button');
      clear.type = 'button'; clear.className = 'tool'; clear.textContent = '清除本关覆盖';
      clear.disabled = override == null;
      clear.onclick = () => {
        pushUndo();
        if (edit.spriteParams.levels[level]) delete edit.spriteParams.levels[level][selEnemy];
        buildSpriteParamsPanel();
        statusMsg('已清除第' + (level + 1) + '关覆盖，恢复全局值');
      };
      actions.appendChild(clear);
    }
    const reset = document.createElement('button');
    reset.type = 'button'; reset.className = 'tool'; reset.textContent = spriteParamScope === 'global' ? '恢复原版值' : '恢复继承值';
    reset.onclick = () => {
      pushUndo();
      if (spriteParamScope === 'global') {
        const d = edit.spriteParams.defaults && edit.spriteParams.defaults.global && edit.spriteParams.defaults.global[selEnemy];
        edit.spriteParams.global[selEnemy] = { health: d && d.health != null ? d.health : 0 };
        const boss = spriteParamBoss(selEnemy);
        if (boss) edit.bossHp[boss.id] = boss.defaultValue != null ? (boss.defaultValue & 0x7F) : edit.spriteParams.global[selEnemy].health;
      } else if (edit.spriteParams.levels[level]) {
        delete edit.spriteParams.levels[level][selEnemy];
      }
      buildSpriteParamsPanel();
      statusMsg('已恢复精灵参数');
    };
    actions.appendChild(reset);
    const boss = spriteParamBoss(selEnemy);
    if (boss) {
      const bossBtn = document.createElement('button');
      bossBtn.type = 'button'; bossBtn.className = 'tool'; bossBtn.textContent = '打开 Boss 设置';
      bossBtn.onclick = () => openBossModal();
      actions.appendChild(bossBtn);
    }
    box.appendChild(actions);
  }

  // ---------- level select ----------
  function buildLevelSelect() {
    const sel = $('levelSelect');
    sel.innerHTML = '';
    const selectLevel = (nextLevel) => {
      const next = Number(nextLevel);
      if (!Number.isInteger(next) || next < 0 || next >= 6) return;
      if (next !== level) {
        level = next; selTile = 0;
        undoStack = []; redoStack = []; updateUndoButtons(); // 撤销栈按关隔离
        buildTypeList();
        buildTilePalette(); buildEnemyPanel(); buildSpriteParamsPanel(); buildPalettePanel(); refreshAll(); updateEnemyPerScreen();
      }
      updateLevelSelect();
    };
    for (let i = 0; i < 6; i++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'level-switcher-button';
      button.textContent = '第' + (i + 1) + '关';
      button.dataset.level = i;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-label', '选择第 ' + (i + 1) + ' 关');
      button.onclick = () => selectLevel(i);
      sel.appendChild(button);
    }
    updateLevelSelect();
    // 精灵池：固定敌人 + 各关独有 + 道具（标注关卡归属），每个 checkbox 勾选随机 + 数量
    function buildTypeList(){
      const box = $('typeList'); if(!box) return;
      const G2 = window.JackalGen;
      if(!G2) return;
      // 每关默认勾选的精灵池：固定敌人永远勾选；每关独有的类型按关勾选；道具(0x50-0x52/0x15)默认不勾
      const DEFAULT_SPRITE_SELECT = {
        common: [0x01, 0x02, 0x05, 0x06, 0x07],
        0: [0x08, 0x0A],
        1: [0x0B, 0x3A, 0x3B, 0x0F, 0x21, 0x22, 0x10, 0x1F, 0x1E],
        2: [0x12, 0x4E, 0x11, 0x38, 0x53, 0x29, 0x1A],
        3: [0x04, 0x2C, 0x2D, 0x2F, 0x30, 0x35, 0x32, 0x33, 0x2B, 0x2A],
        4: [0x0E, 0x0C, 0x03, 0x19, 0x3A, 0x3B, 0x0B, 0x35],
        5: [0x43, 0x2E, 0x3A, 0x3B, 0x0F, 0x12, 0x4E],
      };
      box.innerHTML = '';
      const typeRow = (tid, nm) => {
        const row = document.createElement('span');
        row.className = 'chk type-row'; row.style.fontSize='11px'; row.style.display='inline-flex'; row.style.alignItems='center'; row.style.gap='2px';
        const checked = DEFAULT_SPRITE_SELECT.common.indexOf(tid) >= 0 || (DEFAULT_SPRITE_SELECT[level] || []).indexOf(tid) >= 0;
        row.innerHTML = '<input type="checkbox" class="typeChk" value="'+tid+'"'+(checked?' checked':'')+'> '+nm+
          ' <input type="number" class="typeCnt" data-t="'+tid+'" min="0" max="999" value="0" style="width:38px;font-size:10px;padding:1px 2px;background:#1c1f26;color:#eee;border:1px solid #444;border-radius:3px;" title="该兵种数量上限(0=不限)">';
        return row;
      };
      const uniq = G2.LEVEL_UNIQUE || [];
      for(const grp of uniq){
        const head = document.createElement('div');
        head.style.cssText = 'font-size:11px;color:var(--accent2);margin:4px 0 2px;font-weight:700;width:100%;';
        head.textContent = grp.name;
        box.appendChild(head);
        for(const [tid, nm] of grp.types){
          if(G2.NO_RANDOM_SPAWN && G2.NO_RANDOM_SPAWN.has(tid)) continue;
          box.appendChild(typeRow(tid, nm));
        }
      }
      updateTypeSelState();
    }
    function updateTypeSelState(){
      const chks = document.querySelectorAll('.typeChk');
      const all = $('btnTypeAll'), cl = $('btnTypeClear');
      if(all) all.style.display = chks.length ? '' : 'none';
      if(cl) cl.style.display = chks.length ? '' : 'none';
    }
    const _ta = $('btnTypeAll'); if(_ta) _ta.onclick = () => { document.querySelectorAll('.typeChk').forEach(c=>c.checked=true); };
    const _tc = $('btnTypeClear'); if(_tc) _tc.onclick = () => { document.querySelectorAll('.typeChk').forEach(c=>c.checked=false); };
    // 初始化精灵池列表（首次加载）
    buildTypeList();
    updateLevelSelect();
  }
  function updateLevelSelect() {
    document.querySelectorAll('#levelSelect .level-switcher-button').forEach(button => {
      const active = Number(button.dataset.level) === level;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.tabIndex = active ? 0 : -1;
    });
  }

  // ---------- tile palette ----------
  function renderTilePalette(box) {
    if (!box) return;
    box.innerHTML = '';
    const n = maxTile(level) + 1;
    for (let t = 0; t < n; t++) {
      const cell = document.createElement('button');
      cell.className = 'tile-cell';
      const c = tileImage(level, t);
      const cvs = document.createElement('canvas');
      cvs.width = 32; cvs.height = 32;
      cvs.getContext('2d').drawImage(c, 0, 0);
      const label = document.createElement('span');
      label.className = 'tile-label';
      label.textContent = '#' + t;
      cvs.title = '#' + t + ' (0x' + t.toString(16).toUpperCase().padStart(2, '0') + ')';
      cell.appendChild(cvs);
      cell.appendChild(label);
      cell.dataset.tile = t;
      if (t === selTile) cell.classList.add('active');
      cell.onclick = () => { selTile = t; buildTilePalette(); };
      box.appendChild(cell);
    }
  }
  function buildTilePalette() {
    renderTilePalette($('quickTilePalette'));
  }

  // ---------- global palette editor ----------
  let pickTarget = null;   // { g, c } — swatch currently being edited
  // 色相旋转 n 位（0-15），亮度不变；灰阶(0/E/F)保持
  function rotateHueColor(idx, n) {
    const hue = idx & 0x0F;
    if (hue === 0x00 || hue === 0x0E || hue === 0x0F) return idx;
    return (idx & 0x30) | ((hue + n) & 0x0F);
  }
  // 色相镜像（15 - hue），亮度不变；灰阶保持
  function mirrorHueColor(idx) {
    const hue = idx & 0x0F;
    if (hue === 0x00 || hue === 0x0E || hue === 0x0F) return idx;
    return (idx & 0x30) | ((15 - hue) & 0x0F);
  }
  // 亮度调整（0-3）
  function adjustBrightness(idx, n) {
    const hue = idx & 0x0F;
    const lum = (idx & 0x30) >> 4;
    const nl = Math.max(0, Math.min(3, lum + n));
    return hue | (nl << 4);
  }
  function invertBrightness(idx) {
    const hue = idx & 0x0F;
    const lum = (idx & 0x30) >> 4;
    return hue | ((3 - lum) << 4);
  }
  // 按方式名取反转函数（可多选叠加）
  function paletteInvertFn(mode) {
    let m;
    if ((m = /^hue(\d+)$/.exec(mode))) { const n = parseInt(m[1], 10) % 16; return i => rotateHueColor(i, n); }
    if ((m = /^briUp(\d)$/.exec(mode))) { const n = parseInt(m[1], 10); return i => adjustBrightness(i, n); }
    if ((m = /^briDn(\d)$/.exec(mode))) { const n = parseInt(m[1], 10); return i => adjustBrightness(i, -n); }
    switch (mode) {
      case 'briInv': return invertBrightness;
      case 'mirror': return mirrorHueColor;
      case 'rgb':    return invertRGBColor;
      default:       return i => i;
    }
  }
  // 反转方式 2：RGB 取反后映射到最近的 NES 64 色
  function invertRGBColor(idx) {
    const [r, g, b] = NES.rgb(idx);
    const ir = 255 - r, ig = 255 - g, ib = 255 - b;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < 64; i++) {
      const [r2, g2, b2] = NES.rgb(i);
      const d = (r2 - ir) * (r2 - ir) + (g2 - ig) * (g2 - ig) + (b2 - ib) * (b2 - ib);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
    // 反转方式选项（可多选叠加，按勾选顺序应用）
  const PAL_INVERT_MODES = (() => {
    const list = [];
    for (let n = 1; n <= 15; n++) list.push(['hue' + n, '色相+' + n]);
    list.push(['briUp1', '亮度+1'], ['briUp2', '亮度+2'], ['briUp3', '亮度+3']);
    list.push(['briDn1', '亮度-1'], ['briDn2', '亮度-2'], ['briDn3', '亮度-3']);
    list.push(['briInv', '亮度取反']);
    list.push(['mirror', '色相镜像']);
    list.push(['rgb', 'RGB取反']);
    return list;
  })();
    function buildPalettePanel() {
    const box = $('palettePanel');
    if (!box) return;
    box.innerHTML = '';
    // 反转色设置：勾选 = 反转，取消 = 恢复；反转方式可选「色相(蓝→红)」或「RGB取反」
    const applyInvert = () => {
      const on = cb.checked;
      const modes = [...box.querySelectorAll('input[name="palInvertMode"]:checked')].map(x => x.value);
      const pal = edit.palettes[level];
      if (!edit.paletteOrig) edit.paletteOrig = {};
      if (!edit.paletteOrig[level]) edit.paletteOrig[level] = pal.slice();
      const orig = edit.paletteOrig[level];
      for (let i = 0; i < pal.length; i++) pal[i] = orig[i];
      if (on) {
        for (const m of modes) {
          const inv = paletteInvertFn(m);
          for (let i = 0; i < pal.length; i++) pal[i] = inv(pal[i]);
        }
      }
      if (!edit.paletteInvert) edit.paletteInvert = [];
      if (!edit.paletteInvertModes) edit.paletteInvertModes = [];
      edit.paletteInvert[level] = on;
      edit.paletteInvertModes[level] = modes;
      tileImgCache = {};
      buildPalettePanel();
      refreshAll();
      const modeNames = {};
      for (const [v, label] of PAL_INVERT_MODES) modeNames[v] = label;
      statusMsg(on ? ('已启用反转色（' + (modes.length ? modes.map(m => modeNames[m] || m).join(' + ') : '无方式') + '）') : '已关闭反转色（已恢复原色）');
    };
    const setRow = document.createElement('div');
    setRow.className = 'pal-row';
    const lbl = document.createElement('label');
    lbl.className = 'chk';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!(edit.paletteInvert && edit.paletteInvert[level]);
    cb.onchange = applyInvert;
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(' 反转色'));
    setRow.appendChild(lbl);
    box.appendChild(setRow);
    // 反转方式多选（分组：色相15 + 亮度7 + 其他2，可多选叠加）
    const modeBox = document.createElement('div');
    modeBox.className = 'pal-row';
    modeBox.style.flexDirection = 'column';
    modeBox.style.alignItems = 'flex-start';
    modeBox.style.gap = '2px';
    const selModes = (edit.paletteInvertModes && edit.paletteInvertModes[level]) || [];
    const groups = [
      ['色相', PAL_INVERT_MODES.slice(0, 15)],
      ['亮度', PAL_INVERT_MODES.slice(15, 22)],
      ['其他', PAL_INVERT_MODES.slice(22)],
    ];
    for (const [title, modes] of groups) {
      const g = document.createElement('div');
      g.style.display = 'flex';
      g.style.flexWrap = 'wrap';
      g.style.alignItems = 'center';
      g.style.gap = '1px 8px';
      const t = document.createElement('span');
      t.className = 'muted';
      t.style.fontSize = '12px';
      t.textContent = title;
      g.appendChild(t);
      for (const [v, label] of modes) {
        const ml = document.createElement('label');
        ml.className = 'chk';
        const mc = document.createElement('input');
        mc.type = 'checkbox'; mc.name = 'palInvertMode'; mc.value = v;
        mc.checked = selModes.includes(v);
        mc.onchange = () => { if (cb.checked) applyInvert(); };
        ml.appendChild(mc);
        ml.appendChild(document.createTextNode(label));
        g.appendChild(ml);
      }
      modeBox.appendChild(g);
    }
    box.appendChild(modeBox);
    const names = ['背景0', '背景1', '背景2', '背景3', '精灵0', '精灵1', '精灵2', '精灵3'];
    const pal = edit.palettes[level];
    for (let g = 0; g < 8; g++) {
      const row = document.createElement('div');
      row.className = 'pal-row';
      const lab = document.createElement('span');
      lab.className = 'pal-label';
      lab.textContent = names[g];
      row.appendChild(lab);
      for (let c = 0; c < 4; c++) {
        const idx = g * 4 + c;
        const sw = document.createElement('button');
        sw.className = 'pal-swatch';
        sw.style.background = NES.hex(pal[idx]);
        sw.title = '0x' + pal[idx].toString(16).toUpperCase().padStart(2, '0');
        sw.dataset.g = g; sw.dataset.c = c;
        sw.onclick = () => openPalettePicker(g, c);
        row.appendChild(sw);
      }
      box.appendChild(row);
    }
  }
  function openPalettePicker(g, c) {
    pickTarget = { g, c };
    const picker = $('palettePicker');
    if (!picker) return;
    picker.innerHTML = '';
    for (let i = 0; i < 64; i++) {
      const sw = document.createElement('button');
      sw.className = 'pal-option';
      sw.style.background = NES.hex(i);
      sw.title = '0x' + i.toString(16).toUpperCase().padStart(2, '0');
      sw.onclick = () => {
        edit.palettes[level][g * 4 + c] = i;
        tileImgCache = {};
        picker.hidden = true;
        pickTarget = null;
        buildPalettePanel();
        refreshAll();
      };
      picker.appendChild(sw);
    }
    picker.hidden = false;
  }

  // ---------- level rendering ----------
  function snapshotLevel(l) {
    const e = edit.levels[l];
    return {
      idx: e.idx.slice(),
      layoutBlocks: e.layoutBlocks.map(b => b.slice()),
      spawns: e.spawns.map(s => (s ? s.slice() : s)),
      def: e.def.slice(),
      pal: e.pal.slice(),
      spriteParams: edit.spriteParams ? JSON.parse(JSON.stringify(edit.spriteParams)) : null,
      bossHp: edit.bossHp ? { ...edit.bossHp } : null,
      bossCount: edit.bossCount ? { ...edit.bossCount } : null,
      bossPos: edit.bossPos ? JSON.parse(JSON.stringify(edit.bossPos)) : null,
      bossCompanions: edit.bossCompanions ? { ...edit.bossCompanions } : null,
      bossCompanionWeaponReq: edit.bossCompanionWeaponReq ? { ...edit.bossCompanionWeaponReq } : null,
    };
  }
  function restoreLevel(l, snap) {
    const e = edit.levels[l];
    e.idx = snap.idx.slice();
    e.layoutBlocks = snap.layoutBlocks.map(b => b.slice());
    e.spawns = snap.spawns.map(s => (s ? s.slice() : s));
    e.def = snap.def.slice();
    e.pal = snap.pal.slice();
    if (snap.spriteParams) edit.spriteParams = JSON.parse(JSON.stringify(snap.spriteParams));
    if (snap.bossHp) edit.bossHp = { ...snap.bossHp };
    if (snap.bossCount) edit.bossCount = { ...snap.bossCount };
    if (snap.bossPos) edit.bossPos = JSON.parse(JSON.stringify(snap.bossPos));
    if (snap.bossCompanions) edit.bossCompanions = { ...snap.bossCompanions };
    if (snap.bossCompanionWeaponReq) edit.bossCompanionWeaponReq = { ...snap.bossCompanionWeaponReq };
  }
  function pushUndo() {
    undoStack.push({ level, snap: snapshotLevel(level) });
    if (undoStack.length > 60) undoStack.shift();
    redoStack = [];
    updateUndoButtons();
  }
  function doUndo() {
    if (!undoStack.length) { statusMsg('没有可撤销的操作'); return; }
    redoStack.push({ level, snap: snapshotLevel(level) });
    const u = undoStack.pop();
    restoreLevel(u.level, u.snap);
    enemySel = null; pasteMode = false; pastePos = null; selRect = null;
    refreshAll();
    updateUndoButtons();
    statusMsg('已撤销（还剩 ' + undoStack.length + ' 步）');
  }
  function doRedo() {
    if (!redoStack.length) { statusMsg('没有可恢复的操作'); return; }
    undoStack.push({ level, snap: snapshotLevel(level) });
    const r = redoStack.pop();
    restoreLevel(r.level, r.snap);
    enemySel = null; pasteMode = false; pastePos = null; selRect = null;
    refreshAll();
    updateUndoButtons();
    statusMsg('已恢复');
  }
  function updateUndoButtons() {
    const u = $('btnUndo'), r = $('btnRedo');
    if (u) u.disabled = !undoStack.length;
    if (r) r.disabled = !redoStack.length;
  }
  $('btnUndo').onclick = () => doUndo();
  $('btnRedo').onclick = () => doRedo();

  function updateScreenInfo(){
    const e = edit.levels[level];
    if(!e) return;
    const el = $('screenInfo');
    if(!el) return;
    // 数据大小：idx + layout + def + pal
    const dataSz = e.idx.length + e.layoutBlocks.length * 128 + e.def.length + e.pal.length;
    const maxS = maxScreens(e, level);
    el.textContent = e.idx.length + ' 段 · 还能加 ' + Math.max(0, maxS - e.idx.length) + ' 段 · 数据 ' + dataSz + '/16376';
  }
  function refreshAll() {
    updateSpacer();
    drawLevel();          // drawLevel 末尾会实时刷新 screenInfo / spriteStats
  }

  // 精灵统计：本关精灵总数 + 每屏数量 + 哪些屏超数量限制（屏号自下而上，屏1=起点）
  function updateSpriteStats(){
    const el = $('spriteStats');
    if(!el) return;
    const e = edit.levels[level];
    if(!e) { el.innerHTML = ''; return; }
    const G = window.JackalGen;
    const safeTotal = (G && G.SAFE_PER_SCREEN) || 16;
    const safePri   = (G && G.SAFE_PRIORITY_PER_SCREEN) || 8;
    const apprScr   = (G && G.BOSS_APPROACH_SCREENS) || 2;
    const apprMax   = (G && G.BOSS_APPROACH_MAX) || 6;
    const apprPri   = (G && G.BOSS_APPROACH_PRIORITY_MAX) || 1;
    const bossMax   = (G && G.BOSS_SCREEN_MAX) || 2;
    // 类型名表：编辑器类型列表 + 结构配套精灵的补充名
    const typeNames = {};
    if(G && G.LEVEL_UNIQUE){ for(const grp of G.LEVEL_UNIQUE){ for(const [tid, nm] of grp.types){ typeNames[tid] = nm; } } }
    Object.assign(typeNames, {
      0x00:'0x00', 0x08:'攻击艇', 0x09:'1关Boss', 0x0D:'激光充能',
      0x13:'POW房·2人右', 0x14:'POW房·2人左',    // POW房 = 战俘房，按人数与出门方向区分
      0x16:'POW行走', 0x17:'5关Boss', 0x18:'2关Boss头像', 0x1B:'门',
      0x1C:'POW房·4人右', 0x1D:'POW房·4人左',
      0x26:'5关电门', 0x31:'5关Boss门',
      0x3A:'攻击机·定点', 0x3B:'攻击机·任意',    // AttackPlane：定点投放 / 任意位置
      0x3C:'救援直升机',                        // POW 救援直升机
      0x3D:'降落飞机·右', 0x3E:'降落飞机·左',    // 停机坪上人方向
      0x3F:'POW放人点',
      0x46:'结束判定',
    });
    const boss = findBossScreen();
    let total = 0, totalPri = 0;
    const perScreen = [];
    const perPri = [];
    const byType = {};
    for(let s = 0; s < e.idx.length; s++){
      const list = e.spawns[s] || [];
      let n = 0, pri = 0, i = 0;
      while(i < list.length){
        const y = list[i];
        if(y === 0xEF) break;
        if(y === 0xF0 || y === 0xF1 || y === 0xF2){ i += 2; continue; }
        n++;
        const t7 = list[i + 2] & 0x7F;
        if(list[i + 2] & 0x80) pri++;
        byType[t7] = (byType[t7] || 0) + 1;
        i += 3;
      }
      total += n; totalPri += pri;
      perScreen.push(n); perPri.push(pri);
    }
    // 超限清单
    const over = [];
    for(let s = 0; s < perScreen.length; s++){
      const isBoss = (s === boss);
      const nearBoss = (s >= boss - apprScr) && (s <= boss);
      const capTotal = isBoss ? bossMax : (nearBoss ? apprMax : safeTotal);
      const capPri   = isBoss ? 0 : (nearBoss ? apprPri : safePri);
      if(isBoss) continue;   // Boss 屏是原版战区（恢复原样），不标超限
      if(perScreen[s] > capTotal) over.push('屏' + (s + 1) + '=' + perScreen[s] + ' 个');
      else if(perPri[s] > capPri) over.push('屏' + (s + 1) + ' 优先=' + perPri[s] + ' 个');
    }
    // 汇总（不铺全屏数字，超限屏由下方 ⚠ 行点名）
    let maxN = 0, maxS = 0;
    for(let s = 0; s < perScreen.length; s++) if(perScreen[s] > maxN){ maxN = perScreen[s]; maxS = s; }
    const avg = perScreen.length ? (total / perScreen.length) : 0;
    let html = '👾 精灵 <b>' + total + '</b> 个（优先 ' + totalPri + '）· 共 ' + e.idx.length + ' 屏'
      + ' · 平均 ' + avg.toFixed(1) + '/屏 · 最多 <b>' + maxN + '</b>（屏' + (maxS + 1) + '）';
    // 各类型数量（从多到少）
    const typeParts = [];
    const typs = Object.keys(byType).map(Number).sort((a,b)=>byType[b]-byType[a]);
    for(const t of typs){
      const nm = typeNames[t] || ('0x' + t.toString(16).toUpperCase());
      typeParts.push('<b>' + nm + '</b>×' + byType[t]);
    }
    if(typeParts.length){
      html += '<br><span style="font-size:11px">类型: ' + typeParts.join(' · ') + '</span>';
    }
    if(over.length){
      html += '<br><span style="color:#ff8b8b;font-weight:700">⚠ 超限: ' + over.join('、') + '</span>';
    } else {
      html += '<br><span style="color:#4ade80">✓ 每屏都在上限内（普通屏 ' + safeTotal + ' / 近Boss ' + apprMax + ' / Boss ' + bossMax + '）</span>';
    }
    el.innerHTML = html;
    el.title = '本关精灵统计（屏号自下而上：屏1=起点，最后一屏=Boss 战）。\n' +
      '普通屏上限 ' + safeTotal + ' 个 / 优先精灵上限 ' + safePri + ' 个；\n' +
      '近 Boss 前 ' + apprScr + ' 屏上限 ' + apprMax + ' 个（优先 ' + apprPri + '）；Boss 屏上限 ' + bossMax + ' 个。\n' +
      '超限的屏会在 ⚠ 行里逐屏点名；超了可用「删选定精灵」减少该屏数量。';
  }

  function drawLevel() {
    // Final display-side guard for legacy L3 tile 27 remnants (0x1B/0x27).
    if (level === 2) {
      const e3 = edit.levels[level];
      const boss3 = findBossScreen();
      const bossBlock = boss3 >= 0 ? e3.idx[boss3] : -1;
      for (let s3 = 0; s3 < e3.idx.length; s3++) {
        if (s3 === boss3) continue;
        let bi3 = e3.idx[s3];
        let b3 = e3.layoutBlocks[bi3];
        if (!b3) continue;
        if (bi3 === bossBlock) {
          b3 = b3.slice();
          e3.layoutBlocks.push(b3);
          e3.idx[s3] = e3.layoutBlocks.length - 1;
        }
        for (let i3 = 0; i3 < b3.length; i3++) {
          const t3 = b3[i3] & 0x7F;
          if (t3 === 0x1B || t3 === 0x27) b3[i3] = 0x07;
        }
      }
    }
    const e = edit.levels[level];
    const n = e.idx.length;
    const sc = $('canvasScroll');
    const vw = sc.clientWidth, vh = sc.clientHeight;
    levelCanvas.width = vw;
    levelCanvas.height = vh;
    levelCanvas.style.width = vw + 'px';
    levelCanvas.style.height = vh + 'px';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, vw, vh);
    const ox = sc.scrollLeft, oy = sc.scrollTop;
    const gx0 = Math.max(0, Math.floor(ox / (TILE * zoom)));
    const gy0 = Math.max(0, Math.floor(oy / (TILE * zoom)));
    const gx1 = Math.min(COLS - 1, Math.floor((ox + vw) / (TILE * zoom)));
    const gy1 = Math.min(n * ROWS - 1, Math.floor((oy + vh) / (TILE * zoom)));
    for (let gy = gy0; gy <= gy1; gy++) {
      const s = (n - 1) - Math.floor(gy / ROWS), row = gy % ROWS;
      const block = e.layoutBlocks[e.idx[s]];
      const sy = gy * TILE * zoom - oy;
      for (let gx = gx0; gx <= gx1; gx++) {
        const tile = block[(ROWS - 1 - row) * COLS + gx];
        ctx.drawImage(tileImage(level, tile), gx * TILE * zoom - ox, sy, TILE * zoom, TILE * zoom);
      }
    }
    // screen separators + labels (visible screens only)
    const boss = findBossScreen();
    const sTop = (n - 1) - Math.floor(gy0 / ROWS);
    const sBot = (n - 1) - Math.floor(gy1 / ROWS);
    for (let s = sTop; s >= sBot; s--) {
      const topY = (n - 1 - s) * ROWS * TILE * zoom - oy;
      ctx.strokeStyle = 'rgba(255,255,0,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, topY + 0.5); ctx.lineTo(vw, topY + 0.5); ctx.stroke();
      if (s === boss) { ctx.fillStyle = 'rgba(245,166,35,0.9)'; ctx.font = 'bold 12px sans-serif'; ctx.fillText('BOSS 战·下', 4, topY + 14); }
      else if (s === n - 1) { ctx.fillStyle = 'rgba(255,255,255,0.65)'; ctx.font = '11px sans-serif'; ctx.fillText('BOSS 战·上', 4, topY + 13); }
    }
    // grid
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1;
    for (let gx = gx0; gx <= gx1 + 1; gx++) { const sx = gx * TILE * zoom - ox + 0.5; ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, vh); ctx.stroke(); }
    for (let gy = gy0; gy <= gy1 + 1; gy++) { const sy = gy * TILE * zoom - oy + 0.5; ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(vw, sy); ctx.stroke(); }
    if (tool === 'enemy' || tool === 'pan' || tool === 'select' || tool === 'eraser') drawEnemies();
    if (selRect) {
      const sx = selRect.x0 * zoom - ox, sy = selRect.y0 * zoom - oy;
      const sw = (selRect.x1 - selRect.x0) * zoom, sh = (selRect.y1 - selRect.y0) * zoom;
      ctx.fillStyle = 'rgba(77,195,255,0.18)';
      ctx.fillRect(sx, sy, sw, sh);
      ctx.strokeStyle = '#4dc3ff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);
      ctx.setLineDash([]);
    }
    if (pasteMode && pastePos && clipboard) {
      const sx = Math.floor(pastePos.x / TILE) * TILE * zoom - ox;
      const sy = Math.floor(pastePos.y / TILE) * TILE * zoom - oy;
      ctx.fillStyle = 'rgba(255,210,77,0.14)';
      ctx.fillRect(sx, sy, clipboard.pw * zoom, clipboard.ph * zoom);
      ctx.strokeStyle = '#ffd24d';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(sx + 0.5, sy + 0.5, clipboard.pw * zoom - 1, clipboard.ph * zoom - 1);
      ctx.setLineDash([]);
    }
    if (tool === 'bossPos' || tool === 'pan') drawBossPositions();
    // 实时刷新统计：任何编辑（加/删/移动精灵、撤销重做、切屏、改图块）后重绘都会走到这里
    updateSpriteStats();
    updateScreenInfo();
  }

  // ---------- enemies layer ----------
  function drawEnemies() {
    const e = edit.levels[level];
    const n = e.idx.length;
    const sc = $('canvasScroll');
    const ox = sc.scrollLeft, oy = sc.scrollTop;
    for (let s = 0; s < e.spawns.length; s++) {
      const list = e.spawns[s];
      if (!list || list.length <= 1) continue;
      const top = (n - 1 - s) * ROWS * TILE;
      let i = 0;
      while (i < list.length) {
        const y = list[i];
        if (y === 0xEF) break;
        if (y === 0xF0 || y === 0xF1 || y === 0xF2) { i += 2; continue; }
        const x = list[i + 1], type = list[i + 2];
        const px = (x & 0x7F) * 4, py = (ROWS * TILE - 1) - y;
        const sx = px * zoom - ox, sy = (top + py) * zoom - oy;
        if (sx < -48 * zoom || sx > levelCanvas.width + 48 * zoom || sy < -48 * zoom || sy > levelCanvas.height + 48 * zoom) { i += 3; continue; }
        const high = (x & 0x80) !== 0;
        const isSel = enemySel && enemySel.screen === s && enemySel.off === i;
        const box = renderEnemySprite(ctx, level, type, sx, sy, zoom);
        if (box) {
          ctx.fillStyle = '#000';
          ctx.font = 'bold ' + Math.max(5, Math.round(6 * zoom)) + 'px sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText((type & 0x7F).toString(16).toUpperCase(), box.maxX + 2, box.minY + 6);
          if (isSel) {
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(box.minX - 1, box.minY - 1, box.maxX - box.minX + 2, box.maxY - box.minY + 2);
            const nm = ENEMY_NAMES[type & 0x7F] || '';
            ctx.font = 'bold ' + Math.max(8, Math.round(10 * zoom)) + 'px sans-serif';
            ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
            ctx.strokeText(nm, box.minX, box.minY - 4);
            ctx.fillStyle = '#fff';
            ctx.fillText(nm, box.minX, box.minY - 4);
            ctx.lineWidth = 1;
          }
        } else {
          ctx.fillStyle = high ? '#ff5533' : '#ffe04d';
          ctx.strokeStyle = isSel ? '#fff' : '#000';
          ctx.lineWidth = isSel ? 2 : 1;
          ctx.beginPath();
          ctx.arc(sx + 3 * zoom, sy + 3 * zoom, (isSel ? 8 : 5) * zoom, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.lineWidth = 1;
          ctx.fillStyle = '#000';
          ctx.font = 'bold ' + Math.max(5, Math.round(6 * zoom)) + 'px sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText((type & 0x7F).toString(16).toUpperCase(), sx + 8 * zoom, sy + 6 * zoom);
        }
        i += 3;
      }
    }
  }

  // ---------- boss position markers (drag on map) ----------
  // 当前关对应的有位置标记的 Boss（0-based level -> boss id）
  const LEVEL_BOSS_ID = { 1: 'l2boss', 2: 'l3boss', 4: 'l5door', 5: 'l6turret' };
  // 无独立垂直位置表的 Boss，其固定屏幕 Y（生成逻辑里硬编码）
  const BOSS_FIXED_Y = { l2boss: 0x1C, l5door: 0x48, l6turret: 0x29 };
  const BOSS_SHORT_NAME = { l2boss: '雕像头', l3boss: '炮塔', l5door: '门', l6turret: '激光炮' };
  function bossScreenTop() {
    const e = edit.levels[level];
    const n = e.idx.length;
    return (n - 1 - findBossScreen()) * ROWS * TILE;
  }
  function drawBossPositions() {
    if (!edit.bossPos) return;
    const id = LEVEL_BOSS_ID[level];
    if (!id) return;
    const pos = edit.bossPos[id];
    if (!pos) return;
    const count = Math.min(edit.bossCount[id] || 1, J.POS_MAX);
    const fixedY = BOSS_FIXED_Y[id];
    const name = BOSS_SHORT_NAME[id];
    const top = bossScreenTop();
    const sc = $('canvasScroll');
    const ox = sc.scrollLeft, oy = sc.scrollTop;
    for (let k = 0; k < count; k++) {
      const wx = pos.x[k];
      const wy = top + (pos.y ? pos.y[k] : fixedY);
      const sx = wx * zoom - ox, sy = wy * zoom - oy;
      if (sx < -40 || sx > levelCanvas.width + 40 || sy < -40 || sy > levelCanvas.height + 40) continue;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(sx, sy, 5 * zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // 文字标注：名称 + 序号
      const lbl = name + (k + 1);
      ctx.font = 'bold ' + Math.max(9, Math.round(11 * zoom)) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3;
      ctx.strokeText(lbl, sx, sy - 9 * zoom);
      ctx.fillStyle = '#fff';
      ctx.fillText(lbl, sx, sy - 9 * zoom);
      ctx.textAlign = 'left';
    }
  }
  function findBossPosNear(wx, wy) {
    if (!edit.bossPos) return null;
    const id = LEVEL_BOSS_ID[level];
    if (!id) return null;
    const pos = edit.bossPos[id];
    const count = Math.min(edit.bossCount[id] || 1, J.POS_MAX);
    const fixedY = BOSS_FIXED_Y[id];
    const top = bossScreenTop();
    for (let k = 0; k < count; k++) {
      const px = pos.x[k];
      const py = top + (pos.y ? pos.y[k] : fixedY);
      if (Math.abs(px - wx) < 14 && Math.abs(py - wy) < 14) return { id, k };
    }
    return null;
  }
  function updateBossPos(drag, w) {
    const pos = edit.bossPos[drag.id];
    const top = bossScreenTop();
    pos.x[drag.k] = Math.max(0, Math.min(0x1FF, Math.round(w.x)));
    if (pos.y) pos.y[drag.k] = Math.max(0, Math.min(0xFF, Math.round(w.y - top)));
  }

  // ---------- pointer -> tile coords ----------
  function pointerToTile(ev) {
    const w = pointerToCanvas(ev);
    const col = Math.floor(w.x / TILE);
    const e = edit.levels[level];
    const n = e.idx.length;
    if (col < 0 || col >= COLS) return null;
    const seg = Math.floor(w.y / (ROWS * TILE)); // 0 = top segment of canvas
    if (seg < 0 || seg >= n) return null;
    const screen = n - 1 - seg; // top segment = boss screen (last)
    const rowInScreen = Math.floor((w.y - seg * ROWS * TILE) / TILE);
    if (rowInScreen < 0 || rowInScreen >= ROWS) return null;
    return { screen, row: rowInScreen, col };
  }

  // pixel coords (in canvas px) -> { screen, sy } (sy = y within the screen)
  function pointerToScreenPx(cx, cy) {
    const e = edit.levels[level];
    const n = e.idx.length;
    const seg = Math.floor(cy / (ROWS * TILE));
    if (seg < 0 || seg >= n) return null;
    const screen = n - 1 - seg;
    return { screen, sy: cy - seg * ROWS * TILE };
  }
  // find an enemy entry index within a spawn list near (cx, sy); returns offset or -1
  function enemyNear(list, cx, sy) {
    let best = -1, bestD = 14, i = 0;
    while (i < list.length) {
      const y = list[i];
      if (y === 0xEF) break;
      if (y === 0xF0 || y === 0xF1 || y === 0xF2) { i += 2; continue; }
      const x = list[i + 1];
      const px = (x & 0x7F) * 4;
      const d = Math.hypot(px - cx, (ROWS * TILE - 1 - y) - sy);
      if (d < bestD) { bestD = d; best = i; }
      i += 3;
    }
    return best;
  }
  // 删除指定敌人条目（不含撤销快照；调用方负责 pushUndo）
  function deleteEnemyAt(list, hit) {
    if (!list || hit < 0) return;
    list.splice(hit, 3);
    if (list.length === 0) list.push(0xEF);
    statusMsg('已删除敌人');
    drawLevel();
  }
  // 移动已选中的敌人到指定屏/坐标（敌人工具与移动工具共用）
  function moveSelectedEnemy(sp, cx){
    const e = edit.levels[level];
    const srcList = e.spawns[enemySel.screen];
    const off = enemySel.off;
    if (srcList && off >= 0 && off + 2 < srcList.length) {
      pushUndo();
      const type = srcList[off + 2];
      const oldX = srcList[off + 1];
      let y = Math.round(ROWS * TILE - 1 - sp.sy) & ~3, x = Math.floor(cx / 4);
      if (enemyPlaceCondition === 'maxWeapon') {
        y |= 1;
        if (y === 0xEF) y = 0xED;
      }
      if (y > (enemyPlaceCondition === 'maxWeapon' ? 0xED : 0xEE)) {
        y = enemyPlaceCondition === 'maxWeapon' ? 0xED : 0xEE;
      }
      if (y < 0) y = 0;
      if (x < 0) x = 0; if (x > 0xFF) x = 0xFF;
      x |= (oldX & 0x80); // 保留屏底生成标志
      const list = e.spawns[sp.screen] || (e.spawns[sp.screen] = [0xEF]);
      if (sp.screen === enemySel.screen) {
        srcList[off] = y; srcList[off + 1] = x; // type 不变
      } else {
        srcList.splice(off, 3);
        if (srcList.length === 0) srcList.push(0xEF);
        insertSpawnSorted(list, y, x, type);
      }
    }
    enemySel = null;
    drawLevel();
  }
  function paintEnemy(ev) {
    const w = pointerToCanvas(ev);
    const cx = w.x, cy = w.y;
    const sp = pointerToScreenPx(cx, cy);
    if (!sp) return;
    const e = edit.levels[level];
    const list = e.spawns[sp.screen] || (e.spawns[sp.screen] = [0xEF]);
    // 已选中敌人 → 点击任意位置 = 移动它到新坐标
    if (enemySel) { moveSelectedEnemy(sp, cx); return; }
    const hit = enemyNear(list, cx, sp.sy);
    if (hit >= 0) {
      // 点已有敌人 = 选中（进入移动模式，不删除）
      enemySel = { screen: sp.screen, off: hit };
      const selId = (list[hit + 2] & 0x7F);
      selEnemy = selId;
      enemyPlaceCondition = enemyConditionFromY(list[hit]);
      buildEnemyPanel();
      buildSpriteParamsPanel();
      statusMsg('已选中敌人 #' + selId.toString(16).toUpperCase() + ' ' + (ENEMY_NAMES[selId] || '') + ' · 点击新位置移动 · 右键/Esc 取消');
      drawLevel();
      return;
    }
    // 空白 → 放置当前选中的敌人 (spawn y is bottom-up; 对齐 ≡0 mod4 保证滚动触发)
    let y = (Math.round(ROWS * TILE - 1 - sp.sy) & ~3), x = Math.floor(cx / 4);
    if (enemyPlaceCondition === 'maxWeapon') {
      y |= 1;
      if (y === 0xEF) y = 0xED;
    }
    if (y > (enemyPlaceCondition === 'maxWeapon' ? 0xED : 0xEE)) {
      y = enemyPlaceCondition === 'maxWeapon' ? 0xED : 0xEE;
    }
    if (y < 0) y = 0;
    if (x < 0) x = 0; if (x > 0xFF) x = 0xFF;
    pushUndo();
    insertSpawnSorted(list, y, x, selEnemy & 0x7F);
    drawLevel();
  }
  // 右键：有选中 → 取消；无选中且点了敌人 → 删除
  function onEnemyRightClick(ev) {
    if (enemySel) { enemySel = null; statusMsg('已取消选择'); drawLevel(); return; }
    if (tool !== 'enemy') return;
    const rect = levelCanvas.getBoundingClientRect();
    const cx = (ev.clientX - rect.left) * (levelCanvas.width / rect.width);
    const cy = (ev.clientY - rect.top) * (levelCanvas.height / rect.height);
    const sp = pointerToScreenPx(cx, cy);
    if (!sp) return;
    const e = edit.levels[level];
    const list = e.spawns[sp.screen];
    if (!list) return;
    const hit = enemyNear(list, cx, sp.sy);
    if (hit >= 0) {
      pushUndo();
      deleteEnemyAt(list, hit);
    }
  }
  // Esc 取消选择 / Ctrl+Z 撤销 / Ctrl+Y 恢复
  document.addEventListener('keydown', (ev) => {
    const inInput = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target && ev.target.tagName);
    if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && (ev.key === 'z' || ev.key === 'Z')) {
      if (inInput) return; // 输入框里让浏览器自己处理
      ev.preventDefault();
      doUndo();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'y' || ev.key === 'Y' ||
        (ev.shiftKey && (ev.key === 'z' || ev.key === 'Z')))) {
      if (inInput) return;
      ev.preventDefault();
      doRedo();
      return;
    }
    if (ev.key === 'Escape') {
      if (enemySel) { enemySel = null; statusMsg('已取消选择'); drawLevel(); }
      if (pasteMode) { pasteMode = false; pastePos = null; statusMsg('已取消粘贴'); drawLevel(); }
      if (selRect && tool === 'select') { selRect = null; statusMsg('已清除选区'); drawLevel(); }
    }
  });
  function paint(ev) {
    if (tool === 'enemy') { paintEnemy(ev); return; }
    const w = pointerToCanvas(ev);
    const cx = w.x, cy = w.y;
    const sp = pointerToScreenPx(cx, cy);
    // eraser removes enemies when clicking near one (enemies are drawn in eraser mode)
    if (tool === 'eraser' && sp) {
      const list = edit.levels[level].spawns[sp.screen];
      const hit = list ? enemyNear(list, cx, sp.sy) : -1;
      if (hit >= 0) { deleteEnemyAt(list, hit); return; }
    }
    const pos = pointerToTile(ev);
    if (!pos) return;
    const e = edit.levels[level];
    const n = e.idx.length;
    const gx = pos.col;
    const gy = (n - 1 - pos.screen) * ROWS + pos.row; // 全局行（从顶）
    const tile = (tool === 'eraser') ? emptyGround(level) : selTile;
    for (let dy = 0; dy < brushSize; dy++) {
      const gyy = gy + dy;
      if (gyy < 0 || gyy >= n * ROWS) continue;
      const s = (n - 1) - Math.floor(gyy / ROWS), row = gyy % ROWS;
      const block = e.layoutBlocks[e.idx[s]];
      for (let dx = 0; dx < brushSize; dx++) {
        const gxx = gx + dx;
        if (gxx < 0 || gxx >= COLS) continue;
        block[(ROWS - 1 - row) * COLS + gxx] = tile;
      }
    }
    drawLevel();
  }
  function insertSpawnSorted(list, y, x, type) {
    let i = 0;
    while (i < list.length) {
      const yy = list[i];
      if (yy === 0xEF) break;         // terminator stays last
      if (yy >= 0xF0) { i += 2; continue; } // skip F0/F1/F2 special entries
      if (yy > y) break;              // first entry with larger y
      i += 3;
    }
    list.splice(i, 0, y, x, type);
  }
  function screenToWorld(sx, sy) {
    const sc = $('canvasScroll');
    return { x: (sx + sc.scrollLeft) / zoom, y: (sy + sc.scrollTop) / zoom };
  }
  function worldToScreen(wx, wy) {
    const sc = $('canvasScroll');
    return { x: wx * zoom - sc.scrollLeft, y: wy * zoom - sc.scrollTop };
  }
  function updateSpacer() {
    const sp = $('canvasSpacer');
    const e = edit.levels[level];
    if (!sp) return;
    sp.style.width = COLS * TILE * zoom + 'px';
    sp.style.height = (e ? e.idx.length : 0) * ROWS * TILE * zoom + 'px';
  }
  function pointerToCanvas(ev) {
    const rect = levelCanvas.getBoundingClientRect();
    return screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top);
  }
  function normRect(a, b) {
    return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
  }
  function e2spawn(sp) {
    const e = edit.levels[level];
    return (e.spawns[sp.screen] || (e.spawns[sp.screen] = [0xEF]));
  }

  let drawing = false;
  let panState = null;
  // plain wheel scrolls the container; Ctrl+wheel zooms
  levelCanvas.addEventListener('wheel', (ev) => {
    if (ev.ctrlKey) {
      ev.preventDefault();
      zoomBy(ev.deltaY < 0 ? 1.2 : 1 / 1.2);
    }
  });
  // virtual scrolling: redraw viewport on scroll
  $('canvasScroll').addEventListener('scroll', () => drawLevel());
  levelCanvas.addEventListener('pointerdown', (ev) => {
    levelCanvas.setPointerCapture(ev.pointerId);
    if (tool === 'pan') {
      // 移动工具：点击敌人=选中/移动敌人；点击空白=平移地图
      const w = pointerToCanvas(ev);
      const sp = pointerToScreenPx(w.x, w.y);
      const e = edit.levels[level];
      const list = sp ? e.spawns[sp.screen] : null;
      if (enemySel) { moveSelectedEnemy(sp, w.x); return; } // 已选中 → 移动到点击位置
      if (list) {
        const hit = enemyNear(list, w.x, sp.sy);
        if (hit >= 0) {
          enemySel = { screen: sp.screen, off: hit };
          const selId = (list[hit + 2] & 0x7F);
          selEnemy = selId;
          enemyPlaceCondition = enemyConditionFromY(list[hit]);
          buildEnemyPanel();
          buildSpriteParamsPanel();
          statusMsg('已选中敌人 #' + selId.toString(16).toUpperCase() + ' ' + (ENEMY_NAMES[selId] || '') + ' · 点击新位置移动 · Esc 取消');
          drawLevel();
          return;
        }
      }
      const sc = $('canvasScroll');
      panState = { x: ev.clientX, y: ev.clientY, sl: sc.scrollLeft, st: sc.scrollTop };
    } else if (tool === 'bossPos') {
      const c = pointerToCanvas(ev);
      dragBoss = findBossPosNear(c.x, c.y);
      if (dragBoss) { pushUndo(); statusMsg('拖动中，松开落定'); }
    } else if (pasteMode && ev.button === 0) {
      const c = pointerToCanvas(ev);
      pushUndo();
      doPasteAt(c.x, c.y);
      pasteMode = false; pastePos = null;
      drawLevel();
    } else if (tool === 'select') {
      const c = pointerToCanvas(ev);
      if (ev.button === 2) { selRect = null; drawLevel(); return; }
      selecting = true;
      selStart = c;
      selRect = { x0: c.x, y0: c.y, x1: c.x, y1: c.y };
      pasteMode = false;
      drawLevel();
    } else if (ev.button === 2) {
      onEnemyRightClick(ev);
    } else {
      drawing = true;
      if (tool !== 'enemy') pushUndo(); // 敌人工具在 paintEnemy 内部按真实变异点快照
      paint(ev);
    }
  });
  levelCanvas.addEventListener('pointermove', (ev) => {
    if (panState) {
      const sc = $('canvasScroll');
      sc.scrollLeft = panState.sl - (ev.clientX - panState.x);
      sc.scrollTop = panState.st - (ev.clientY - panState.y);
    } else if (dragBoss) {
      const c = pointerToCanvas(ev);
      updateBossPos(dragBoss, c);
      drawLevel();
    } else if (selecting && selStart) {
      const c = pointerToCanvas(ev);
      selRect = normRect(selStart, c);
      drawLevel();
    } else if (pasteMode) {
      pastePos = pointerToCanvas(ev);
      drawLevel();
    } else if (drawing) {
      paint(ev);
    }
  });
  levelCanvas.addEventListener('pointerup', () => { drawing = false; panState = null; selecting = false; dragBoss = null; });
  levelCanvas.addEventListener('pointercancel', () => { drawing = false; panState = null; selecting = false; });
  levelCanvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

  // ---------- tile coordinate readout ----------
  function updateTileInfo(ev) {
    const el = $('tileInfo');
    if (!el) return;
    if (!ev) { el.textContent = ''; return; }
    const pos = pointerToTile(ev);
    if (!pos) { el.textContent = ''; return; }
    const e = edit.levels[level];
    const blockIdx = e.idx[pos.screen];
    const block = e.layoutBlocks[blockIdx];
    const idx = (ROWS - 1 - pos.row) * COLS + pos.col;
    const tile = block[idx];
    const screenFromBottom = pos.screen + 1; // screen 0 = start (bottom)
    const screenCount = e.idx.length;
    el.textContent = ' · 从下往上第 ' + screenFromBottom + '/' + screenCount + ' 屏 · 行 ' + (pos.row + 1) + ' 列 ' + (pos.col + 1) + ' · 图块 #' + tile;
  }
  levelCanvas.addEventListener('pointermove', (ev) => { if (!panState) updateTileInfo(ev); });
  levelCanvas.addEventListener('pointerleave', () => updateTileInfo(null));
  levelCanvas.addEventListener('pointerdown', (ev) => { if (tool !== 'pan') updateTileInfo(ev); });

  // ---------- copy / paste (whole screens) ----------
  function doCopyRect() {
    const e = edit.levels[level];
    const n = e.idx.length;
    const copyTiles = $('copyTiles').checked;
    const copyEnemies = $('copyEnemies').checked;
    if (!copyTiles && !copyEnemies) { statusMsg('请至少勾选「图块」或「敌人」'); return; }
    const gx0 = Math.max(0, Math.floor(selRect.x0 / TILE));
    const gy0 = Math.max(0, Math.floor(selRect.y0 / TILE));
    const gx1 = Math.min(COLS - 1, Math.floor(selRect.x1 / TILE));
    const gy1 = Math.min(n * ROWS - 1, Math.floor(selRect.y1 / TILE));
    const w = gx1 - gx0 + 1, h = gy1 - gy0 + 1;
    clipboard = { w, h, pw: w * TILE, ph: h * TILE, tiles: [], enemies: [] };
    if (copyTiles) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const s = (n - 1) - Math.floor(gy / ROWS), row = gy % ROWS;
        const block = e.layoutBlocks[e.idx[s]];
        for (let gx = gx0; gx <= gx1; gx++) clipboard.tiles.push(block[(ROWS - 1 - row) * COLS + gx]);
      }
    }
    if (copyEnemies) {
      for (let s = 0; s < e.spawns.length; s++) {
        const list = e.spawns[s];
        if (!list) continue;
        const top = (n - 1 - s) * ROWS * TILE;
        let i = 0;
        while (i < list.length) {
          const y = list[i];
          if (y === 0xEF) break;
          if (y >= 0xF0) { i += 2; continue; }
          const x = list[i + 1], type = list[i + 2];
          const px = (x & 0x7F) * 4;
          const py = top + (ROWS * TILE - 1) - y;
          if (px >= selRect.x0 && px <= selRect.x1 && py >= selRect.y0 && py <= selRect.y1) {
            clipboard.enemies.push({ dx: px - selRect.x0, dy: py - selRect.y0, type: type & 0x7F, x });
          }
          i += 3;
        }
      }
    }
    statusMsg('已复制 ' + w + '×' + h + ' 图块' + (copyEnemies ? ' + ' + clipboard.enemies.length + ' 个敌人' : '') + '（蓝色框为选区）');
  }
  function doPasteAt(cx, cy) {
    if (!clipboard) return;
    const e = edit.levels[level];
    const n = e.idx.length;
    const gx = Math.floor(cx / TILE), gy = Math.floor(cy / TILE);
    if (clipboard.tiles.length) {
      for (let dy = 0; dy < clipboard.h; dy++) {
        const gyy = gy + dy;
        if (gyy < 0 || gyy >= n * ROWS) continue;
        const s = (n - 1) - Math.floor(gyy / ROWS), row = gyy % ROWS;
        const block = e.layoutBlocks[e.idx[s]];
        for (let dx = 0; dx < clipboard.w; dx++) {
          const gxx = gx + dx;
          if (gxx < 0 || gxx >= COLS) continue;
          block[(ROWS - 1 - row) * COLS + gxx] = clipboard.tiles[dy * clipboard.w + dx];
        }
      }
    }
    for (const en of clipboard.enemies) {
      const px = gx * TILE + en.dx;
      const py = gy * TILE + en.dy;
      const s = (n - 1) - Math.floor(py / (ROWS * TILE));
      if (s < 0 || s >= n) continue;
      const pyIn = py - Math.floor(py / (ROWS * TILE)) * (ROWS * TILE);
      const spawnY = Math.max(0, Math.min(0xEE, (ROWS * TILE - 1) - Math.round(pyIn)));
      const sx = Math.max(0, Math.min(0xFF, Math.floor(px / 4)));
      const list = e.spawns[s] || (e.spawns[s] = [0xEF]);
      insertSpawnSorted(list, spawnY, sx | (en.x & 0x80), en.type);
    }
    refreshAll();
    statusMsg('已粘贴到列 ' + (gx + 1) + ' 行 ' + (gy + 1));
  }
  $('btnCopy').onclick = () => {
    if (!selRect) { statusMsg('请先用「选框」工具拖拽框选区域'); return; }
    doCopyRect();
    drawLevel();
  };
  $('btnPaste').onclick = () => {
    if (!clipboard) { statusMsg('请先框选并复制'); return; }
    pasteMode = true;
    statusMsg('移动鼠标预览（黄色虚线框），点击落定粘贴，Esc 取消');
    drawLevel();
  };

  // ---------- screen-range copy / paste (整屏段复制) ----------
  $('btnCopyScreens').onclick = () => {
    const e = edit.levels[level];
    const n = e.idx.length;
    const from = parseInt($('scrFrom').value, 10);
    const to = parseInt($('scrTo').value, 10);
    if (isNaN(from) || isNaN(to) || from < 1 || to < from || to > n) {
      statusMsg('屏号无效：需 1-' + n + '，且「到」≥「从」');
      return;
    }
    const s0 = from - 1, s1 = to - 1;
    const blocks = [], spawns = [];
    for (let s = s0; s <= s1; s++) {
      blocks.push(e.layoutBlocks[e.idx[s]].slice());
      spawns.push(e.spawns[s] ? e.spawns[s].slice() : [0xEF]);
    }
    screenClipboard = { count: s1 - s0 + 1, blocks, spawns, fromLevel: level };
    statusMsg('已复制第 ' + from + '~' + to + ' 屏（共 ' + screenClipboard.count + ' 屏），填目标屏号后点「粘贴屏」');
  };
  $('btnPasteScreens').onclick = async () => {
    if (!screenClipboard) { statusMsg('请先填「从/到」屏号并点「复制屏」'); return; }
    const e = edit.levels[level];
    const n = e.idx.length;
    const at = parseInt($('scrPasteAt').value, 10) - 1;
    if (isNaN(at) || at < 0 || at >= n) { statusMsg('目标屏号无效（1-' + n + '）'); return; }
    if (at + screenClipboard.count > n) {
      statusMsg('放不下：需要 ' + screenClipboard.count + ' 屏，第 ' + (at + 1) + ' 屏起只剩 ' + (n - at) + ' 屏');
      return;
    }
    if (screenClipboard.fromLevel !== level) {
      if (!(await uiConfirm('粘贴屏', '剪贴板来自第 ' + (screenClipboard.fromLevel + 1) + ' 关，图块编号在本关可能含义不同，仍要粘贴？'))) return;
    }
    pushUndo();
    for (let i = 0; i < screenClipboard.count; i++) {
      // 粘贴写入新 block，避免污染与其他屏共享的 block
      e.layoutBlocks.push(screenClipboard.blocks[i].slice());
      e.idx[at + i] = e.layoutBlocks.length - 1;
      e.spawns[at + i] = screenClipboard.spawns[i].slice();
    }
    compactLayoutBlocks(e);
    refreshAll();
    statusMsg('已把 ' + screenClipboard.count + ' 屏粘贴到第 ' + (at + 1) + ' 屏起（可撤销）');
  };

  // ---------- brush size / fill range ----------
  function setBrush(size) {
    brushSize = size;
    for (const s of [1, 2, 3, 4]) {
      const button = $('brush' + s);
      if (button) button.classList.toggle('active', s === size);
    }
    document.querySelectorAll('.quick-brush').forEach(button => {
      button.classList.toggle('active', Number(button.dataset.size) === size);
    });
  }
  for (const size of [1, 2, 3, 4]) {
    const button = $('brush' + size);
    if (button) button.onclick = () => setBrush(size);
  }
  document.querySelectorAll('.quick-brush').forEach(button => {
    button.onclick = () => setBrush(Number(button.dataset.size));
  });
  $('quickCopy').onclick = () => $('btnCopy').click();
  $('quickPaste').onclick = () => $('btnPaste').click();
  setBrush(brushSize);
  async function fillRange() {
    const e = edit.levels[level];
    const v1 = await uiPrompt('批量填充', '起始屏（从下往上第几屏，1-' + e.idx.length + '）', '1');
    if (v1 == null) return;
    const start = parseInt(v1, 10) - 1;
    if (isNaN(start) || start < 0 || start >= e.idx.length) { await uiAlert('批量填充', '起始屏无效'); return; }
    const v2 = await uiPrompt('批量填充', '结束屏（1-' + e.idx.length + '）', String(e.idx.length));
    if (v2 == null) return;
    const end = parseInt(v2, 10) - 1;
    if (isNaN(end) || end < start || end >= e.idx.length) { await uiAlert('批量填充', '结束屏无效'); return; }
    const v3 = await uiPrompt('批量填充', '填充图块号（0-' + maxTile(level) + '，当前 ' + selTile + '）', String(selTile));
    if (v3 == null) return;
    const tile = parseInt(v3, 10);
    if (isNaN(tile) || tile < 0) { await uiAlert('批量填充', '图块号无效'); return; }
    pushUndo();
    for (let s = start; s <= end; s++) {
      const block = e.layoutBlocks[e.idx[s]];
      for (let k = 0; k < 128; k++) block[k] = tile;
    }
    refreshAll();
    statusMsg('已将第 ' + (start + 1) + '~' + (end + 1) + ' 屏填充为图块 #' + tile);
  }
  const fillButton = $('btnFillRange');
  if (fillButton) fillButton.onclick = fillRange;
  $('quickFill').onclick = fillRange;

  // ---------- 批量删除（精灵/地图） ----------
  function clearSpawnList(list){
    const out = [];
    let i = 0;
    if(list){
      while(i < list.length){
        const y = list[i];
        if(y === 0xEF) break;
        if(y === 0xF0 || y === 0xF1 || y === 0xF2){ out.push(y, list[i+1]); i += 2; continue; }
        i += 3;   // 跳过 [y,x,type] 三元组
      }
    }
    out.push(0xEF);
    return out;
  }
  function clearMapBlock(e, s){
    const bi = e.idx[s];
    const blk = e.layoutBlocks[bi];
    if(!blk) return;
    // 共享 layout block 不能直接改，否则会连带清空未选中的屏。
    let refs = 0;
    for(const id of e.idx) if(id === bi) refs++;
    if(refs > 1){
      const copy = blk.slice();
      e.layoutBlocks.push(copy);
      e.idx[s] = e.layoutBlocks.length - 1;
      for(let k=0; k<128; k++) copy[k] = emptyGround(level);
    } else {
      for(let k=0; k<128; k++) blk[k] = emptyGround(level);
    }
  }
  function parseScreenRange(fromId, toId){
    const e = edit.levels[level];
    const n = e.idx.length;
    const from = parseInt($(fromId).value, 10);
    const to = parseInt($(toId).value, 10);
    if(isNaN(from) || isNaN(to) || from < 1 || to < from || to > n) return null;
    return { s0: from - 1, s1: to - 1 };
  }
  $('btnClearAllSprites').onclick = async () => {
    const e = edit.levels[level];
    if(!(await uiConfirm('删全部精灵', '确定清空整关所有屏的精灵？（Boss 战区自动保留，其余屏保留 Boss 触发标记，可用撤销恢复）'))) return;
    const war = bossWarScreenSet();
    let skipped = 0;
    pushUndo();
    for(let s=0; s<e.spawns.length; s++){ if(war.has(s)){ skipped++; continue; } e.spawns[s] = clearSpawnList(e.spawns[s]); }
    refreshAll();
    statusMsg('已清空整关所有屏的精灵' + (skipped ? '（保留 Boss 战区 ' + skipped + ' 屏）' : ''));
  };
  $('btnClearAllMap').onclick = async () => {
    const e = edit.levels[level];
    if(!(await uiConfirm('删全部地图', '确定清空整关所有屏的地图？（Boss 战区自动保留，可用撤销恢复）'))) return;
    const war = bossWarScreenSet();
    let skipped = 0;
    pushUndo();
    for(let s=0; s<e.idx.length; s++){ if(war.has(s)){ skipped++; continue; } clearMapBlock(e, s); }
    refreshAll();
    statusMsg('已清空整关所有屏的地图' + (skipped ? '（保留 Boss 战区 ' + skipped + ' 屏）' : ''));
  };
  $('btnClearSelSprites').onclick = () => {
    const e = edit.levels[level];
    const r = parseScreenRange('clearFrom', 'clearTo');
    if(!r){ statusMsg('屏号无效：需 1-' + e.idx.length + '，且「到」≥「从」'); return; }
    const war = bossWarScreenSet();
    let skipped = 0;
    pushUndo();
    for(let s=r.s0; s<=r.s1; s++){ if(war.has(s)){ skipped++; continue; } e.spawns[s] = clearSpawnList(e.spawns[s]); }
    refreshAll();
    statusMsg('已清空第 ' + (r.s0+1) + '~' + (r.s1+1) + ' 屏的精灵' + (skipped ? '（保留 Boss 战区 ' + skipped + ' 屏）' : ''));
  };
  $('btnClearSelMap').onclick = () => {
    const e = edit.levels[level];
    const r = parseScreenRange('clearFrom', 'clearTo');
    if(!r){ statusMsg('屏号无效：需 1-' + e.idx.length + '，且「到」≥「从」'); return; }
    const war = bossWarScreenSet();
    let skipped = 0;
    pushUndo();
    for(let s=r.s0; s<=r.s1; s++){ if(war.has(s)){ skipped++; continue; } clearMapBlock(e, s); }
    refreshAll();
    statusMsg('已清空第 ' + (r.s0+1) + '~' + (r.s1+1) + ' 屏的地图' + (skipped ? '（保留 Boss 战区 ' + skipped + ' 屏）' : ''));
  };

  // ---------- tools ----------
  function setTool(t) {
    tool = t;
    enemySel = null;
    $('toolBrush').classList.toggle('active', t === 'brush');
    $('toolEraser').classList.toggle('active', t === 'eraser');
    $('toolPan').classList.toggle('active', t === 'pan');
    $('toolEnemy').classList.toggle('active', t === 'enemy');
    $('toolSelect').classList.toggle('active', t === 'select');
    $('toolBossPos').classList.toggle('active', t === 'bossPos');
    levelCanvas.style.cursor = t === 'bossPos' ? 'grab' : (t === 'pan' ? 'grab' : 'crosshair');
    // 敌人工具切到独立敌人面板；其他工具回到基础面板。
    const isEnemy = t === 'enemy';
    const ep = $('enemyPanelSection');
    if (ep) ep.hidden = !isEnemy;
    if (isEnemy) buildEnemyPanel();
    setSidebarTab(isEnemy ? 'enemy' : (t === 'brush' ? 'tiles' : 'basic'));
    drawLevel();
  }
  $('toolBrush').onclick = () => setTool('brush');
  $('toolEraser').onclick = () => setTool('eraser');
  $('toolPan').onclick = () => setTool('pan');
  $('toolSelect').onclick = () => setTool('select');
  $('toolBossPos').onclick = () => setTool('bossPos');
  $('toolEnemy').onclick = () => setTool('enemy');

  // ---------- screen add/remove ----------
  // find the screen that triggers the boss (its spawn list contains the F0 marker)
  function findBossScreen() {
    const e = edit.levels[level];
    for (let s = e.spawns.length - 1; s >= 0; s--) {
      const list = e.spawns[s];
      if (list && list.indexOf(0xF0) >= 0) return s;
    }
    return e.idx.length - 1; // fallback: last screen
  }
  // 返回 Boss 战区屏号集合（与生成器 snapshotBossWar 一致：boss 屏 + 其上所有屏；L2 只算 boss 屏）。
  // 删全部/删选定地图、精灵时会跳过这些屏，避免破坏 Boss 战。
  function bossWarScreenSet() {
    const e = edit.levels[level];
    const boss = findBossScreen();
    const set = new Set();
    if (boss < 0) return set;
    set.add(boss);
    if (level !== 1) { for (let s = boss + 1; s < e.idx.length; s++) set.add(s); }
    return set;
  }
    // 每关数据必须放进单个 16KB bank（placeGroup 检查 8 + size <= 0x4000）
  // size = idx + layout(blocks*128) + def + pal。加长出的大片空白屏在 ROM 打包时
  // 会去重共用同一空白块，因此每加一屏只花 1B（idx）；而去重前的原始占用由
  // dedupeLevelCopy 在副本上估算。引擎纵向滚动上限：前 5 关 129 屏，**第 6 关（索引 5）
  // 为 128 屏**——超过后 Boss 屏无法到达，玩家会回绕到第 1 屏继续走。
  const ENGINE_MAX_SCREENS = [129, 129, 129, 129, 129, 128];
  function maxScreens(e, lv) {
    const d = P.dedupeLevelCopy(e);          // 副本去重，不动 live edit
    const base = d.idx.length + d.layoutBlocks.length * 128 + d.def.length + d.pal.length;
    const room = 0x3FF8 - base;              // 0x3FF8 = 16376 = 0x4000 - 8
    // 加长（空白屏）复用已有块 → 每屏约 1B；实际上限由引擎滚动回绕（各关上限）决定
    const cap = (lv != null && ENGINE_MAX_SCREENS[lv] != null) ? ENGINE_MAX_SCREENS[lv] : ENGINE_MAX_SCREENS[0];
    return Math.min(cap, d.idx.length + Math.max(0, room));
  }
  // 「加长地图」→ 弹窗确认，避免误触；确定后才真正插入
  const showLengthen = () => {
    const e = edit.levels[level];
    const maxS = maxScreens(e, level);
    const canAdd = Math.max(0, maxS - e.idx.length);
    const info = $('lengthenInfo');
    const ovr = $('lengthenOverride');
    const hint = $('lengthenOverrideHint');
    if (ovr) ovr.checked = false;                 // 默认不选「超出限制」
    const upd = () => {
      const on = !!(ovr && ovr.checked);
      if (hint) hint.textContent = on ? '已勾选：可输入超过上限的屏数，不再拦截' : '勾选后可输入超过上限的屏数（默认不选，仍受上限限制）';
      if (!info) return;
      if (on) {
        info.textContent = '第 ' + (level + 1) + ' 关当前 ' + e.idx.length + ' 屏。已勾选「超出限制」，可输入超过默认上限 ' + maxS + ' 屏的任意屏数。';
      } else {
        info.textContent = '第 ' + (level + 1) + ' 关当前 ' + e.idx.length + ' 屏，最多 ' + maxS + ' 屏，最多还能加 ' + canAdd + ' 屏。';
      }
    };
    upd();
    if (ovr) ovr.onchange = upd;
    const countEl = $('lengthenCount');
    if (countEl) countEl.value = String(Math.max(1, Math.min(canAdd || 1, 999)));
    const modal = $('lengthenModal');
    if (modal) modal.hidden = false;
    if (countEl) { countEl.focus(); countEl.select(); }
  };
  const hideLengthen = () => { const modal = $('lengthenModal'); if (modal) modal.hidden = true; };
  $('btnInsertScreen').onclick = showLengthen;
  $('lengthenOk').onclick = async () => {
    const e = edit.levels[level];
    const maxS = maxScreens(e, level);
    const canAdd = Math.max(0, maxS - e.idx.length);
    const input = $('lengthenCount');
    const ovr = $('lengthenOverride');
    const override = !!(ovr && ovr.checked);      // 「超出限制」：超过上限也照样加长
    const raw = String(input.value).trim();
    if (!/^\d+$/.test(raw) || parseInt(raw, 10) < 1) {
      statusMsg('请输入有效数量（整数 1–' + (override ? '9999' : maxS) + '）');
      input.focus(); input.select();
      return;
    }
    const n = parseInt(raw, 10);
    if (!override && (e.idx.length + n > maxS)) {
      await uiAlert('加长地图', '第 ' + (level + 1) + ' 关最多 ' + maxS + ' 屏（当前 ' + e.idx.length + ' 屏）。\n' +
        '受引擎纵向滚动上限限制（前 5 关 129 屏，第 6 关 128 屏）——超过后 Boss 屏无法到达，玩家会回绕到第 1 屏继续走。\n' +
        '最多还能再加 ' + canAdd + ' 屏。');
      input.value = String(Math.max(1, canAdd));
      return;
    }
    const boss = findBossScreen();
    const at = Math.max(0, Math.min(boss, e.idx.length)); // insert before the boss
    const newIdx = [];
    const newSpawns = [];
    for (let k = 0; k < n; k++) {
      e.layoutBlocks.push(new Array(128).fill(emptyGround(level)));
      newIdx.push(e.layoutBlocks.length - 1);
      newSpawns.push([0xEF]);
    }
    pushUndo();
    e.idx.splice(at, 0, ...newIdx);
    e.spawns.splice(at, 0, ...newSpawns);
    input.value = '1';
    if (ovr) ovr.checked = false;                 // 加长后复位「超出限制」
    hideLengthen();
    refreshAll();
    statusMsg('已加长 ' + n + ' 屏');
  };
  $('lengthenCancel').onclick = hideLengthen;
  $('lengthenClose').onclick = hideLengthen;
  (function () { const mk = $('lengthenModal'); if (mk) mk.addEventListener('click', e2 => { if (e2.target === mk) hideLengthen(); }); })();
  function compactLayoutBlocks(e) {
    // 删除未使用的图块块，并重新映射 idx（缩短地图后回收空间）
    const used = new Set(e.idx);
    const newBlocks = [];
    const remap = new Map();
    for (const bi of used) {
      remap.set(bi, newBlocks.length);
      newBlocks.push(e.layoutBlocks[bi]);
    }
    e.layoutBlocks = newBlocks;
    for (let i = 0; i < e.idx.length; i++) e.idx[i] = remap.get(e.idx[i]);
  }
  $('btnDeleteScreen').onclick = async () => {
    const e = edit.levels[level];
    const boss = findBossScreen();
    if (boss <= 1) { await uiAlert('缩短地图', 'Boss 前没有可删除的关卡段'); return; }
    const v = await uiPrompt('缩短地图', '缩短多少屏？(1-' + (boss - 1) + ')', '1');
    if (v == null) return;
    const count = parseInt(v, 10);
    if (isNaN(count) || count < 1) { statusMsg('请输入有效数量'); return; }
    const n = Math.min(count, boss - 1);
    // remove the normal screens just before the boss; keep the boss + aftermath
    const at = boss - n;
    pushUndo();
    e.idx.splice(at, n);
    e.spawns.splice(at, n);
    compactLayoutBlocks(e);
    refreshAll();
    statusMsg('已缩短 ' + n + ' 屏');
  };

  // ---------- scroll navigation ----------
  function scrollByScreen(dir) {
    const sc = $('canvasScroll');
    const screens = Math.max(1, edit.levels[level].idx.length);
    const perScreen = levelCanvas.clientHeight / screens;
    sc.scrollBy({ top: dir * perScreen, behavior: 'smooth' });
  }
  $('btnScrollUp').onclick = () => scrollByScreen(-1);
  $('btnScrollDown').onclick = () => scrollByScreen(1);

  // ---------- zoom ----------
  function updateZoomLabels() {
    const value = Math.round(zoom * 100) + '%';
    const label = $('zoomLabel');
    const quickLabel = $('quickZoomLabel');
    if (label) label.textContent = value;
    if (quickLabel) quickLabel.textContent = value;
  }
  function applyZoom() {
    updateSpacer();
    updateZoomLabels();
    drawLevel();
  }
  function zoomBy(factor) {
    const sc = $('canvasScroll');
    const old = zoom;
    zoom = Math.max(0.5, Math.min(4, zoom * factor));
    if (zoom === old) return;
    // keep the viewport center stable while zooming
    const rect = sc.getBoundingClientRect();
    const cx = sc.scrollLeft + rect.width / 2;
    const cy = sc.scrollTop + rect.height / 2;
    const rx = sc.scrollWidth ? cx / sc.scrollWidth : 0;
    const ry = sc.scrollHeight ? cy / sc.scrollHeight : 0;
    applyZoom();
    sc.scrollLeft = rx * sc.scrollWidth - rect.width / 2;
    sc.scrollTop = ry * sc.scrollHeight - rect.height / 2;
  }
  $('zoomIn').onclick = () => zoomBy(1.2);
  $('zoomOut').onclick = () => zoomBy(1 / 1.2);
  $('zoomReset').onclick = () => { zoom = 1; applyZoom(); };
  $('quickZoomIn').onclick = () => zoomBy(1.2);
  $('quickZoomOut').onclick = () => zoomBy(1 / 1.2);
  $('quickZoomReset').onclick = () => { zoom = 1; applyZoom(); };

  function initCollapsiblePanels() {
    document.querySelectorAll('.panel-collapsible > h2').forEach(heading => {
      heading.addEventListener('click', () => {
        const panel = heading.closest('.panel-collapsible');
        if (panel) panel.classList.toggle('panel-collapsed');
      });
    });
  }
  function setSidebarTab(tab) {
    document.querySelectorAll('[data-sidebar-tab]').forEach(button => {
      button.classList.toggle('active', button.dataset.sidebarTab === tab);
    });
    const panels = document.querySelectorAll('#sidebarContent > [data-sidebar-group]');
    panels.forEach(panel => {
      const active = panel.dataset.sidebarGroup === tab;
      panel.classList.toggle('sidebar-panel-active', active);
      if (active && panel.classList.contains('panel-collapsed')) panel.classList.remove('panel-collapsed');
    });
    const enemyPanel = $('enemyPanelSection');
    if (enemyPanel && tab === 'enemy') {
      enemyPanel.hidden = false;
      buildEnemyPanel();
    }
    if (tab === 'params') buildSpriteParamsPanel();
  }
  document.querySelectorAll('[data-sidebar-tab]').forEach(button => {
    button.onclick = () => setSidebarTab(button.dataset.sidebarTab);
  });
  initCollapsiblePanels();

  // ---------- lives / boss HP ----------
  function updateLivesLabel() { $('btnLives').textContent = '命数 · ' + edit.lives; }
  $('btnLives').onclick = async () => {
    const v = await uiPrompt('初始命数', '初始命数 (1-255):', edit.lives);
    if (v == null) return;
    const n = parseInt(v, 10);
    if (!isNaN(n) && n >= 1 && n <= 255) { edit.lives = n; updateLivesLabel(); }
  };

  $('btnBoss').onclick = () => openBossModal();

  function syncBossParamMirror() {
    if (!edit || !edit.spriteParams) return;
    edit.spriteParams.boss = {};
    for (const b of J.BOSS_HP) {
      const pos = edit.bossPos && edit.bossPos[b.id];
      edit.spriteParams.boss[b.id] = {
        health: edit.bossHp && edit.bossHp[b.id],
        count: edit.bossCount && edit.bossCount[b.id],
        pos: pos ? { x: pos.x.slice(), y: pos.y ? pos.y.slice() : null } : null,
      };
      if (b.spriteType != null && b.offsets[0] === J.ENEMY_HEALTH_BASE + b.spriteType && edit.spriteParams.global) {
        edit.spriteParams.global[b.spriteType] = { health: edit.bossHp[b.id] & 0x7F };
      }
    }
  }

  function openBossModal() {
    const modal = $('modal');
    const body = $('modalBody');
    body.innerHTML = '';
    const countMap = {};
    for (const b of J.BOSS_COUNT) countMap[b.id] = b;
    for (const b of J.BOSS_HP) {
      const row = document.createElement('div');
      row.className = 'boss-row';
      const span = document.createElement('span');
      span.textContent = b.name;
      // 数量
      const c = countMap[b.id];
      const cnt = document.createElement('input');
      if (c) {
        cnt.type = 'number'; cnt.min = 1; cnt.max = (c.max != null ? c.max : 128);
        cnt.value = edit.bossCount[b.id];
        cnt.dataset.kind = 'count'; cnt.dataset.id = b.id;
        cnt.disabled = c.fixed;
        cnt.title = c.fixed ? '该 Boss 数量固定' : '打几个过关';
      } else {
        cnt.type = 'text'; cnt.value = '—'; cnt.disabled = true;
        cnt.title = '无独立数量（固定 1 个）';
      }
      // 血量
      const hp = document.createElement('input');
      hp.type = 'number'; hp.min = 0; hp.max = 127;
      hp.value = edit.bossHp[b.id] & 0x7F;
      hp.dataset.kind = 'hp'; hp.dataset.id = b.id;
      hp.title = 'Boss 血量（0-127）';
      row.appendChild(span); row.appendChild(cnt); row.appendChild(hp);
      body.appendChild(row);
      // 位置编辑（有位置表的 Boss）
      const pos = edit.bossPos && edit.bossPos[b.id];
      if (pos) {
        const pr = document.createElement('div');
        pr.className = 'boss-pos-row';
        const xl = document.createElement('span');
        xl.textContent = 'X位置';
        const xi = document.createElement('input');
        xi.type = 'text';
        xi.value = pos.x.join(',');
        xi.dataset.kind = 'posX'; xi.dataset.id = b.id;
        xi.title = '水平位置（0-512），逗号分隔，共 8 个';
        pr.appendChild(xl); pr.appendChild(xi);
        if (pos.y) {
          const yl = document.createElement('span');
          yl.textContent = 'Y位置';
          const yi = document.createElement('input');
          yi.type = 'text';
          yi.value = pos.y.join(',');
          yi.dataset.kind = 'posY'; yi.dataset.id = b.id;
          yi.title = '垂直位置（0-255），逗号分隔，共 8 个';
          pr.appendChild(yl); pr.appendChild(yi);
        }
        body.appendChild(pr);
      }
    }
    const head = document.createElement('div');
    head.className = 'boss-head';
    head.innerHTML = '<span>Boss</span><span>数量(打几个)</span><span>血量(0-255)</span>';
    body.insertBefore(head, body.firstChild);
    modal.hidden = false;
    $('modalTitle').textContent = 'Boss 设置（数量 / 血量）';
  }
  $('modalClose').onclick = () => { $('modal').hidden = true; };
  $('modalSave').onclick = () => {
    pushUndo();
    for (const input of document.querySelectorAll('#modalBody input')) {
      const v = parseInt(input.value, 10);
      if (isNaN(v)) continue;
      const id = input.dataset.id;
      if (input.dataset.kind === 'count') {
        const cm = J.BOSS_COUNT.find(b => b.id === id);
        edit.bossCount[id] = Math.max(1, Math.min((cm && cm.max != null ? cm.max : 128), v));
      } else if (input.dataset.kind === 'posX' || input.dataset.kind === 'posY') {
        const pos = edit.bossPos[id];
        if (!pos) continue;
        const arr = input.value.split(',').map(s => parseInt(s.trim(), 10)).filter(v => !isNaN(v));
        const isX = input.dataset.kind === 'posX';
        for (let k = 0; k < J.POS_MAX; k++) {
          const val = arr[k] != null ? arr[k] : (isX ? pos.x[k] : pos.y[k]);
          if (isX) pos.x[k] = Math.max(0, Math.min(0x1FF, val));
          else pos.y[k] = Math.max(0, Math.min(0xFF, val));
        }
      }
      else edit.bossHp[id] = Math.max(0, Math.min(127, v));
    }
    syncBossParamMirror();
    $('modal').hidden = true;
  };
  $('modalReset').onclick = () => {
    pushUndo();
    for (const b of J.BOSS_HP) edit.bossHp[b.id] = b.defaultValue;
    for (const b of J.BOSS_COUNT) edit.bossCount[b.id] = b.defaultValue;
    if (!edit.bossCompanions) edit.bossCompanions = {};
    for (const b of (J.BOSS_COMPANIONS || [])) edit.bossCompanions[b.id] = b.defaultValue;
    if (!edit.bossCompanionWeaponReq) edit.bossCompanionWeaponReq = {};
    for (const b of (J.BOSS_COMPANIONS || [])) edit.bossCompanionWeaponReq[b.id] = b.defaultWeaponLevel;
    syncBossParamMirror();
    openBossModal();
  };

  // ---------- random generation（见 gen-main.js / gen-core.js）----------
  // 实时显示：生成等级 → 每屏敌人范围 + 精灵总数极限（单关）
  function updateEnemyPerScreen(){
    const el = $('enemyPerScreen');
    const stHint = $('spriteTotalHint');
    const sel = $('randDiff'); const ps = $('randPerScreen');
    const G2 = window.JackalGen;
    const lv = sel && sel.value !== 'auto' ? parseInt(sel.value,10) : null;
    const perScreen = ps ? (parseInt(ps.value,10)||0) : 0;
    // 每屏敌人
    if(el){
      if(perScreen > 0){ el.textContent = '每屏 ' + perScreen + ' 个'; }
      else if(lv && G2 && G2.GEN_DIFF && G2.GEN_DIFF[lv]){ const d = G2.GEN_DIFF[lv]; el.textContent = '每屏 ' + d.enemies[0] + '~' + d.enemies[1] + ' 个'; }
      else { el.textContent = '每屏: 随等级'; }
    }
    // 精灵总数极限（随当前关卡 + 等级实时刷新；0=随等级自动）
    if(stHint){
      if(lv && G2 && G2.maxSpritesForLevel){ stHint.textContent = '极限 ' + G2.maxSpritesForLevel(level, lv); }
      else { stHint.textContent = ''; }
    }
  }
  const _rd = $('randDiff'), _rc = $('randPerScreen'), _st = $('randSpriteTotal');
  if(_rd) _rd.onchange = updateEnemyPerScreen;
  if(_rc) _rc.oninput = updateEnemyPerScreen;
  if(_st) _st.oninput = updateEnemyPerScreen;
  updateEnemyPerScreen();
  function updateOddRatio(){
    const el = $('oddRatioVal'); const slider = $('randOddRatio'); const mode = $('randParity');
    if(!el || !slider) return;
    const v = parseInt(slider.value,10)||30;
    const m = mode ? mode.value : 'even';
    if(m === 'mixed'){ el.textContent = v + '%满级条件'; slider.style.display=''; }
    else if(m === 'odd'){ el.textContent = '100%满级条件'; slider.style.display='none'; }
    else { el.textContent = '0%满级条件'; slider.style.display='none'; }
  }
  const _rp = $('randParity'), _ro = $('randOddRatio');
  if(_rp) _rp.onchange = updateOddRatio;
  if(_ro) _ro.oninput = updateOddRatio;

  $('btnRandom').onclick = () => {
    const e = edit.levels[level];
    if (!e) return;
    const doMap = $('randMap').checked;
    // 精灵复选框统一控制：敌人 + 精灵设施 + 星星道具（精灵池）
    const doSprite = $('randSprite').checked;
    const doEnemy = doSprite;
    const doStar = doSprite;
    const doBoss = false; // Boss 不随机
    const sel = $('randDiff');
    const diffKey = sel ? sel.value : 'auto';
    const parSel = $('randParity');
    const oddRatioEl = $('randOddRatio');
    const oddRatio = oddRatioEl ? (parseInt(oddRatioEl.value,10)||30)/100 : 0.3;
    const oddStartEl = $('randOddStart');
    const oddStart = oddStartEl ? (parseInt(oddStartEl.value,10)||0) : 0;
    const parity = parSel ? { mode: parSel.value, ratio: oddRatio, oddStart } : { mode: 'even', oddStart };
    const seedStr = $('randSeed').value.trim();
    const seed = seedStr ? (parseInt(seedStr, 10) >>> 0 || hashSeed(seedStr)) : null;
    const ecSel = $('randPerScreen');
    const enemyPerScreen = ecSel ? (parseInt(ecSel.value,10) || 0) : 0;
    // 兵种/道具数量：星星(0x50-52)与精灵设施(0x1B/0x13/0x14/0x1C/0x1D/0x15/0x19/0x3C-3F/0x08/0x4E/0x53)不参与敌人白名单
    // 精灵池白名单：所有勾选的类型（含敌人/道具/精灵设施）；全选=null(不限)
    const typeChks = document.querySelectorAll('.typeChk');
    const checkedTypes = Array.from(typeChks).filter(c=>c.checked).map(c=>parseInt(c.value,10));
    const enemyTypes = (checkedTypes.length < typeChks.length) ? checkedTypes : null; // 全不选=[]空数组(不生成随机)，全选=null(不限)
    const checkedSet = new Set(checkedTypes);
    const typeCounts = {};
    document.querySelectorAll('.typeCnt').forEach(inp => {
      const t = parseInt(inp.dataset.t,10);
      if(!checkedSet.has(t)) return;   // 未勾选的类型，其数量一并忽略（全不选时 count 全部失效）
      const v = parseInt(inp.value,10) || 0;
      if(v > 0) typeCounts[t] = v;
    });
    const counts = Object.keys(typeCounts).length ? typeCounts : null;
    const stInp = $('randSpriteTotal');
    const spriteTotal = stInp ? (parseInt(stInp.value,10)||0) : 0;
    const G = window.JackalGen;
    pushUndo();
    const res = G.generateLevel(edit, level, { seed, difficulty: diffKey, doMap, doEnemy, doSprite, doStar, doBoss, pool: 'level', parity, enemyPerScreen, counts, enemyTypes, spriteTotal });
    refreshAll();
    const diffName = res.difficulty + '级';
    if (res.ok) {
      statusMsg('已生成 ' + res.nScreens + ' 屏 · 等级「' + diffName + '」· 种子 ' + res.seed + (doMap ? ' · 地图' : '') + (doSprite ? ' · 精灵' : ''));
    } else {
      statusMsg('生成完成但有 ' + res.issues.length + ' 处问题：' + res.issues.slice(0, 3).join('；') + ' · 等级「' + diffName + '」');
    }
  };
  function hashSeed(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  // ---------- download ----------
  $('btnDownload').onclick = () => {
    try {
      // 初始原版使用内嵌原版作为基准；载入重打包/自定义 ROM 时必须保留其
      // 固定代码 bank（尤其是自定义敌人/子弹 AI），否则 boss 战区虽然图块和炮台
      // 位置相同，运行时子弹行为也会被原版代码替换。
      const buildBase = (rom && rom[4] !== 8) ? rom : (baseRom || rom);
      const patched = P.buildPatchedROM(buildBase, edit);
      const blob = new Blob([patched], { type: 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'Jackal_custom.nes';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      statusMsg('已生成 ROM：' + patched.length + ' 字节 (' + patched[4] + ' 个 PRG bank)');
    } catch (err) {
      uiAlert('生成失败', err.message);
    }
  };

  function statusMsg(s) {
    const el = $('status'); el.textContent = s;
    clearTimeout(statusMsg._t); statusMsg._t = setTimeout(() => el.textContent = '', 4000);
  }

  // ---------- 通用页面内弹窗（替换原生 alert/confirm/prompt，避免触屏/嵌入式环境弹不出或打不了字） ----------
  function esc(s){ return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
  function openUiModal(title, bodyHtml, buttons, cancelValue){
    return new Promise(resolve => {
      const mask = $('uiModal'), closeBtn = $('uiModalClose');
      $('uiModalTitle').textContent = title || '';
      $('uiModalBody').innerHTML = bodyHtml;
      const foot = $('uiModalFoot'); foot.innerHTML = '';
      const finish = v => { mask.hidden = true; closeBtn.onclick = null; mask.onclick = null; resolve(v); };
      for(const b of buttons){
        const el = document.createElement('button');
        el.textContent = b.label; el.className = 'btn ' + (b.cls || 'btn-ghost');
        el.onclick = () => { const v = (typeof b.value === 'function') ? b.value($('uiModalBody')) : b.value; finish(v); };
        foot.appendChild(el);
      }
      closeBtn.onclick = () => finish(cancelValue);
      mask.onclick = ev => { if(ev.target === mask) finish(cancelValue); };
      mask.hidden = false;
      const first = mask.querySelector('input,select');
      if(first){ first.focus(); if(first.select) first.select(); }
    });
  }
  function uiAlert(title, message){
    return openUiModal(title || '提示', '<div class="hint" style="white-space:pre-line">' + esc(message) + '</div>', [{label:'确定', cls:'btn-primary', value:true}], true);
  }
  function uiConfirm(title, message){
    return openUiModal(title || '确认', '<div class="hint" style="white-space:pre-line">' + esc(message) + '</div>', [
      {label:'取消', cls:'btn-ghost', value:false},
      {label:'确定', cls:'btn-primary', value:true}
    ], false);
  }
  function uiPrompt(title, message, def){
    const body = '<div class="hint" style="white-space:normal;margin-bottom:6px;">' + esc(message) + '</div>' +
      '<input type="text" inputmode="numeric" pattern="[0-9]*" id="uiPromptInput" class="txt-input" value="' + esc(def == null ? '' : def) + '" style="width:150px;background:#1a1a1a;color:#ddd;border:1px solid #333;border-radius:3px;padding:5px 8px;font-size:14px;">';
    return openUiModal(title || '输入', body, [
      {label:'取消', cls:'btn-ghost', value:null},
      {label:'确定', cls:'btn-primary', value: (bodyEl) => { const inp = bodyEl && bodyEl.querySelector('#uiPromptInput'); return inp ? inp.value : null; }}
    ], null);
  }

  // Confirm and cancel all modal types from the keyboard. Keep this at the
  // document level so alerts without an input still work immediately after
  // opening, even when focus remains on the button that opened the modal.
  document.addEventListener('keydown', ev => {
    if (ev.isComposing) return;
    const target = ev.target;

    const visible = id => {
      const el = $(id);
      return el && !el.hidden ? el : null;
    };
    const modal = visible('uiModal') || visible('lengthenModal') || visible('modal');
    if (!modal) return;
    // Buttons inside the active modal already have native Enter activation;
    // leave those alone to avoid firing both the focused button and the modal
    // default action. A button outside the modal is usually the opener, so it
    // must not block Enter from confirming a newly opened alert/prompt.
    if (target && target.tagName === 'BUTTON' && target.closest('.modal-mask') === modal) return;

    if (ev.key === 'Escape') {
      const cancelId = modal.id === 'uiModal' ? 'uiModalClose'
        : (modal.id === 'lengthenModal' ? 'lengthenCancel' : 'modalClose');
      const cancel = $(cancelId);
      if (cancel) {
        ev.preventDefault();
        ev.stopPropagation();
        cancel.click();
      }
      return;
    }

    if (ev.key !== 'Enter' || ev.shiftKey) return;
    if (target && target.tagName === 'TEXTAREA') return;
    const confirmId = modal.id === 'uiModal' ? null
      : (modal.id === 'lengthenModal' ? 'lengthenOk' : 'modalSave');
    const confirm = confirmId ? $(confirmId) : modal.querySelector('#uiModalFoot .btn-primary');
    if (!confirm || confirm.disabled) return;
    ev.preventDefault();
    ev.stopPropagation();
    confirm.click();
  }, true);

  // ---------- load custom ROM ----------
  $('btnLoad').onclick = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.nes';
    inp.onchange = () => {
      const f = inp.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try { init(new Uint8Array(r.result)); statusMsg('已载入 ' + f.name); }
        catch (e) { uiAlert('无效的 Jackal ROM', e.message); }
      };
      r.readAsArrayBuffer(f);
    };
    inp.click();
  };

  // ---------- start ----------
  if (window.JACKAL_ROM_BASE64) {
    init(b64ToBytes(window.JACKAL_ROM_BASE64));
  } else {
    $('status').textContent = '未找到内嵌 ROM，请点击「载入 ROM」';
  }
})();
