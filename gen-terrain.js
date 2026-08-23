/* 地形与河流生成：片段 / 字母道路 / 围栏 / 6 关阶段 / 程序化地图 / L1 河流 / 机场 / 章节 / 道路骨架 */
(function () {
  'use strict';
  const NS = window.JackalGen;
  const {
    COLS, ROWS, EMPTY, TILE_ROLE, GEN_THEME, LEVEL_UNIQUE, COMMON_TYPES, resolveEnemyPool, MAX_SCREENS, maxSpritesForLevel, normalizeCounts, DIFF_LEVELS, DIFF_RANGE, lerp, diffAt, GEN_DIFF, MAX_OBJ_SLOTS, SAFE_PER_SCREEN, SAFE_PRIORITY_PER_SCREEN, BOSS_APPROACH_SCREENS, BOSS_APPROACH_MAX, BOSS_SCREEN_MAX, BOSS_APPROACH_PRIORITY_MAX, PRIMARY_GROUND, STRONG_ENEMIES, FACILITY_IDS, NO_RANDOM_SPAWN, LEVEL_BOSSES, seededRandom, initTemplates, idxAt, getTile, setTile, rowToY, gxToX, roleOf, isWalkable, isStoneTile, STRUCTURES, AIRPORTS, stampStructure, snapshotBossWar, CRESCENT_TILE, screenExitOk,
  } = NS;

  // ===== Segment 片段系统（用户规格：竖直长度10倍 + 每关9-12片段拼接）=====
  // 每片段 ≈ 原版一关规模，首尾竖直相连向下；横向宽度锁死原版 16 列。
  // 每关片段数：L1 9-11, L2 9-11, L3 9-11, L4 8-10, L5 10-12, L6 10-12
  const SEGMENT_COUNTS = [[9,11],[9,11],[9,11],[8,10],[10,12],[10,12]];
  function buildSegments(nScreens, level, rng){
    const range = SEGMENT_COUNTS[level] || [9,11];
    const nSeg = Math.min(nScreens, range[0] + Math.floor(rng()*(range[1]-range[0]+1)));
    const segs = [];
    let start = 0;
    for(let i=0;i<nSeg;i++){
      let len = Math.max(1, Math.floor(nScreens/nSeg) + (rng()<0.5?1:0));
      if(i === nSeg-1) len = nScreens - start;
      if(start + len > nScreens) len = nScreens - start;
      if(len < 1) len = 1;
      segs.push({ idx:i, start, end:start+len, type: segType(level, i, nSeg, rng) });
      start += len;
      if(start >= nScreens) break;
    }
    return segs;
  }
  // 片段类型：0=开阔/赶路 1=隘口/卡点 2=特征战斗段
  function segType(level, i, nSeg, rng){
    // 起点段(0)开阔、终点段(nSeg-1)收口；中间按节奏交替
    if(i === 0) return 0;
    if(i === nSeg-1) return 1;
    const cycle = rng();
    if(cycle < 0.4) return 0;   // 开阔
    if(cycle < 0.75) return 2;  // 战斗/特征
    return 1;                    // 隘口
  }

  // 每关片段内单屏生成器：返回填充好的 block（128 数组）
  // seg 上下文提供片段类型与屏在片段内位置
  function genSegmentScreen(level, blk, s, seg, segPos, skel, rng, ctx){
    const role = TILE_ROLE[level];
    const grounds = role.ground && role.ground.length ? role.ground : role.road;
    const pick = (arr) => arr[Math.floor(rng()*arr.length)];
    const sc = (skel && skel.cols && skel.cols[s] != null) ? skel.cols[s] : Math.floor(COLS/2);
    const colE = (skel && skel.cols && skel.cols[s+1] != null) ? skel.cols[s+1] : sc;
    // 走廊骨架列（每行，底→顶蜿蜒）
    const skelColAt = (row) => {
      let c = Math.round(sc + (colE-sc)*row/(ROWS-1));
      if(rng()<0.2) c += (rng()<0.5?-1:1);
      return Math.max(2, Math.min(COLS-3, c));
    };

    // 1) 铺满主地面（整屏可通行，开阔）——只用该关唯一的默认空地图块
    const mainGround = PRIMARY_GROUND[level] != null ? PRIMARY_GROUND[level] : pick(grounds);
    for(let i=0;i<128;i++) blk[i] = mainGround;

    // 2) 每关特征（零散障碍 + 各关主题，避免两侧成片墙）
    applySegmentFeature(level, blk, s, seg, segPos, skel, rng, ctx, skelColAt);

    return blk;
  }

  // 每关片段特征（规格 §Stage1-6 地形规则）：零散障碍，走廊畅通
  function applySegmentFeature(level, blk, s, seg, segPos, skel, rng, ctx, skelColAt){
    if(level === 0) applyStage1(blk, s, seg, skel, rng, ctx, skelColAt);
    else if(level === 1) applyStage2(blk, s, seg, skel, rng, ctx, skelColAt);
    else if(level === 2) applyStage3(blk, s, seg, skel, rng, ctx, skelColAt);
    else if(level === 3) applyStage4(blk, s, seg, skel, rng, ctx, skelColAt);
    else if(level === 4) applyStage5(blk, s, seg, skel, rng, ctx, skelColAt);
    else applyStage6(blk, s, seg, skel, rng, ctx, skelColAt);
  }
  // 通用：2格小簇撒障碍（1x2或2x1相邻，不孤立也不成片），避开走廊中心 ±2
  // 通用：2格小簇撒障碍（1x2或2x1相邻，不孤立也不成片），避开走廊中心 ±2
  function scatterObstacles(blk, role, density, skelColAt, rng, tiles){
    const pick = (arr) => arr[Math.floor(rng()*arr.length)];
    const grounds = role.ground && role.ground.length ? role.ground : role.road;
    const target = Math.round(128 * density);
    let placed = 0;
    let guard = 0;
    while(placed < target && guard++ < 200){
      const row = 1 + Math.floor(rng()*(ROWS-2));
      const gx = 1 + Math.floor(rng()*(COLS-3));
      const horiz = rng() < 0.5;
      const cells = horiz ? [[0,0],[0,1]] : [[0,0],[1,0]];
      const t = pick(tiles);
      let ok = true;
      for(const [dr,dc] of cells){
        const rr = row+dr, gg = gx+dc;
        if(rr >= ROWS-1 || gg >= COLS-1) { ok=false; break; }
        if(Math.abs(gg - skelColAt(rr)) <= 2) { ok=false; break; }
        if(!grounds.includes(getTile(blk,rr,gg))) { ok=false; break; }
      }
      if(!ok) continue;
      for(const [dr,dc] of cells){
        setTile(blk, row+dr, gx+dc, t);
        placed++;
      }
    }
  }

  // ===== 围栏配置（用户规格）=====
  //  L1 竖栏 33(0x21)/34(0x22)、空地 88(0x58)
  //  L2 竖栏 24(0x18)/28(0x1C)、空地 79(0x4F)
  //  L4 竖栏 32(0x20)/33(0x21)、空地 80(0x50)
  //  L5 竖栏 18(0x12)/19(0x13)、空地 45(0x2D)
  // 横栏图块、5-6 门、空地开口 各关一致；5-6 门格在各关都算可通行（不算堵路）
  const FENCE_CFG = [
    { vL:0x21, vR:0x22, fill:0x58, blocking:false },   // L1 丛林
    { vL:0x18, vR:0x1C, fill:0x4F, blocking:false },   // L2 水岸
    null,                                               // L3 走水平围栏带（见 FENCE_BAND）
    { vL:0x20, vR:0x21, fill:0x50, blocking:false },   // L4 峡谷
    { vL:0x12, vR:0x13, fill:0x2D, blocking:false },   // L5 要塞
    null,                                               // L6 走水平围栏带（见 FENCE_BAND）
  ];
  // ===== 水平围栏带（无竖直围栏）：面板 + 门 + 上下墙行 =====
  //  L3 面板 59(0x3B)、门 57-5-6-58(0x39 05 06 3A)、上墙37/下墙38
  //  L5(另一种) 面板 60/61/62(0x3C/0x3D/0x3E) 代替 8/9/10 和 15/16、门 56-57(0x38/0x39) 代替 5-6
  //  L6 面板 20(0x14)、门 21-5-6-22(0x15 05 06 16)、下墙18（两端0b）
  const FENCE_BAND = [
    null, null,
    { panel:[0x3B], gate:[0x39,0x05,0x06,0x3A], wallTop:0x37, gateTop:[0x35,0x36], wallBot:0x38, gateBot:[0x3C,0x3D,0x3E,0x3F] },  // L3
    null,
    { panel:[0x3C,0x3D,0x3E], gate:[0x38,0x39] },                                                                             // L5 类型2
    { panel:[0x14], gate:[0x15,0x05,0x06,0x16], wallBot:0x18, gateBot:[0x13,0x17], endTile:0x0B },                              // L6
  ];
  // 围栏底栏签名图块（嵌在 10/9/8 面板位置，替换面板 + 上方灰炮台）：
  //   L1 月湾43(0x2B)+炮台、L5 月湾17(0x11)+炮台；L4 石头79 是散置障碍（不嵌围栏，见 OCCASIONAL_CFG）
  const FENCE_SIGNATURE = [
    { tile: 0x2B, cannon: true  },   // L1 月湾 + 上方灰炮台
    null,                            // L2
    null,                            // L3
    null,                            // L4 石头79 走散置，不嵌围栏
    { tile: 0x11, cannon: true  },   // L5 月湾 + 上方灰炮台
    null,                            // L6
  ];

  // ===== Stage1 沙漠荒野：开阔沙地 + 散置树丛 + 片段内横向河流桥 =====
  // L1 围栏系统（规则）：
  //   · 只有两种形态：完整四边形围栏（上横栏+下横栏+左右竖直 33/34），
  //     或单条下横栏（仅底行）；竖直 33/34 绝不单独随机出现
  //   · 竖直边只连在横栏两端：矩形两侧都连；单下围栏可选连左/右/双/不连，
  //     也可只连一边（半个围栏）
  //   · 相邻屏不顶在一起：上一屏已放下围栏，本屏就不放上横栏（避免两栏紧贴无空档）
  function stampL1Fences(blk, s, rng, rec, onGate, gateAllowed, prevInfo, level, onCannon, sc){
    const isRect = rng() < 0.5;                  // 完整四边形 / 单条下横栏
    const prevIsBottom = !!(prevInfo && prevInfo.kind === 'bottom');
    // 矩形必须带上横栏；上一屏是下围栏时，上横栏下移一行(空出屏顶 1 格空档)
    const hasTop = isRect;
    const hasBot = true;
    // 上横栏永远放在 row1（屏顶留 1 行空）：这样本屏上横栏与"上方那屏底行围栏"之间
    // 必然至少隔 1 格空地，两条围栏永不顶在一起
    const topRow = 1;
    const fc = FENCE_CFG[level || 0] || FENCE_CFG[0];
    // 与上一屏下围栏对接时沿用它的左右列，竖直围栏才能跨屏连成一条线
    let x1, x2;
    if(fc.blocking){
      // 挡路关卡（L2）：短栏，宽 5~9 列，且旁边至少留 5 列空地可绕行
      const w = 5 + Math.floor(rng()*5);
      const leftSide = rng() < 0.5;
      x1 = leftSide ? (1 + Math.floor(rng()*2)) : (COLS-1-w - Math.floor(rng()*2));
      x1 = Math.max(1, Math.min(COLS-2-w, x1));
      x2 = x1 + w;
    } else {
      // L1：横栏可全宽铺满（只要有门 5-6 / 空口 88 就能通行，不算堵路）
      if(rng() < 0.45){
        x1 = 0; x2 = COLS-1;
      } else {
        x1 = 1 + Math.floor(rng()*4);
        x2 = Math.max(x1+4, COLS-3 - Math.floor(rng()*4));
      }
    }
    if(isRect && prevIsBottom && prevInfo.x1 != null){ x1 = prevInfo.x1; x2 = prevInfo.x2; }
    // 横栏端点（下）：左 11/15，右 16/7
    const left = rng()<0.5 ? 0x0B : 0x0F;
    const right = rng()<0.5 ? 0x10 : 0x07;
    // 铺一条横栏；返回该行两端列与端点图块
    const drawBar = (row) => {
      const isTop = (row === topRow);
      const bL = isTop ? 0x0C : left;            // 上:12, 下:11/15
      const bR = isTop ? 0x0D : right;           // 上:13, 下:16/7
      const cells = [[row, x1, bL]];
      let gx = x1 + 1;
      let hasOpening = false;   // 记录是否有空/门开口
      while(gx < x2){
        const k = rng();
        if(k < 0.5 || gx + 3 >= x2){
          cells.push([row, gx, [0x0A,0x09,0x08][Math.floor(rng()*3)]]);
          gx++;
        } else if(k < 0.75 && (!gateAllowed || gateAllowed(row, gx+2))){
          cells.push([row, gx,   rng()<0.5 ? 0x10 : 0x07]);
          cells.push([row, gx+1, 0x05]);
          cells.push([row, gx+2, 0x06]);
          hasOpening = true;
          cells.push([row, gx+3, rng()<0.5 ? 0x0F : 0x0B]);
          if(onGate) onGate(row, gx+1);
          gx += 4;
        } else {
          const n = Math.min(x2 - gx - 2, 1 + Math.floor(rng()*4));
          cells.push([row, gx, rng()<0.5 ? 0x10 : 0x07]);
          for(let j=0;j<n;j++) cells.push([row, gx+1+j, fc.fill]);
          cells.push([row, gx+1+n, rng()<0.5 ? 0x0F : 0x0B]);
          hasOpening = true;
          gx += 2 + n;
        }
      cells.push([row, x2, bR]);
      // ===== 设计：下横栏的 8/9/10 面板位置嵌一段签名图块 =====
      // L1 月湾 43(0x2B)+上方炮台 | L4 石头 79(0x4F) | L5 月湾 17(0x11)
      const sig = FENCE_SIGNATURE[level] || null;
      if(sig && row === ROWS-1 && rng() < 0.35){
        const panelIdx = [];
        for(let ci=0; ci<cells.length; ci++){
          const t = cells[ci][2];
          if(t === 0x0A || t === 0x09 || t === 0x08) panelIdx.push(ci);   // 面板 10/9/8
        }
        // 找一段连续的面板（列号相邻），长度 1~3
        if(panelIdx.length){
          const runs = [];
          let cur = [panelIdx[0]];
          for(let k=1;k<panelIdx.length;k++){
            if(cells[panelIdx[k]][1] === cells[panelIdx[k-1]][1] + 1) cur.push(panelIdx[k]);
            else { runs.push(cur); cur = [panelIdx[k]]; }
          }
          runs.push(cur);
          const run = runs[Math.floor(rng()*runs.length)];
          const wantLen = 1 + Math.floor(rng()*3);
          const take = run.slice(0, Math.min(wantLen, run.length));
          const withCannon = sig.cannon && rng() < 0.6;   // 只有 L1 月湾上方放炮台
          for(const ci of take){
            const gx = cells[ci][1];
            cells[ci][2] = sig.tile;                    // 面板位置换成签名图块
            if(withCannon && row-1 >= 0 && getTile(blk, row-1, gx) === fc.fill){
              setTile(blk, row-1, gx, 0x04);            // 月湾上方灰炮台座
              rec([[row-1, gx, 0x04]]);
              if(onCannon) onCannon(row-1, gx);         // 绑定炮台精灵 5/6
            }
          }
        }
      }
        // 全实心 → 强制中间开一个空门(88)口
        const mid = Math.floor((x1 + x2) / 2);
        for(let ci=0; ci<cells.length; ci++) if(cells[ci][1] === mid) cells[ci][2] = fc.fill;
      }
      const applied = [];
      for(const c of cells){ if(isStoneTile(level, getTile(blk, c[0], c[1]))) continue; setTile(blk, c[0], c[1], c[2]); applied.push(c); }
      rec(applied);
      return { bL, bR };
    };
    // 强制骨架列空门：门(空地)开在主通道上，入口/出口必然对齐通路 → 修复不用再凿围栏
    const forceSkelGate = (row) => {
      const s0 = Math.max(x1+1, Math.min(x2-2, sc));
      for(let dc=0; dc<2; dc++){
        const gx = s0 + dc;
        if(isStoneTile(level, getTile(blk, row, gx))) continue;
        setTile(blk, row, gx, fc.fill);
        rec([[row, gx, fc.fill]]);
      }
    };
    drawBar(ROWS-1);                              // 下横栏
    if(hasTop) drawBar(topRow);                   // 上横栏（仅矩形）
    if(sc != null && x2 - x1 >= 4){               // 骨架列有门才保证连通（带围栏的关）
      forceSkelGate(ROWS-1);
      if(hasTop) forceSkelGate(topRow);
      // 门列上下打通（2 宽通道贯穿全屏）：门=通行口，上下路基清空 → 绝对连通，修复不用凿围栏
      const s0 = Math.max(x1+1, Math.min(x2-2, sc));
      for(let dc=0; dc<2; dc++){
        const gx = s0 + dc;
        for(let row=0; row<ROWS; row++){
          if(isStoneTile(level, getTile(blk, row, gx))) continue;
          if(!isWalkable(level, getTile(blk, row, gx))) setTile(blk, row, gx, fc.fill);
        }
      }
    }
    // 竖直边：只连在横栏两端 x1/x2
    let vLeft, vRight;
    if(isRect && prevIsBottom){
      // 连接上一屏下围栏：它右边没堵住，右边就不连；左边同理
      vLeft  = !!(prevInfo.vLeft);
      vRight = !!(prevInfo.vRight);
    } else if(isRect){
      vLeft = true; vRight = true;               // 独立矩形：两侧都连
    } else {
      const k = rng();
      if(k < 0.34){ /* 都不连 */ }
      else if(k < 0.55){ vLeft = true; }          // 只连左边（半个围栏）
      else if(k < 0.76){ vRight = true; }         // 只连右边（半个围栏）
      else { vLeft = vRight = true; }             // 两边都连
    }
    const vCells = [];
    const put = (r,gx,t)=>{ if(r>=0 && r<ROWS && gx>=0 && gx<COLS && !isStoneTile(level, getTile(blk, r, gx))){ vCells.push([r,gx,t]); } };
    if(hasTop){
      for(let r=topRow+1; r<ROWS-1; r++){                // 竖栏在自己上/下横栏之间
        if(vLeft) put(r, x1, fc.vL);
        if(vRight) put(r, x2, fc.vR);
      }
    } else {
      // 单下围栏：竖直边从底行向上伸（不向下出屏），可一边/两边/不伸
      const vLen = 1 + Math.floor(rng()*2);
      for(let k=1; k<=vLen; k++){
        const r = ROWS-1-k;
        if(vLeft) put(r, x1, fc.vL);
        if(vRight) put(r, x2, fc.vR);
      }
    }
    if(vCells.length){ for(const c of vCells) setTile(blk, c[0], c[1], c[2]); rec(vCells); }
    return { kind: hasTop ? 'rect' : 'bottom', x1, x2, vLeft: !!vLeft, vRight: !!vRight, hasBot };
  }

  // ===== L3/L5(类型2)/L6 水平围栏带（无竖直围栏）：面板 + 门 + 上下墙行 =====
  //  L3：面板 59(0x3B)、门 57-5-6-58(0x39 05 06 3A)、上墙37/门顶35 36、下墙38/门底3C 3D 3E 3F
  //  L5(另一种)：面板 60/61/62(0x3C/0x3D/0x3E) 代替 8/9/10/15/16、门 56-57(0x38/0x39) 代替 5-6
  //  L6：面板 20(0x14)、门 21-5-6-22(0x15 05 06 16)、下墙18/门底13 17（两端 0b）
  // 约 45% 屏放一条水平带；带内门格可通行，不堵路。
  function stampBandFence(e, blk, s, rng, rec, onGate, gateAllowed, level, sc){
    const cfg = FENCE_BAND[level];
    if(!cfg || !cfg.panel || !cfg.panel.length) return;
    if(rng() >= 0.45) return;
    const barRow = 1 + Math.floor(rng()*5);                // bar 行 1..5
    // 门开在骨架列（主通道）上 → 带内入口/出口必然对齐通路，不用修复再凿
    const gw = cfg.gate.length;
    let gateCol = (sc != null ? sc : 7) - Math.floor(gw/2);
    gateCol = Math.max(1, Math.min(COLS-gw-1, gateCol));
    const nRec0 = (e && e._fences && e._fences[s]) ? e._fences[s].length : 0;
    const nSpr0 = (e && e.structSprites && e.structSprites[s]) ? e.structSprites[s].length : 0;
    const undo = [];
    const put = (r,c,t) => {
      if(r<0||r>=ROWS||c<0||c>=COLS) return;
      if(isStoneTile(level, getTile(blk, r, c))) return;
      undo.push([r,c,getTile(blk,r,c)]);
      setTile(blk, r, c, t);
      rec([[r,c,t]]);
    };
    const panelT = () => cfg.panel.length===1 ? cfg.panel[0] : cfg.panel[Math.floor(rng()*cfg.panel.length)];
    // bar 行：面板 + 门
    for(let c=0; c<COLS; c++){
      const g = (c>=gateCol && c<gateCol+gw) ? cfg.gate[c-gateCol] : panelT();
      put(barRow, c, g);
    }
    // 门精灵 1B 挂在门右格：4 格门(57-5-6-58)→06 格；2 格门(56-57)→57 格
    const doorLeft = gateCol + (gw > 2 ? 1 : 0);
    if(onGate) onGate(barRow, doorLeft);
    // 上墙行（L3：37 + 门顶 35 36）
    if(cfg.wallTop){
      for(let c=0; c<COLS; c++){
        const inGate = (c>=gateCol+1 && c<=gateCol+2);
        put(barRow-1, c, inGate ? cfg.gateTop[c-gateCol-1] : cfg.wallTop);
      }
    }
    // 下墙行（L3：38 + 门底 3C 3D 3E 3F；L6：18 + 门底 13 17，两端 0b）
    if(cfg.wallBot){
      for(let c=0; c<COLS; c++){
        let t = cfg.wallBot;
        if(c>=gateCol && c<gateCol+cfg.gateBot.length) t = cfg.gateBot[c-gateCol];
        else if(cfg.endTile && (c===0 || c===COLS-1)) t = cfg.endTile;
        put(barRow+1, c, t);
      }
    }
    // 门列上下打通（2 宽通道贯穿全屏）：门格=通行口，上下路基清空 → 绝对连通，修复不用凿围栏
    const fillT = cfg.fill != null ? cfg.fill : 0x07;
    for(let dc=0; dc<2; dc++){
      const gx = Math.max(0, Math.min(COLS-1, gateCol+dc));
      for(let row=0; row<ROWS; row++){
        if(isStoneTile(level, getTile(blk, row, gx))) continue;
        if(!isWalkable(level, getTile(blk, row, gx))) setTile(blk, row, gx, fillT);
      }
    }
    // 堵路就整带撤销（带是完整建筑）
    if(!screenExitOk(e, level, s)){
      for(const [r,c,t] of undo) setTile(blk, r, c, t);
      if(e){
        if(e._fences && e._fences[s]) e._fences[s].length = nRec0;
        if(e.structSprites && e.structSprites[s]) e.structSprites[s].length = nSpr0;
      }
    }
  }

  // ===== 各关围栏统一入口（L1/L2/L4/L5 共用：结构一致，仅竖栏/签名图块按关不同）=====
  // ctx.fenceBig：跨屏大围栏状态（首屏底栏带门 → 中间屏竖边 → 末屏顶栏带门）
  // 只要有门 5-6 / 空口(各关空地) 就能通行 → 全宽 + 竖直好几个屏都不算堵路
  function stampFenceLevel(e, level, blk, s, rng, rec, onGate, gateAllowed, ctx, onCannon, sc){
    const fc = FENCE_CFG[level] || FENCE_CFG[0];
    const big = ctx.fenceBig;
    if(big && big.remaining > 0){
      big.remaining--;
      const last = big.remaining <= 0;
      const cells = [];
      for(let r=0; r<ROWS; r++){
        if(big.vLeft && !isStoneTile(level, getTile(blk, r, big.x1)))  cells.push([r, big.x1, fc.vL]);
        if(big.vRight && !isStoneTile(level, getTile(blk, r, big.x2))) cells.push([r, big.x2, fc.vR]);
      }
      // 末屏补一条带门的上横栏（row 1），让吉普从围栏里穿出去
      if(last){
        const bar = [[1, big.x1, 0x0C]];
        let gx = big.x1 + 1;
        let hasOpening = false;
        while(gx < big.x2){
          const k = rng();
          if(k < 0.45 || gx + 3 >= big.x2){
            bar.push([1, gx, [0x0A,0x09,0x08][Math.floor(rng()*3)]]);
            gx++;
          } else if(k < 0.7 && (!gateAllowed || gateAllowed(1, gx+2))){
            bar.push([1, gx,   rng()<0.5 ? 0x10 : 0x07]);
            bar.push([1, gx+1, 0x05]);
            bar.push([1, gx+2, 0x06]);
            hasOpening = true;
            bar.push([1, gx+3, rng()<0.5 ? 0x0F : 0x0B]);
            if(onGate) onGate(1, gx+1);
            gx += 4;
          } else {
            const n = Math.min(big.x2 - gx - 2, 1 + Math.floor(rng()*4));
            bar.push([1, gx, rng()<0.5 ? 0x10 : 0x07]);
            for(let j=0;j<n;j++) bar.push([1, gx+1+j, fc.fill]);
            bar.push([1, gx+1+n, rng()<0.5 ? 0x0F : 0x0B]);
            hasOpening = true;
            gx += 2 + n;
          }
        }
        bar.push([1, big.x2, 0x0D]);
        if(!hasOpening && big.x2 - big.x1 >= 3){
          const mid = Math.floor((big.x1 + big.x2)/2);
          for(const c of bar) if(c[1] === mid) c[2] = fc.fill;
        }
        const barApplied = [];
        for(const c of bar){ if(isStoneTile(level, getTile(blk, c[0], c[1]))) continue; setTile(blk, c[0], c[1], c[2]); barApplied.push(c); }
        rec(barApplied);
      }
      for(const c of cells) setTile(blk, c[0], c[1], c[2]);
      rec(cells);
      ctx.fencePrevInfo = { kind:'bigMid', x1:big.x1, x2:big.x2, vLeft:big.vLeft, vRight:big.vRight };
      if(last) ctx.fenceBig = null;
      return;
    }
    ctx.fencePrevInfo = stampL1Fences(blk, s, rng, rec, onGate, gateAllowed, ctx.fencePrevInfo, level, onCannon, sc);
    // 记下围栏矩形范围：灰炮台可以随机在围栏内布置（营地里的炮位）
    if(e && ctx.fencePrevInfo && ctx.fencePrevInfo.kind === 'rect'){
      (e._fenceRects = e._fenceRects || {})[s] = { x1: ctx.fencePrevInfo.x1, x2: ctx.fencePrevInfo.x2 };
    }
    // 启动大围栏：全宽底栏 + 至少一条竖边 → 向上延续 1~3 屏
    const fi = ctx.fencePrevInfo;
    if(fi && fi.kind === 'bottom' && (fi.x2 - fi.x1) >= 13 && (fi.vLeft || fi.vRight) && rng() < 0.5 && s >= 1 && s + 1 < ctx.nScreens){
      // 把本屏竖边延长到全高，作为大围栏的起始墙
      const ext = [];
      for(let r=0; r<ROWS-1; r++){
        if(fi.vLeft && !isStoneTile(level, getTile(blk, r, fi.x1)))  { setTile(blk, r, fi.x1, fc.vL); ext.push([r, fi.x1, fc.vL]); }
        if(fi.vRight && !isStoneTile(level, getTile(blk, r, fi.x2))) { setTile(blk, r, fi.x2, fc.vR); ext.push([r, fi.x2, fc.vR]); }
      }
      rec(ext);
      if(e) (e._fenceRects = e._fenceRects || {})[s] = { x1: fi.x1, x2: fi.x2 };
      ctx.fenceBig = { remaining: 1 + Math.floor(rng()*3), x1: fi.x1, x2: fi.x2, vLeft: !!fi.vLeft, vRight: !!fi.vRight };
    }
  }

  function applyStage1(blk, s, seg, skel, rng, ctx, skelColAt){
    const e = ctx && ctx.e;
    // 记录围栏格子，生成后重铺（避免被河流/连通修复截断）
    const fences = (e && (e._fences = e._fences || {}));
    const rec = (cells) => { if(fences){ (fences[s] = fences[s] || []).push(cells); } };
    // L1 不用字母道路：它的墙会铺出 53/55/87 这些散图块，破坏"空地只用 88"和河流结构。
    // L1 的地形语汇 = 空地 88 + 围栏 + 河流/桥 + 灰炮台/月湾 + 偶尔的 41/42/43。
    // 空地一律 88(0x58)，整屏先清成 88，绝不留其它地面变体(89~98)
    for(let i=0;i<128;i++) blk[i] = 0x58;
    // 围栏系统：上/下横栏 + 竖直边(左33右34)；中间=10/9/8栅栏 / 88空地 / 5-6门；可构成矩形
    // 河流屏不铺围栏（否则会被河流盖穿、只剩残片）
    if(!(ctx && ctx.riverScreens && ctx.riverScreens[s])){
      // 5-6 门绑定 1B 门精灵（原版：y=32*(ROWS-1-row)、x=门右格(6)、type=0x9B）
      const onGate = (row, gxLeft) => {
        if(!e) return;
        (e.structSprites = e.structSprites || {})[s] = e.structSprites[s] || [];
        e.structSprites[s].push([32*(ROWS-1-row), gxToX(gxLeft+1), 0x1B]);
      };
      // 屏 0 出生点安全区内不放 5-6 门（那里的精灵会被安全区清理删掉）
      const startCol0 = (skel && skel.cols && skel.cols[0] != null) ? skel.cols[0] : 4;
      const gateAllowed = (row, spriteGx) => {
        if(s !== 0) return true;
        return !((row >= ROWS-3) && (spriteGx >= startCol0-2) && (spriteGx <= startCol0+3));
      };
      // 围栏里嵌的灰炮台：精灵锚点与 placeCannonBases 相同（x=col*8+4, y=32*(7-row)+2）
      const onCannon = (row, gx) => {
        if(!e) return;
        (e.structSprites = e.structSprites || {})[s] = e.structSprites[s] || [];
        e.structSprites[s].push([32*(ROWS-1-row) + 2, gxToX(gx) + 4, rng()<0.75 ? 0x05 : 0x06]);
      };
      const scF = (skel && skel.cols && skel.cols[s] != null) ? skel.cols[s] : 7;
      stampFenceLevel(e, 0, blk, s, rng, rec, onGate, gateAllowed, ctx, onCannon, scF);
    }
    // 河流/桥/汽艇由旧 L1 河流系统(planL1River+enhanceL1River)统一生成，不在此重复
  }

  // ===== Stage2 古代遗迹：石柱阵战斗厅 + 浅水池 =====
  function applyStage2(blk, s, seg, skel, rng, ctx, skelColAt){
    const role = TILE_ROLE[1];
    const segPos = s - seg.start;
    const segLen = seg.end - seg.start;
    // L2 不用字母道路：它的墙会用石柱(72)/浅水池(68)等结构碎片，单独摆出来就是"乱码"感。
    // 这些图块只该作为完整建筑的一部分出现。
    // L2 围栏：与 L1 结构相同（全宽横栏 + 跨屏大围栏），竖栏 24(0x18)左 / 28(0x1C)右、空地 79(0x4F)
    // L2 横栏是障碍，靠 5-6 门 / 79 空口通行；铺完若堵死本屏通路就整屏撤销
    {
      const e2 = ctx && ctx.e;
      const fences2 = (e2 && (e2._fences = e2._fences || {}));
      const rec2 = (cells) => { if(fences2){ (fences2[s] = fences2[s] || []).push(cells); } };
      const onGate2 = (row, gxLeft) => {
        if(!e2) return;
        (e2.structSprites = e2.structSprites || {})[s] = e2.structSprites[s] || [];
        e2.structSprites[s].push([32*(ROWS-1-row), gxToX(gxLeft+1), 0x1B]);
      };
      const startCol0 = (skel && skel.cols && skel.cols[0] != null) ? skel.cols[0] : 4;
      const gateAllowed2 = (row, spriteGx) => {
        if(s !== 0) return true;
        return !((row >= ROWS-3) && (spriteGx >= startCol0-2) && (spriteGx <= startCol0+3));
      };
      const mustContinue = !!(ctx.fenceBig && ctx.fenceBig.remaining > 0);   // 大围栏中间屏必须续
      if(mustContinue || rng() < 0.8){
        const snap = blk.slice();
        const nSpr = ((e2 && e2.structSprites && e2.structSprites[s]) || []).length;
        const nRec = (fences2 && fences2[s]) ? fences2[s].length : 0;
        const onCannon2 = (row, gx) => {
          if(!e2) return;
          (e2.structSprites = e2.structSprites || {})[s] = e2.structSprites[s] || [];
          e2.structSprites[s].push([32*(ROWS-1-row) + 2, gxToX(gx) + 4, rng()<0.75 ? 0x05 : 0x06]);
        };
        const scF2 = (skel && skel.cols && skel.cols[s] != null) ? skel.cols[s] : 7;
        stampFenceLevel(e2, 1, blk, s, rng, rec2, onGate2, gateAllowed2, ctx, onCannon2, scF2);
        if(e2 && !screenExitOk(e2, 1, s)){
          for(let k=0;k<128;k++) blk[k] = snap[k];
          if(e2.structSprites && e2.structSprites[s]) e2.structSprites[s].length = nSpr;
          if(fences2 && fences2[s]) fences2[s].length = nRec;
          ctx.fencePrevInfo = null;
          ctx.fenceBig = null;
        }
      } else {
        ctx.fencePrevInfo = null;
      }
    }
    // L2 不再零散摆石柱/浅水池：72(0x48)、68(0x44)、109(0x6D) 都是"完整建筑/岩壁"的结构碎片，
    // 单独丢出来就是乱码感。这些图块只该出现在原版那种连贯墙体里。
    // L2 的主体内容 = 围栏 + 战俘房 + 偶尔的 41/42/43 障碍，不再额外散置结构碎片。
  }

  // L3 水块（竖直堆叠）：上边界 17-23-18、中间 13-35-12、下边界 21-22-22
  // 23/22 同 35 一样中间可去可加（加宽）
  function stampL3WaterBlock(blk, x, width, y, height){
    if(width < 3) width = 3;
    if(height < 3) height = 3;
    // 上边界 17-23-18（中间 23 = 0x17，不是 35）
    setTile(blk, y, x, 0x11);
    for(let k=1; k<width-1; k++) setTile(blk, y, x+k, 0x17);
    setTile(blk, y, x+width-1, 0x12);
    // 中间 13-35-12
    for(let r=y+1; r<y+height-1; r++){
      setTile(blk, r, x, 0x0D);
      for(let k=1; k<width-1; k++) setTile(blk, r, x+k, 0x23);
      setTile(blk, r, x+width-1, 0x0C);
    }
    // 下边界 21-22-22
    setTile(blk, y+height-1, x, 0x15);
    for(let k=1; k<width; k++) setTile(blk, y+height-1, x+k, 0x16);
  }


  // ===== L3 激光阵结构 =====
  // 数据按“列”记录：每个数组是一个纵向列，从上到下 4 个图块。
  // 你给出的 7 组数据因此表示 7 列 × 4 行，而不是 4 行 × 7 列。
  const L3_LASER_UNIT_COLUMNS = [
    [0x29,0x33,0x31,0x07], // 41-51-49-空
    [0x50,0x34,0x31,0x07], // 80-52-49-空
    [0x47,0x46,0x31,0x07], // 71-70-49-空
    [0x50,0x34,0x31,0x07], // 80-52-49-空
    [0x47,0x46,0x31,0x07], // 71-70-49-空
    [0x50,0x34,0x31,0x07], // 80-52-49-空
    [0x28,0x32,0x31,0x07], // 40-50-49-空
  ];
  const L3_LASER_LEFT_COLUMN   = [0x28,0x2A,0x2E,0x07];  // 40-42-46-空
  const L3_LASER_RIGHT_COLUMN  = [0x29,0x2B,0x2F,0x07];  // 41-43-47-空
  const L3_LASER_CENTER_COLUMN = [0x30,0x34,0x31,0x07];  // 48-52-49-空

  // 输入数据严格按“列”保存：7 列 × 4 行，每列从上到下读取。
  // 三个单元应上下堆叠，形成 7 列 × 12 行，也就是 12×7 结构。
  function stampL3LaserColumns(blk, x, y, columns) {
    for(let col=0; col<columns.length; col++) {
      for(let row=0; row<columns[col].length; row++) {
        const gx = x + col;
        const gy = y + row;
        if(gy >= 0 && gy < ROWS && gx >= 0 && gx < COLS) {
          setTile(blk, gy, gx, columns[col][row]);
        }
      }
    }
  }

  function laserUnitColumns(edge) {
    const columns = L3_LASER_UNIT_COLUMNS.map(column => column.slice());
    if(edge) {
      columns[0] = edge.slice();
      columns[columns.length - 1] = edge.slice();
    }
    return columns;
  }

  function stampL3LaserArray(e, blk, screen, rng, mirror, options) {
    // 不是横向拼三个单元：三个 7×4 单元按上下方向排列。
    // 单屏高 8 格，因此这里写入 0~11 行时只保留当前屏可见部分；
    // 跨屏连续结构由后续屏继续生成。
    options = options || {};
    const x = options.x == null ? 3 : options.x;
    // 4x7 是不可拆分的原版结构单元；中心列固定为1列，禁止在单元内部扩宽。
    const centerWidth = 1;
    const left = mirror ? L3_LASER_RIGHT_COLUMN : L3_LASER_LEFT_COLUMN;
    const right = mirror ? L3_LASER_LEFT_COLUMN : L3_LASER_RIGHT_COLUMN;
    // 基础结构严格保留为用户指定的7列；外围只替换首尾列。
    const columns = laserUnitColumns();
    // Layout row 0 is the bottom of the playfield; source rows are listed
    // top-to-bottom, so reverse only the vertical order when stamping.
    const addLeft = options.addLeft !== false;
    const addRight = options.addRight !== false;
    if(addLeft) columns.unshift(mirror ? right.slice() : left.slice());
    if(addRight) columns.push(mirror ? left.slice() : right.slice());
    const rowOffset = options.rowOffset || 0;
    // 12x(3+centerWidth) 阵列按 4 行单元切片到连续屏幕；越过当前屏的行
    // 留给下一次调用，绝不写入屏外，也不从第0列开始以免被边界覆盖。
    for(let localRow=0; localRow<4; localRow++) {
      const screenRow = rowOffset + localRow;
      if(screenRow < 0 || screenRow >= ROWS) continue;
      // 屏幕按 s=0 起点向上滚动：续接的第三个单元必须从下一屏底部
      // 向上写入，否则会落在下一屏顶部，中间就会出现空行。
      const sourceRow = localRow;
      for(let col=0; col<columns.length; col++) {
        const gx = x + col;
        if(gx < 0 || gx >= COLS) continue;
        setTile(blk, screenRow, gx, columns[col][sourceRow]);
      }
    }

    // 7 列道路中的弯折口，左右镜像使用相反侧。
    const bendX = mirror ? x + Math.max(0, columns.length - 3) : x;
    // 弯道只能落在每个4行单元的第4行空格，不能覆盖第3行的结构块。
    const bendRow = mirror ? 7 : 3;
    for(let col=0; col<3; col++) {
      const gx = bendX + col;
      if(gx >= 0 && gx < COLS) setTile(blk, bendRow, gx, 0x07);
    }

    if(e) {
      // 记录激光阵屏，后续统一清除会挡住激光弹道的 0x26/0x27。
      e._l3LaserScreens = e._l3LaserScreens || new Set();
      e._l3LaserScreens.add(screen);
      e.structSprites = e.structSprites || {};
      e.structSprites[screen] = e.structSprites[screen] || [];
      // 0x26/0x27 是实心阻挡块，不能留在激光阵的道路和弹道区域。
      for(let row=0; row<ROWS; row++) {
        for(let gx=0; gx<COLS; gx++) {
          const tile = getTile(blk, row, gx);
        }
      }
      // 三列激光炮沿阵列的左/右边缘交替，形成己字/镜像己字弯路。
      // 原版为稀疏绑定：每个连续阵列只在夹层保留一枚 38，放在该层最左侧。
      if(options.bindSprite !== false) {
        // Bind 38 to the second column of the 4x7 body (not the perimeter).
        // Mirror swaps the corresponding second-from-left body column.
        const bodyStart = x + (addLeft ? 1 : 0);
        const bodyEnd = x + columns.length - 1 - (addRight ? 1 : 0);
        // The anchor is always the left-most 80 column (second column of the
        // 4x7 body); mirroring changes the artwork, not this original anchor.
        const spriteCol = bodyStart + 1;
        const spriteRow = options.bindRow != null ? options.bindRow : (mirror ? Math.min(ROWS - 1, 5) : Math.max(0, 2));
        // Original anchor: center of the second-from-left 80 tile.
        e.structSprites[screen].push([rowToY(spriteRow) + (options.bindYAdjust || 0), gxToX(spriteCol) + 4, 0x38, true]);
      }
      e._l3LaserProtect = e._l3LaserProtect || {};
      const record = { x, width: columns.length, centerWidth, rowOffset, mirror, addLeft, addRight, bindSprite: options.bindSprite !== false, bindRow: options.bindRow, bindYAdjust: options.bindYAdjust };
      const oldProtect = e._l3LaserProtect[screen];
      if (options.appendProtect && oldProtect) {
        oldProtect.parts = oldProtect.parts || [];
        oldProtect.parts.push(record);
      } else {
        e._l3LaserProtect[screen] = record;
      }
    }
  }

  function restoreL3LaserArrays(e){
    if(!e || !e._l3LaserProtect) return;
    for(const key of Object.keys(e._l3LaserProtect)){
      const screen = Number(key), p = e._l3LaserProtect[screen];
      const blk = e.layoutBlocks[e.idx[screen]];
      if(!blk || !p) continue;
      if(e.structSprites && e.structSprites[screen]){
        e.structSprites[screen] = e.structSprites[screen].filter(o => (o[2] & 0x7F) !== 0x38);
      }
      const parts = (p.parts || [p]).slice();
      // Rebuilding must replace the protection record, otherwise each final
      // restore appends the same unit again.
      e._l3LaserProtect[screen] = null;
      for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        const part = parts[partIndex];
        stampL3LaserArray(e, blk, screen, function(){ return 0.5; }, part.mirror, {
        x:part.x, centerWidth:part.centerWidth, rowOffset:part.rowOffset, addLeft:part.addLeft, addRight:part.addRight, bindSprite:part.bindSprite, bindRow:part.bindRow, bindYAdjust:part.bindYAdjust,
          appendProtect: partIndex > 0,
        });
      }
      // 激光阵屏左右边沿禁止残留 0x27，避免边缘出现旧墙/电门图块。
      for(let row=0; row<ROWS; row++){
      }
    }
  }

  // ===== Stage3 港口工业区：超长河流(1/3条路) + 2字/镜像2字折返路 + 激光阵 =====
  function applyStage3(blk, s, seg, skel, rng, ctx, skelColAt){
    const role = TILE_ROLE[2];
    const segPos = s - seg.start;
    const pick = (arr) => arr[Math.floor(rng()*arr.length)];
    // L3 新结构只使用 0x07 空地；禁用旧的 53/54/55（0x35/0x36/0x37）道路变体。
    const roadT = () => 0x07;
    const e = ctx && ctx.e;
    const isWalk = (t) => { const r = roleOf(2,t); return r==='road'||r==='mixed'; };

    // 随机阶段（避免相邻屏重复，打破固定周期）
    let phase = Math.floor(rng()*4);
    if(phase === ctx.phaseLast) phase = (phase+1)%4;
    ctx.phaseLast = phase;
    // 激光阵随机段：至少连续两屏；每完成两屏仍可继续，最多延伸到 Boss 前，
    // 因而激光阵排数没有固定上限。第8/9屏提高出现概率，方向和列位置在段内锁定。
    const laserStart = ctx.l3LaserRun > 0 || rng() < 0.45 || s === 7 || s === 8;
    if(laserStart){
      if(ctx.l3LaserRun <= 0){
        // 从当前屏一直延伸到Boss前；地图长度是唯一的自然上限，
        // 不再按“两屏一组”重置，保证可连续出现任意多排。
        // Keep laser arrays in readable original-style groups. A run may
        // continue for several screens, but must not consume the whole stage.
        ctx.l3LaserRun = Math.min(Math.max(2, ctx.nScreens - s - 1), 2 + Math.floor(rng() * 3));
        ctx.l3LaserMirror = rng() < 0.5;
        ctx.l3LaserX = 2 + Math.floor(rng() * 5);
        ctx.l3LaserCenterWidth = 1;
        ctx.l3LaserAddLeft = rng() < 0.85;
        ctx.l3LaserAddRight = rng() < 0.85;
        if(!ctx.l3LaserAddLeft && !ctx.l3LaserAddRight) ctx.l3LaserAddLeft = rng() < 0.5;
        ctx.l3LaserOffset = 0;
        ctx.l3LaserUnitIndex = 0;
      }
      stampL3LaserArray(e, blk, s, rng, ctx.l3LaserMirror, {
        x: ctx.l3LaserX,
        centerWidth: ctx.l3LaserCenterWidth,
        addLeft: ctx.l3LaserAddLeft,
        addRight: ctx.l3LaserAddRight,
        rowOffset: 0,
        bindSprite: false,
      });
      // Two 7-column x 4-row units can share one screen without a gap.
      // Their second-column 80 tiles form the first same-screen夹层.
      if (ctx.l3LaserOffset === 0) {
        stampL3LaserArray(e, blk, s, rng, ctx.l3LaserMirror, {
          x: ctx.l3LaserX,
          centerWidth: ctx.l3LaserCenterWidth,
          addLeft: ctx.l3LaserAddLeft,
          addRight: ctx.l3LaserAddRight,
          rowOffset: 4,
          bindSprite: false,
          appendProtect: true,
        });
      }
      // Original L3 starts with two vertically adjacent 4x7 units on one
      // screen; the second unit creates the first inter-row 38 at row 2.
      ctx.l3LaserOffset = 0;
      ctx.l3LaserUnitIndex++;
      ctx.l3LaserRun--;
      if(ctx.l3LaserRun <= 0) {
        ctx.l3LaserOffset = 0;
        ctx.l3LaserUnitIndex = 0;
      }
    } else if(phase === 3){
      // ---- 大面积河流：宽河(5~7列)竖贯 + 1~2 座桥（路）横跨，两岸各 ≥3 格路 ----
      const mainCol = 4 + Math.floor(rng()*4);       // 主河列 4~7（保证两岸 ≥3 格）
      const mainW = 5 + Math.floor(rng()*3);         // 主河宽 5~7（大面积）
      stampL3WaterBlock(blk, mainCol, mainW, 0, ROWS);   // 17-23-18 / 13-35-12 / 21-22-22 整条连续，不挖断
      // （去掉桥：路面图块 53/54/55 会打断水面）
    } else if(phase === 0){
      // ---- 竖直超长河流：2 列河水(0x23)，把路逼成 1 条 或 3 条 ----
      const mode = rng() < 0.5 ? 1 : 3;
      if(mode === 1){
        // 1 条路：大面积河贴路一侧（3 列），整条路只剩一条宽道
        const left = rng() < 0.5;
        if(left){ stampL3WaterBlock(blk, 1, 3, 0, ROWS); }
        else    { stampL3WaterBlock(blk, 12, 3, 0, ROWS); }
      } else {
        // 3 条路：大面积河(3列) + 墙带(2列)，路分左/中/右 三条竖道（各 ≥3 格）
        const rCol = 4 + Math.floor(rng()*2);   // 河流 4~6
        const wCol = rCol + 6;                  // 墙带 10~12
        stampL3WaterBlock(blk, rCol, 3, 0, ROWS);
        if(wCol < 15){ for(let row=0; row<ROWS; row++){ setTile(blk,row,wCol,0x1B); setTile(blk,row,wCol+1,0x1B); } }
      }
      // 河流屏：不散置（大面积河已够，散置会与河水形成封闭死角）
    } else {
      // L3 激光阵专用段：移除旧的“2字/镜像2字”货箱道路结构。
      // 这里不再生成 0x1A/0x1B 旧墙带，只生成新的列式激光阵与弯道。
      const mirror = rng() < 0.5;
      if(e) stampL3LaserArray(e, blk, s, rng, mirror, { x: 3, centerWidth: 1, rowOffset: 0, bindSprite: false });
      // 保证上下屏衔接边保留道路，不调用后续连通性开路修复。
      for(let gx=0; gx<COLS; gx++) {
        setTile(blk, 0, gx, roadT());
        setTile(blk, ROWS-1, gx, roadT());
      }
    }

    // 边界：不随机撒 35 水块，用货箱墙或留空白
    for(let row=0; row<ROWS; row++){
      if(rng() < 0.45){ setTile(blk,row,0,roadT()); }
      else if(isWalk(getTile(blk,row,1))){ setTile(blk,row,0,roadT()); }
      else { setTile(blk,row,0,roadT()); }
      if(rng() < 0.45){ setTile(blk,row,15,roadT()); }
      else if(isWalk(getTile(blk,row,14))){ setTile(blk,row,15,roadT()); }
      else { setTile(blk,row,15,roadT()); }
    }
    // 旧的 L3 水平围栏/53-55 组合结构已移除。

    // 激光阵屏不允许出现 26/27，避免墙块遮挡激光路线。
    for(let row=0; row<ROWS; row++) {
      for(let gx=0; gx<COLS; gx++) {
        const tile = getTile(blk, row, gx);
        if(tile === 0x26 || tile === 0x27) setTile(blk, row, gx, 0x07);
      }
    }
  }

  // ===== Stage4 深山沼泽：岩壁夹谷 + 沼泽切割 =====
  function applyStage4(blk, s, seg, skel, rng, ctx, skelColAt){
    const role = TILE_ROLE[3];
    const segPos = s - seg.start;
    const rock = [0x30,0x2C,0x2F,0x24];
    const rockT = () => rock[Math.floor(rng()*rock.length)];
    // 左右边界：不固定实体岩壁，部分留空白（地面可通行）
    for(let row=0; row<ROWS; row++){
      if(rng() < 0.5){ setTile(blk,row,0,0x30); setTile(blk,row,1,0x2F); }
      if(rng() < 0.5){ setTile(blk,row,14,0x2C); setTile(blk,row,15,0x30); }
    }
    // 中间大峡谷：黄土路铺底
    for(let row=0; row<ROWS; row++){
      for(let gx=2; gx<=13; gx++){
        setTile(blk, row, gx, [0x50,0x51,0x52][Math.floor(rng()*3)]);
      }
    }
    // 大峡谷特征（随机阶段，避免相邻屏重复）：菱形 / Z字 / 镜像Z字 / 六边形厚墙 / 大面积水域
    let phase = Math.floor(rng()*5);
    if(phase === ctx.phaseLast) phase = (phase+1)%5;
    ctx.phaseLast = phase;
    if(phase === 4){
      // 大面积水域：浅水湖泊/大河（L4 水域可通车，吉普可涉水，不堵路）
      const waterT = [0x53,0x57,0x58,0x59,0x5A,0x5B];
      const wT = () => waterT[Math.floor(rng()*waterT.length)];
      const kind = rng();
      if(kind < 0.5){
        // 大河：3 行横贯整幅路面
        const row = 2 + Math.floor(rng()*2);
        for(let r=row; r<row+3; r++){
          for(let gx=2; gx<=13; gx++) setTile(blk, r, gx, wT());
        }
      } else if(kind < 0.8){
        // 大湖：6~7 列 × 4 行 水泊
        const cx = 3 + Math.floor(rng()*4), cy = 2 + Math.floor(rng()*2);
        for(let r=cy; r<Math.min(ROWS,cy+4); r++){
          for(let gx=cx; gx<Math.min(14,cx+7); gx++) setTile(blk, r, gx, wT());
        }
      } else {
        // 双河：上 2 行 + 下 2 行 两段水
        for(let r=0; r<2; r++) for(let gx=2; gx<=13; gx++) setTile(blk, r, gx, wT());
        for(let r=6; r<8; r++) for(let gx=2; gx<=13; gx++) setTile(blk, r, gx, wT());
      }
    } else     if(phase === 3){
      // 六边形厚墙：2 格厚，长边横向切上下 / 90° 旋转纵向切左右；墙长、缺口宽随机（长短不一）
      const rockT = () => rock[Math.floor(rng()*rock.length)];
      const kind = rng();
      if(kind < 0.5){
        // 横向厚墙 ×1 → 上下 2 段：墙长 8~14，缺口宽 3~5
        const row = 2 + Math.floor(rng()*2);
        const w1 = 2 + Math.floor(rng()*5);                        // 墙左端 2~6
        const w2 = Math.max(w1 + 8, 13 - Math.floor(rng()*2));     // 墙右端（≥8 宽）
        const gw = 3 + Math.floor(rng()*3);                        // 缺口宽 3~5
        const gap = w1 + Math.floor(rng()*Math.max(1, w2 - w1 - gw - 1));
        for(let r = row; r < row+2; r++){
          for(let gx=Math.max(2,w1); gx<=Math.min(13,w2); gx++){
            if(gx >= gap && gx < gap+gw) continue;
            setTile(blk, r, gx, rockT());
          }
        }
      } else if(kind < 0.8){
        // 横向厚墙 ×2 → 上中下 3 段：每段墙长/缺口随机
        for(let wi=0; wi<2; wi++){
          const row = wi===0 ? 2 : 5;
          const w1 = 2 + Math.floor(rng()*5);
          const w2 = Math.max(w1 + 8, 13 - Math.floor(rng()*2));
          const gw = 3 + Math.floor(rng()*3);
          const gap = w1 + Math.floor(rng()*Math.max(1, w2 - w1 - gw - 1));
          for(let gx=Math.max(2,w1); gx<=Math.min(13,w2); gx++){
            if(gx >= gap && gx < gap+gw) continue;
            setTile(blk, row, gx, rockT());
            setTile(blk, row+1, gx, rockT());
          }
        }
      } else {
        // 纵向厚墙（90° 旋转）→ 左右 2 段：墙长 4~7 行，缺口 2~3 行
        const col = 5 + Math.floor(rng()*4);                       // col 5~8
        const r1 = 1 + Math.floor(rng()*3);                        // 墙起始行 1~3
        const r2 = Math.max(r1+4, 6 - Math.floor(rng()*2));        // 墙结束行（≥4 行）
        const gw = 2 + Math.floor(rng()*2);                        // 缺口 2~3 行
        const gap = r1 + Math.floor(rng()*Math.max(1, r2 - r1 - gw - 1));
        for(let row=0; row<ROWS; row++){
          if(row < r1 || row > r2) continue;
          if(row >= gap && row < gap+gw) continue;
          setTile(blk, row, col, rockT());
          setTile(blk, row, col+1, rockT());
        }
      }
    } else if(phase === 0){
      // 菱形结构：把道路从中间分成两半，玩家绕左或绕右；半径/中心随机（大小不一）
      const radius = 2 + rng()*2;                            // 半径 2~4
      const cx = 6 + Math.floor(rng()*4);                    // 中心列 6~9
      const cy = 2 + Math.floor(rng()*3);                    // 中心行 2~4
      for(let row=0; row<ROWS; row++){
        for(let gx=2; gx<=13; gx++){
          const dx = Math.abs(gx - cx - 0.5);
          const dy = Math.abs(row - cy - 0.5);
          if(dx + dy <= radius){
            setTile(blk, row, gx, rockT());
          }
        }
      }
    } else if(phase === 1){
      // 横向 Z 字：斜向岩壁带（左上→右下），缺口宽 3~6 随机（道路宽不定）
      const startGx = 3 + Math.floor(rng()*3);               // 斜带起点 3~5
      const gw = 3 + Math.floor(rng()*4);                    // 缺口宽 3~6
      for(let row=1; row<ROWS-1; row++){
        const bandGx = startGx + Math.floor(row * 1.2);
        for(let gx=2; gx<=13; gx++){
          if(gx >= bandGx && gx < bandGx+gw) continue;
          setTile(blk, row, gx, rockT());
        }
      }
    } else {
      // 镜像 Z 字：斜向岩壁带（右上→左下），缺口宽 3~6 随机
      const startGx = 11 - Math.floor(rng()*3);               // 斜带起点 8~10
      const gw = 3 + Math.floor(rng()*4);                     // 缺口宽 3~6
      for(let row=1; row<ROWS-1; row++){
        const bandGx = startGx - Math.floor(row * 1.2);
        for(let gx=2; gx<=13; gx++){
          if(gx >= bandGx && gx < bandGx+gw) continue;
          setTile(blk, row, gx, rockT());
        }
      }
    }
    // L4 围栏：与 L1 结构相同，竖栏 32(0x20)左 / 33(0x21)右、空地 80(0x50)、签名石头 79(0x4F)
    {
      const e4 = ctx && ctx.e;
      const fences4 = (e4 && (e4._fences = e4._fences || {}));
      const rec4 = (cells) => { if(fences4){ (fences4[s] = fences4[s] || []).push(cells); } };
      const onGate4 = (row, gxLeft) => {
        if(!e4) return;
        (e4.structSprites = e4.structSprites || {})[s] = e4.structSprites[s] || [];
        e4.structSprites[s].push([32*(ROWS-1-row), gxToX(gxLeft+1), 0x1B]);
      };
      const startCol0 = (skel && skel.cols && skel.cols[0] != null) ? skel.cols[0] : 4;
      const gateAllowed4 = (row, spriteGx) => {
        if(s !== 0) return true;
        return !((row >= ROWS-3) && (spriteGx >= startCol0-2) && (spriteGx <= startCol0+3));
      };
      const mustContinue = !!(ctx.fenceBig && ctx.fenceBig.remaining > 0);
      if(mustContinue || rng() < 0.7){
        const snap = blk.slice();
        const nSpr = ((e4 && e4.structSprites && e4.structSprites[s]) || []).length;
        const nRec = (fences4 && fences4[s]) ? fences4[s].length : 0;
        const scF4 = (skel && skel.cols && skel.cols[s] != null) ? skel.cols[s] : 7;
        stampFenceLevel(e4, 3, blk, s, rng, rec4, onGate4, gateAllowed4, ctx, null, scF4);
        if(e4 && !screenExitOk(e4, 3, s)){
          for(let k=0;k<128;k++) blk[k] = snap[k];
          if(e4.structSprites && e4.structSprites[s]) e4.structSprites[s].length = nSpr;
          if(fences4 && fences4[s]) fences4[s].length = nRec;
          ctx.fencePrevInfo = null;
          ctx.fenceBig = null;
        }
      } else {
        ctx.fencePrevInfo = null;
      }
    }
  }

  // 巷道屏：左右黑边（顶行51-59、中间0x26、底行47），中间巷道（上边界48-49-50、主体34-35-36、下边界仍是巷道）
  function alleywayScreen(blk, rng, groundT, wall38){
    const innerW = 3 + Math.floor(rng()*4);        // 内部宽（中间可加宽）
    const h = 4 + Math.floor(rng()*5);             // 高 4~8 行
    const y = Math.floor(rng()*Math.max(1, ROWS-h-1));
    const maxX = 12 - innerW;
    const x = 4 + Math.floor(rng()*Math.max(1, maxX - 3));
    // 黑边顶行：51/59 循环交替；第二行 55/63/58 随机
    const secondWall = () => [0x37, 0x3F, 0x3A][Math.floor(rng()*3)];   // 55, 63, 58
    for(let r=y; r<y+h; r++){
      // 中间巷道：顶行 48-49-50（49 可加宽），其余 34-35-36（下边界仍是巷道）
      if(r === y){
        setTile(blk, r, x, 0x30);
        for(let c=1; c<innerW-1; c++) setTile(blk, r, x+c, 0x31);
        setTile(blk, r, x+innerW-1, 0x32);
      } else {
        setTile(blk, r, x, 0x34);
        for(let c=1; c<innerW-1; c++) setTile(blk, r, x+c, 0x35);
        setTile(blk, r, x+innerW-1, 0x36);
      }
      // 左右黑边：顶行 51-59、中间 0x26、底行 47
      for(let c=0; c<x; c++){
        if(r === y) setTile(blk, r, c, (c % 2 === 0) ? 0x33 : 0x3B);   // 顶行 51/59 循环
        else if(r === y+1) setTile(blk, r, c, secondWall());           // 下层 55/63/58
        else if(r === y+h-1) setTile(blk, r, c, 0x2F);
        else setTile(blk, r, c, 0x26);
      }
      for(let c=x+innerW; c<COLS; c++){
        if(r === y) setTile(blk, r, c, (c % 2 === 0) ? 0x33 : 0x3B);   // 顶行 51/59 循环
        else if(r === y+1) setTile(blk, r, c, secondWall());           // 下层 55/63/58
        else if(r === y+h-1) setTile(blk, r, c, 0x2F);
        else setTile(blk, r, c, 0x26);
      }
    }
  }

  // ===== L5 石块（3 行高，用户规格）=====
  // 顶 20-21-21-23 / 中 24-25-26-27 / 底 28-29-30-31（十进制=0x14-0x1F）
  //   20/24/28=左列，23/27/31=右列，21=顶中循环，25-26/29-30=中/底两图块循环
  // 宽 2~5（最小 3×2=20,23,24,27,28,31；4×3=全宽；3×3=去一列）
  // 贴边沿：去左列(20/24/28)贴左边沿 / 去右列(23/27/31)贴右边沿
  // 石块间留 ≥1 格空地（正常地面），其他结构可在空地上生成
  function stampL5StoneBlocks(blk, s, rng, skelColAt){
    if(rng() >= 0.5) return;                       // ~50% 屏放石块
    const y0 = 1 + Math.floor(rng()*3);            // 顶行 1..3（3 行高 → 占 1..5 行）
    const put = (r,c,t) => { if(r>=0&&r<ROWS&&c>=0&&c<COLS) setTile(blk,r,c,t); };
    const draw = (x0, y0, w, edge) => {
      if(edge === 'left'){
        // 去左列贴左边沿：21×n-23 / 25-26循环-27 / 29-30循环-31
        for(let c=0;c<w;c++){
          const last = c===w-1;
          put(y0,   x0+c, last?0x17:0x15);
          put(y0+1, x0+c, last?0x1B:((c%2===0)?0x19:0x1A));
          put(y0+2, x0+c, last?0x1F:((c%2===0)?0x1D:0x1E));
        }
      } else if(edge === 'right'){
        // 去右列贴右边沿：20-21×n / 24-25-26循环 / 28-29-30循环
        for(let c=0;c<w;c++){
          const first = c===0;
          put(y0,   x0+c, first?0x14:0x15);
          put(y0+1, x0+c, first?0x18:(((c-1)%2===0)?0x19:0x1A));
          put(y0+2, x0+c, first?0x1C:(((c-1)%2===0)?0x1D:0x1E));
        }
      } else {
        put(y0,   x0,   0x14);
        for(let c=1;c<w-1;c++) put(y0, x0+c, 0x15);
        put(y0,   x0+w-1, 0x17);
        put(y0+1, x0,   0x18);
        for(let c=1;c<w-1;c++) put(y0+1, x0+c, (c%2===1)?0x19:0x1A);
        put(y0+1, x0+w-1, 0x1B);
        put(y0+2, x0,   0x1C);
        for(let c=1;c<w-1;c++) put(y0+2, x0+c, (c%2===1)?0x1D:0x1E);
        put(y0+2, x0+w-1, 0x1F);
      }
    };
    const sc = skelColAt(y0+1);
    const kind = rng();
    if(kind < 0.35){
      // 单块（不挡主通道）：落点避开门列 sc±2，多次重试
      const w = 2 + Math.floor(rng()*3);
      let x0 = -1;
      for(let at=0; at<8 && x0<0; at++){
        const cand = 1 + Math.floor(rng()*Math.max(1, COLS-w-3));
        if(cand + w - 1 < sc - 2 || cand > sc + 2) x0 = cand;
      }
      if(x0 >= 0) draw(x0, y0, w, null);
    } else if(kind < 0.7){
      // 左右两块：左块-空地-右块（空地含主通道，≥1 格；右块离门列 ≥2 格）
      const wL = 2 + Math.floor(rng()*3);
      const wR = 2 + Math.floor(rng()*3);
      const gapL = 1 + Math.floor(rng()*2);
      const gapR = 2 + Math.floor(rng()*2);
      const xL = Math.max(0, sc - gapL - wL);
      const xR = Math.min(COLS-wR, sc + gapR);
      if(xL >= 0 && xR + wR <= COLS && xL + wL + 1 <= xR){
        draw(xL, y0, wL, null);
        draw(xR, y0, wR, null);
      }
    } else if(kind < 0.85){
      // 上下两块：石块1-空地-石块2（中间 ≥1 行空地）——3+1+3 行=7 行，只能从顶行 1 开始
      const w = 2 + Math.floor(rng()*3);
      let x0 = -1;
      for(let at=0; at<8 && x0<0; at++){
        const cand = 1 + Math.floor(rng()*Math.max(1, COLS-w-3));
        if(cand + w - 1 < sc - 2 || cand > sc + 2) x0 = cand;
      }
      if(x0 >= 0){
        draw(x0, 1, w, null);
        draw(x0, 5, w, null);
      }
    } else {
      // 贴边沿：左贴边 + 右贴边，中间留空（含主通道）
      const wL = 2 + Math.floor(rng()*3);
      const wR = 2 + Math.floor(rng()*3);
      const gapL = 1 + Math.floor(rng()*2);
      const gapR = 2 + Math.floor(rng()*2);
      if(sc - gapL >= wL - 1 && sc + gapR + wR <= COLS){
        draw(0, y0, wL, 'left');
        draw(COLS-wR, y0, wR, 'right');
      }
    }
  }

  // ===== Stage5 山地要塞：横向高墙 + 唯一隘口 =====
  function applyStage5(blk, s, seg, skel, rng, ctx, skelColAt){
    const role = TILE_ROLE[4];
    const segPos = s - seg.start;
    // L5 不用字母道路（墙碎片单独摆出会乱）
    const segLen = seg.end - seg.start;
    const groundT = PRIMARY_GROUND[4];
    // 巷道屏：战斗段 ~50% 概率，长短不一的窄巷（避开高墙屏/字母屏）
    const isWallPos = segLen >= 3 && (segPos === Math.floor(segLen/2) || segPos === Math.floor(segLen/2)+1);
    if(seg.type === 2 && !isWallPos && rng() < 0.7){
      alleywayScreen(blk, rng, groundT, 0x26);
      return;
    }
    // 横向高墙（0x26），每片段 1 堵，留唯一隘口；墙长/隘口宽随机（长短不一）
    // 不贴屏边（留 2 列），避免路边 0x26 残留感
    if(isWallPos){
      const row = 2 + Math.floor(rng()*3);
      const gap = Math.max(3, Math.min(COLS-4, skelColAt(row)));
      const w1 = Math.max(2, gap - (4 + Math.floor(rng()*6)));   // 墙左端（可变）
      const w2 = Math.min(COLS-3, gap + (4 + Math.floor(rng()*6))); // 墙右端（可变）
      const gw = 2 + Math.floor(rng()*3);                        // 隘口宽 2~4
      for(let gx=w1; gx<=w2; gx++){
        if(Math.abs(gx-gap) <= Math.floor(gw/2)) continue;
        setTile(blk,row,gx, 0x26);
      }
      // 墙基：原版要塞墙底带 63/58/55(0x3F/0x3A/0x37) 转角底座，桥头炮台绑在这
      if(row + 1 < ROWS){
        const gapL = gap - Math.floor(gw/2), gapR = gap + Math.floor(gw/2);
        const base = (r, c, t) => { if(r>=0&&r<ROWS&&c>=0&&c<COLS) setTile(blk, r, c, t); };
        // 左段 [w1..gapL-1]：3f 3a 起头，段够长时内端 37
        if(gapL - w1 >= 2){ base(row+1, w1, 0x3F); base(row+1, w1+1, 0x3A); if(gapL - w1 >= 4) base(row+1, gapL-1, 0x37); }
        else if(gapL - w1 === 1){ base(row+1, w1, 0x3F); }
        // 右段 [gapR+1..w2]：3a 3f 收尾，段够长时内端 37
        if(w2 - gapR >= 2){ base(row+1, w2-1, 0x3A); base(row+1, w2, 0x3F); if(w2 - gapR >= 4) base(row+1, gapR+1, 0x37); }
        else if(w2 - gapR === 1){ base(row+1, w2, 0x3F); }
      }
    }
    // 边缘城墙桩（0x26 路边残留）已按用户要求去掉
    // L5 石块（3 行高结构）：石块间留 ≥1 格空地，其他结构可在空地上生成；高墙屏不放（墙已占结构位）
    if(!isWallPos) stampL5StoneBlocks(blk, s, rng, skelColAt);
    // L5 围栏：与 L1 结构相同，竖栏 18(0x12)左 / 19(0x13)右、空地 45(0x2D)、签名月湾 17(0x11)
    {
      const e5 = ctx && ctx.e;
      const fences5 = (e5 && (e5._fences = e5._fences || {}));
      const rec5 = (cells) => { if(fences5){ (fences5[s] = fences5[s] || []).push(cells); } };
      const onGate5 = (row, gxLeft) => {
        if(!e5) return;
        (e5.structSprites = e5.structSprites || {})[s] = e5.structSprites[s] || [];
        e5.structSprites[s].push([32*(ROWS-1-row), gxToX(gxLeft+1), 0x1B]);
      };
      const startCol0 = (skel && skel.cols && skel.cols[0] != null) ? skel.cols[0] : 4;
      const gateAllowed5 = (row, spriteGx) => {
        if(s !== 0) return true;
        return !((row >= ROWS-3) && (spriteGx >= startCol0-2) && (spriteGx <= startCol0+3));
      };
      // 月湾17 嵌围栏时上方放灰炮台：绑定炮台精灵 5/6（锚点同 placeCannonBases）
      const onCannon5 = (row, gx) => {
        if(!e5) return;
        (e5.structSprites = e5.structSprites || {})[s] = e5.structSprites[s] || [];
        e5.structSprites[s].push([32*(ROWS-1-row) + 2, gxToX(gx) + 4, rng()<0.75 ? 0x05 : 0x06]);
      };
      const mustContinue = !!(ctx.fenceBig && ctx.fenceBig.remaining > 0);
      if(mustContinue){
        // 大围栏中间屏必须续（竖边围栏类型）
        const snap = blk.slice();
        const nSpr = ((e5 && e5.structSprites && e5.structSprites[s]) || []).length;
        const nRec = (fences5 && fences5[s]) ? fences5[s].length : 0;
        const scF5 = (skel && skel.cols && skel.cols[s] != null) ? skel.cols[s] : 7;
        stampFenceLevel(e5, 4, blk, s, rng, rec5, onGate5, gateAllowed5, ctx, onCannon5, scF5);
        if(e5 && !screenExitOk(e5, 4, s)){
          for(let k=0;k<128;k++) blk[k] = snap[k];
          if(e5.structSprites && e5.structSprites[s]) e5.structSprites[s].length = nSpr;
          if(fences5 && fences5[s]) fences5[s].length = nRec;
          ctx.fencePrevInfo = null;
          ctx.fenceBig = null;
        }
      } else if(rng() < 0.3){
        // L5 另一种围栏：水平带（无竖直）——门 56-57(0x38/0x39)、面板 60/61/62(0x3C/0x3D/0x3E)
        const scB5 = (skel && skel.cols && skel.cols[s] != null) ? skel.cols[s] : 7;
        stampBandFence(e5, blk, s, rng, rec5, onGate5, gateAllowed5, 4, scB5);
        ctx.fencePrevInfo = null;
      } else if(rng() < 0.7){
        const snap = blk.slice();
        const nSpr = ((e5 && e5.structSprites && e5.structSprites[s]) || []).length;
        const nRec = (fences5 && fences5[s]) ? fences5[s].length : 0;
        const scF5 = (skel && skel.cols && skel.cols[s] != null) ? skel.cols[s] : 7;
        stampFenceLevel(e5, 4, blk, s, rng, rec5, onGate5, gateAllowed5, ctx, onCannon5, scF5);
        if(e5 && !screenExitOk(e5, 4, s)){
          for(let k=0;k<128;k++) blk[k] = snap[k];
          if(e5.structSprites && e5.structSprites[s]) e5.structSprites[s].length = nSpr;
          if(fences5 && fences5[s]) fences5[s].length = nRec;
          ctx.fencePrevInfo = null;
          ctx.fenceBig = null;
        }
      } else {
        ctx.fencePrevInfo = null;
      }
    }
  }

  // ===== Stage6 军事基地：巷道隔间 + 1/3收敛 + 停机坪 =====
  function applyStage6(blk, s, seg, skel, rng, ctx, skelColAt){
    const role = TILE_ROLE[5];
    const segPos = s - seg.start;
    const ground = PRIMARY_GROUND[5];
    const nScreens = ctx.nScreens;
    const totalSegs = ctx.totalSegs || 1;
    const convergeStart = Math.floor(nScreens * 2/3);
    const isLastSeg = seg.idx === totalSegs-1;
    // 停机坪：开阔大空间（Boss 房在其下）
    if(isLastSeg){
      for(let row=1; row<ROWS-1; row++){
        for(let gx=3; gx<COLS-3; gx++) setTile(blk, row, gx, ground);
      }
      return;
    }
    // L6 不用字母道路、不再撒零散残留（用户要求去掉）
    const segLen = seg.end - seg.start;
    // L6 水平围栏带（无竖直围栏）：面板 20(0x14)、门 21-5-6-22、下墙18（两端0b）
    {
      const e6 = ctx && ctx.e;
      const fences6 = (e6 && (e6._fences = e6._fences || {}));
      const rec6 = (cells) => { if(fences6){ (fences6[s] = fences6[s] || []).push(cells); } };
      const onGate6 = (row, gxLeft) => {
        if(!e6) return;
        (e6.structSprites = e6.structSprites || {})[s] = e6.structSprites[s] || [];
        e6.structSprites[s].push([32*(ROWS-1-row), gxToX(gxLeft+1), 0x1B]);
      };
      const scB6 = (skel && skel.cols && skel.cols[s] != null) ? skel.cols[s] : 7;
      stampBandFence(e6, blk, s, rng, rec6, onGate6, () => true, 5, scB6);
    }
  }

  

  // ===== L1 草结构生成（图块 51-66，按原版拼法）=====
  // 拼法（原版研究）：内部 53(0x35)；上边 64(0x40)；左上角 59(0x3B)、右上角 57(0x39)；
  // 左边 62(0x3E)、右边 52(0x34)；左下角 63(0x3F)、右下角 65(0x41)；下边 62。
  // 散点草丛 51/54/56/60/66(0x33/0x36/0x38/0x3C/0x42)。
  // 规则：不规则团块（随机扩展）；远离道路骨架(≥4列)；不压河/桥/机场/围栏；
  // 每屏铺完用 2 格宽 BFS(screenExitOk) 检查，堵路即整团回滚；跳过出生点屏与 boss 战区。
  function stampForests(e, level, rng, skel){
    if(level !== 0) return;   // 草结构图块 51-66 是 L1 专属
    let boss = e.idx.length-1;
    for(let s=e.spawns.length-1; s>=0; s--){ const l=e.spawns[s]; if(l && l.indexOf(0xF0)>=0){ boss=s; break; } }
    const isGround = (t) => t>=0x58 && t<=0x62;   // L1 地面 88-98
    const GRASS = 0x35;
    // 判断某格"实际是不是草"（含跨屏 + 左右贴屏视为草延续出屏）。
    // 行方向约定（与 screenExitOk 一致）：row0=屏顶(接 s+1 底行 row7)，row7=屏底(接 s-1 顶行 row0)。
    const grassAt = (ss, rr, gx) => {
      if(gx < 0 || gx >= COLS) return true;          // 森林贴左右屏边 → 草延续出屏，不在这里放边
      if(rr < 0){ ss = ss + 1; rr = ROWS-1; }        // 上方 = s+1 底行
      else if(rr >= ROWS){ ss = ss - 1; rr = 0; }    // 下方 = s-1 顶行
      if(ss < 0 || ss >= e.idx.length) return false;
      const b = e.layoutBlocks[e.idx[ss]];
      if(!b) return false;
      const t = b[idxAt(rr,gx)];
      return t >= 0x33 && t <= 0x42;
    };
    for(let s=1; s<boss-2; s++){
      const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
      const sc = (skel && skel.cols && skel.cols[s] != null) ? skel.cols[s] : 7;
      const free = (r, gx) => {
        if(r < 0 || r >= ROWS || gx < 0 || gx >= COLS) return false;
        if(Math.abs(gx - sc) <= 3) return false;                 // 不挡路
        if(!isGround(getTile(blk, r, gx))) return false;         // 只长在地面上
        const kk = s + '|' + ((ROWS-1-r)*COLS + gx);
        if(e._riverCells && e._riverCells.has(kk)) return false; // 不压河
        if(e._aptCells && e._aptCells.has(kk)) return false;     // 不压机场
        const fr = e._fenceRects && e._fenceRects[s];
        if(fr && r >= fr.y0 && r <= fr.y1 && gx >= fr.x1 && gx <= fr.x2) return false;  // 不压围栏
        return true;
      };
      // 实心森林柱：贴屏幕左/右边缘，从屏顶(row0)向下长一个实心矩形柱，
      // 撞到路/河/结构就停。内部 53(全草)、朝路一侧 62/52、底边 64 + 角 63/65。
      // 原版森林就是左右边缘的实心草墙、中间留道路——不镂空、无散点、边缘一圈围好。
      const tryColumn = (side) => {
        // side=false 左边缘(草在左，朝路一侧是右边)；side=true 右边缘(草在右，朝路一侧是左边)
        const maxW = side ? Math.max(0, COLS-1 - sc - 3) : Math.max(0, sc - 3);
        if(maxW < 1) return;
        const W = 1 + Math.floor(rng()*Math.min(3, maxW));   // 宽 1~3（不挡路）
        const gx0 = side ? COLS-W : 0;
        // 从屏顶向下数连续可放行数
        let H = 0;
        for(let r=0; r<ROWS; r++){
          let ok = true;
          for(let gx=gx0; gx<gx0+W; gx++){ if(!free(r, gx)){ ok=false; break; } }
          if(!ok) break;
          H++;
        }
        if(H < 2) return;
        const saved = [];
        for(let r=0; r<H; r++) for(let gx=gx0; gx<gx0+W; gx++) saved.push([r, gx, getTile(blk, r, gx)]);
        for(let r=0; r<H; r++){
          for(let gx=gx0; gx<gx0+W; gx++){
            const roadSide = side ? (gx === gx0) : (gx === gx0+W-1);  // 朝路的最内一列
            const bottom = (r === H-1) && !grassAt(s, r+1, gx);        // 最后一格且下方是地
            let t = GRASS;
            if(roadSide) t = bottom ? (side ? 0x41 : 0x3F) : (side ? 0x34 : 0x3E);
            else         t = bottom ? 0x40 : GRASS;
            setTile(blk, r, gx, t);
          }
        }
        if(!screenExitOk(e, level, s)){      // 堵路 → 整柱回滚
          for(const [r,gx,t] of saved) setTile(blk, r, gx, t);
        }
      };
      if(rng() < 0.82) tryColumn(false);   // 左边缘森林
      if(rng() < 0.82) tryColumn(true);    // 右边缘森林
    }
  }

  // 收尾兜底：连通性修复/补宽可能把草边缘图块凿成地面，导致内部 53(全草) 一侧露空(镂空)。
  // 这里在最后一轮连通修复之后，把任何"露空的全草 53"重新围回正确的边缘/角块——保证全草块始终被围好。
  // 只改 53(全草)，不动已有的 52/62/64/63/65 边缘块，也不改可走性（都是非可走草，不影响连通）。
  function reEncloseGrass(e, level){
    if(level !== 0) return;   // 草结构 51-66 是 L1 专属
    const isGrass = (t) => t>=0x33 && t<=0x42;
    let boss = e.idx.length-1;
    for(let s=e.spawns.length-1; s>=0; s--){ const l=e.spawns[s]; if(l && l.indexOf(0xF0)>=0){ boss=s; break; } }
    const grassAt = (ss, rr, gx) => {
      if(gx < 0 || gx >= COLS) return true;          // 贴左右屏边 → 草延续出屏
      if(rr < 0){ ss = ss + 1; rr = ROWS-1; }
      else if(rr >= ROWS){ ss = ss - 1; rr = 0; }
      if(ss < 0 || ss >= e.idx.length) return false;
      const b = e.layoutBlocks[e.idx[ss]];
      if(!b) return false;
      return isGrass(b[idxAt(rr,gx)]);
    };
    for(let s=1; s<boss-2; s++){
      const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
      for(let r=0; r<ROWS; r++) for(let gx=0; gx<COLS; gx++){
        if(getTile(blk, r, gx) !== 0x35) continue;   // 只修全草 53
        const up = !grassAt(s, r-1, gx), down = !grassAt(s, r+1, gx),
              left = !grassAt(s, r, gx-1), right = !grassAt(s, r, gx+1);
        let nt = 0x35;
        if(up && left) nt = 0x36;         // 54 左上角
        else if(up && right) nt = 0x3D;   // 61 右上角
        else if(down && left) nt = 0x41;  // 65 左下角
        else if(down && right) nt = 0x3F; // 63 右下角
        else if(left) nt = 0x34;          // 52 左缘
        else if(right) nt = 0x3E;         // 62 右缘
        else if(down) nt = 0x40;          // 64 下边
        if(nt !== 0x35) setTile(blk, r, gx, nt);
      }
    }
  }

  // ===== 程序化地图生成（结构盖章法：完整图像 + 走廊连通）=====
  // 原版构图 = 主地面 + 走廊通道 + 两侧盖章完整结构（飞机场/营地/小屋）。
  function generateMapFromScratch(e, level, nScreens, rng, skel, chapters, l1river, bossWar){
    const role = TILE_ROLE[level];
    const grounds = role.ground && role.ground.length ? role.ground : role.road;
    const trees = role.tree && role.tree.length ? role.tree : role.obstacle.slice(0,4);
    const waters = role.water;
    const pick = (arr) => arr[Math.floor(rng()*arr.length)];
    const structLib = STRUCTURES[level] || STRUCTURES[0];

    let boss = e.idx.length - 1;
    for(let s=e.spawns.length-1; s>=0; s--){ const l=e.spawns[s]; if(l && l.indexOf(0xF0)>=0){ boss=s; break; } }

    // boss 战区使用的 block 索引（程序化生成不得覆盖）
    const bossBlockIdx = new Set();
    for(const s of bossWar.screens) bossBlockIdx.add(e.idx[s]);

    // Segment 划分（用户规格：9-12 片段竖直拼接）
    const segments = buildSegments(Math.min(boss, e.idx.length), level, rng);
    const segOf = new Map();
    for(const sg of segments){ for(let ss=sg.start; ss<sg.end; ss++) segOf.set(ss, sg); }
    // 河流屏集合：这些屏不铺围栏（河与围栏不抢同一屏，两者都能保持完整结构）
    const riverScreens = {};
    if(l1river){
      for(const rv of (Array.isArray(l1river) ? l1river : [l1river])){
        for(let s=rv.sStart; s<=rv.sEnd; s++) riverScreens[s] = 1;
      }
    }
    const ctx = {
      nScreens: boss, riverDone:false, totalSegs: segments.length, e, phaseLast: -1,
      riverScreens, fencePrevInfo:null,
      l3LaserRun: 0, l3LaserMirror: false, l3LaserX: 3,
      l3LaserCenterWidth: 1, l3LaserOffset: 0, l3LaserUnitIndex: 0,
      l3LaserAddLeft: true, l3LaserAddRight: true,
    };

    for(let s=0; s<boss && s<e.idx.length; s++){
      let blockIdx = e.idx[s];
      // 若该 block 被 boss 战区共享 → 分配新 block 并重映射，避免覆盖 boss 战区
      if(bossBlockIdx.has(blockIdx)){
        blockIdx = e.layoutBlocks.length;
        e.layoutBlocks.push(new Array(128));
        e.idx[s] = blockIdx;
      }
      if(blockIdx >= e.layoutBlocks.length) continue;
      const seg = segOf.get(s) || { idx:0, start:0, end:boss, type:0 };
      const segPos = s - seg.start;
      e.layoutBlocks[blockIdx] = genSegmentScreen(level, new Array(128), s, seg, segPos, skel, rng, ctx);
    }

    // Boss 战区：恢复原版模板（生成地图绝不影响 boss 战区）
    for(const s of bossWar.screens){
      const blockIdx = e.idx[s];
      if(blockIdx < 0 || blockIdx >= e.layoutBlocks.length) continue;
      const saved = bossWar.blocks.get(blockIdx);
      if(saved) e.layoutBlocks[blockIdx] = saved.slice();
    }

    // 关级签名特色地形增强（§6.x）
    enhanceLevelTerrain(e, level, nScreens, rng, skel, l1river);
  }

  // ===== §6.0 L1 河流系统（参数化：水宽可变 + 错位堆叠斜河 + 竖直直河）=====
  // 行型（注释为十进制编号，代码为 hex）。ws = 水域起始列，w = 水宽（中间 87 的数量，可变）：
  //   top   上边：82 86 [87×(w+1)] 72 73      （与下方 body 同 ws；水吃掉 74 那一列）
  //   body  斜身：82 83 84 [87×w] 74 75 76 / 74 77 78   （每下一行整体左移 1 列）
  //   preBot 过渡：85 84 [87×w] 74 77 78
  //   vert  下边：81 [87×(w+1)] 70 71 / 72 73  （ws 不变→竖直；81 接 85、70 接 74、71 接 77）
  function riverRowSpan(p){
    if(!p) return null;
    if(p.kind === 'body') return [p.ws-3, p.ws+p.w+2];
    if(p.kind === 'vert' || p.kind === 'brTop' || p.kind === 'brBot' || p.kind === 'vert67' || p.kind === 'vert101') return [p.ws-2, p.ws+p.w+1];
    return [p.ws-2, p.ws+p.w+2];               // top / preBot
  }
  function drawRiverRow(blk, row, p){
    if(!p) return;
    const { kind, ws, w } = p;
    const put = (gx,t) => { if(gx>=0 && gx<COLS) setTile(blk, row, gx, t); };
    // 河岸两端各放一个空块（88）：河岸不贴屏边，也不与旁边结构粘连
    const sp = riverRowSpan(p);
    if(sp){ put(sp[0]-1, 0x58); put(sp[1]+1, 0x58); }
    if(kind === 'top'){
      // 82 86 [87×(w+1)] 72 73
      put(ws-2, 0x52); put(ws-1, 0x56);
      for(let k=0;k<=w;k++) put(ws+k, 0x57);
      put(ws+w+1, 0x48); put(ws+w+2, 0x49);
    } else if(kind === 'preBot'){
      // 85 84 [87×w] 74 77 78
      put(ws-2, 0x55); put(ws-1, 0x54);
      for(let k=0;k<w;k++) put(ws+k, 0x57);
      put(ws+w, 0x4A); put(ws+w+1, 0x4D); put(ws+w+2, 0x4E);
    } else if(kind === 'brTop'){
      // 桥顶行：44 [45×n] 47（X=81 那列，Y=73 那列；n = Y-X-1）
      const X = ws-2, Y = ws+w+1;
      put(X, 0x2C);
      for(let gx=X+1; gx<=Y-1; gx++) put(gx, 0x2D);
      put(Y, 0x2F);
    } else if(kind === 'brBot'){
      // 桥底行：48 [46×(n-1)] 49 50 —— 48 接下方 86、50 接下方 73
      const X = ws-2, Y = ws+w+1;
      put(X, 0x30);
      for(let gx=X+1; gx<=Y-2; gx++) put(gx, 0x2E);
      put(Y-1, 0x31); put(Y, 0x32);
    } else if(kind === 'vert'){
      // 81 [87×(w+1)] 70 71 或 81 [87×(w+1)] 72 73 —— 81 对齐上方 85，水吃掉 84 那一列
      put(ws-2, 0x51);
      for(let k=-1;k<w;k++) put(ws+k, 0x57);
      if(p.variant === 1){ put(ws+w, 0x48); put(ws+w+1, 0x49); }   // 72 73
      else if(p.variant === 2){ put(ws+w, 0x44); put(ws+w+1, 0x45); }  // 68 69
      else { put(ws+w, 0x46); put(ws+w+1, 0x47); }                    // 70 71
    } else if(kind === 'vert67'){
      // 81 [87×(w+2)] 67 —— 69 下接 67（水多吃一列，右岸单格 67），67 可竖直堆叠
      put(ws-2, 0x51);
      for(let k=-1;k<=w;k++) put(ws+k, 0x57);
      put(ws+w+1, 0x43);
    } else if(kind === 'vert101'){
      // 81 [87×(w+1)] 74 101 —— 67 下接 101
      put(ws-2, 0x51);
      for(let k=-1;k<w;k++) put(ws+k, 0x57);
      put(ws+w, 0x4A);
      put(ws+w+1, 0x65);
    } else {
      // body：82 83 84 [87×w] 74 + (75 76 | 77 78 | 75 100)
      put(ws-3, 0x52); put(ws-2, 0x53); put(ws-1, 0x54);
      for(let k=0;k<w;k++) put(ws+k, 0x57);
      put(ws+w, 0x4A);
      if(p.variant === 2){ put(ws+w+1, 0x4B); put(ws+w+2, 0x64); }   // 75 100：73 下接 100、100 左接 75
      else if(p.variant){ put(ws+w+1, 0x4D); put(ws+w+2, 0x4E); }
      else               { put(ws+w+1, 0x4B); put(ws+w+2, 0x4C); }
    }
  }
  // 逐行规划整条河：上边→斜身(每行左移1)→过渡→下边(竖直，可变长)，循环无限堆叠；
  // 移出左边界不管，继续移位，整行移出后从右侧重新起（可无限叠加）
  // 逐行规划整条河：严格错位对齐 —— 斜身每下一行整体左移 1 列，绝不因地图边界而停顿或夹紧，
  // 超出地图的部分自动裁掉；整行都移出左边界后，再从右侧重新起一条（无限堆叠）。
  // 行型两端各带一个空块 88（在图内就写，出界就跟着被裁掉）。
  // 段结构：上边 → 斜身 → 过渡 → 竖直下边 →（可选桥）→ 接缝左移 1 列后继续下一段
  // 接缝对齐（用户规格）：81 上接 85；86 正接上方 81（有桥时 81→44→48→86 同列）；
  //                       71/73 上接 77；47 上接 73；50 下接 73
  function planRiverRows(sStart, sEnd, rng, bridgeProb, forceSeamAtD, forceFirstSeams){
    const Dmax = (sEnd - sStart + 1) * 8 - 1;
    const riverLen = sEnd - sStart + 1;
    const withCycle = riverLen >= 7;   // 长河才做底部多圈直河循环
    const plan = new Array(Dmax + 1);
    const newW = () => 1 + Math.floor(rng() * (riverLen >= 7 ? 7 : 3));   // 长河水宽 1~7、短河 1~3（短河屏少，宽了走不到左下角）
    // 整条河是一条连续不断的对角带：从右边缘外进入（走向右上、出地图），
    // 一路向左下，到左边缘外退出（出地图）。中间斜河(body)与直河(vert)交替堆叠，桥做渡口。
    // 不许断成一段段、更不许留空档——否则会看到断裂的河流。
    let D = 0;
    let seamForced = false;   // 强制接缝只生效一次
    let seamsLeftToForce = forceFirstSeams || 0;   // 前 N 个接缝强制架桥
    let w = newW();
    const rows = Dmax + 1;
    let bodyVar = 0;                              // 斜河右岸变体全局交替：75→78→77→76 循环
    // 左岸起始列：让左岸(ws-2)在右边缘(col 15)外一列 → 河从右上角进入
    let ws = COLS + 2;
    // 终点：右岸(vert 的 ws+w)落到左边缘(col 0) → 直河在左边缘纵向走一段再出图
    let wsEnd = -w;
    const totalShift = ws - wsEnd;         // 需要左移的总列数
    let remainShift = totalShift;          // 还剩多少列要左移（由斜河/接缝完成）

    // 顶部：直河(vert) 从右上角进入（1~3 行）
    const topVert = 1 + Math.floor(rng()*3);
    for(let t=0; t<topVert && D<=Dmax; t++) plan[D++] = { kind:'vert', ws, w, variant: t % 3 };

    while(D <= Dmax && remainShift > 0){
      // 桥段最多占 n+11 行；给底部多留行，让直河循环在左边缘多次堆叠（左下直河）
      // 底部直河循环必须贴左边缘（右岸≈col0-1）：remainShift 未完成就不 break，
      // 让主循环继续把河左移到 wsEnd（否则直河会在屏幕中间，用户要求从第1屏第1格开始）
      if(Dmax - D + 1 < 30 && remainShift < 8) break;
      const remainRows = Dmax - D + 1;
      // 本段斜河(body)行数：让段的位移率(body n + 桥下5 / 段长 n+11)≈ 剩余位移/剩余行，
      // 保证河在底部正好移到左边缘、既不短也不过头。
      const rate = remainShift / Math.max(1, remainRows);
      // 稍微多左移一点，让河早点到左边缘，底部留出更多直河
      let n = Math.round((rate * 11 - 5) / Math.max(0.01, 1 - rate)) + 1;
      n = Math.max(1, Math.min(n, remainShift, 5));
      // 段内斜身必须 v0 开头且 v0 结尾（n 取奇数）：top 73→body 76、body 75→preBot 78 才对
      if(n % 2 === 0) n--;
      if(n < 1) n = 1;
      plan[D++] = { kind:'top', ws, w };                // 上边与下方斜身同列
      bodyVar = 0;                                      // 每段斜身从 v0 开始（top 73 正接 body 76）
      let onScreenCells = 0;
      for(let t=0; t<n && D<=Dmax && remainShift>0; t++){
        plan[D++] = { kind:'body', ws, w, variant: (bodyVar++ & 1) };
        if(ws + w + 2 >= 8 && ws + w + 2 <= COLS-1) onScreenCells++;   // 右半区域(8~15)屏内斜格
        ws--; remainShift--;
        if(forceSeamAtD != null && !seamForced && D >= forceSeamAtD){ seamForced = true; break; }
      }
      if(D > Dmax) break;
      if(D <= Dmax) plan[D++] = { kind:'preBot', ws, w };
      // 河在屏内（桥两端 88 都能放下）就必须架桥：连续河没有空档，桥是唯一渡口，漏了会堵死
      const mustBridge = seamsLeftToForce > 0 || (ws - 3 >= 0 && ws + w + 2 <= COLS - 1);
      if((mustBridge || rng() < bridgeProb) && D+8 <= Dmax && ws-3 >= 0 && ws+w+2 <= COLS-1){
        if(seamsLeftToForce > 0) seamsLeftToForce--;
        // 接缝竖直 2 行：variant0(70/71) 上接 preBot(74/77)、variant1(72/73) 下接桥(47)
        plan[D++] = { kind:'vert',  ws, w, variant: 0 };
        plan[D++] = { kind:'vert',  ws, w, variant: 1 };
        plan[D++] = { kind:'brTop', ws, w };
        plan[D++] = { kind:'brBot', ws, w };
        // 桥下方：先一行 top（86 正接 48、73 正接 50），再 5 层斜身（84 接 86、76 接 73）
        ws--; remainShift--;                     // 左移1列：top 的 86 落在 48 正下、73 落在 50 正下
        plan[D++] = { kind:'top', ws, w };
        bodyVar = 0;                             // 桥下斜身从 v0 开始：73→76 需要第一行 v0
        for(let t=0; t<5 && D<=Dmax; t++){
          plan[D++] = { kind:'body', ws, w, variant: (bodyVar++ & 1) };
          if(ws + w + 2 >= 8 && ws + w + 2 <= COLS-1) onScreenCells++;
          ws--; remainShift--;
        }
        // 桥下斜身结束后：必须 preBot(77) → vert 71 → vert 73 过渡到下一段 top，
        // 否则 body 的 75 会直接接 top 的 73（75→73 错）、83 直接接 86（83→86 错）
        plan[D++] = { kind:'preBot', ws, w };            // body 75 → preBot 78（75→78 循环继续）、83 → 84
        plan[D++] = { kind:'vert',  ws, w, variant: 0 }; // preBot 77 → vert 71
        plan[D++] = { kind:'vert',  ws, w, variant: 1 }; // vert 71 → vert 73
        ws--; remainShift--;                             // 接缝后继续左移 1 列（86 正落在 81 那一列）
        // 桥下斜身后宽度保持（保证斜河右岸 75→78→77→76 链完整）
        wsEnd = -w;
        remainShift = ws - wsEnd;
      } else {
        // 直河必须是两条：vert 71 上、vert 73 下（71 上接 preBot 77，73 下接下一段）
        plan[D++] = { kind:'vert', ws, w, variant: 0 };
        plan[D++] = { kind:'vert', ws, w, variant: 1 };
        ws--; remainShift--;                             // 接缝后继续左移 1 列（86 正落在 81 那一列）
      }
    }

    // 底部：剥掉主循环收尾接缝，用斜河 body 补完剩余位移到 wsEnd（左边缘，右岸≈col0-1），
    // 重建接缝(77→71→73)，然后底部直河循环多圈(71→73→69→67×n→101，结尾必须是73)，
    // 最后 73→100(74 75 100：100 正接 73、75 在 100 左边) → 75循环斜河(75→78→77→76→75) 出左下角。
    let peeledVerts = [];
    while(D > 0 && plan[D-1] && (plan[D-1].kind==='vert'||plan[D-1].kind==='vert67'||plan[D-1].kind==='vert101')){
      peeledVerts.unshift(plan[D-1]); D--;
    }
    let hadPreBot = false;
    if(D > 0 && plan[D-1] && plan[D-1].kind==='preBot'){ hadPreBot = true; D--; }
    if(hadPreBot || peeledVerts.length){ ws++; remainShift = ws - wsEnd; }   // 剥掉接缝（含接缝后的 ws--），并重算剩余位移（少补1列会让接缝78错连到上一行74）
    while(D <= Dmax && remainShift > 0){
      plan[D++] = { kind:'body', ws, w, variant: (bodyVar++ & 1) };
      ws--; remainShift--;
    }
    if(D <= Dmax - 1){
      const vws0 = wsEnd;
      if(hadPreBot || peeledVerts.length === 0) plan[D++] = { kind:'preBot', ws: vws0, w };
      if(peeledVerts.length){
        for(const t of peeledVerts) plan[D++] = { ...t, ws: vws0, w };
      } else {
        plan[D++] = { kind:'vert', ws: vws0, w, variant: 0 };   // 77→71
        plan[D++] = { kind:'vert', ws: vws0, w, variant: 1 };   // 71→73
      }
      // 直河循环体（第二条河用）：v0(70/71)→v1(72/73)→v2(68/69)→vert67(87/67)×n→vert101(74/101)→…
      const makeRowAt = (n67) => (ph) => {
        if(ph === 0) return { kind:'vert', variant: 0 };   // 71
        if(ph === 1) return { kind:'vert', variant: 1 };   // 73
        if(ph === 2) return { kind:'vert', variant: 2 };   // 69
        if(ph < 3 + n67) return { kind:'vert67', variant: 0 };  // 67
        return { kind:'vert101', variant: 0 };             // 101
      };
      // 第一条河专用（无 101）：v0(70/71)→v1(72/73)→v2(68/69)→vert67(87/67)×n→回到 v0
      const makeRowAtNo101 = (n67) => (ph) => {
        if(ph === 0) return { kind:'vert', variant: 0 };   // 71
        if(ph === 1) return { kind:'vert', variant: 1 };   // 73
        if(ph === 2) return { kind:'vert', variant: 2 };   // 69
        return { kind:'vert67', variant: 0 };              // 67（67 直连下一圈 71，不用 101）
      };
      if(sStart === 0){
        // 第一条河：直河循环 71→73→69→67(可多个)→71… 直接铺到关卡最底部（第1屏底线），
        // 不用 101、也不用 73→100/75/78/88 出口（那是第二条河的规则）。
        const n67 = 1 + Math.floor(rng()*2);
        const cycleLen = 3 + n67;
        const rowAt = makeRowAtNo101(n67);
        let phase = 2;   // 接缝已放 71,73 → 从 69 开始
        while(D <= Dmax){
          const rw = rowAt(phase % cycleLen);
          plan[D++] = { kind: rw.kind, ws: vws0, w, variant: rw.variant };
          phase++;
        }

      } else {
        // 第二条河：直河循环（够长才做，结尾必须是73）→ 73→100(74 75 100) → 75循环斜河 出左下角。
        if(withCycle){
          const available = (Dmax - 2) - D + 1;   // 预留 body100 + 78 出口尾
          let bestN67 = 2, bestGap = 99;
          for(const cand of [2, 1]){
            const L = 4 + cand;
            const vc = available - (available % L);
            const gap = available - vc;
            if(gap < bestGap){ bestGap = gap; bestN67 = cand; }
          }
          const n67 = bestN67;
          const cycleLen = 4 + n67;
          const rowAt = makeRowAt(n67);
          let phase = 2;
          const vc = available - (available % cycleLen);
          for(let i=0; i<vc && D <= Dmax - 2; i++){
            const rw = rowAt(phase % cycleLen);
            plan[D++] = { kind: rw.kind, ws: vws0, w, variant: rw.variant };
            phase++;
          }
        }
        // 73→100 出口 + 75 循环斜河
        const exitW = Math.max(0, w - 1);
        plan[D++] = { kind:'body', ws: vws0, w: exitW, variant: 2 };   // 74 75 100
        ws = vws0 - 1;
        let ev = 1;
        while(D <= Dmax){
          plan[D++] = { kind:'body', ws, w: exitW, variant: ev };      // 75→78→77→76→75
          ev = 1 - ev;
          ws--;
        }
      }
    } else if(D <= Dmax){
      plan[D++] = { kind:'body', ws, w, variant: (bodyVar++ & 1) };
    }

    return plan;
  }

  // 规划河流区：连续屏（避开起点屏 0 与 Boss 屏）；桥已并入 plan（接缝处），不再单独定位
  // "河往右把右边顶死"之后，接下来 2 屏(16 行)内至少 2 座桥通到左边。
  // "河往右把右边顶死"之后，接下来 2 屏(16 行)内至少 2 座桥通到左边。
  // 河带右端到第 14 列起，右边就只剩 1 格宽（吉普过不去）→ 视为堵死。
  // 堵点总在河的最上端（河从右侧起），所以做法是：强制最前面 2 个接缝架桥。
  // 河从右边界外起、往上越过右边界 → 顶部若干行右侧完全没路（右路被堵死）。
  // 玩家是从下往上走的，所以"堵死处的下方 2 屏(16 行)内"必须有桥能换到左岸。
  function ensureRightSealBridges(sStart, sEnd, plan, rng){
    const Dmax = (sEnd - sStart + 1) * 8 - 1;
    const lastSealD = () => {
      let last = -1;
      for(let D=0; D<=Dmax; D++){
        const p = plan[D];
        if(!p || p.kind==='brTop' || p.kind==='brBot') continue;
        const sp = riverRowSpan(p);
        if(sp && sp[1] >= COLS-1) last = D;          // 最右列(15)是河块 → 右侧完全没路
      }
      return last;
    };
    const bridgesIn = (from, to) => {
      let n = 0;
      for(let D=Math.max(0, from); D<=Math.min(Dmax, to); D++) if(plan[D] && plan[D].kind==='brTop') n++;
      return n;
    };
    const sd = lastSealD();
    if(sd < 0) return plan;                          // 没堵死，不用管
    for(let attempt=0; attempt<3 && bridgesIn(sd, sd + 7) < 1; attempt++){
      plan = planRiverRows(sStart, sEnd, rng, 0.35, null, 2);   // 前 2 个接缝强制架桥
    }
    return plan;
  }

  function makeL1River(sStart, sEnd, rng){
    const plan = ensureRightSealBridges(sStart, sEnd, planRiverRows(sStart, sEnd, rng, 0.35), rng);
    return { sStart, sEnd, plan };
  }

  function planL1River(boss, rng){
    if(boss < 5) return null;
    const rivers = [];
    const used = new Uint8Array(boss);
    const place = (len, forceStart) => {
      let guard=0, sStart=-1, sEnd=-1;
      while(guard++ < 60){
        const start = (forceStart != null) ? forceStart : (1 + Math.floor(rng()*Math.max(1, boss-len)));
        let ok = true;
        for(let ss=start; ss<start+len; ss++){ if(ss>=boss || used[ss]){ ok=false; break; } }
        if(ok){ sStart=start; sEnd=start+len-1; break; }
      }
      if(sStart < 0) return null;
      for(let ss=sStart; ss<=sEnd; ss++) used[ss]=1;
      return makeL1River(sStart, sEnd, rng);
    };
    // 第一条河：从关卡最底部(屏0)开始，55%~85% 全图；其余屏留给围栏/POW房等结构。
    const firstLen = Math.min(boss - 1, Math.max(7, Math.floor((boss-2) * (0.55 + rng()*0.3))));
    const r0 = place(firstLen, 0);
    if(r0) rivers.push(r0);
    // 其余河：1~2 条，长度 6~8 屏，随机落在第一条河之后的空隙。
    const nExtra = (firstLen > (boss-2)*0.55) ? 1 : (1 + Math.floor(rng()*2));
    for(let k=0; k<nExtra; k++){
      const len = 6 + Math.floor(rng()*3);
      const r = place(len);
      if(r) rivers.push(r);
    }
    return rivers.length ? rivers : null;
  }

  // 把河流盖到河流区各屏：逐行按 plan 铺（上边/斜身/过渡/竖直下边/桥）+ 汽艇。
  // 桥是 plan 的一部分（接缝处），所以 44 一定接在 81 下、48 一定接在 86 上。
  // 若整条河把前进路截断，就提高"接缝架桥概率"重排后重铺（用桥换岸，不在河上凿洞）。
  function enhanceL1River(e, l1river, rng, startCol){
    const rivers = Array.isArray(l1river) ? l1river : [l1river];
    e._rivers = rivers;
    const isRiverTile = (t) => (t>=0x44 && t<=0x57) || t===0x63 || t===0x64;
    const markers = [];
    for(const rv of rivers){
      const { sStart, sEnd } = rv;
      // 铺河前快照（重排重铺时还原，避免残留旧河）
      const snap = {};
      for(let s=sStart; s<=sEnd; s++){
        const blk = e.layoutBlocks[e.idx[s]];
        if(blk) snap[s] = blk.slice();
      }
      const paint = (plan) => {
        for(let s=sStart; s<=sEnd; s++){
          const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
          for(let r=0; r<ROWS; r++){
            drawRiverRow(blk, r, plan[(sEnd - s)*8 + r]);
          }
        }
      };
      const restore = () => {
        for(let s=sStart; s<=sEnd; s++){
          const blk = e.layoutBlocks[e.idx[s]];
          if(blk && snap[s]) for(let k=0;k<128;k++) blk[k] = snap[s][k];
        }
      };
      // 1 格宽空隙并入河岸：仅当左右两侧都真的是河时才填（屏边不算）。
      // 河在边界只做裁断，不生成多余图块；过河靠桥保证通路。
      const absorbNarrowGaps = () => {
        for(let s=sStart; s<=sEnd; s++){
          const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
          for(let r=0; r<ROWS; r++){
            for(let gx=0; gx<COLS; gx++){
              const t = getTile(blk,r,gx);
              if(isRiverTile(t) || (t>=0x2C && t<=0x32)) continue;      // 河/桥本体跳过
              const lt = gx>0 ? getTile(blk,r,gx-1) : -1;
              const rt = gx<COLS-1 ? getTile(blk,r,gx+1) : -1;
              // 屏边不算河：河流在边界直接裁断，不复制多余图块把边上那列填满
              const lRiver = gx===0 ? false : isRiverTile(lt);
              const rRiver = gx===COLS-1 ? false : isRiverTile(rt);
              if(lRiver && rRiver){
                setTile(blk, r, gx, isRiverTile(lt) ? lt : (isRiverTile(rt) ? rt : 0x57));
              }
            }
          }
        }
      };
      // 逐次提高"接缝架桥"概率，直到全关按吉普 2 格宽可过（通路靠桥，不靠河边窄缝）
      const probs = [null, 1.0, 1.0, 1.0];
      const applyPlan = (pl) => { paint(pl); absorbNarrowGaps(); };
      const bridgeCount = (pl) => { let n=0; for(const p of pl) if(p && p.kind==='brTop') n++; return n; };
      let plan = rv.plan;
      applyPlan(plan);
      // 循环：先保证可通行，再保证右路不堵死（右路堵死重排后可能又不通，所以要一起循环）
      for(let attempt=0; attempt<10; attempt++){
        if(levelCrossable2(e, startCol)){
          const sealed = ensureRightSealBridges(sStart, sEnd, plan, rng);
          if(sealed === plan) break;               // 已可通行且无右路堵死
          restore();
          plan = sealed;
          applyPlan(plan);                          // 右路堵死重排后重新铺
          continue;                                 // 再回循环头检查可通行
        }
        // 走不通：把收尾接缝（连带桥）挪到"卡住的那一行"，再重铺
        const fd = crossFrontierD(e, startCol, sStart, sEnd);
        restore();
        plan = planRiverRows(sStart, sEnd, rng, 1.0, fd >= 0 ? fd : null);
        applyPlan(plan);
      }
      rv.plan = plan;
      markers.push(() => {
        const prot = (e._riverCells = e._riverCells || new Set());
        for(let s=sStart; s<=sEnd; s++){
          const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
          for(let k=0;k<128;k++){
            const t = blk[k];
            if(isRiverTile(t) || (t>=0x2C && t<=0x32)) prot.add(s + '|' + k);
            else if(t === 0x58){
              // 保护河/桥两端紧邻的 88 空地（桥左右必须接 88，不能被机场/炮台等结构覆盖）
              const col = k % COLS;
              const lt = col > 0 ? blk[k-1] : -1;
              const rt = col < COLS-1 ? blk[k+1] : -1;
              if((isRiverTile(lt) || (lt>=0x2C && lt<=0x32)) || (isRiverTile(rt) || (rt>=0x2C && rt<=0x32))){
                prot.add(s + '|' + k);
              }
            }
          }
        }
      });
      // 汽艇(0x08)：待在河心，能水平打到岸(88)和桥(44~50)。
      // 数量按桥的宽度与数量来定：桥越宽/越多 → 桥附近汽艇越多；再补少量靠岸汽艇。
      for(let s=sStart; s<=sEnd; s++){
        const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
        // 找出本屏每段桥的列范围（brTop/brBot 两行各算一段）
        const bridgeSegs = [];
        for(let r=0; r<ROWS; r++){
          for(let gx=0; gx<COLS; gx++){
            const t = getTile(blk, r, gx);
            if(t < 0x2C || t > 0x32) continue;
            let X = gx, Y = gx;
            while(X > 0){ const tl = getTile(blk, r, X-1); if(tl >= 0x2C && tl <= 0x32) X--; else break; }
            while(Y < COLS-1){ const tr = getTile(blk, r, Y+1); if(tr >= 0x2C && tr <= 0x32) Y++; else break; }
            bridgeSegs.push({ row: r, X, Y, w: Y - X + 1 });
            gx = Y;
          }
        }
        const isCore = (r, gx) => getTile(blk, r, gx) === 0x57;           // 87 水面
        // "离岸 2 格"= 左右各 2 格都还在河里且不可走（水面或不可走的河岸），汽艇不会开上岸
        const inRiverBlock = (r, gx) => {
          if(r<0||r>=ROWS||gx<0||gx>=COLS) return false;
          const t = getTile(blk, r, gx);
          const isRiverTile = (t>=0x44 && t<=0x57) || t===0x63 || t===0x64;
          return isRiverTile && !isWalkable(0, t);
        };
        // 能打到桥：与桥同行/相邻 2 行内，且水平落在桥跨 ±2 列
        const nearBridge = (r, gx) => bridgeSegs.some(b => Math.abs(b.row - r) <= 2 && gx >= b.X - 2 && gx <= b.Y + 2);
        const spots = [];
        for(let r=1; r<ROWS-1; r++){
          for(let gx=2; gx<COLS-2; gx++){
            if(!isCore(r, gx)) continue;
            if(!inRiverBlock(r, gx-1) || !inRiverBlock(r, gx-2)) continue;
            if(!inRiverBlock(r, gx+1) || !inRiverBlock(r, gx+2)) continue;
            // 到最近空地 88（岸）的距离：贴岸才能水平打到岸上敌人
            let dGround = 99;
            for(let dx=0; dx<5; dx++){
              if(gx-dx >= 0 && getTile(blk, r, gx-dx) === 0x58){ dGround = dx; break; }
              if(gx+dx < COLS && getTile(blk, r, gx+dx) === 0x58){ dGround = dx; break; }
            }
            if(nearBridge(r, gx) || dGround <= 4) spots.push([r, gx]);
          }
        }
        if(!spots.length) continue;
        // 记录全部可用泊位（placeRoomsAndStars 多余汽艇从这里撒）
        (e._boatSpots = e._boatSpots || []).push(...spots.map(p => [s, p[0], p[1]]));
        // 数量：桥总宽决定桥附近汽艇数（每 4 列桥宽约 1 艘、至少 1 艘），再补 1 艘靠岸
        const totalBridgeW = bridgeSegs.reduce((a, b) => a + b.w, 0);
        const nBoat = Math.min(spots.length, Math.min(4, Math.max(1, Math.ceil(totalBridgeW / 4))) + 1);
        for(let b=0; b<nBoat; b++){
          const pick = spots.splice(Math.floor(rng()*spots.length), 1)[0];
          (e._boatUsed = e._boatUsed || new Set()).add(s + '|' + pick[0] + '|' + pick[1]);
          (e.structSprites = e.structSprites || {})[s] = e.structSprites[s] || [];
          e.structSprites[s].push([32*(ROWS-1-pick[0]) + 4, gxToX(pick[1]) + 4, 0x08, true]);
        }
        e._boatCount = (e._boatCount || 0) + nBoat;
      }
    }
    // 所有河都铺完后统一保护河流格（防止机场/炮台/围栏/散置障碍覆盖河与桥）；
    // 保护与可通行解耦：连通性由上面的重排循环（加桥/挪接缝）保证，
    // 保护集只拦截非连通性覆盖；连通性修复(ensurePairConnected)自带 prot 检查会跳过河格。
    for(const mark of markers) mark();
  }

  // 与 levelCrossable2 同一套 2 格宽 BFS，但返回"前进最远处"落在指定河流区里的 D
  // （用于把桥强行安排到卡住的那一行）
  function crossFrontierD(e, startCol, sStart, sEnd){
    let boss = e.idx.length-1;
    for(let s=e.spawns.length-1; s>=0; s--){ const l=e.spawns[s]; if(l && l.indexOf(0xF0)>=0){ boss=s; break; } }
    const screens = boss+1;
    const seen = [];
    for(let i=0;i<screens;i++) seen.push(new Uint8Array(ROWS*COLS));
    const okPair = (s,row,gx) => {
      if(s<0||s>=screens||row<0||row>=ROWS||gx<0||gx+1>=COLS) return false;
      const blk = e.layoutBlocks[e.idx[s]]; if(!blk) return false;
      return isWalkable(0, getTile(blk,row,gx)) && isWalkable(0, getTile(blk,row,gx+1));
    };
    const q = [];
    const push = (s,row,gx) => {
      if(!okPair(s,row,gx)) return;
      const k = row*COLS+gx;
      if(seen[s][k]) return;
      seen[s][k] = 1; q.push([s,row,gx]);
    };
    for(let gx=0; gx+1<COLS; gx++){ push(0, ROWS-1, gx); push(0, ROWS-2, gx); }
    let bestD = -1;
    for(let qi=0; qi<q.length; qi++){
      const [s,row,gx] = q[qi];
      if(s >= sStart && s <= sEnd){
        const D = (sEnd - s)*8 + row;
        if(D > -1 && (bestD < 0 || D < bestD)) bestD = D;   // D 越小 = 越靠上 = 进度越远
      }
      push(s,row-1,gx);
      if(row === 0) push(s+1, ROWS-1, gx);
      push(s,row+1,gx);
      if(row === ROWS-1) push(s-1, 0, gx);
      push(s,row,gx-1);
      push(s,row,gx+1);
    }
    return bestD;
  }

  // 全关按吉普 2 格宽可过？成对格 BFS（占 (row,gx) 与 (row,gx+1)）：
  // 起点屏底部 → boss 前一屏顶行。1 格窄缝不算通路，河边那种一列缝不会被误判成连通。
  // 屏间衔接：屏 s 顶行(row0) 接 屏 s+1 底行(row ROWS-1)。
  function levelCrossable2(e, startCol){
    let boss = e.idx.length-1;
    for(let s=e.spawns.length-1; s>=0; s--){ const l=e.spawns[s]; if(l && l.indexOf(0xF0)>=0){ boss=s; break; } }
    const screens = boss+1;
    const seen = [];
    for(let i=0;i<screens;i++) seen.push(new Uint8Array(ROWS*COLS));
    const okPair = (s,row,gx) => {
      if(s<0||s>=screens||row<0||row>=ROWS||gx<0||gx+1>=COLS) return false;
      const blk = e.layoutBlocks[e.idx[s]]; if(!blk) return false;
      return isWalkable(0, getTile(blk,row,gx)) && isWalkable(0, getTile(blk,row,gx+1));
    };
    const q = [];
    const push = (s,row,gx) => {
      if(!okPair(s,row,gx)) return;
      const k = row*COLS+gx;
      if(seen[s][k]) return;
      seen[s][k] = 1; q.push([s,row,gx]);
    };
    // 起点屏底部整行都当入口：出生点安全区稍后才清理，这里不该因为它误判不通
    for(let gx=0; gx+1<COLS; gx++){ push(0, ROWS-1, gx); push(0, ROWS-2, gx); }
    for(let qi=0; qi<q.length; qi++){
      const [s,row,gx] = q[qi];
      if(s >= boss-1 && row === 0) return true;
      push(s,row-1,gx);
      if(row === 0) push(s+1, ROWS-1, gx);
      push(s,row+1,gx);
      if(row === ROWS-1) push(s-1, 0, gx);
      push(s,row,gx-1);
      push(s,row,gx+1);
    }
    return false;
  }

  // 往某屏 spawn 列表末尾插入一个对象（y,x,type）
  function pushSpawnRaw(e, s, y, x, type){
    let list = e.spawns[s];
    if(!list) list = e.spawns[s] = [0xEF];
    list.splice(list.length-1, 0, y, x, type);
  }

  // ===== L2 水岸结构生成（白块建筑 + 石柱/石墙 + 浅水池 + 岩壁边框）=====
  // 注意：本结构仅允许 level===1 使用；第 3 关不调用此结构。
  // 拼法依据：原版 L2 实测（research/L2-structure.md §9 精确竖向堆叠）
  //   白块建筑：31(顶檐) → 36(上墙) → 42(内部) → 22(下墙) → 26/2a/2d(岩壁) → 4f(沙)
  //   石墙/石栏：40(石顶) → 48(石柱) → 61/41(草地)
  //   浅水池竖列：44 竖直重复 → 48(底) → 6b/4f
  //   岩壁边框：左缘 3b/26/2a/2d + 27 + 2f（右下 2d/2e 收口）
  // 全部只铺在沙地(ground)上、远离道路骨架列(sc)、堵路即整屏回滚。
  function enhanceL2Terrain(e, rng, skel, screens){
    const role = TILE_ROLE[1];
    const groundSet = new Set(role.ground || []);
    const isGround = (blk,row,gx) => row>=0 && row<ROWS && gx>=0 && gx<COLS && groundSet.has(getTile(blk,row,gx));
    const skelCol = (s) => (skel && skel.cols && skel.cols[s] != null) ? skel.cols[s] : 7;

    // 白块建筑（原版完整拼法，屏5 实测）：
    //   顶檐: 49 4d [31]×n 4e 39
    //   上墙: 26 [36]×(n+2) 26
    //   内部: 3a [42]×(n+2) 3b   （×h 行，循环）
    //   下墙: 3a [22]×(n+2) 3b
    // 总宽 = n+4；n=循环列数(可多可少)、h=内部行数(循环)
    const stampWhiteBlock = (blk, row0, gx0, n, h) => {
      const W = n + 4;
      const put = (row, gx, t) => { if(row>=0 && row<ROWS && gx>=0 && gx<COLS) setTile(blk, row, gx, t); };
      // 顶檐行
      put(row0,   gx0,     0x49);
      put(row0,   gx0+1,   0x4d);
      for(let c=0; c<n; c++) put(row0, gx0+2+c, 0x31);
      put(row0,   gx0+2+n, 0x4e);
      put(row0,   gx0+3+n, 0x39);
      // 上墙行
      put(row0+1, gx0,     0x26);
      for(let c=0; c<n+2; c++) put(row0+1, gx0+1+c, 0x36);
      put(row0+1, gx0+3+n, 0x26);
      // 内部行（循环 h 行）
      for(let r=0; r<h; r++){
        put(row0+2+r, gx0,     0x3a);
        for(let c=0; c<n+2; c++) put(row0+2+r, gx0+1+c, 0x42);
        put(row0+2+r, gx0+3+n, 0x3b);
      }
      // 下墙行
      put(row0+2+h, gx0,     0x3a);
      for(let c=0; c<n+2; c++) put(row0+2+h, gx0+1+c, 0x22);
      put(row0+2+h, gx0+3+n, 0x3b);
      return W;
    };
    // 岩壁底座（白块下方过渡到沙地）：26 → 2a → 2d
    const stampRockBase = (blk, row0, gx0, w) => {
      const seq = [0x26, 0x2a, 0x2d];
      for(let r=0; r<seq.length; r++){
        const row = row0 + r;
        if(row>=ROWS) break;
        for(let c=0; c<w; c++){
          const gx = gx0 + c;
          if(gx>=COLS) continue;
          setTile(blk, row, gx, seq[r]);
        }
      }
    };
    // 白块建筑核心（§9.1 完整结构，总宽 n+4，7 行高，第 8 行=沙地）
    //   顶檐: 49 4d [31]×n 4e 39 | 上墙: 26 [36]×(n+2) 26
    //   内部: 3a [42]×(n+2) 3b | 下墙: 3a [22]×(n+2) 3b
    //   岩壁: [26]×W / [2a]×W / [2d]×W
    const stampWhiteBlockCore = (blk, gx0, n) => {
      const put = (row, gx, t) => { if(row>=0 && row<ROWS && gx>=0 && gx<COLS) setTile(blk, row, gx, t); };
      const W = n + 4;
      put(0, gx0, 0x49); put(0, gx0+1, 0x4d);
      for(let c=0; c<n; c++) put(0, gx0+2+c, 0x31);
      put(0, gx0+2+n, 0x4e); put(0, gx0+3+n, 0x39);
      put(1, gx0, 0x26);
      for(let c=0; c<n+2; c++) put(1, gx0+1+c, 0x36);
      put(1, gx0+3+n, 0x26);
      put(2, gx0, 0x3a);
      for(let c=0; c<n+2; c++) put(2, gx0+1+c, 0x42);
      put(2, gx0+3+n, 0x3b);
      put(3, gx0, 0x3a);
      for(let c=0; c<n+2; c++) put(3, gx0+1+c, 0x22);
      put(3, gx0+3+n, 0x3b);
      for(let r=0; r<3; r++){
        const seq = [0x26, 0x2a, 0x2d][r];
        for(let c=0; c<W; c++) put(4+r, gx0+c, seq);
      }
      return W;
    };
    // ===== 白块章节三屏（程序拼法：结构与原版同款，开口随道路骨架居中）=====
    // 拱脚屏：左右两根白柱 + 中间沙地走廊 + 桥；桥必须接白块内部 66(0x42)，
    // 不能接在 58(0x3a)/59(0x3b) 墙缘上（游戏里桥断头会看起来像结构错误）
    const stampArchLegs = (blk) => {
      const put = (row, gx, t) => { if(row>=0 && row<ROWS && gx>=0 && gx<COLS) setTile(blk, row, gx, t); };
      stampWhiteBlockCore(blk, 0, 2);          // 左柱 cols 0..5
      stampWhiteBlockCore(blk, 12, 0);         // 右柱 cols 12..15
      // 左柱内部延伸到 col5，让左桥(6-7)接在 66(0x42) 上
      put(1, 5, 0x42); put(2, 5, 0x42); put(3, 5, 0x42);
      // 右柱：全部改成内部 66(0x42)（原版右柱样式），左右桥都接 66
      put(0, 12, 0x42); put(0, 13, 0x42); put(0, 14, 0x42);
      put(1, 12, 0x42); put(1, 13, 0x42); put(1, 14, 0x42);
      put(2, 12, 0x42);
      put(3, 12, 0x42);
      put(2, 6, 0x58); put(2, 7, 0x59);        // 左桥(顶)
      put(3, 6, 0x5c); put(3, 7, 0x5d);        // 左桥(底)
      put(2, 10, 0x5a); put(2, 11, 0x5b);      // 右桥(顶)
      put(3, 10, 0x5e); put(3, 11, 0x5f);      // 右桥(底)
    };
    // 横梁屏：全宽白块，竖井(7-8)贯通 8 行只用 66(0x42)
    const stampBeam = (blk) => {
      const put = (row, gx, t) => { if(row>=0 && row<ROWS && gx>=0 && gx<COLS) setTile(blk, row, gx, t); };
      put(0, 0, 0x49); put(0, 1, 0x4d);
      for(let c=2; c<14; c++) put(0, c, (c===7||c===8) ? 0x42 : 0x31);
      put(0, 14, 0x4e); put(0, 15, 0x39);
      put(1, 0, 0x26);
      for(let c=1; c<15; c++) put(1, c, (c===7||c===8) ? 0x42 : 0x36);
      put(1, 15, 0x26);
      put(2, 0, 0x3a); for(let c=1; c<15; c++) put(2, c, 0x42); put(2, 15, 0x3b);
      put(3, 0, 0x3a); for(let c=1; c<15; c++) put(3, c, (c===7||c===8) ? 0x42 : 0x22); put(3, 15, 0x3b);
      for(let r=0; r<3; r++){
        const seq = [0x26, 0x2a, 0x2d][r];
        for(let c=0; c<16; c++){
          const t = (c===7||c===8) ? (r===2 ? 0x4f : 0x42) : seq;
          put(4+r, c, t);
        }
      }
    };
    // 拱右柱屏：右侧一根柱 + 左侧沙地 + 左缘桥（桥接 66）
    const stampArchRightLeg = (blk) => {
      const put = (row, gx, t) => { if(row>=0 && row<ROWS && gx>=0 && gx<COLS) setTile(blk, row, gx, t); };
      stampWhiteBlockCore(blk, 12, 0);         // 右柱 cols 12..15
      put(2, 12, 0x42); put(3, 12, 0x42);      // 右柱左缘改成 66，桥直接接上
      put(2, 10, 0x5a); put(2, 11, 0x5b);      // 左缘桥(顶)
      put(3, 10, 0x5e); put(3, 11, 0x5f);      // 左缘桥(底)
    };
    // 石墙/石栏（岸边）：40 石顶 + 48 石柱
    const stampStoneWall = (blk, row0, gx0, w) => {
      for(let c=0; c<w; c++){
        const gx = gx0 + c;
        if(gx>=COLS) continue;
        if(row0 < ROWS) setTile(blk, row0, gx, 0x40);
        if(row0+1 < ROWS) setTile(blk, row0+1, gx, 0x48);
      }
    };

    // ===== 石柱密度分区：有些区段柱子少，有些区段密度高且跨多屏 =====
    const pillarZones = [];
    {
      let zStart = 1;
      while(zStart < screens - 1){
        const zLen = 2 + Math.floor(rng()*5);                        // 每段 2~6 屏
        const zEnd = Math.min(screens - 1, zStart + zLen);
        const dens = [0.4, 0.65, 0.9][Math.floor(rng()*3)];          // 低/中/高密度（单屏更密）
        pillarZones.push({ start: zStart, end: zEnd, dens });
        zStart = zEnd;
      }
    }
    // ===== 白块章节：3 屏连成一个不规则"拱门"（原版屏4-6：拱脚→横梁→拱右柱）=====
    //   屏0(底)=拱脚：左右两根宽柱 + 中间沙地走廊 + 桥连接
    //   屏1(中)=横梁：全宽白块，内部竖井(42/3a/4f)贯通供吉普上下
    //   屏2(顶)=拱右柱：右侧一根柱收窄，左侧沙地 + 左缘桥
    // 三种屏拼出跨 3 屏的不规则轮廓（左右柱→全宽→单柱），不再是一个屏的规则方块。
    const chapUsed = new Set();
    const nChaps = 1;                                              // 一个跨 3 屏的拱门
    for(let ci=0; ci<nChaps; ci++){
      let start = -1;
      for(let s=4; s<screens-3; s++){
        let ok = true;
        for(let k=0; k<3; k++){ if(chapUsed.has(s+k)){ ok=false; break; } }
        if(ok){ start = s; break; }
      }
      if(start < 0) continue;
      const stamps = [stampArchLegs, stampBeam, stampArchRightLeg];
      for(let k=0; k<3; k++){
        const s = start + k;
        const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
        for(let i=0;i<128;i++) blk[i] = 0x4F;                      // 先清屏：去掉围栏/道路残留
        stamps[k](blk);                                          // 再铺拱门结构（白块是主体）
        const ws = (e._whiteCells = e._whiteCells || new Set());
        for(let i=0; i<128; i++) ws.add(s + '|' + i);            // 整屏保护：修复/炮台不凿白块
        chapUsed.add(s);
      }
    }

    // ===== 专属柱子屏（原版屏9/10/11 同款：整屏柱子场 + 两侧满高边框柱）=====
    // 原版 L2 的柱子不是零散分布，而是集中在连续的"专属柱子屏"长廊：
    //   满高左右边框柱（6B 长柱顶 → 48 柱座 → 44 中段贯底）
    //   + 两条横向柱带（48 柱座一行，上接 40 普通/6B 长柱顶），中间留道路缺口不堵路。
    // 柱带长廊放在 boss 前 3 屏（原版屏 8/9/10 相对 boss 11 的位置），散点分布仍在其余屏保留。
    const pillarZone = new Set();
    {
      const pEnd = screens - 1;                 // 最后可生成屏（boss 前）
      const pStart = Math.max(1, pEnd - 2);     // 3 屏长廊
      for(let s=pStart; s<=pEnd; s++){
        if(s < 1 || s >= screens || chapUsed.has(s)) continue;
        const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
        const sc = skelCol(s);
        const snap = blk.slice();
        const nSpr0 = ((e.structSprites && e.structSprites[s]) || []).length;
        for(let i=0;i<128;i++) blk[i] = 0x4F;   // 清屏成沙地
        // 满高边框柱（左右屏缘）：6B 长柱顶 → 48 柱座 → 44 中段贯底
        const stampBorder = (gx) => {
          setTile(blk, 7, gx, 0x6B);
          setTile(blk, 6, gx, 0x48);
          for(let r=0; r<=5; r++) setTile(blk, r, gx, 0x44);
        };
        stampBorder(0); stampBorder(15);
        // 两条横向柱带：48 柱座一行 + 上接 40/6B 柱顶，留道路缺口（sc±1）
        const band = (baseRow) => {
          if(baseRow <= 0 || baseRow >= ROWS) return;
          for(let gx=1; gx<=14; gx++){
            if(Math.abs(gx - sc) <= 1) continue;   // 留 2 格宽吉普通道
            if(rng() < 0.15) continue;             // 偶发缺口
            const top = rng() < 0.5 ? 0x40 : 0x6B;
            setTile(blk, baseRow, gx, 0x48);
            setTile(blk, baseRow-1, gx, top);
            if(rng() < 0.3){                       // 照原版：专属柱子屏精灵较稀疏(~3/屏)
              const yy = (top === 0x40) ? 32*(ROWS-1-baseRow)+16 : 32*(ROWS-1-baseRow);
              (e.structSprites = e.structSprites || {})[s] = e.structSprites[s] || [];
              e.structSprites[s].push([yy, gxToX(gx)+4, rng()<0.5 ? 0x10 : 0x1F]);
            }
          }
        };
        band(5);   // 上柱带（柱座行 5，柱顶行 4）
        band(2);   // 下柱带（柱座行 2，柱顶行 1）
        if(!screenExitOk(e, 1, s)){                // 堵路 → 整屏回滚
          for(let i=0;i<128;i++) blk[i] = snap[i];
          if(e.structSprites && e.structSprites[s]) e.structSprites[s].length = nSpr0;
          continue;
        }
        pillarZone.add(s);
        const ws = (e._whiteCells = e._whiteCells || new Set());
        for(let i=0; i<128; i++) ws.add(s + '|' + i);   // 整屏保护：修复/机场/炮台/房间不凿柱子屏
      }
    }

    for(let s=1; s<screens-1; s++){
      const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
      const sc = skelCol(s);
      const snap = blk.slice();
      const inChap = chapUsed.has(s) || pillarZone.has(s);   // 白块章节/专属柱子屏：跳过零散结构，保留整带
      const nSprP0 = ((e && e.structSprites && e.structSprites[s]) || []).length;

      // 岩壁边框屏（约 1/4 屏）：左缘 3 列阶梯岩壁（原版屏0/12 收边），与结构屏互斥
      if(!inChap && rng() < 0.25 && sc >= 5){
        const stepCol0 = [0x3b,0x3b,0x3b,0x3b,0x3b,0x26,0x2a,0x2d];  // col0 上→下
        const stepCol1 = [0x27,0x27,0x27,0x27,0x27,0x27,0x27,0x2d];  // col1
        const stepCol2 = [0x2f,0x2f,0x2f,0x2f,0x2f,0x2f,0x2f,0x2e];  // col2
        let ok = true;
        for(let r=0; r<ROWS; r++){
          if(!isGround(blk,r,0) || !isGround(blk,r,1) || !isGround(blk,r,2)){ ok=false; break; }
        }
        if(ok){
          for(let r=0; r<ROWS; r++){
            setTile(blk, r, 0, stepCol0[r]);
            setTile(blk, r, 1, stepCol1[r]);
            setTile(blk, r, 2, stepCol2[r]);
          }
        }
      } else if(!inChap){
        const leftSide = sc > 8;   // 道路偏右 → 结构放左侧；反之放右侧
        // 远离道路那一侧的可用列数（道路 2 列宽，留 2 列净空 → 大型白块可占满剩余整侧）
        const availW = leftSide ? Math.max(0, sc - 2) : Math.max(0, COLS - (sc + 2));
        if(availW >= 5){
          // ② 石墙/石栏（岸边，横向；铺在远离道路一侧的底部 1~2 行）
          if(rng() < 0.45){
            const w = 3 + Math.floor(rng()*Math.min(availW-2, 6));   // 宽 3~8
            const gx0 = leftSide ? 0 : (COLS - w);
            const row0 = ROWS - 3 - Math.floor(rng()*2);             // 底部
            let ok = true;
            for(let r=0; r<2 && ok; r++) for(let c=0; c<w; c++){
              const gx = gx0 + c, row = row0 + r;
              if(row>=ROWS || gx>=COLS || !isGround(blk,row,gx)){ ok=false; break; }
            }
            if(ok) stampStoneWall(blk, row0, gx0, w);
          }

          // ③ 浅水池/石柱竖列（0x44 竖直，底部 0x48 收口）
          if(rng() < 0.35){
            const len = 2 + Math.floor(rng()*3);                     // 竖列长 2~4
            const gx = leftSide ? 0 : (COLS-1);
            const row0 = 1 + Math.floor(rng()*Math.max(1, ROWS-len-1));
            let ok = true;
            for(let r=0; r<len+1 && ok; r++){
              const row = row0 + r;
              if(row>=ROWS || !isGround(blk,row,gx)){ ok=false; break; }
            }
            if(ok){
              for(let r=0; r<len; r++) setTile(blk, row0+r, gx, 0x44);
              setTile(blk, row0+len, gx, 0x48);
            }
          }

          // ④ 石柱带（用户规格）：散点分布（单个/两个/一行/一列/一组），密度分区
          //   自下而上：72(0x48) 柱座；上接 64(0x40)=普通 / 107(0x6B)=长；
          //   68(0x44) 中段可无限堆叠（72→68×n→64|107）。两行/两列(2×2 组)概率低。
          //   柱子在普通地面(0x4F)随机生成，可长在围栏里，但不堵路。
          //   精灵绑定照原版：72-64 → 放 72 上(中)；72-107 → 放 72 顶边(=与 107 之间)；
          //   72-68(n)-64 → 放 72 或任意 68 上(中)；72-68(n)-107 → 放 72/68 上或 68 顶边。
          const zone = pillarZones.find(z => s >= z.start && s < z.end);
          if(zone && rng() < zone.dens){
            const makeStack = () => {
              const stack = [0x48];
              if(rng() < 0.75){ const n68 = 1 + Math.floor(rng()*4); for(let q=0;q<n68;q++) stack.push(0x44); }
              stack.push(rng() < 0.5 ? 0x40 : 0x6B);
              return stack;
            };
            const makeShort = () => [0x48, (rng() < 0.5 ? 0x40 : 0x6B)];
            const defs = [];   // {dx, rowOff, stack}：rowOff=底座相对 row0 上移的格数
            const r = rng();
            if(r < 0.30) defs.push({ dx:0, rowOff:0, stack:makeStack() });                                                       // 单个散点
            else if(r < 0.50){ defs.push({dx:0,rowOff:0,stack:makeStack()},{dx:1,rowOff:0,stack:makeStack()}); }                 // 两个散点
            else if(r < 0.75){ const n=3+Math.floor(rng()*Math.min(12,COLS-3)); for(let k=0;k<n;k++) defs.push({dx:k,rowOff:0,stack:makeStack()}); }  // 一行散点
            else if(r < 0.93){ const n=2+Math.floor(rng()*2); for(let k=0;k<n;k++) defs.push({dx:0,rowOff:k*2,stack:makeShort()}); }   // 一列散点(短柱纵向错开)
            else { defs.push({dx:0,rowOff:0,stack:makeShort()},{dx:1,rowOff:0,stack:makeShort()},{dx:0,rowOff:2,stack:makeShort()},{dx:1,rowOff:2,stack:makeShort()}); } // 一组(2×2，低概率)
            // 找落点：整组铺不下就换点重试
            let placed = null;
            for(let tries=0; tries<12 && !placed; tries++){
              const row0 = ROWS-2;
              const maxW = defs.reduce((m,d)=>Math.max(m,d.dx),0) + 1;
              const gx0 = 1 + Math.floor(rng()*Math.max(1, COLS-1-maxW));
              const undo = [];
              let ok = true;
              for(const d of defs){
                const gx = gx0 + d.dx;
                const bRow = row0 - d.rowOff;
                if(gx >= COLS){ ok = false; break; }
                for(let q=0; q<d.stack.length && ok; q++){
                  const rr = bRow - q;
                  if(rr < 0 || !isGround(blk, rr, gx)){ ok = false; break; }
                  undo.push([rr, gx, getTile(blk, rr, gx)]);
                }
              }
              if(!ok) continue;
              for(const d of defs) for(let q=0; q<d.stack.length; q++) setTile(blk, (row0-d.rowOff)-q, gx0+d.dx, d.stack[q]);
              if(!screenExitOk(e, 1, s)){
                for(const [rr,gg,tt] of undo) setTile(blk, rr, gg, tt);
                continue;
              }
              placed = { row0, gx0, defs };
            }
            if(placed){
              // 绑定柱子精灵 10/1F（80% 的柱子，按堆型定锚点）
              for(const d of placed.defs){
                if(rng() >= 0.8) continue;
                const baseRow = placed.row0 - d.rowOff;
                const top = d.stack[d.stack.length-1];
                const n68 = d.stack.length - 2;
                let yy;
                if(n68 === 0){
                  // 72-64 → 放 72 上(中)；72-107 → 放 72 顶边(=与 107 之间)
                  yy = (top === 0x40) ? 32*(ROWS-1-baseRow) + 16 : 32*(ROWS-1-baseRow);
                } else {
                  const pick68 = () => 32*(ROWS-1-(baseRow-(1+Math.floor(rng()*n68)))) + 16;  // 任意 68 上(中)
                  if(top === 0x40){
                    yy = (rng() < 0.5) ? 32*(ROWS-1-baseRow) + 16 : pick68();                 // 72 或 68 上
                  } else if(rng() < 0.5){
                    yy = (rng() < 0.5) ? 32*(ROWS-1-baseRow) + 16 : pick68();                 // 72 或 68 上
                  } else {
                    yy = 32*(ROWS-1-(baseRow-n68));                                           // 68 顶边(=与 107 之间)
                  }
                }
                (e.structSprites = e.structSprites || {})[s] = e.structSprites[s] || [];
                e.structSprites[s].push([yy, gxToX(placed.gx0+d.dx) + 4, rng()<0.5 ? 0x10 : 0x1F]);   // +4=柱块半格居中（原版实测）
              }
            }
          }

        }
      }

      // 堵路 → 整屏回滚（结构都是完整建筑，不能留半截）
      if(!screenExitOk(e, 1, s)){
        for(let k=0;k<128;k++) blk[k] = snap[k];
        if(e.structSprites && e.structSprites[s]) e.structSprites[s].length = nSprP0;
      }
    }
  }

  function enhanceLevelTerrain(e, level, nScreens, rng, skel, l1river){
    const role = TILE_ROLE[level];
    const groundTiles = role.ground && role.ground.length ? role.ground : role.road;
    let boss = e.idx.length-1;
    for(let s=e.spawns.length-1; s>=0; s--){ const l=e.spawns[s]; if(l && l.indexOf(0xF0)>=0){ boss=s; break; } }
    const screens = Math.min(boss, nScreens);
    // 骨架列辅助：某屏道路中心列
    const skelCol = (s) => (skel && skel.cols && skel.cols[s] != null) ? skel.cols[s] : Math.floor(COLS/2);

    // §6.0 L1 河流系统：斜河流(10×10可叠加) + 直河流(2×5) + 桥(可变长) + 汽艇
    if(level === 0 && l1river){
      enhanceL1River(e, l1river, rng, skelCol(0));
    }

    // §6.0b L1 散置障碍：41树/42石 偶尔堆叠 + 43月弯 + 黑炮台(图块4+子弹炮台精灵5/6)
    // 只替换空旷地面(88-98)图块 → 绝不覆盖结构/河流/桥；避开起点屏与河流屏
    if(level === 0){
      const groundSet = new Set(role.ground || []);
      const isGround = (blk,row,gx) => groundSet.has(getTile(blk,row,gx));
      for(let s=1; s<screens; s++){
        if(l1river && l1river.some(r=>s>=r.sStart && s<=r.sEnd)) continue;
        const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
        const sc = skelCol(s);
        // 0~2 组 41/42/43 散置（41 可 2×2 堆叠；43 放屏下部 2~3 连）
        const nPut = Math.floor(rng()*3);
        for(let k=0; k<nPut; k++){
          const kind = rng();
          const side = sc <= 7 ? 11 : 2;   // 放骨架对侧
          if(kind < 0.45){
            // 41 树：1×2 或 2×2 堆叠
            const gx = side + Math.floor(rng()*3);
            const row = 1 + Math.floor(rng()*4);
            if(isGround(blk,row,gx) && isGround(blk,row,gx+1)){
              setTile(blk,row,gx,0x29); setTile(blk,row,gx+1,0x29);
              if(rng()<0.5 && isGround(blk,row+1,gx) && isGround(blk,row+1,gx+1)){
                setTile(blk,row+1,gx,0x29); setTile(blk,row+1,gx+1,0x29);
              }
            }
          } else if(kind < 0.8){
            // 42 石：单块或 1×2
            const gx = side + Math.floor(rng()*4);
            const row = 1 + Math.floor(rng()*5);
            if(isGround(blk,row,gx)){
              setTile(blk,row,gx,0x2A);
              if(rng()<0.4 && isGround(blk,row,gx+1)) setTile(blk,row,gx+1,0x2A);
            }
          } else {
            // 43 月弯：屏下部 2~3 连（挡下往上火箭弹）
            const row = ROWS-2 + (rng()<0.5?0:1);
            const gx = side===11 ? 9+Math.floor(rng()*4) : 1+Math.floor(rng()*4);
            let placedAny = false;
            for(let i=0; i<2+Math.floor(rng()*2); i++){
              if(isGround(blk,row,gx+i)){ setTile(blk,row,gx+i,0x2B); placedAny = true; }
            }
            if(!placedAny) continue;
          }
        }
        // 灰炮台改由 placeCannonBases 统一生成（各关图块不同，且要在连通性修复之后放）
      }
    }

    // §6.4 L4 峡谷：每 3~4 屏，左右 3 列岩壁 + 中间 6 列黄土路(0x50 可通行)
    // 注意：0x30 是岩壁(obstacle)不是土路；L4 可通行主地面是 0x50 系黄土
    if(level === 3 && role.tree && role.tree.length){
      const rockA = 0x2C, rockB = 0x2F, dirt = 0x50;
      for(let s=1; s<screens-1; s += 3 + Math.floor(rng()*2)){
        if(e._fences && e._fences[s] && e._fences[s].length) continue;  // 有围栏的屏不铺峡谷岩壁（不覆盖围栏）
        const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
        const sc = skelCol(s);
        for(let row=0;row<ROWS;row++){
          // 左岩壁：只在远离道路骨架时铺（骨架列 > 6 才铺左 2 列）
          if(sc > 6){
            for(let gx=0; gx<2; gx++){
              setTile(blk,row,gx, rng()<0.5?rockA:rockB);
            }
          }
          // 右岩壁：只在远离道路骨架时铺（骨架列 < 9 才铺右 2 列）
          if(sc < 9){
            for(let gx=14; gx<16; gx++){
              setTile(blk,row,gx, rng()<0.5?rockA:rockB);
            }
          }
          // 中间黄土路确保连贯（含骨架列，8 列宽）
          const midL = Math.max(2, Math.min(7, sc - 3));
          for(let gx=midL; gx<midL+8 && gx<COLS; gx++){
            setTile(blk,row,gx, dirt);
          }
        }
      }
    }

    // §6.3 L3 激光阵：改由 applyStage3 直接放 0x38 激光精灵（原石板方案移除）

    // L2 水岸结构：白块建筑 + 石柱/石墙 + 浅水池竖列 + 岩壁边框（原版实测拼法，见 research/L2-structure.md）
    if(level === 1){
      enhanceL2Terrain(e, rng, skel, screens);
    }

    // §6.5 L5 要塞：不再撒 0x26 城墙（用户：路边残留，去掉）

    // §6.6 L6 基地：不再撒 0x86 墙体（用户：路边残留，去掉）
  }

  // ===== 飞机场放置：每关 1 个，距 boss 3~6 屏，放中间场地（不镜像）=====
  // 在 enhanceLevelTerrain 之后调用（避免被岩壁/墙体覆盖）。
  // 自家飞机 = 降落直升机右 0x3D / 左 0x3E（L1/L5/L6 右，L2/L3/L4 左）。
  // L1 图块可通行放屏中；L2~L6 实体机场放道路骨架对侧，若堵走廊则换边/换屏。
  function airportBlocksCorridor(blk, level, apt, x0, y0){
    for(let row=y0; row<y0+apt.h && row<ROWS; row++){
      let maxRun=0, run=0;
      for(let gx=0; gx<COLS; gx++){
        if(isWalkable(level, getTile(blk,row,gx))) run++;
        else { if(run>maxRun) maxRun=run; run=0; }
      }
      if(run>maxRun) maxRun=run;
      if(maxRun < 2) return true; // 该行被堵死
    }
    return false;
  }
  function placeAirport(e, level, boss, rng, skel, l1river){
    const apt = AIRPORTS[level];
    if(!apt) return;
    // 距 boss 2~5 屏（用户规格）：这个范围内的屏全部试一遍，保证一定放下一个机场
    const lo = Math.max(1, boss-5);
    const hi = Math.max(lo, boss-2);
    const order = [];
    for(let cand=lo; cand<=hi; cand++) order.push(cand);
    for(let i=order.length-1;i>0;i--){ const j=Math.floor(rng()*(i+1)); const t=order[i]; order[i]=order[j]; order[j]=t; }
    // 优先非河流屏，其次河流屏（总比没有机场好）
    order.sort((a,b)=>{
      const ra = l1river && l1river.some(r=>a>=r.sStart && a<=r.sEnd) ? 1 : 0;
      const rb = l1river && l1river.some(r=>b>=r.sStart && b<=r.sEnd) ? 1 : 0;
      return ra - rb;
    });
    for(const cand of order){ if(tryPlaceAirportAt(e, level, cand, rng, skel, apt)) return; }
  }
  // 在指定屏尝试放机场；成功返回 true 并登记受保护格
  function tryPlaceAirportAt(e, level, s, rng, skel, apt){
    const blk = e.layoutBlocks[e.idx[s]];
    if(!blk) return false;
    const sc = (skel && skel.cols && skel.cols[s] != null) ? skel.cols[s] : Math.floor(COLS/2);
    const prot = e._riverCells;
    const wprot = e._whiteCells;   // 白块结构屏（L2 拱门）：机场不得压到白块建筑上
    const isProt = (row,gx) => !!(prot && prot.has(s + '|' + ((ROWS-1-row)*COLS+gx)));
    // 围栏格保护：机场周边凿路/补宽不得动围栏（围栏是完整建筑）
    const fset = new Set();
    if(e._fences && e._fences[s]) for(const cells of e._fences[s]) for(const c of cells)
      fset.add((ROWS-1-c[0])*COLS + c[1]);
    const isFence = (row,gx) => fset.has((ROWS-1-row)*COLS + gx);
    // 降落飞机不贴边：左向(0x3E)机场左边留 2 列，右向(0x3D)机场右边留 2 列
    const minX = apt.sprite === 0x3E ? 2 : 1;
    const maxX = COLS - apt.w - (apt.sprite === 0x3D ? 2 : 1);
    // 把整屏所有能放下的落点都列出来（不再只试 2~4 个固定位置，否则大多数种子放不下机场）
    const spots = [];
    for(let yy=0; yy + apt.h <= ROWS; yy++){
      for(let xx=minX; xx <= maxX; xx++){
        if(xx < 0 || xx + apt.w > COLS) continue;
        const awayFromSkel = (xx + apt.w - 1) < sc - 1 || xx > sc + 2;   // 不压骨架竖道
        const midRow = Math.abs(yy - 2);                                  // 靠屏中垂直位置优先
        spots.push({ x0:xx, y0:yy, score: (awayFromSkel?0:100) + midRow*10 + Math.floor(rng()*5) });
      }
    }
    if(!spots.length) return false;
    spots.sort((a,b)=>a.score-b.score);
    for(const spot of spots){
      const x0 = spot.x0, y0 = spot.y0;
      // 保存原图块以便回滚
      const saved = [];
      for(let r=0; r<apt.h; r++) for(let c=0; c<apt.w; c++) saved.push(getTile(blk, y0+r, x0+c));
      // 机场不许压在河流/桥上，也不许压白块结构/围栏（保住完整建筑）
      let hitsRiver = false, hitsWhite = false, hitsFence = false, hitsStone = false;
      for(let r=0; r<apt.h && !hitsRiver && !hitsWhite && !hitsFence && !hitsStone; r++)
        for(let c=0; c<apt.w; c++){
          if(isProt(y0+r, x0+c)){ hitsRiver = true; break; }
          if(wprot && wprot.has(s + '|' + ((ROWS-1-(y0+r))*COLS+(x0+c)))){ hitsWhite = true; break; }
          if(isFence(y0+r, x0+c)){ hitsFence = true; break; }
          if(isStoneTile(level, getTile(blk, y0+r, x0+c))){ hitsStone = true; break; }
        }
      if(hitsRiver || hitsWhite || hitsFence || hitsStone) continue;
      if(!stampStructure(blk, apt, x0, y0)) continue;
      if(airportBlocksCorridor(blk, level, apt, x0, y0)){
        let k=0;
        for(let r=0; r<apt.h; r++) for(let c=0; c<apt.w; c++) setTile(blk, y0+r, x0+c, saved[k++]);
        continue;
      }
      // 机场跑道/周边不留 1 格宽通道（吉普需要 2 格）：把机场行里的 1 格宽可走段补宽
      // 用各关主地面（不是 ground[0] 变体，避免 0x41 之类残留图块）
      const lr = TILE_ROLE[level];
      const groundT = PRIMARY_GROUND[level] != null ? PRIMARY_GROUND[level] : ((lr.ground && lr.ground.length) ? lr.ground[0] : 0x50);
      for(let row=y0; row<y0+apt.h && row<ROWS; row++){
        let run=0, runStart=0;
        const closeRun = (end) => {
          if(run === 1){
            const gx = runStart;
            // 该 1 格"通道"本身就是河流结构的一部分（82/76/78 等可走河岸格）→ 不是路，不补宽
            if(isProt(row,gx)){ run = 0; return; }   // 河流结构格不是路，不补宽
            const fix = gx > 0 ? gx-1 : gx+1;
            const inApt = (row >= y0 && row < y0+apt.h && fix >= x0 && fix < x0+apt.w);
            if(fix >= 0 && fix < COLS && !inApt && !isProt(row,fix) && !isFence(row,fix) && !isStoneTile(level, getTile(blk,row,fix)) && !isWalkable(level, getTile(blk,row,fix))) setTile(blk,row,fix, groundT);
          }
          run = 0;
        };
        for(let gx=0; gx<COLS; gx++){
          if(isWalkable(level, getTile(blk,row,gx))){ if(run===0) runStart=gx; run++; }
          else closeRun(gx);
        }
        closeRun(COLS);
      }
      // 确保机场屏不被堵住：骨架列清出 2 格宽竖道（贯穿整屏，绕过机场建筑）
      for(let row=0; row<ROWS; row++){
        for(let dx=0; dx<2; dx++){
          const gx = Math.max(1, Math.min(COLS-2, sc+dx));
          if(row >= y0 && row < y0+apt.h && gx >= x0 && gx < x0+apt.w) continue;   // 绝不凿机场本体
          if(!isProt(row,gx) && !isFence(row,gx) && !isStoneTile(level, getTile(blk,row,gx)) && !isWalkable(level, getTile(blk,row,gx))) setTile(blk,row,gx, groundT);
        }
      }
      // 放完检查本屏可达（L3 水域机场进不去 / 被水围死 → 换落点）
      if(!screenExitOk(e, level, s)){
        let k=0;
        for(let r=0; r<apt.h; r++) for(let c=0; c<apt.w; c++) setTile(blk, y0+r, x0+c, saved[k++]);
        continue;
      }
      const cx = x0 + apt.spritePos[1];
      const cy = y0 + apt.spritePos[0];
      (e.structSprites = e.structSprites || {})[s] = e.structSprites[s] || [];
      // 原版飞机锚点：4x3 机场 x=col*8+4（L1~L5 实测都是 dx=4）；L6 的 6x6 机场 dx=0
      const planeDx = (apt.w === 4) ? 4 : 0;
      e.structSprites[s].push([rowToY(cy), gxToX(cx) + planeDx, apt.sprite]);
      // POW放下点 0x3F（给飞机上人），绑在飞机图块中间
      if(apt.sprite3F){
        const fx = x0 + apt.sprite3FPos[1];
        const fy = y0 + apt.sprite3FPos[0];
        e.structSprites[s].push([rowToY(fy), gxToX(fx), apt.sprite3F]);
      }
      // 登记机场格为受保护：后续连通性修复/补宽不得在上面凿洞
      const aset = (e._aptCells = e._aptCells || new Set());
      for(let r=0; r<apt.h; r++) for(let c=0; c<apt.w; c++)
        aset.add(s + '|' + ((ROWS-1-(y0+r))*COLS + (x0+c)));
      return true;
    }
    return false;
  }

  // ===== §6.0 篇章划分 =====
  function buildChapters(nScreens, rng){
    const chapters = [];
    if(nScreens <= 3){
      chapters.push({ type:'起点章', start:0, end:nScreens, zone:0, openLevel:1.0 });
      return chapters;
    }
    const startLen = Math.min(3, Math.max(2, Math.floor(nScreens*0.15)));
    chapters.push({ type:'起点章', start:0, end:startLen, zone:0, openLevel:1.0 });
    const climaxLen = Math.min(3, Math.max(1, Math.floor(nScreens*0.12)));
    const climaxStart = nScreens - climaxLen;
    let midStart = startLen;
    const midEnd = Math.max(midStart, climaxStart);
    let zoneCycle = 0;
    while(midStart < midEnd){
      const segLen = Math.min(2+Math.floor(rng()*4), midEnd-midStart);
      if(segLen <= 0) break;
      chapters.push({
        type:'主题章'+(++zoneCycle),
        start:midStart, end:midStart+segLen,
        zone:zoneCycle,
        openLevel: 0.4 + rng()*0.5,
      });
      midStart += segLen;
    }
    if(climaxStart > startLen){
      chapters.push({
        type:'高潮章', start:climaxStart, end:nScreens,
        zone:'climax', openLevel:0.6 + rng()*0.3,
      });
    }
    return chapters;
  }
  function chapterOf(s, chapters){
    for(const c of chapters) if(s >= c.start && s < c.end) return c;
    return chapters[chapters.length-1] || null;
  }

  // ===== §5.3 增强版道路骨架（带宽度信息）=====
  function buildRoadSkeleton(n,rng,level){
    const cols=[]; let col=4;
    const widths=[];
    const isCanyon = (level === 3); // L4 大峡谷：Z 字大幅横向折返
    for(let s=0;s<n;s++){
      cols.push(col);
      widths.push(isCanyon ? 4 : (2 + Math.floor(rng()*2)));
      if(isCanyon){
        // Z 字：每 2~3 屏从一侧折返到另一侧（4 ↔ 11）
        const zig = Math.floor(s / (2 + Math.floor(rng()*2)));
        col = (zig % 2 === 0) ? 4 : 11;
        if(rng() < 0.15) col += (rng()<0.5?-1:1);
        col = Math.max(3, Math.min(COLS-4, col));
      } else {
        const big = rng() < 0.2;
        const step = big ? (rng()<0.5?-2:2) : (Math.floor(rng()*3)-1);
        col = Math.max(3, Math.min(COLS-4, col + step));
      }
    }
    return { cols, widths };
  }

  // ===== §5.4 出生点保护 =====
  function carveSpawnSafeZone(e, level, startCol, rng){
    if(!e.idx.length) return;
    const role = TILE_ROLE[level];
    const groundTiles = role.ground && role.ground.length ? role.ground : role.road;
    const pickGround = () => (PRIMARY_GROUND[level] != null ? PRIMARY_GROUND[level] : groundTiles[0]);
    const block0 = e.layoutBlocks[e.idx[0]];
    if(!block0) return;
    for(let row = ROWS-3; row < ROWS; row++){
      for(let gx = Math.max(0,startCol-2); gx <= Math.min(COLS-1,startCol+3); gx++){
        const t = getTile(block0,row,gx);
        if(!isWalkable(level, t)){
          setTile(block0,row,gx, pickGround());
        }
      }
    }
    const list0 = e.spawns[0];
    if(list0){
      const out = [];
      let i=0;
      while(i<list0.length){
        const y=list0[i];
        if(y===0xEF){ out.push(0xEF); break; }
        if(y===0xF0||y===0xF1||y===0xF2){ out.push(y,list0[i+1]); i+=2; continue; }
        const yy=list0[i], xx=list0[i+1]&0x7F, tt=list0[i+2];
        const gxPos = xx >> 3;
        const screenPx = 239 - yy;
        const rowPos = Math.floor(screenPx / 32);
        const inSafe = (rowPos >= ROWS-3) && (gxPos >= startCol-2) && (gxPos <= startCol+3);
        if(!inSafe){
          out.push(yy,list0[i+1],tt);
        }
        i+=3;
      }
      const triples=[]; i=0;
      while(i<out.length){
        const y=out[i]; if(y===0xEF)break;
        if(y===0xF0||y===0xF1||y===0xF2){ triples.push([y,out[i+1],null,true]); i+=2; continue; }
        triples.push([y,out[i+1],out[i+2],false]); i+=3;
      }
      triples.sort((a,b)=>a[0]-b[0]);
      const fin=[]; for(const t of triples){ if(t[3])fin.push(t[0],t[1]); else fin.push(t[0],t[1],t[2]); }
      fin.push(0xEF); e.spawns[0] = fin;
    }
  }


  Object.assign(NS, {
    SEGMENT_COUNTS, buildSegments, segType, genSegmentScreen, applySegmentFeature, scatterObstacles, stampL3LaserColumns, stampL3LaserArray, restoreL3LaserArrays, FENCE_CFG, stampL1Fences, applyStage1, applyStage2, stampL3WaterBlock, applyStage3, applyStage4, alleywayScreen, applyStage5, applyStage6, generateMapFromScratch, riverRowSpan, drawRiverRow, planRiverRows, ensureRightSealBridges, makeL1River, planL1River, enhanceL1River, crossFrontierD, levelCrossable2, pushSpawnRaw, enhanceLevelTerrain, airportBlocksCorridor, placeAirport, tryPlaceAirportAt, buildChapters, chapterOf, buildRoadSkeleton, carveSpawnSafeZone, stampForests, reEncloseGrass,
  });
})();
