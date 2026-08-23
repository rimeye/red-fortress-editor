/* 内容放置：主流程外的房间 / 星星 / 敌人 / POW / 障碍 / 炮台 / 对象槽位 / Boss */
(function () {
  'use strict';
  const NS = window.JackalGen;
  const {
    COLS, ROWS, EMPTY, TILE_ROLE, GEN_THEME, LEVEL_UNIQUE, COMMON_TYPES, resolveEnemyPool, MAX_SCREENS, maxSpritesForLevel, normalizeCounts, DIFF_LEVELS, DIFF_RANGE, lerp, diffAt, GEN_DIFF, MAX_OBJ_SLOTS, SAFE_PER_SCREEN, SAFE_PRIORITY_PER_SCREEN, BOSS_APPROACH_SCREENS, BOSS_APPROACH_MAX, BOSS_SCREEN_MAX, BOSS_APPROACH_PRIORITY_MAX, PRIMARY_GROUND, STRONG_ENEMIES, FACILITY_IDS, NO_RANDOM_SPAWN, LEVEL_BOSSES, seededRandom, initTemplates, idxAt, getTile, setTile, rowToY, gxToX, roleOf, isWalkable, isBulletSolid, STRUCTURES, AIRPORTS, stampStructure, snapshotBossWar, CRESCENT_TILE, screenExitOk, SEGMENT_COUNTS, buildSegments, segType, genSegmentScreen, applySegmentFeature, scatterObstacles, FENCE_CFG, stampL1Fences, applyStage1, applyStage2, stampL3WaterBlock, applyStage3, applyStage4, alleywayScreen, applyStage5, applyStage6, generateMapFromScratch, riverRowSpan, drawRiverRow, planRiverRows, ensureRightSealBridges, makeL1River, planL1River, enhanceL1River, crossFrontierD, levelCrossable2, pushSpawnRaw, enhanceLevelTerrain, airportBlocksCorridor, placeAirport, tryPlaceAirportAt, buildChapters, chapterOf, buildRoadSkeleton, carveSpawnSafeZone,
  } = NS;

  // ===== layoutBlocks 去重（相同内容 block 合并，idx 重映射）=====
  function dedupeLayoutBlocks(e){
    if(!e.layoutBlocks) return;
    const sigMap = new Map(); // sig -> 首个 block 索引
    const remap = new Map();  // blockIdx -> dedupe 后的 blockIdx
    const newBlocks = [];
    for(let b=0; b<e.layoutBlocks.length; b++){
      const blk = e.layoutBlocks[b];
      if(!blk) continue;
      const sig = blk.join(',');
      if(sigMap.has(sig)){
        remap.set(b, sigMap.get(sig));
      } else {
        sigMap.set(sig, newBlocks.length);
        remap.set(b, newBlocks.length);
        newBlocks.push(blk);
      }
    }
    // 重映射 idx
    for(let s=0; s<e.idx.length; s++){
      const bi = e.idx[s];
      if(bi < e.layoutBlocks.length && remap.has(bi)){
        e.idx[s] = remap.get(bi);
      }
    }
    e.layoutBlocks = newBlocks;
  }

  // ===== 预算钳制：超 16KB 时**不减屏数**，收敛合并 layout 块来降低数据 =====
  // 按住用户设置生成多少屏就保留多少屏：不再通过移除屏来凑预算。当数据超过 0x3FF8
  // 时，把「引用数最少」的图块 block 合并到与其最相似的另一 block（让多屏共用一块），
  // 从而降低 distinct layoutBlocks 的字节占用，使数据收敛进 16KB 上限；每轮合并后重新去重。
  // 起点屏 / Boss 战区屏（含 0xF0/0xF1/0xF2 标记）的 block 不参与合并（不改变其内容）。
  function enforceBudget(e, level, boss, rng){
    // 预算口径（与 repack placeGroup 一致）：idx + layout*128 + def + pal <= 0x3FF8
    const budget = () => e.idx.length + e.layoutBlocks.length * 128 + e.def.length + e.pal.length;
    if(budget() <= 0x3FF8) return;
    // 需要保留内容不变的屏：起点(0)、boss 及之后、含 0xF0/F1/F2 的屏
    const keepScreens = new Set([0]);
    for(let s=0; s<e.spawns.length; s++){
      const l = e.spawns[s];
      if(l && (l.indexOf(0xF0)>=0 || l.indexOf(0xF1)>=0 || l.indexOf(0xF2)>=0)) keepScreens.add(s);
    }
    const keepBlockIdx = new Set(); // 这些 block 只能当合并目标，不能当被合并方（保证起点/boss 内容不变）
    for(let s=0; s<e.idx.length; s++){ if(keepScreens.has(s)) keepBlockIdx.add(e.idx[s]); }
    const SIM = (a,b) => { let n=0; for(let k=0;k<128;k++) if(a[k]===b[k]) n++; return n; };
    let guard = 0;
    while(budget() > 0x3FF8 && guard++ < 400){
      // 统计每个 distinct block 被多少屏引用
      const refs = new Array(e.layoutBlocks.length).fill(0);
      for(let s=0;s<e.idx.length;s++){ const bi=e.idx[s]; if(bi>=0 && bi<refs.length) refs[bi]++; }
      // 按引用数升序处理：优先合并「最不常用」的块（改动影响屏数最少）
      const order = [];
      for(let i=0;i<e.layoutBlocks.length;i++) if(refs[i]>0) order.push(i);
      if(order.length <= 1) break;
      order.sort((a,b)=>refs[a]-refs[b]);
      let from = -1, to = -1, best = -1;
      for(const a of order){
        if(keepBlockIdx.has(a)) continue; // 不合并起点/boss 屏的块
        const blkA = e.layoutBlocks[a];
        for(let b=0;b<e.layoutBlocks.length;b++){
          if(b===a || refs[b]<=0) continue;
          const sim = SIM(blkA, e.layoutBlocks[b]);
          // 只按相似度选目标：差异越小内容变化越小，越贴近「收敛」的语义
          if(sim > best){ best = sim; from = a; to = b; }
        }
        if(from >= 0) break; // 已为当前最低频块找到最相似目标
      }
      if(from < 0 || to < 0) break; // 无可合并（或仅剩受保护块）
      // 把 from 的所有屏重指到 to（多屏共用 to 这一块）
      for(let s=0;s<e.idx.length;s++){ if(e.idx[s]===from) e.idx[s]=to; }
      // 移除被合并的 block，并重映射后续索引
      e.layoutBlocks.splice(from, 1);
      for(let s=0;s<e.idx.length;s++){ const bi=e.idx[s]; if(bi>from) e.idx[s]=bi-1; }
      // 重新去重（合并可能使两块完全相同 → 进一步省空间，满足屏数不变）
      dedupeLayoutBlocks(e);
    }
  }

  // 位置评分：离主干道中心线距离
  function scoreNearRoad(s,row,gx,skel){
    if(!skel || !skel.cols) return 1;
    const col = skel.cols[s] != null ? skel.cols[s] : Math.floor(COLS/2);
    const w = skel.widths ? (skel.widths[s]||2) : 2;
    const dist = Math.abs(gx - col);
    if(dist <= w) return 10;
    if(dist <= w+1) return 6;
    if(dist <= 3) return 3;
    return 1;
  }
  function scoreRewardSpot(s,row,gx,skel,chapters){
    let sc = 1;
    if(skel && skel.cols){
      const col = skel.cols[s] != null ? skel.cols[s] : Math.floor(COLS/2);
      const dist = Math.abs(gx - col);
      if(dist >= 5) sc += 4;
      else if(dist >= 3) sc += 2;
    }
    if(row <= 1 || row >= ROWS-2) sc += 1;
    const ch = chapterOf(s, chapters||[]);
    if(ch && (ch.type === '高潮章')) sc += 5;
    if(ch && (ch.type === '起点章')) sc -= 3;
    return sc;
  }
  function pickBestSpot(spots, scorer, rng){
    if(!spots.length) return -1;
    const scored = spots.map((p,i)=>({i, s:scorer(p.s,p.row,p.gx)+rng()*0.5}));
    scored.sort((a,b)=>b.s-a.s);
    const topN = Math.max(1, Math.floor(scored.length * 0.25));
    const pick = scored[Math.floor(rng()*topN)];
    return spots.splice(pick.i,1)[0];
  }

  // ===== §5.6 房间 + 星星放置 =====
  function placeRoomsAndStars(e,level,cfg,skel,diff,rng,rndInt,chapters,what){
    const cols = skel.cols || skel;
    const n = cols.length;
    if(n<=0) return;
    // 分类：what.doSprite=精灵设施(门/POW房/飞机/地雷/坦克房/停放车)；
    //       what.doStar=星星道具 + 升级房(0x15 闪人房)
    const doSprite = !what || what.doSprite !== false;
    const doStar   = !what || what.doStar !== false;
    // 逐项数量控制（0=自动按等级/密度）：counts.starUp/starClear/starLife(星星)，
    //   pow(0x13/14)/pow4(0x1C/1D 战俘)/flash(0x15 升级房)/tank(0x19)/vehicle(0x4E/0x53)
    const C = (what && what.counts) || {};
    const c = (k, auto) => (C[k] > 0 ? C[k] : auto);
    // 精灵总数（单关极限）：spriteTotal > 0 时按比例分配各精灵
    const spriteTotal = (what && what.spriteTotal) || 0;
    // 白名单：只生成勾选的类型（含星星/POW/升级房/道具）
    const WL = (what && what.enemyTypes);
    const wlOk = (t) => WL == null || WL.indexOf(t) >= 0;
    const dens=diff.density;
    const count=(per)=>Math.max(1,Math.ceil(per*n*dens));
    const diffFactor = diff.level / 10; // 等级越高道具越多（任务书 §6.0 密度模型）
    // 升级星星最多（用户要求星星类=升级星星多）：0x51 主升 > 0x50 清屏 > 0x52 1UP
    const nStarUp   = doStar    ? c('starUp',   Math.max(1, Math.ceil(count(1/4) * (0.8 + diffFactor)))) : 0;
    const nStarClear= doStar    ? c('starClear',Math.max(1, Math.ceil(count(1/6)))) : 0;
    const nStarLife = doStar    ? c('starLife', Math.max(0, Math.ceil(count(1/12) * (0.3 + diffFactor)))) : 0;
    const nPow      = doSprite  ? c('pow',  count(1/4)) : 0;
    const nPow4     = doSprite  ? c('pow4', Math.max(1, Math.ceil(count(1/4)/3))) : 0;  // 战俘房 0x1C/1D
    const nFlash    = doStar    ? c('flash',Math.max(1, Math.ceil(count(1/6) * (0.6 + diffFactor)))) : 0;  // 升级房=道具类
    // 坦克房(0x19)数量不限：Boss 门生成的槽位问题已由 ROM 补丁根治
    // （见 patch.js GATE_HELPER：生成失败时挤掉次要对象再试，槽满也不会卡死）。
    const nTankRoom = doSprite  ? c('tank', (level===4 ? Math.max(0, Math.ceil(n/15*(diff.level>=5?1:0.5))) : 0)) : 0;
    const nVehicle  = doSprite  ? c('vehicle', count(1/5)) : 0;
    // 精灵总数上限：POW+战俘+坦克+停放 累计不超过 spriteTotal（0=不限）

    const spots=[];
    const wprot = e._whiteCells;   // 白块结构屏（L2 拱门）：房间/星星不得压上去
    for(let s=0;s<n;s++){
      const block=e.layoutBlocks[e.idx[s]]; if(!block) continue;
      for(let row=1;row<=6;row++) for(let gx=1;gx<COLS-1;gx++){
        if(!isWalkable(level, getTile(block,row,gx))) continue;
        if(wprot && wprot.has(s + '|' + ((ROWS-1-row)*COLS+gx))) continue;
        if(s===0 && row>=ROWS-3 && gx>= (cols[0]||4)-2 && gx<=(cols[0]||4)+3) continue;
        spots.push({s,row,gx});
      }
    }
    if(!spots.length) return;

    const pushSpawn=(s,y,x,type)=>{
      let list=e.spawns[s];
      if(!list) list=e.spawns[s]=[0xEF];
      list.splice(list.length-1,0,y,x,type);
      const triples=[]; let i=0;
      while(i<list.length){ const yy=list[i]; if(yy===0xEF)break;
        if(yy===0xF0||yy===0xF1||yy===0xF2){ triples.push([yy,list[i+1],null,true]); i+=2; continue; }
        triples.push([yy,list[i+1],list[i+2],false]); i+=3; }
      triples.sort((a,b)=>a[0]-b[0]);
      const out=[]; for(const t of triples){ if(t[3])out.push(t[0],t[1]); else out.push(t[0],t[1],t[2]); }
      out.push(0xEF); e.spawns[s]=out;
    };
    const ch2 = chapters || [];
    const takeNearRoad = () => pickBestSpot(spots, (s,r,gx)=>scoreNearRoad(s,r,gx,skel), rng);
    const takeReward   = () => pickBestSpot(spots, (s,r,gx)=>scoreRewardSpot(s,r,gx,skel,ch2), rng);
    const takeRand     = () => { const i=Math.floor(rng()*spots.length); return spots.splice(i,1)[0]; };

    // 停放车图块绑定（原版实测）：
    //   L3 吉普 3×3：上 49 4A 4B / 中 4D 4E 4F / 下 49 4A 4B，精灵在中心 4E 图块
    //   L6 坦克 2×2：上 1B 84（或镜像 84 1B）/ 下 1F 1F，精灵在 1B 图块
    //   其它关不绑（原版没有停放车）
    const stampVehicle = (p) => {
      const blk = e.layoutBlocks[e.idx[p.s]];
      if(!blk) return false;
      let pat = null, ax = 0, ay = 0;
      if(level === 2){
        pat = [[0x49,0x4A,0x4B],[0x4D,0x4E,0x4F],[0x49,0x4A,0x4B]]; ax = 1; ay = 1;
      } else if(level === 5){
        const mir = rng() < 0.5;
        pat = mir ? [[0x84,0x1B],[0x1F,0x1F]] : [[0x1B,0x84],[0x1F,0x1F]];
        ax = mir ? 1 : 0; ay = 0;
      } else {
        return true;   // 其它关不绑车辆图块
      }
      const y0 = p.row - ay, x0 = p.gx - ax;
      // 只铺在"纯地面"上：可走判定会把炮台座(0B)/门(5-6)也当可走，压上去会毁掉绑定结构，
      // 所以这里只认各关主地面（L3/L6 都是 07），结构/白块/机场一律不压
      const roleV = TILE_ROLE[level];
      const groundSetV = new Set(roleV.ground && roleV.ground.length ? roleV.ground : roleV.road);
      for(let r=0; r<pat.length; r++) for(let c=0; c<pat[0].length; c++){
        const rr = y0 + r, cc = x0 + c;
        if(rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS) return false;
        if(!groundSetV.has(getTile(blk, rr, cc))) return false;
        if(wprot && wprot.has(p.s + '|' + ((ROWS-1-rr)*COLS + cc))) return false;
      }
      const undo = [];
      for(let r=0; r<pat.length; r++) for(let c=0; c<pat[0].length; c++){
        const rr = y0 + r, cc = x0 + c;
        undo.push([rr, cc, getTile(blk, rr, cc)]);
        setTile(blk, rr, cc, pat[r][c]);
      }
      if(!screenExitOk(e, level, p.s)){
        for(const [r,c,t] of undo) setTile(blk, r, c, t);
        return false;
      }
      return true;
    };

    // 1UP（最稀有）：50% 概率藏 0x53 吉普下（L3 要绑吉普图块；放不下就退化成普通 1UP 星）
    for(let i=0;i<nStarLife && spots.length;i++){
      if(rng() < 0.5 && cfg.vehicles.indexOf(0x53)>=0 && wlOk(0x53)){
        let done = false;
        for(let tries=0; tries<10 && spots.length && !done; tries++){
          const p = takeReward(); if(!p) break;
          if(!stampVehicle(p)) continue;
          pushSpawn(p.s,rowToY(p.row),gxToX(p.gx), 0x53|0x80);
          done = true;
        }
        if(done) continue;
        if(spots.length && wlOk(cfg.stars.life)){ const p = takeReward(); if(p) pushSpawn(p.s,rowToY(p.row),gxToX(p.gx), cfg.stars.life|0x80); }
      } else if(wlOk(cfg.stars.life)){
        const p = takeReward();
        if(p) pushSpawn(p.s,rowToY(p.row),gxToX(p.gx), cfg.stars.life|0x80);
      }
    }
    // 升级星星（奖励位）
    for(let i=0;i<nStarUp && spots.length;i++){ if(!wlOk(cfg.stars.upgrade)) continue; const p=takeReward(); pushSpawn(p.s,rowToY(p.row),gxToX(p.gx),cfg.stars.upgrade|0x80); }
    // 升级房(0x15 闪人房)多余部分：地图上每间房都已绑定精灵；用户设的数量超过房间数时，把多出的撒在地图随机处
    {
      const roomCount = e._flashRoomCount || 0;
      const excessFlash = (C.flash > 0) ? Math.max(0, C.flash - roomCount) : 0;
      for(let i=0;i<excessFlash && spots.length;i++){
        if(!wlOk(cfg.rooms.flash)) continue;
        const p = takeRand();
        if(!p) continue;
        pushSpawn(p.s,rowToY(p.row),gxToX(p.gx), cfg.rooms.flash|0x80);
      }
    }
    // 汽艇(0x08 攻击艇)多余部分：河流自然填充的汽艇已在 enhanceL1River 放好；
    // 用户设的数量超过自然汽艇数时，把多出的撒到剩余河心泊位（汽艇 raw，无 0x80）
    if(doSprite){
      const boatExcess = C.boat > 0 ? Math.max(0, C.boat - (e._boatCount || 0)) : 0;
      if(boatExcess > 0 && wlOk(0x08)){
        const used = e._boatUsed || new Set();
        const free = (e._boatSpots || []).filter(p => !used.has(p[0] + '|' + p[1] + '|' + p[2]));
        for(let i=0;i<boatExcess && free.length;i++){
          const p = free.splice(Math.floor(rng()*free.length),1)[0];
          pushSpawn(p[0], 32*(ROWS-1-p[1]) + 4, gxToX(p[2]) + 4, 0x08);
        }
      }
    }
    // POW房(0x13/14) / 战俘房(0x1C/1D) 多余部分：地图上每间房都已绑定精灵（先填充满），
    // 用户设的数量超过房间数时，把多出的撒在地图随机处（剩余随机分配）。
    {
      const powCount = e._powRoomCount || 0;
      const excessPow = (C.pow > 0) ? Math.max(0, C.pow - powCount) : 0;
      for(let i=0;i<excessPow && spots.length;i++){
        const t = cfg.rooms.pow[Math.floor(rng()*cfg.rooms.pow.length)];
        if(!wlOk(t)) continue;
        const p = takeRand();
        if(!p) continue;
        pushSpawn(p.s,rowToY(p.row),gxToX(p.gx), t|0x80);
      }
      const excessPow4 = (C.pow4 > 0) ? Math.max(0, C.pow4 - (e._pow4RoomCount||0)) : 0;
      for(let i=0;i<excessPow4 && spots.length;i++){
        const t = cfg.rooms.pow4[Math.floor(rng()*cfg.rooms.pow4.length)];
        if(!wlOk(t)) continue;
        const p = takeRand();
        if(!p) continue;
        pushSpawn(p.s,rowToY(p.row),gxToX(p.gx), t|0x80);
      }
    }
    let sprPlaced = 0;
    const sprOk = () => spriteTotal <= 0 || sprPlaced < spriteTotal;
    // 清屏星星（随机）
    for(let i=0;i<nStarClear && spots.length;i++){ if(!wlOk(cfg.stars.clear)) continue; const p=takeRand(); if(p) pushSpawn(p.s,rowToY(p.row),gxToX(p.gx),cfg.stars.clear|0x80); }
    // 坦克房（L5要塞）
    for(let i=0;i<nTankRoom && spots.length && sprOk();i++){ if(!wlOk(cfg.rooms.tank)) continue; const p=takeNearRoad(); if(p){ pushSpawn(p.s,rowToY(p.row),gxToX(p.gx),cfg.rooms.tank|0x80); sprPlaced++; } }
    for(let i=0;i<nVehicle && spots.length && sprOk();i++){
      const v = cfg.vehicles[Math.floor(rng()*cfg.vehicles.length)];
      if(!wlOk(v)) continue;
      // 找能放下车辆图块的位置（放不下就换点，最多试 10 次）
      let placed = false;
      for(let tries=0; tries<10 && spots.length && !placed; tries++){
        const p = takeNearRoad(); if(!p) continue;
        if(!stampVehicle(p)) continue;
        pushSpawn(p.s,rowToY(p.row),gxToX(p.gx), v|0x80);
        placed = true;
        sprPlaced++;
      }
    }
  }

  // ===== §5.7 敌人摆放（分区定类型 + 签名特色注入）=====
  function placeEnemies(e,level,cfg,skel,diff,rng,rndInt,startCol,chapters,what){
    const cols = skel.cols || skel;
    const n = cols.length;
    if(!n) return;
    // Boss 屏（0xF0 标记所在屏）：用于 Boss 前清场，保证 Boss 有空对象槽
    let bossScreen = null;
    for(let s=e.spawns.length-1; s>=0; s--){ const l=e.spawns[s]; if(l && l.indexOf(0xF0)>=0){ bossScreen=s; break; } }
    const chs = chapters || [];
    // 分类：what.doEnemy=普通敌人(固定+半固定兵种)；what.doSprite=签名特色(每关独有)+结构配套精灵(门/POW/飞机/汽艇)
    const doEnemy  = !what || what.doEnemy  !== false;
    const doSprite = !what || what.doSprite !== false;
    const parity   = (what && what.parity) || { mode:'even' };
    // 敌人生成总数倍率（UI「敌人数」）+ 每屏固定数量（UI「每屏敌人数」，0=自动按等级）
    const eDensity = (what && what.enemyDensity) || 1;
    const perScreen = (what && what.enemyPerScreen) || 0;
    const enemyTotal = (what && what.enemyTotal) || 0;
    // 敌人总数模式：把总数均摊到非 boss 屏
    const perFromTotal = enemyTotal > 0 ? Math.max(1, Math.round(enemyTotal / Math.max(1, n))) : 0;
    // 精灵逐项数量控制：counts.gate(门 0x1B)/plane(飞机)/mine(地雷 0x35)
    const C2 = (what && what.counts) || {};
    let minePlaced = 0, gatePlaced = 0, planePlaced = 0;

    const baseEntries = [];
    const typeWhitelist = (what && what.enemyTypes);
    // 灰炮台(0x05/0x06)本关有座子图块时，由 placeCannonBases 按 fill+excess 生成，不进随机池
    const cannonBound = CANNON_TILE[level] != null;
    const isBoundCannon = (t) => cannonBound && ((t & 0x7F) === 0x05 || (t & 0x7F) === 0x06);
    // 停放车(0x4E/0x53)必须绑车辆图块（L3 吉普 3×3 / L6 坦克 2×2），由 placeRoomsAndStars 统一放，
    // 不进随机敌人池——否则会散出没图块的裸车精灵
    const isBoundVehicle = (t) => (t & 0x7F) === 0x4E || (t & 0x7F) === 0x53;
    // L2 柱子精灵(0x10/0x1F/0x1E)必须立在柱块上（地形层柱子带绑定），不进随机池
    const isBoundPillar = (t) => level === 1 && ((t & 0x7F) === 0x10 || (t & 0x7F) === 0x1F || (t & 0x7F) === 0x1E);
    if(typeWhitelist == null){
      // 不限（全选/未启用白名单）→ 本关原池全部
      for(const [t,w] of cfg.enemies){
        if(NO_RANDOM_SPAWN.has(t)) continue;
        if(isBoundCannon(t)) continue;
        if(isBoundVehicle(t)) continue;
        if(isBoundPillar(t)) continue;
        baseEntries.push([t,w]);
      }
    } else if(typeWhitelist.length){
      // 白名单模式：勾选的所有类型（含道具/独有兵种）都参与每屏敌人生成，权重相等，可大量生成
      for(const t of typeWhitelist){
        if(NO_RANDOM_SPAWN.has(t & 0x7F)) continue;
        if(isBoundCannon(t)) continue;
        if(isBoundVehicle(t)) continue;
        if(isBoundPillar(t)) continue;
        // 原池有权重则用原权重，否则默认权重 10（保证足量生成）
        const orig = cfg.enemies.find(e => e[0] === (t & 0x7F));
        baseEntries.push([t & 0x7F, orig ? orig[1] : 10]);
      }
    } else {
      // 全不选（空数组）→ 不生成随机敌人，只保留绑定结构的精灵
    }

    // 签名特色单次注入
    const signatureSpots = {};

    // §6.1 L1 0x0A Boss坦克：中高难度(≥5级)、高潮章/后段 1 次
    if(level === 0 && diff.level >= 5){
      const climaxIdx = chs.findIndex(c => c.type==='高潮章');
      let targetS = -1;
      if(climaxIdx >= 0){
        const c = chs[climaxIdx];
        targetS = c.start + Math.floor(rng()*Math.max(1,c.end-c.start));
      } else if(n >= 4){
        targetS = n - 2 - Math.floor(rng()*2);
      }
      if(targetS > 0){
        signatureSpots[targetS] = signatureSpots[targetS] || [];
        signatureSpots[targetS].push(0x0A);
      }
    }
    // §6.2 L2 人像：2~3 个（柱子 10/1F 必须立在柱块上，由地形层柱子堆绑定，不再裸撒）
    if(level === 1){
      const candidates = [1,3,5,7].filter(x=>x<n);
      for(let k=0;k<2 && candidates.length;k++){
        const si = Math.floor(rng()*candidates.length);
        const s = candidates.splice(si,1)[0];
        signatureSpots[s] = signatureSpots[s] || [];
        signatureSpots[s].push(rng()<0.5 ? 0x18 : 0x21);
      }
    }
    // §6.3 L3 激光阵
    if(level === 2){
      const step = 5 + Math.floor(rng()*4);
      for(let s=step; s<n; s+=step){
        signatureSpots[s] = signatureSpots[s] || [];
        signatureSpots[s].push(0x0D);
        signatureSpots[s].push(0x0D);
      }
    }
    // §6.4 L4 落石/火车/导弹
    if(level === 3){
      for(let k=0;k<Math.max(1,Math.floor(n/5));k++){
        const s = 2 + Math.floor(rng()*Math.max(1,n-3));
        signatureSpots[s] = signatureSpots[s] || [];
        const pick = [0x2F,0x30,0x2D,0x32][Math.floor(rng()*4)];
        signatureSpots[s].push(pick);
        if(pick===0x32) signatureSpots[s].push(0x2A);
      }
    }
    // §6.5 L5 埋炮台 + 散弹炮塔
    if(level === 4){
      for(let s=2; s<n; s+=3){
        signatureSpots[s] = signatureSpots[s] || [];
        signatureSpots[s].push(0x0C);
        signatureSpots[s].push(0x12);
      }
    }
    // §6.6 L6 电梯 + 武直
    if(level === 5){
      const s = Math.max(1, Math.floor(n*0.7));
      signatureSpots[s] = signatureSpots[s] || [];
      signatureSpots[s].push(0x44);
      signatureSpots[s].push(0x43);
    }

    // 每类型数量上限：counts 里以类型 ID 为键（如 counts[1]=10 表示步兵最多10个）
    const typePlaced = {};
    const capOf = (t) => { const v = C2[('t'+t)]; return v > 0 ? v : (C2[t] > 0 ? C2[t] : 0); };
    const makeWeightedPick = (extraEntries) => {
      const entries = baseEntries.slice();
      for(const t of (extraEntries||[])){
        if(NO_RANDOM_SPAWN.has(t)) continue;
        if(typeWhitelist != null && typeWhitelist.indexOf(t & 0x7F) < 0) continue;
        entries.push([t, 2]);
      }
      return () => {
        // 动态过滤：排除已到数量上限的类型（ws 与 entries 对齐，跳过处填 0）
        let total=0; const ws=[];
        for(const [t,w] of entries){
          const t7 = t & 0x7F;
          const cap = capOf(t7);
          if(cap > 0 && (typePlaced[t7]||0) >= cap){ ws.push(0); continue; }
          const m=(STRONG_ENEMIES.has(t)?diff.strong:1)*w; total+=m; ws.push(m);
        }
        if(total <= 0) return null; // 全部达上限，本屏不再生成
        let r=rng()*total;
        for(let i=0;i<entries.length;i++){
          if(ws[i] === 0) continue;
          r-=ws[i]; if(r<=0) return entries[i][0];
        }
        for(let i=entries.length-1;i>=0;i--){ if(ws[i]>0) return entries[i][0]; }
        return null;
      };
    };

    for(let s=0;s<n;s++){
      const block=e.layoutBlocks[e.idx[s]];
      const roadSpots=[];
      if(block){
        for(let row=1;row<ROWS-1;row++) for(let gx=1;gx<COLS-1;gx++){
          if(isWalkable(level, getTile(block,row,gx))) roadSpots.push({row,gx});
        }
      }
      const ch = chapterOf(s, chs);
      let enemyMul = 1.0;
      if(ch && ch.type === '起点章') enemyMul = 0.5;
      if(ch && ch.type === '高潮章') enemyMul = 1.4;
      const nEraw = perFromTotal > 0 ? perFromTotal : (perScreen > 0 ? perScreen : rndInt(diff.enemies[0], diff.enemies[1]));
      const nE = Math.max(s===0?1:0, Math.round(nEraw * enemyMul * eDensity));

      let extraPool = [];
      const zoneName = cfg.zones && ch && typeof ch.zone==='number' ? cfg.zones[ch.zone % cfg.zones.length] : '';
      if(/开阔|广场|平原|空地/.test(zoneName)) extraPool.push(0x01,0x0F,0x01);
      if(/窄巷|巷道|要塞|迷宫|峡谷/.test(zoneName)){ if(!cannonBound) extraPool.push(0x05,0x06); extraPool.push(0x0C,0x07,0x0E); }
      // 汽艇 0x08：L1 由地图河流系统生成（structSprites），随机池不再加；L2/L3 无地图汽艇，保留随机
      if(/水岸|河道|湖心|桥梁|沼泽/.test(zoneName) && level>=1 && level<3) extraPool.push(0x08);
      if(/水岸|河道|湖心/.test(zoneName) && level===2) extraPool.push(0x29,0x1A);

      const weightedPick = makeWeightedPick(extraPool);
      const list=[];

      // 每屏奇偶占比：前 oddStart 屏全偶y（玩家武器未满级），之后屏按占比精确分配
      const pMode2 = parity.mode || 'even';
      const oddRatio2 = (pMode2==='odd') ? 1 : (pMode2==='mixed' ? (parity.ratio!=null?parity.ratio:0.3) : 0);
      const oddStart = (parity.oddStart!=null) ? parity.oddStart : 3;
      const oddFlags = [];
      if(doEnemy){
        const nOdd = (s < oddStart || pMode2==='even') ? 0 : Math.max(0, Math.min(nE, Math.round(nE * oddRatio2)));
        for(let k=0;k<nE;k++) oddFlags.push(k < nOdd);
        for(let k=nE-1;k>0;k--){ const j=Math.floor(rng()*(k+1)); const tmp=oddFlags[k]; oddFlags[k]=oddFlags[j]; oddFlags[j]=tmp; }
      }

      if(doEnemy){ for(let i=0;i<nE;i++){
        let row,gx;
        if(roadSpots.length){
          let spot;
          for(let tries=0;tries<8;tries++){
            spot=roadSpots[Math.floor(rng()*roadSpots.length)];
            if(s===0 && spot.gx>=startCol-2 && spot.gx<=startCol+3 && spot.row>=ROWS-3) continue;
            break;
          }
          // 兜底：8 次全落在安全区时，改从非安全区重选
          if(s===0 && spot.gx>=startCol-2 && spot.gx<=startCol+3 && spot.row>=ROWS-3){
            const safe = roadSpots.filter(p => !(p.gx>=startCol-2 && p.gx<=startCol+3 && p.row>=ROWS-3));
            if(safe.length) spot = safe[Math.floor(rng()*safe.length)];
          }
          row=spot.row; gx=spot.gx;
        } else {
          row=1+Math.floor(rng()*(ROWS-2)); gx=1+Math.floor(rng()*(COLS-2));
        }
        let type = weightedPick();
        if(type == null) break; // 所有类型都达到数量上限
        type &= 0x7F;
        typePlaced[type] = (typePlaced[type]||0) + 1;
        if(type === 0x35){
          if(!(block && isWalkable(level, getTile(block,row,gx)))) type = 0x01;
          if(C2.mine > 0 && minePlaced >= C2.mine) type = 0x01; // 地雷数量上限
        }
        // （灰炮台弹道：原版灰炮台正下方常有实心墙图块，子弹被挡属正常现象，不做限制）
        if(type === 0x35) minePlaced++;
        // 奇y = 满级武器才生成的敌人（Bank7.ASM:6596）
        // 奇偶按每屏配额 oddFlags[i]（mixed）或全部/全奇；低难度强敌隐藏杠杆保留
        let yPos = rowToY(row);
        const Y_odd_hide = diff.level <= 3 && STRONG_ENEMIES.has(type&0x7F) && rng() < 0.4;
        const makeOdd = Y_odd_hide || oddFlags[i];
        if(makeOdd && (yPos & 1) === 0){ yPos = (yPos + 1) & 0xFF; if(yPos === 0xEF) yPos = 0xED; }
        let xx=gxToX(gx);
        // 设施类（星星/POW房/升级房/坦克房/停放车/门/飞机/汽艇）需带 0x80 位
        const outType = FACILITY_IDS.has(type) ? (type | 0x80) : type;
        list.push([yPos, xx, outType]);
      } }

      // 注入签名特色对象（每关独有兵种/设施）—— 白名单：只生成勾选的类型
      const sg = doSprite ? signatureSpots[s] : null;
      if(sg){
        for(const tid of sg){
          if(typeWhitelist != null && typeWhitelist.indexOf(tid) < 0) continue;
          const row = 2 + Math.floor(rng()*4);
          const gx = 2 + Math.floor(rng()*(COLS-4));
          list.push([rowToY(row), gxToX(gx), tid|0x80]);
        }
      }

      // 注入结构配套精灵（飞机场自家飞机/营地敌人/门/POW房，来自 generateMapFromScratch）
      // 门/飞机数量：0=不生成，>0=上限，undefined=自动全部
      const ss = doSprite && e.structSprites ? e.structSprites[s] : null;
      if(ss){
        for(const [yy,xx,tid,raw] of ss){
          const t7 = tid & 0x7F;
          // structSprites 全是"绑定结构"的精灵（飞机0x3C-3E/放人点0x3F/门0x1B/炮台0x05-06/
          // 汽艇0x08/POW房0x13-14/战俘房0x1C-1D/升级房0x15/守卫0x02），必须跟随结构固定出现，
          // 不受"勾选精灵类型"白名单过滤——白名单只管随机散落的敌人/道具/多余部分。
          if(t7 === 0x1B){
            if(C2.gate === 0) continue;
            if(C2.gate > 0 && gatePlaced >= C2.gate) continue;
            gatePlaced++;
          }
          if(t7 === 0x3C || t7 === 0x3D || t7 === 0x3E || t7 === 0x3F){
            if(C2.plane === 0) continue;
            if(C2.plane > 0 && planePlaced >= C2.plane) continue;
            planePlaced++;
          }
          // 汽艇 0x08：fill+excess —— 自然填充已在 enhanceL1River 放好，这里一律注入；
          // 多余部分在 placeRoomsAndStars 按 counts.boat 撒到剩余泊位
          list.push([yy, xx, raw ? tid : (tid|0x80)]);
        }
      }

      list.sort((a,b)=>a[0]-b[0]);
      const out=[];
      const orig=e.spawns[s];
      // 只保留 orig 中的 Boss 标记（0xF0/0xF1/0xF2），设施对象由 placeRoomsAndStars 重新生成
      if(orig){
        let i=0;
        while(i<orig.length){
          const y=orig[i];
          if(y===0xEF) break;
          if(y===0xF0||y===0xF1||y===0xF2){ out.push(y, orig[i+1]); i+=2; continue; }
          i+=3;
        }
      }
      for(const en of list) out.push(en[0],en[1],en[2]);
      const triples=[];
      let i=0;
      while(i<out.length){
        const y=out[i];
        if(y===0xF0||y===0xF1||y===0xF2){ triples.push([y, out[i+1], null, true]); i+=2; continue; }
        triples.push([y, out[i+1], out[i+2], false]); i+=3;
      }
      triples.sort((a,b)=>a[0]-b[0]);
      const final=[];
      for(const t of triples){ if(t[3]) final.push(t[0],t[1]); else final.push(t[0],t[1],t[2]); }
      final.push(0xEF);
      e.spawns[s]=final;
    }
  }

  // ===== 灰炮台：图块 ↔ 精灵 5/6 强绑定（权威：原版 ROM 实测）=====
  // 原版每关的炮台座图块与精灵一一对应（按 y=32*(ROWS-1-row)、x=gx*8 配对 100% 命中）：
  //   L1 图块4 ×15、L2 图块4 ×16、L3 图块11 ×14、L4 图块4 ×13、L5 图块4 ×18
  //   L6 的图块4 不是炮台座（角色表里是障碍），所以 L6 不放
  // 精灵类型是 0x85/0x86（= 5/6 带 0x80 优先位），0x85 约占 3/4
  // 密度按原版：平均约 1.2 座/屏，成小簇分布（多数屏 0 座，个别屏 2~4 座）
  // 统计指定行里"恰好 1 格宽的可走段"数量：放障碍前后对比，变多就说明挤出了窄缝
  function thinRunCount(blk, level, rows){
    let n = 0;
    for(const row of rows){
      if(row < 0 || row >= ROWS) continue;
      let run = 0;
      for(let gx=0; gx<=COLS; gx++){
        const w = gx < COLS && isWalkable(level, getTile(blk, row, gx));
        if(w) run++;
        else { if(run === 1) n++; run = 0; }
      }
    }
    return n;
  }

  // ===== 普通战俘房（固定放在围栏里；无围栏的关卡散置空地）=====
  // 右房 2×3：[空白 0 1 / 空白 2 3] → POW 左精灵 14(0x14)，Δcol=+2
  // 左房 2×3：[房2块 空白]         → POW 右精灵 13(0x13)，Δcol=+1
  //   L1/L4 左房=19 17/20 18；L5=72 73/76 77；L3/L6=8 9/10 4；L2 无左房
  // 空白 = 各关主地面（留给吉普开进去吸人）。锚点 y=32*(ROWS-1-row)-12、x=(col+Δcol)*8，写入带 0x80
  const POW_CFG = [
    { flash:[[0x25,0x27],[0x26,0x28]], left:[[0x13,0x11],[0x14,0x12]], right:[[0x00,0x01],[0x02,0x03]], blank:0x58 },  // L1
    { flash:[[0x62,0x63],[0x66,0x67]], left:null,                      right:[[0x00,0x01],[0x02,0x03]], blank:0x4F },  // L2
    { flash:null,                      left:[[0x08,0x09],[0x0A,0x04]], right:[[0x00,0x01],[0x02,0x03]], blank:0x07 },  // L3
    { flash:[[0x70,0x71],[0x72,0x73]], left:[[0x13,0x11],[0x14,0x12]], right:[[0x00,0x01],[0x02,0x03]], blank:0x50 },  // L4
    { flash:[[0x40,0x41],[0x44,0x45]], left:[[0x48,0x49],[0x4C,0x4D]], right:[[0x00,0x01],[0x02,0x03]], blank:0x2D },  // L5
    { flash:null,                      left:[[0x08,0x09],[0x0A,0x04]], right:[[0x00,0x01],[0x02,0x03]], blank:0x07 },  // L6
  ];
  // 闪人房(POW升级房 0x15)精灵锚点偏移（原版实测，相对房顶行/房左列）：
  //   L1 +0/+8 | L2 -8/+8 | L3 无 | L4 -16/+6 | L5 -16/+8 | L6 无
  const FLASH_ANCHOR = [[0,8],[-8,8],[0,8],[-16,6],[-16,8],[0,8]];
  function powRoomsForLevel(level){
    const cfg = POW_CFG[level] || POW_CFG[0];
    const rooms = [];
    if(cfg.right) rooms.push({ tiles:[[cfg.blank,cfg.right[0][0],cfg.right[0][1]],[cfg.blank,cfg.right[1][0],cfg.right[1][1]]], sprite:0x14, dCol:2 });
    if(cfg.left)  rooms.push({ tiles:[[cfg.left[0][0],cfg.left[0][1],cfg.blank],[cfg.left[1][0],cfg.left[1][1],cfg.blank]], sprite:0x13, dCol:1 });
    return rooms;
  }
  function placePowRooms(e, level, rng, skel, counts){
    const rooms = powRoomsForLevel(level);
    if(!rooms.length) return;
    const role = TILE_ROLE[level];
    const groundSet = new Set(role.ground && role.ground.length ? role.ground : role.road);
    let boss = e.idx.length-1;
    for(let s=e.spawns.length-1; s>=0; s--){ const l=e.spawns[s]; if(l && l.indexOf(0xF0)>=0){ boss=s; break; } }
    const prot = e._riverCells, aprot = e._aptCells;
    const wprot = e._whiteCells;   // L2 白块拱门：POW 房不许压进白块章节
    const fenceAt = new Set();
    if(e._fences) for(const ss in e._fences)
      for(const cells of e._fences[ss]) for(const c of cells) fenceAt.add(ss + '|' + c[0] + '|' + c[1]);
    const protSet = (e._aptCells = e._aptCells || new Set());
    const keepSet = (e._roomSprites = e._roomSprites || new Set());
    let roomCount = 0;
    for(let s=1; s<boss; s++){
      const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
      const rect = e._fenceRects && e._fenceRects[s];
      const inFence = !!(rect && rect.x2 - rect.x1 >= 4);
      // 围栏内约一半；无围栏关卡（L3/L6）每屏约 30% 散置
      if(inFence ? rng() >= 0.5 : rng() >= 0.30) continue;
      const room = rooms[Math.floor(rng()*rooms.length)];
      for(let tries=0; tries<16; tries++){
        let row, col;
        if(inFence){
          row = 1 + Math.floor(rng()*(ROWS-3));
          col = rect.x1 + 1 + Math.floor(rng()*Math.max(1, rect.x2 - rect.x1 - 3));
        } else {
          row = 1 + Math.floor(rng()*(ROWS-3));
          col = 1 + Math.floor(rng()*(COLS-4));
        }
        if(col < 1 || col+2 >= COLS-1 || row+1 >= ROWS) continue;
        let ok = true;
        for(let dr=0; dr<2 && ok; dr++) for(let dc=0; dc<3; dc++){
          const rr = row+dr, cc = col+dc;
          const key = s + '|' + ((ROWS-1-rr)*COLS+cc);
          if(!groundSet.has(getTile(blk, rr, cc))){ ok = false; break; }   // 只铺在空地上
          if(prot && prot.has(key)){ ok = false; break; }
          if(aprot && aprot.has(key)){ ok = false; break; }
          if(wprot && wprot.has(key)){ ok = false; break; }               // 白块拱门里不放 POW 房
          if(fenceAt.has(s + '|' + rr + '|' + cc)){ ok = false; break; }
        }
        if(!ok) continue;
        // 房图块在 L2-L6 是障碍：铺完若堵路就整间撤销
        const undo = [];
        for(let dr=0; dr<2; dr++) for(let dc=0; dc<3; dc++)
          undo.push([row+dr, col+dc, getTile(blk, row+dr, col+dc)]);
        for(let dr=0; dr<2; dr++) for(let dc=0; dc<3; dc++)
          setTile(blk, row+dr, col+dc, room.tiles[dr][dc]);
        if(!screenExitOk(e, level, s)){
          for(const [r,c,t] of undo) setTile(blk, r, c, t);
          continue;
        }
        const py = Math.max(0, 32*(ROWS-1-row) - 12);
        const px = gxToX(col + room.dCol);
        (e.structSprites = e.structSprites || {})[s] = e.structSprites[s] || [];
        e.structSprites[s].push([py, px, room.sprite]);       // 带 0x80 → 0x93 / 0x94
        keepSet.add(s + '|' + py + '|' + px);                  // 房间必需精灵，不许被裁
        for(let dr=0; dr<2; dr++) for(let dc=0; dc<3; dc++)
          protSet.add(s + '|' + ((ROWS-1-(row+dr))*COLS+(col+dc)));
        roomCount++;
        break;
      }
    }
    e._powRoomCount = roomCount;
  }

  // ===== 闪人房（POW 升级房，2×2）=====
  // 升级房精灵 0x15(POW升级) 挂右上格；固定步兵 0x02 挂右下格
  //   L1 37/39/38/40 | L2 98/99/102/103 | L4 112/113/114/115 | L5 64/65/68/69 | L3/L6 无升级房
  // 出现频率：约每 3~4 屏 1~2 个；也会偶尔出现在围栏里。
  function placeFlashRooms(e, level, rng, skel, counts){
    const flash = POW_CFG[level] && POW_CFG[level].flash;
    if(!flash) return;
    const role = TILE_ROLE[level];
    const groundSet = new Set(role.ground && role.ground.length ? role.ground : role.road);
    let boss = e.idx.length-1;
    for(let s=e.spawns.length-1; s>=0; s--){ const l=e.spawns[s]; if(l && l.indexOf(0xF0)>=0){ boss=s; break; } }
    const prot = e._riverCells, aprot = e._aptCells;
    const wprot = e._whiteCells;   // L2 白块拱门：闪人房不许压进白块章节
    const fenceAt = new Set();
    if(e._fences) for(const ss in e._fences)
      for(const cells of e._fences[ss]) for(const c of cells) fenceAt.add(ss + '|' + c[0] + '|' + c[1]);
    const protSet = (e._aptCells = e._aptCells || new Set());   // 结构保护集（开路时不许凿）
    let roomCount = 0;
    for(let s=1; s<boss; s++){
      if(rng() >= 0.29) continue;                 // 固定密度：约每 3~4 屏 1~2 间（房间数量只由地图决定）
      const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
      const sc = (skel && skel.cols && skel.cols[s] != null) ? skel.cols[s] : Math.floor(COLS/2);
      const rect = e._fenceRects && e._fenceRects[s];
      const nRoom = 1 + (rng() < 0.35 ? 1 : 0);
      for(let k=0; k<nRoom; k++){
        // 散点分布：全屏随机取点（偶尔也落在围栏里，与散点一致）
        const inFence = rect && rect.x2 > rect.x1 + 2 && rng() < 0.25;
        for(let tries=0; tries<14; tries++){
          const row = 1 + Math.floor(rng()*(ROWS-3));
          const col = inFence ? (rect.x1 + 1 + Math.floor(rng()*Math.max(1, rect.x2 - rect.x1 - 2)))
                              : (1 + Math.floor(rng()*(COLS-3)));
          if(col < 1 || col+1 >= COLS-1 || row+1 >= ROWS) continue;
          if(Math.abs(col - sc) <= 1 || Math.abs(col+1 - sc) <= 1) continue;   // 上排挡路，避开主通道
          let ok = true;
          for(let dr=0; dr<2 && ok; dr++) for(let dc=0; dc<2; dc++){
            const rr = row+dr, cc = col+dc;
            const key = s + '|' + ((ROWS-1-rr)*COLS+cc);
            if(!groundSet.has(getTile(blk, rr, cc))){ ok = false; break; }
            if(prot && prot.has(key)){ ok = false; break; }
            if(aprot && aprot.has(key)){ ok = false; break; }
            if(wprot && wprot.has(key)){ ok = false; break; }               // 白块拱门里不放闪人房
            if(fenceAt.has(s + '|' + rr + '|' + cc)){ ok = false; break; }
          }
          if(!ok) continue;
          // 与河/桥留 1 格
          let nearRiver = false;
          for(let dr=-1; dr<3 && !nearRiver; dr++) for(let dc=-1; dc<3; dc++){
            const rr = row+dr, cc = col+dc;
            if(rr<0||rr>=ROWS||cc<0||cc>=COLS) continue;
            if(prot && prot.has(s + '|' + ((ROWS-1-rr)*COLS+cc))){ nearRiver = true; break; }
          }
          if(nearRiver) continue;
          // 铺房 + 守卫（堵路/挤窄缝就撤）
          const undo = [];
          for(let dr=0; dr<2; dr++) for(let dc=0; dc<2; dc++)
            undo.push([row+dr, col+dc, getTile(blk, row+dr, col+dc)]);
          const thinB = thinRunCount(blk, level, [row, row+1]);
          for(let dr=0; dr<2; dr++) for(let dc=0; dc<2; dc++)
            setTile(blk, row+dr, col+dc, flash[dr][dc]);
          if(!screenExitOk(e, level, s) || thinRunCount(blk, level, [row, row+1]) > thinB){
            for(const [r,c,t] of undo) setTile(blk, r, c, t);
            continue;
          }
          // 精灵：POW 升级 0x15（右上格）+ 固定步兵 0x02（右下格）
          (e.structSprites = e.structSprites || {})[s] = e.structSprites[s] || [];
          const fa = FLASH_ANCHOR[level] || [0,8];      // 原版实测锚点偏移
          const powY = Math.max(0, 32*(ROWS-1-row) + fa[0]);
          const powX = Math.max(0, gxToX(col) + fa[1]);
          const infY = Math.max(0, 32*(ROWS-1-(row+1)) - 4);
          // L5：POW 升级 0x15 与 POW 坦克房 0x19 可互换（原版 L5 实测 5 间里 1 间是坦克房 0x99）
          const sprFlash = (level === 4 && rng() < 0.25) ? 0x19 : 0x15;   // L5：POW升级 0x15 与 POW坦克房 0x19 可互换
          e.structSprites[s].push([powY, powX, sprFlash]);          // 带 0x80 → 0x95 / 0x99
          e.structSprites[s].push([infY, powX, 0x02, true]);        // raw 步兵
          // 登记为"房间必需精灵"：对象槽限量时不许裁掉，否则房间变空壳
          const keepSet = (e._roomSprites = e._roomSprites || new Set());
          keepSet.add(s + '|' + powY + '|' + powX);
          keepSet.add(s + '|' + infY + '|' + powX);
          for(let dr=0; dr<2; dr++) for(let dc=0; dc<2; dc++)
            protSet.add(s + '|' + ((ROWS-1-(row+dr))*COLS+(col+dc)));                  // 房间受保护
          roomCount++;
          break;
        }
      }
    }
    e._flashRoomCount = roomCount;               // 给 placeRoomsAndStars 算"多余撒多少"
  }

  // ===== 偶尔出现的散置障碍（各关签名图块）=====
  // L1：树 41(0x29) 石 42(0x2A) 月湾 43(0x2B)
  // L4：石头 79(0x4F)——生成方式同 L1 石头 42（散置，不嵌围栏、不接炮台）
  // L5：月湾 17(0x11)——生成方式同 L1 月湾 43（散置 + 接炮台下方 + 嵌围栏 8/9/10+灰炮台）
  // 统一低密度：每屏各约 1/5 概率出一小簇。
  const OCCASIONAL_CFG = [
    { tiles:[0x29,0x2A,0x2B], p:[0.22,0.22,0.12], crescent:0x2B },   // L1
    null,                                                           // L2
    null,                                                           // L3
    { tiles:[0x4F],          p:[0.22],           crescent:null  },   // L4 石头79
    { tiles:[0x11],          p:[0.12],           crescent:0x11 },   // L5 月湾17
    null,                                                           // L6
  ];
  function crescentTileFor(level){ return (OCCASIONAL_CFG[level] && OCCASIONAL_CFG[level].crescent) || null; }
  function scatterOccasionalObstacles(e, level, rng, skel){
    const cfg = OCCASIONAL_CFG[level];
    if(!cfg || !cfg.tiles || !cfg.tiles.length) return;
    const tiles = cfg.tiles, probs = cfg.p;
    const role = TILE_ROLE[level];
    const groundSet = new Set((role.ground && role.ground.length ? role.ground : role.road));
    let boss = e.idx.length-1;
    for(let s=e.spawns.length-1; s>=0; s--){ const l=e.spawns[s]; if(l && l.indexOf(0xF0)>=0){ boss=s; break; } }
    const prot = e._riverCells;
    const fenceAt = new Set();
    if(e._fences) for(const s in e._fences)
      for(const cells of e._fences[s]) for(const c of cells) fenceAt.add(s + '|' + c[0] + '|' + c[1]);
    // 小簇形状：单个 / 横 1x2 / 竖 2x1 / 2x2 / 横 3 连
    const shapes = [
      [[0,0]],
      [[0,0],[0,1]],
      [[0,0],[1,0]],
      [[0,0],[0,1],[1,0],[1,1]],
      [[0,0],[0,1],[0,2]],
    ];
    for(let s=1; s<boss; s++){
      const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
      const sc = (skel && skel.cols && skel.cols[s] != null) ? skel.cols[s] : Math.floor(COLS/2);
      const free = (row, gx) => {
        if(row < 0 || row >= ROWS || gx < 1 || gx >= COLS-1) return false;
        if(Math.abs(gx - sc) <= 1) return false;
        if(!groundSet.has(getTile(blk, row, gx))) return false;   // 只铺空白地面，天然避开结构/炮台/月湾
        // 离河流/桥留 1 格空隙，别把河边通道挤成 1 格宽
        for(const [dr,dc] of [[0,0],[-1,0],[1,0],[0,-1],[0,1]]){
          const rr = row+dr, cc = gx+dc;
          if(rr<0||rr>=ROWS||cc<0||cc>=COLS) continue;
          if(level === 0){
            const tt = getTile(blk, rr, cc);
            if((tt>=0x44 && tt<=0x57) || tt===0x63 || tt===0x64 || (tt>=0x2C && tt<=0x32)) return false;  // L1 河/桥本体直接避让
          }
          const kk = s + '|' + ((ROWS-1-rr)*COLS+cc);
          if(prot && prot.has(kk)) return false;
          if(e._aptCells && e._aptCells.has(kk)) return false;   // 机场也不许压
        }
        if(fenceAt.has(s + '|' + row + '|' + gx)) return false;
        return true;
      };
      for(let ti=0; ti<tiles.length; ti++){
        if(rng() >= probs[ti]) continue;
        const tile = tiles[ti];
        const offs = shapes[Math.floor(rng()*shapes.length)];
        for(let tries=0; tries<12; tries++){
          const row0 = Math.floor(rng()*ROWS);
          const gx0 = 1 + Math.floor(rng()*(COLS-2));
          let ok = true;
          for(const [dr,dc] of offs) if(!free(row0+dr, gx0+dc)){ ok=false; break; }
          if(!ok) continue;
          const undo = [];
          const rowsTouched = [];
          for(const [dr,dc] of offs){
            undo.push([row0+dr, gx0+dc, getTile(blk,row0+dr,gx0+dc)]);
            if(rowsTouched.indexOf(row0+dr) < 0) rowsTouched.push(row0+dr);
          }
          const thinBefore = thinRunCount(blk, level, rowsTouched);
          for(const [dr,dc] of offs) setTile(blk, row0+dr, gx0+dc, tile);
          // 堵路 或 挤出新的 1 格宽窄缝 → 整簇回滚
          if(!screenExitOk(e, level, s) || thinRunCount(blk, level, rowsTouched) > thinBefore){
            for(const [r,c,t] of undo) setTile(blk, r, c, t);
            continue;
          }
          break;
        }
      }
    }
  }
  const CANNON_TILE = [0x04, 0x04, 0x0B, 0x04, 0x04, null];
  // ===== 炮台向下弹道检查 =====
  // 玩家从屏幕下方逼近（gen row 0 = 屏幕底，row 7 = 屏幕顶），灰炮台朝下（递减 gen row）开火。
  // 从炮台下一格向下扫描，只要命中一格的图块是子弹实心，弹道就被墙挡住（会哑火）。
  // 注意：旧代码在这里检查的是 row+1（朝屏幕顶，远离玩家），方向反了，导致从没验证过
  // 真正的开火弹道——这在第五关要塞/炮台阵里把灰炮台压在了墙后。
  function downLaneBlocked(blk, row, gx){
    for(let r=row-1; r>=0; r--) if(isBulletSolid(getTile(blk, r, gx))) return true;
    return false;
  }
  // 灰炮台排列：单座 / 横排 / 横向间隔 / 竖排 / 2x2 方块 / 斜排，
  // 每种排列都可以（约一半概率）在每座炮台正下方接一个月湾 43，横排时月湾自然连成一条
  function placeCannonBases(e, level, rng, skel, l1river, counts){
    const tile = CANNON_TILE[level];
    if(tile == null) return;
    const role = TILE_ROLE[level];
    const groundSet = new Set((role.ground && role.ground.length ? role.ground : role.road));
    let boss = e.idx.length-1;
    for(let s=e.spawns.length-1; s>=0; s--){ const l=e.spawns[s]; if(l && l.indexOf(0xF0)>=0){ boss=s; break; } }
    const prot = e._riverCells;
    const wprot = e._whiteCells;   // 白块结构屏：炮台不得压到白块建筑上
    // 围栏占位（含围栏里的 88 空门格）也要避开，否则会把围栏那条线打断
    const fenceAt = new Set();
    if(e._fences) for(const s in e._fences)
      for(const cells of e._fences[s]) for(const c of cells) fenceAt.add(s + '|' + c[0] + '|' + c[1]);

    let cannonPlaced = 0;                              // 自然密度放置的灰炮台座数
    const cannonTarget = counts ? ((counts[5]||0) + (counts[6]||0)) : 0;  // 灰炮台=白弹0x05+红弹0x06 之和
    for(let s=1; s<boss; s++){
      const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
      // 每屏形态分四档：不放 / 偶尔单个 / 一组排列 / 密集据点
      //   这样既有"偶尔冒出一座孤零零的炮台"，也有成排成方块的据点
      const roll = rng();
      let groups, loneOnly = false;
      if(roll < 0.30) continue;                        // 30% 屏完全不放
      else if(roll < 0.60){ groups = 1; loneOnly = true; }   // 30% 只放 1 座（偶尔单个）
      else if(roll < 0.88){ groups = 1; }              // 28% 放一组排列
      else { groups = 2 + Math.floor(rng()*2); }       // 12% 放 2~3 组（密集据点）
      const sc = (skel && skel.cols && skel.cols[s] != null) ? skel.cols[s] : Math.floor(COLS/2);
      // 炮台座图块本身在各关都是 road（可走），不会堵路 → 不需要避开主通道；
      // 只有挂在它下面的月湾 43 是障碍，那一格才要守主通道（见 freeBlocking）
      const free = (row, gx) => {
        if(row < 0 || row >= ROWS || gx < 1 || gx >= COLS-1) return false;
        const t0 = getTile(blk, row, gx);
        // L5 只铺 2C/2D/2E 主地面（原版 04 座子都在这些地上；0x35 是巷道走廊中行，不能压）
        const okGround = level === 4 ? (t0 === 0x2C || t0 === 0x2D || t0 === 0x2E) : groundSet.has(t0);
        if(!okGround) return false;                                                 // 只铺在空白地面
        if(downLaneBlocked(blk, row, gx)) return false;                             // 向下弹道不可被墙挡
        if(prot && prot.has(s + '|' + ((ROWS-1-row)*COLS+gx))) return false;        // 不动河流/桥
        if(wprot && wprot.has(s + '|' + ((ROWS-1-row)*COLS+gx))) return false;        // 不动白块结构
        // 离河流/桥留 1 格空隙：紧贴河边会把河边通道挤成 1 格宽（吉普过不去）
        for(const [dr,dc] of [[0,0],[-1,0],[1,0],[0,-1],[0,1]]){
          const rr = row+dr, cc = gx+dc;
          if(rr<0||rr>=ROWS||cc<0||cc>=COLS) continue;
          const kk = s + '|' + ((ROWS-1-rr)*COLS+cc);
          if(prot && prot.has(kk)) return false;
          if(e._aptCells && e._aptCells.has(kk)) return false;   // 机场也不许压
          if(level === 0){
            const tt = getTile(blk, rr, cc);
            if((tt>=0x44 && tt<=0x57) || tt===0x63 || tt===0x64 || (tt>=0x2C && tt<=0x32)) return false;  // L1 河/桥本体直接避让
          }
        }
        if(fenceAt.has(s + '|' + row + '|' + gx)) return false;                     // 不动围栏
        return true;
      };
      // 月湾 43 是障碍：它那一格要避开主通道
      const freeBlocking = (row, gx) => free(row, gx) && Math.abs(gx - sc) > 1;
      const putCannon = (row, gx) => {
        setTile(blk, row, gx, tile);
        (e.structSprites = e.structSprites || {})[s] = e.structSprites[s] || [];
        // 原版锚点：x = col*8 + 4、y = 32*(ROWS-1-row) + 2
        e.structSprites[s].push([32*(ROWS-1-row) + 2, gxToX(gx) + 4, rng()<0.75 ? 0x05 : 0x06]);
        cannonPlaced++;
      };
      // 排列模板：返回相对偏移列表
      const patterns = [
        () => [[0,0]],                                                     // 单座
        () => { const n=2+Math.floor(rng()*3); const a=[]; for(let k=0;k<n;k++) a.push([0,k]); return a; },      // 横排 2~4
        () => { const n=2+Math.floor(rng()*2); const a=[]; for(let k=0;k<n;k++) a.push([0,k*2]); return a; },    // 横向间隔
        () => { const n=2+Math.floor(rng()*2); const a=[]; for(let k=0;k<n;k++) a.push([k,0]); return a; },      // 竖排 2~3
        () => [[0,0],[0,1],[1,0],[1,1]],                                   // 2x2 方块
        () => { const n=2+Math.floor(rng()*2); const d=rng()<0.5?1:-1; const a=[]; for(let k=0;k<n;k++) a.push([k,k*d]); return a; }, // 斜排
      ];
      // ===== 围栏内的炮位（随机）=====
      // 围栏矩形是天然的营地，里面随机摆 1~2 座灰炮台（可有可无）
      const rect = e._fenceRects && e._fenceRects[s];
      if(rect && rect.x2 > rect.x1 + 2 && rng() < 0.75){
        const n = 1 + Math.floor(rng()*3);   // 围栏内 1~3 座
        for(let k=0; k<n; k++){
          for(let tries=0; tries<16; tries++){
            const row = 1 + Math.floor(rng()*(ROWS-2));
            const gx = rect.x1 + 1 + Math.floor(rng()*Math.max(1, rect.x2 - rect.x1 - 1));
            if(!free(row, gx)) continue;
            const before = getTile(blk, row, gx);
            const nSpr = ((e.structSprites && e.structSprites[s]) || []).length;
            const thinB = thinRunCount(blk, level, [row]);
            putCannon(row, gx);
            if(!screenExitOk(e, level, s) || thinRunCount(blk, level, [row]) > thinB){
              setTile(blk, row, gx, before);
              if(e.structSprites && e.structSprites[s]) e.structSprites[s].length = nSpr;
              cannonPlaced--;
              continue;
            }
            break;
          }
        }
      }
      for(let g=0; g<groups; g++){
        const offs = loneOnly ? [[0,0]] : patterns[Math.floor(rng()*patterns.length)]();
        const crescent = crescentTileFor(level);             // L1=月湾43 / L5=月湾17；其余关无
        const withCrescent = !!crescent && rng() < 0.5;      // 约一半概率在炮台正下方接月湾
        let placed = false;
        for(let tries=0; tries<14 && !placed; tries++){
          const row0 = Math.floor(rng()*ROWS);
          const gx0 = 1 + Math.floor(rng()*(COLS-2));
          // 整组都要放得下（接月湾时下方一行也要空）
          let ok = true;
          for(const [dr,dc] of offs){
            const r = row0+dr, c = gx0+dc;
            if(!free(r, c)){ ok = false; break; }
            if(withCrescent && !freeBlocking(r+1, c)){ ok = false; break; }
          }
          if(!ok) continue;
          // 先快照将被改动的格子：月湾 43 在部分关卡是障碍(L3/L4)，
          // 整组铺完若把本屏上下通路堵死就整组回滚
          const undo = [];
          const nSprBefore = ((e.structSprites && e.structSprites[s]) || []).length;
          const rowsTouched = [];
          for(const [dr,dc] of offs){
            const r = row0+dr, c = gx0+dc;
            undo.push([r, c, getTile(blk, r, c)]);
            if(rowsTouched.indexOf(r) < 0) rowsTouched.push(r);
            if(withCrescent){ undo.push([r+1, c, getTile(blk, r+1, c)]); if(rowsTouched.indexOf(r+1) < 0) rowsTouched.push(r+1); }
          }
          const thinBefore = thinRunCount(blk, level, rowsTouched);
          for(const [dr,dc] of offs){
            const r = row0+dr, c = gx0+dc;
            putCannon(r, c);
            if(withCrescent) setTile(blk, r+1, c, crescent);        // 月湾接在炮台正下方
          }
          if(!screenExitOk(e, level, s) || thinRunCount(blk, level, rowsTouched) > thinBefore){
            for(const [r,c,t] of undo) setTile(blk, r, c, t);
            if(e.structSprites && e.structSprites[s]) e.structSprites[s].length = nSprBefore;
            cannonPlaced -= offs.length;
            continue;
          }
          placed = true;
        }
      }
    }

    // ===== 灰炮台 excess（fill+excess 模型）=====
    // 自然密度已放 cannonPlaced 座（每座都绑定炮台精灵 0x85/0x86）；
    // 用户设的数量超过自然座数时，把多出的撒在随机空地（同样座子图块 + 精灵成对）。
    // 轮转各屏、每屏每轮只补 1 座，均匀分布；跳过近 boss 屏（会被对象槽清场，白放）。
    if(cannonTarget > cannonPlaced){
      let progress = true;
      while(cannonPlaced < cannonTarget && progress){
        progress = false;
        for(let s=1; s<boss-2 && cannonPlaced < cannonTarget; s++){
          const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
          for(let tries=0; tries<6; tries++){
            const row = 1 + Math.floor(rng()*(ROWS-2));
            const gx = 1 + Math.floor(rng()*(COLS-2));
            const freeEx = (r2, g2) => {
              if(r2 < 0 || r2 >= ROWS || g2 < 1 || g2 >= COLS-1) return false;
              if(!groundSet.has(getTile(blk, r2, g2))) return false;
              if(downLaneBlocked(blk, r2, g2)) return false;   // 向下弹道不可被墙挡
              if(prot && prot.has(s + '|' + ((ROWS-1-r2)*COLS+g2))) return false;
              for(const [dr,dc] of [[0,0],[-1,0],[1,0],[0,-1],[0,1]]){
                const rr = r2+dr, cc = g2+dc;
                if(rr<0||rr>=ROWS||cc<0||cc>=COLS) continue;
                const kk = s + '|' + ((ROWS-1-rr)*COLS+cc);
                if(prot && prot.has(kk)) return false;
                if(e._aptCells && e._aptCells.has(kk)) return false;
              }
              if(fenceAt.has(s + '|' + r2 + '|' + g2)) return false;
              return true;
            };
            if(!freeEx(row, gx)) continue;
            const before = getTile(blk, row, gx);
            const nSpr = ((e.structSprites && e.structSprites[s]) || []).length;
            const thinB = thinRunCount(blk, level, [row]);
            setTile(blk, row, gx, tile);
            (e.structSprites = e.structSprites || {})[s] = e.structSprites[s] || [];
            e.structSprites[s].push([32*(ROWS-1-row) + 2, gxToX(gx) + 4, rng()<0.75 ? 0x05 : 0x06]);
            cannonPlaced++;
            if(!screenExitOk(e, level, s) || thinRunCount(blk, level, [row]) > thinB){
              setTile(blk, row, gx, before);
              if(e.structSprites && e.structSprites[s]) e.structSprites[s].length = nSpr;
              cannonPlaced--;
              continue;
            }
            progress = true;
            break;
          }
        }
      }
    }
    e._cannonCount = cannonPlaced;
  }

  // ===== 只生成精灵（不重生成地图）：补全加载地图上的图块绑定精灵 =====
  // 门/POW房/闪人房/机场/汽艇/灰炮台等精灵在图上有固定锚点。加载一张地图后
  // 只点"随机精灵"时地图不动，这些锚点必须先填充满（先填充满，剩余的随机分配
  // 由 placeRoomsAndStars 按 counts 撒到空位），否则地图只剩空壳、炮台哑火。
  // 锚点规则全部对照原版 ROM 实测：炮台座图块↔精灵 100% 配对、门精灵挂门右格、
  // POW房空白列=主地面、L2 白块拱门(62/63/66/67)只出现在 boss 屏(跳过)、
  // L6 机场按中心 2×2(97-98-101-102)识别。
  function fillBoundSprites(e, level, rng){
    let boss = e.idx.length-1;
    for(let s=e.spawns.length-1; s>=0; s--){ const l=e.spawns[s]; if(l && l.indexOf(0xF0)>=0){ boss=s; break; } }
    const apt = AIRPORTS[level];
    const ctile = CANNON_TILE[level];
    const cfgP = POW_CFG[level];
    // POW 房只按房结构 2×2 图块识别，不查空白列：空白列可能是地面变体，
    // 也可能是障碍（原版实测 L3 屏6 左房下空白=28 是障碍），查空白会漏房。
    const keepSet = (e._roomSprites = e._roomSprites || new Set());
    const protSet = (e._aptCells = e._aptCells || new Set());
    let powN = 0, flashN = 0, boatN = 0, bridgeN = 0, pillarN = 0;
    const boatSpots = (e._boatSpots = e._boatSpots || []);
    const boatUsed = (e._boatUsed = e._boatUsed || new Set());
    const SS = (e.structSprites = e.structSprites || {});
    const pushS = (s, yy, xx, type, raw) => {
      SS[s] = SS[s] || [];
      // 去重：连续多次"随机精灵"时结构精灵可能已存在（地图不变，锚点相同），
      // 同一锚点只补一次（类型可能随机波动，如闪人房 0x15↔0x19），避免双份
      for(const q of SS[s]) if(q[0] === yy && q[1] === xx) return;
      SS[s].push(raw ? [yy, xx, type, true] : [yy, xx, type]);
    };

    for(let s=0; s<boss; s++){
      const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
      // ① 灰炮台座：图块 ↔ 精灵 100% 配对（L1/L2/L4/L5 图块4、L3 图块11）
      //    L5 要塞墙上的炮台锚点：112/115/109 图块（原版实测 5 座；108 是墙角不放），锚点 +8 照原版
      //    L5 石头 28-31 / 巷道墙基 55/58/63：偶尔（每格 ~35%）直接绑定，规则同 placeBridgeCannons
      if(ctile != null || level === 4){
        for(let row=0; row<ROWS; row++) for(let gx=0; gx<COLS; gx++){
          const t = getTile(blk, row, gx);
          let isBase = ctile != null && t === ctile;
          let anchor = 32*(ROWS-1-row) + 2;
          let type = 0;                                                  // 0 = 灰炮塔(0x05/0x06 随机)
          if(!isBase && level === 4){
            if(t === 0x70 || t === 0x73 || t === 0x6D){
              isBase = true;
              anchor = 32*(ROWS-1-row) + 8;                              // 原版墙炮锚点（灰炮塔）
            } else if(bridgeN < 5 && BRIDGE_BIND_TILES.indexOf(t) >= 0 && rng() < 0.35){
              isBase = true;                                             // 桥头炮塔 0x0C：锚点 y+0 照原版（全关 ≤5，同随机生成）
              anchor = 32*(ROWS-1-row);
              type = 0x0C;
              bridgeN++;
            }
          }
          if(!isBase) continue;
          pushS(s, anchor, gxToX(gx) + 4, type === 0x0C ? 0x0C : (rng() < 0.75 ? 0x05 : 0x06));
        }
      }
      // ①b L2 柱子精灵：按堆型绑 10/1F（照原版锚点，白块拱门屏跳过；全关 ≤20）
      //   72-64 → 放 72 上；72-107 → 放 72 与 107 中间；
      //   72-68(n)-64 → 放 72 或任意 68 上；72-68(n)-107 → 放 72/68 上或 68 与 107 中间
      if(level === 1 && !(e._whiteCells && e._whiteCells.has(s + '|0')) && pillarN < 20){
        for(let row=0; row<ROWS && pillarN < 20; row++) for(let gx=0; gx<COLS && pillarN < 20; gx++){
          const t = getTile(blk, row, gx);
          if(t !== 0x48) continue;                      // 只从柱座 72 起算
          if(rng() >= 0.7) continue;
          const above = row > 0 ? getTile(blk, row-1, gx) : -1;
          let yy = null;
          if(above === 0x40) yy = 32*(ROWS-1-row) + 16;                                 // 72-64：放 72 上(中)
          else if(above === 0x6B) yy = 32*(ROWS-1-row);                                  // 72-107：72 顶边(=中间)
          else if(above === 0x44){
            let k = 0;
            while(row-1-k >= 0 && getTile(blk, row-1-k, gx) === 0x44) k++;
            const top = row-1-k >= 0 ? getTile(blk, row-1-k, gx) : -1;
            const pick68 = () => 32*(ROWS-1-(row - (1 + Math.floor(rng()*k)))) + 16;    // 任意 68 上
            if(top === 0x40){
              yy = (rng() < 0.5) ? 32*(ROWS-1-row) + 16 : pick68();                     // 72 或 68 上
            } else if(top === 0x6B){
              if(rng() < 0.5) yy = (rng() < 0.5) ? 32*(ROWS-1-row) + 16 : pick68();     // 72 或 68 上
              else yy = 32*(ROWS-1-(row-k));                                            // 68 顶边(=与 107 之间)
            }
          }
          if(yy == null) continue;
          pushS(s, yy, gxToX(gx) + 4, rng()<0.5 ? 0x10 : 0x1F);   // 带 0x80 → 0x90/0x9F；+4=半格居中（原版实测）
          pillarN++;
        }
      }
      // ② 门：5-6 门精灵挂 06 格；L5 类型2 的 56-57 门挂 57 格
      for(let row=0; row<ROWS; row++) for(let gx=0; gx+1<COLS; gx++){
        const tL = getTile(blk, row, gx), tR = getTile(blk, row, gx+1);
        if(tL === 0x05 && tR === 0x06) pushS(s, 32*(ROWS-1-row), gxToX(gx+1), 0x1B);
        else if(level === 4 && tL === 0x38 && tR === 0x39) pushS(s, 32*(ROWS-1-row), gxToX(gx+1), 0x1B);
      }
      // ③ POW 房（2×3：空白列=主地面 + 房结构 2×2）
      if(cfgP){
        if(cfgP.right){
          for(let row=0; row+1<ROWS; row++) for(let gx=0; gx+2<COLS; gx++){
            let ok = true;
            for(let dr=0; dr<2 && ok; dr++) for(let dc=0; dc<2; dc++)
              if(getTile(blk,row+dr,gx+1+dc) !== cfgP.right[dr][dc]) { ok = false; break; }
            if(!ok) continue;
            const py = Math.max(0, 32*(ROWS-1-row) - 12), px = gxToX(gx+2);
            pushS(s, py, px, 0x14);
            keepSet.add(s + '|' + py + '|' + px); powN++;
            for(let dr=0; dr<2; dr++) for(let dc=0; dc<3; dc++)
              protSet.add(s + '|' + ((ROWS-1-(row+dr))*COLS + (gx+dc)));
          }
        }
        if(cfgP.left){
          for(let row=0; row+1<ROWS; row++) for(let gx=0; gx+2<COLS; gx++){
            let ok = true;
            for(let dr=0; dr<2 && ok; dr++) for(let dc=0; dc<2; dc++)
              if(getTile(blk,row+dr,gx+dc) !== cfgP.left[dr][dc]) { ok = false; break; }
            if(!ok) continue;
            const py = Math.max(0, 32*(ROWS-1-row) - 12), px = gxToX(gx+1);
            pushS(s, py, px, 0x13);
            keepSet.add(s + '|' + py + '|' + px); powN++;
            for(let dr=0; dr<2; dr++) for(let dc=0; dc<3; dc++)
              protSet.add(s + '|' + ((ROWS-1-(row+dr))*COLS + (gx+dc)));
          }
        }
        // ④ 闪人房（2×2）：升级房精灵挂右上格 + 固定步兵挂右下格
        if(cfgP.flash){
          for(let row=0; row+1<ROWS; row++) for(let gx=0; gx+1<COLS; gx++){
            let ok = true;
            for(let dr=0; dr<2 && ok; dr++) for(let dc=0; dc<2; dc++)
              if(getTile(blk,row+dr,gx+dc) !== cfgP.flash[dr][dc]) { ok = false; break; }
            if(!ok) continue;
            const fa = FLASH_ANCHOR[level] || [0,8];    // 原版实测锚点偏移
            const powY = Math.max(0, 32*(ROWS-1-row) + fa[0]);
            const powX = Math.max(0, gxToX(gx) + fa[1]);
            const infY = Math.max(0, 32*(ROWS-1-(row+1)) - 4);
            const sprFlash = (level === 4 && rng() < 0.25) ? 0x19 : 0x15;
            pushS(s, powY, powX, sprFlash);
            pushS(s, infY, powX, 0x02, true);
            keepSet.add(s + '|' + powY + '|' + powX);
            keepSet.add(s + '|' + infY + '|' + powX); flashN++;
            for(let dr=0; dr<2; dr++) for(let dc=0; dc<2; dc++)
              protSet.add(s + '|' + ((ROWS-1-(row+dr))*COLS + (gx+dc)));
          }
        }
      }
      // ⑤ 机场：自家飞机 + POW放下点（L6 按中心 2×2 识别，锚点照原版）
      if(apt){
        if(level === 5){
          for(let row=0; row+1<ROWS; row++) for(let gx=0; gx+2<COLS; gx++){
            if(getTile(blk,row,gx) === 0x61 && getTile(blk,row,gx+1) === 0x62 &&
               getTile(blk,row+1,gx) === 0x65 && getTile(blk,row+1,gx+1) === 0x66){
              pushS(s, rowToY(row), gxToX(gx+1), apt.sprite);
              if(apt.sprite3F) pushS(s, rowToY(row), gxToX(gx+2), apt.sprite3F);
            }
          }
        } else {
          for(let y0=0; y0+apt.h<=ROWS; y0++) for(let x0=0; x0+apt.w<=COLS; x0++){
            let ok = true;
            for(let r=0; r<apt.h && ok; r++) for(let c=0; c<apt.w; c++){
              const t = apt.tiles[r][c];
              if(t != null && getTile(blk,y0+r,x0+c) !== t) { ok = false; break; }
            }
            if(!ok) continue;
            const cx = x0 + apt.spritePos[1], cy = y0 + apt.spritePos[0];
            const planeDx = apt.w === 4 ? 4 : 0;
            pushS(s, rowToY(cy), gxToX(cx) + planeDx, apt.sprite);
            if(apt.sprite3F) pushS(s, rowToY(y0 + apt.sprite3FPos[0]), gxToX(x0 + apt.sprite3FPos[1]), apt.sprite3F);
            for(let r=0; r<apt.h; r++) for(let c=0; c<apt.w; c++)
              protSet.add(s + '|' + ((ROWS-1-(y0+r))*COLS + (x0+c)));
          }
        }
      }
      // ⑥ L1 汽艇：河心泊位（桥附近 / 贴岸），数量按桥宽（与 enhanceL1River 同口径）
      if(level === 0){
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
        if(bridgeSegs.length){
          const inRiverBlock = (r, gx) => {
            if(r<0||r>=ROWS||gx<0||gx>=COLS) return false;
            const t = getTile(blk, r, gx);
            const isRiverTile = (t>=0x44 && t<=0x57) || t===0x63 || t===0x64;
            return isRiverTile && !isWalkable(0, t);
          };
          const nearBridge = (r, gx) => bridgeSegs.some(b => Math.abs(b.row - r) <= 2 && gx >= b.X - 2 && gx <= b.Y + 2);
          const spots = [];
          for(let r=1; r<ROWS-1; r++) for(let gx=2; gx<COLS-2; gx++){
            if(getTile(blk, r, gx) !== 0x57) continue;
            if(!inRiverBlock(r, gx-1) || !inRiverBlock(r, gx-2)) continue;
            if(!inRiverBlock(r, gx+1) || !inRiverBlock(r, gx+2)) continue;
            let dGround = 99;
            for(let dx=0; dx<5; dx++){
              if(gx-dx >= 0 && getTile(blk, r, gx-dx) === 0x58){ dGround = dx; break; }
              if(gx+dx < COLS && getTile(blk, r, gx+dx) === 0x58){ dGround = dx; break; }
            }
            if(nearBridge(r, gx) || dGround <= 4) spots.push([r, gx]);
          }
          boatSpots.push(...spots.map(p => [s, p[0], p[1]]));
          const totalBridgeW = bridgeSegs.reduce((a, b) => a + b.w, 0);
          const nBoat = Math.min(spots.length, Math.min(4, Math.max(1, Math.ceil(totalBridgeW / 4))) + 1);
          for(let b=0; b<nBoat; b++){
            const pick = spots.splice(Math.floor(rng()*spots.length), 1)[0];
            boatUsed.add(s + '|' + pick[0] + '|' + pick[1]);
            pushS(s, 32*(ROWS-1-pick[0]) + 4, gxToX(pick[1]) + 4, 0x08, true);
            boatN++;
          }
        }
      }
    }
    e._powRoomCount = powN;
    e._flashRoomCount = flashN;
    e._boatCount = boatN;
  }


  // ===== 对象槽限量（生成最后统一执行）=====
  // 游戏只有 16 个对象槽($0720,X)。超量的后果：
  //   · 普通对象（无 0x80）找不到空槽 → 静默不生成（$F0C9→$F25B 失败即跳过）
  //   · 优先对象（带 0x80，POW房/门/飞机/汽艇等设施）→ 走 $F1EC 强制挤掉已有对象，
  //     兜底 LDX #$00 会无条件挤掉 0 号槽，Boss 正好在里面时就出事
  // 所以：每屏总条目 ≤ 槽数；优先对象另设更小上限；Boss 前若干屏清场留空槽给 Boss。
  // ===== L5 桥头炮塔（0x0C，数量节制，每关 ≤5 座）=====
  // 直接绑定结构图块：石头 28-31(0x1C-0x1F) 与巷道墙基 55/58/63(0x37/0x3A/0x3F)，
  // 偶尔（每格 ~35%）挂桥头炮塔精灵（原版实测 5 座全在墙基 58(0x3A) 上，锚点 y+0）。
  // 桥头炮塔的炮弹(类型7)出生后有 6 帧无视碰撞（tblBullet_ShellInvisibilityFrameCount），
  // 能飞出实心墙图块——所以可以直接挂在实心结构上，这是它与灰炮塔(0x05/0x06)的
  // 关键区别（灰炮塔挂在实心图块上一出生就撞墙哑火，绝不能混用）。
  const BRIDGE_BIND_TILES = [0x1C,0x1D,0x1E,0x1F,0x37,0x3A,0x3F];
  function placeBridgeCannons(e, level, rng){
    if(level !== 4) return;
    let boss = e.idx.length-1;
    for(let s=e.spawns.length-1; s>=0; s--){ const l=e.spawns[s]; if(l && l.indexOf(0xF0)>=0){ boss=s; break; } }
    const prot = e._riverCells, aprot = e._aptCells;
    const fenceAt = new Set();
    if(e._fences) for(const s in e._fences)
      for(const cells of e._fences[s]) for(const c of cells) fenceAt.add(s + '|' + c[0] + '|' + c[1]);
    let placed = 0;
    const MAX = 5;
    // 直接绑结构图块（不放 04 座子，图块不动）：桥头炮塔 0x0C，锚点 y+0 照原版
    const putDirect = (s, blk, row, gx) => {
      if(placed >= MAX) return false;
      if(row < 0 || row >= ROWS || gx < 0 || gx >= COLS) return false;
      const t = getTile(blk, row, gx);
      if(BRIDGE_BIND_TILES.indexOf(t) < 0) return false;
      (e.structSprites = e.structSprites || {})[s] = e.structSprites[s] || [];
      e.structSprites[s].push([32*(ROWS-1-row), gxToX(gx) + 4, 0x0C]);   // 带 0x80 → 0x8C
      placed++;
      return true;
    };
    // 04 座子炮台（围栏带门桥专用：座子只铺在主地面，弹道沿门洞向下）
    const putSeat = (s, blk, row, gx, withCres) => {
      if(placed >= MAX) return false;
      if(row < 0 || row >= ROWS || gx < 0 || gx >= COLS) return false;
      const t = getTile(blk, row, gx);
      if(!(t === 0x2C || t === 0x2D || t === 0x2E)) return false;
      if(downLaneBlocked(blk, row, gx)) return false;      // 向下弹道不可被墙挡（灰炮台哑火）
      if(fenceAt.has(s + '|' + row + '|' + gx)) return false;
      const kk = s + '|' + ((ROWS-1-row)*COLS+gx);
      if(prot && prot.has(kk)) return false;
      if(aprot && aprot.has(kk)) return false;
      const undo = [[row, gx, t]];
      setTile(blk, row, gx, 0x04);
      if(withCres && row+1 < ROWS){
        const t2 = getTile(blk, row+1, gx);
        if((t2 === 0x2C || t2 === 0x2D || t2 === 0x2E) && !fenceAt.has(s + '|' + (row+1) + '|' + gx)){ undo.push([row+1, gx, t2]); setTile(blk, row+1, gx, 0x11); }
      }
      const nSpr = ((e.structSprites && e.structSprites[s]) || []).length;
      (e.structSprites = e.structSprites || {})[s] = e.structSprites[s] || [];
      e.structSprites[s].push([32*(ROWS-1-row) + 2, gxToX(gx) + 4, rng()<0.75 ? 0x05 : 0x06]);
      if(!screenExitOk(e, level, s)){
        for(const [r,c,tt] of undo) setTile(blk, r, c, tt);
        if(e.structSprites && e.structSprites[s]) e.structSprites[s].length = nSpr;
        return false;
      }
      placed++;
      return true;
    };
    for(let s=1; s<boss; s++){
      const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
      // 1) 石头结构 28-31 / 巷道墙基 55/58/63：偶尔（每格 ~35%）直接绑定
      for(let row=0; row<ROWS && placed<MAX; row++){
        for(let gx=0; gx<COLS && placed<MAX; gx++){
          const t = getTile(blk, row, gx);
          if(BRIDGE_BIND_TILES.indexOf(t) < 0) continue;
          if(rng() >= 0.35) continue;
          putDirect(s, blk, row, gx);
        }
      }
      // 2) 围栏带（类型2 门 56-57）屏：~30% 在门洞正上方放 1~2 座（原版屏10 样式）
      let bandRow = -1, gateCol = -1;
      for(let r=0;r<ROWS && bandRow<0;r++) for(let c=0;c+1<COLS;c++){
        if(blk[(ROWS-1-r)*COLS+c]===0x38 && blk[(ROWS-1-r)*COLS+c+1]===0x39){ bandRow=r; gateCol=c; break; }
      }
      if(bandRow >= 0 && rng() < 0.45 && placed < MAX){
        // 只放在门洞(56-57)正上方：子弹沿可通行的门洞打下去，不会被实心面板挡住
        putSeat(s, blk, bandRow-2, gateCol, rng()<0.4);
        if(placed < MAX && rng() < 0.5) putSeat(s, blk, bandRow-2, gateCol+1, rng()<0.4);
      }
    }
  }

  function enforceObjectSlots(e, level){
    let bossScreen = null;
    for(let s=e.spawns.length-1; s>=0; s--){ const l=e.spawns[s]; if(l && l.indexOf(0xF0)>=0){ bossScreen=s; break; } }
    let trimmed = 0, priTrimmed = 0;
    for(let s=0; s<e.spawns.length; s++){
      const list = e.spawns[s];
      if(!list || !list.length) continue;
      const markers = [], objs = [];
      let i = 0;
      while(i < list.length){
        const y = list[i];
        if(y === 0xEF) break;
        if(y === 0xF0 || y === 0xF1 || y === 0xF2){ markers.push([y, list[i+1]]); i += 2; continue; }
        objs.push([y, list[i+1], list[i+2]]); i += 3;
      }
      const isBossScreen = (bossScreen != null) && (s === bossScreen);
      const nearBoss = (bossScreen != null) && (s >= bossScreen - BOSS_APPROACH_SCREENS) && (s <= bossScreen);
      const capTotal = isBossScreen ? BOSS_SCREEN_MAX : (nearBoss ? BOSS_APPROACH_MAX : SAFE_PER_SCREEN);
      const capPri   = isBossScreen ? 0 : (nearBoss ? BOSS_APPROACH_PRIORITY_MAX : SAFE_PRIORITY_PER_SCREEN);
      objs.sort((a,b)=>a[0]-b[0]);
      // ① 先限优先对象（只有它们会挤掉别人）：按 y 顺序保留前 capPri 个
      // 被砍掉的 1B 门精灵要同步把地图上的 5-6 门改成空门(88)，
      // 否则会留下"光图块没精灵"的门（门精灵与 5-6 图块必须成对）
      // 炮台精灵被砍 → 把座子图块还原成空白地面（图块与精灵必须成对）
      const dropCannonTile = (yy, xx) => {
        const ct = CANNON_TILE[level];
        if(ct == null) return;
        const blk = e.layoutBlocks[e.idx[s]]; if(!blk) return;
        const row = (ROWS-1) - Math.round(yy / 32);
        const col = (xx & 0x7F) >> 3;
        if(row < 0 || row >= ROWS || col < 0 || col >= COLS) return;
        if(getTile(blk, row, col) !== ct) return;
        const role = TILE_ROLE[level];
        const g = PRIMARY_GROUND[level] != null ? PRIMARY_GROUND[level] : ((role.ground && role.ground.length) ? role.ground[0] : 0);
        setTile(blk, row, col, g);
        // 座子下方挂的月湾一起还原，别留悬空月湾
        const cres = crescentTileFor(level);
        if(cres && row+1 < ROWS && getTile(blk, row+1, col) === cres) setTile(blk, row+1, col, g);
      };
      const dropGateTiles = (yy, xx) => {
        const blk = e.layoutBlocks[e.idx[s]]; if(!blk) return;
        const row = (ROWS-1) - Math.round(yy / 32);
        const col = (xx & 0x7F) >> 3;                  // 精灵挂在门右格
        if(row < 0 || row >= ROWS || col < 1 || col >= COLS) return;
        const tL = getTile(blk, row, col-1), tR = getTile(blk, row, col);
        // 5-6 门 或 56-57 门（L5 类型2 水平带，精灵挂 57 格）
        const isGate = (tR === 0x06 && tL === 0x05) || (tR === 0x39 && tL === 0x38);
        if(isGate){
          // 用各关主地面（不是 0x58 兜底——L3 的 0x58 是水/障碍，会把门堵死）
          const gf = PRIMARY_GROUND[level] != null ? PRIMARY_GROUND[level]
            : ((FENCE_CFG[level] && FENCE_CFG[level].fill) != null ? FENCE_CFG[level].fill : 0x58);
          setTile(blk, row, col-1, gf);
          setTile(blk, row, col,   gf);
          // 同步围栏记录：这两格已变成空门，记录也要跟着改，否则记录与图不一致
          const rec = e._fences && e._fences[s];
          if(rec) for(const cells of rec) for(const c of cells){
            if(c[0] === row && (c[1] === col || c[1] === col-1)) c[2] = gf;
          }
        }
      };
      let priSeen = 0;
      let kept = [];
      // 飞机/POW上人点(0x3C~0x3F) 是关卡必需设施（用户要求 boss 前 2~5 屏必须有飞机），
      // 它们不参与优先对象裁剪，也不会被总量抽稀掉
      const roomKeep = e._roomSprites;
      const mustKeep = (t, yy, xx) => {
        const t7m = t & 0x7F;
        if(t7m >= 0x3C && t7m <= 0x3F) return true;                                 // 飞机/POW上人点
        if(t7m === 0x1B) return true;                                               // 门精灵：图块 5-6/56-57 与门必须成对
        if(roomKeep && roomKeep.has(s + '|' + yy + '|' + (xx & 0x7F))) return true; // 闪人房的 POW/步兵
        return false;
      };
      // 绑定结构精灵（门/飞机/POW上人点/闪人房 + 炮台 0x05/0x06 也带 0x80）：
      // 图块与精灵必须成对，加载地图补全的炮台不能被随机散落的星星/停放车挤爆
      // 优先额度而裁掉——"先填充满绑定位置"优先于随机分配。
      const boundPri = (t, yy, xx) => mustKeep(t, yy, xx) || (t & 0x7F) === 0x05 || (t & 0x7F) === 0x06 || (t & 0x7F) === 0x0C; // 0x0C=桥头炮塔（绑结构）
      // 第一遍：必需设施（无条件保留，占额度）
      for(const o of objs){ if((o[2] & 0x80) && mustKeep(o[2], o[0], o[1])) priSeen++; }
      // 第二遍：绑定炮台（额度内保留；绑定数本身超过 capPri 时从 y 大的一头砍，
      //   原版极限 11 本身也包含绑定对象，超了就是超原版）
      for(const o of objs){
        if(mustKeep(o[2], o[0], o[1])) continue;
        const t7c = o[2] & 0x7F;
        if((o[2] & 0x80) && (t7c === 0x05 || t7c === 0x06 || t7c === 0x0C)){
          if(priSeen >= capPri){ priTrimmed++; dropCannonTile(o[0], o[1]); continue; }
          priSeen++;
        }
      }
      // 第三遍：其余对象（炮台第二遍已裁决，这里直接保留；随机优先对象占剩余额度）
      for(const o of objs){
        const keepM = mustKeep(o[2], o[0], o[1]);
        if(keepM){ kept.push(o); continue; }
        if((o[2] & 0x80) !== 0){
          const t7d2 = o[2] & 0x7F;
          if(t7d2 === 0x05 || t7d2 === 0x06 || t7d2 === 0x0C){ kept.push(o); continue; }   // 绑定炮台/桥头炮塔：第二遍已保留
          if(priSeen >= capPri){ priTrimmed++; continue; }               // 随机散落的优先对象超额度就裁掉
          priSeen++;
        }
        kept.push(o);
      }
      // ② 再限总量：均匀抽稀（保留纵向分布，避免只砍屏幕上半部分）
      if(kept.length > capTotal){
        // 保留集：先放"必需设施"(飞机/POW上人点)+绑定炮台，再按均匀步长补齐到 capTotal
        const keepSet = new Set();
        for(let k=0;k<kept.length;k++) if(mustKeep(kept[k][2], kept[k][0], kept[k][1]) || boundPri(kept[k][2], kept[k][0], kept[k][1])) keepSet.add(k);
        const step = kept.length / capTotal;
        for(let k=0;k<capTotal && keepSet.size < capTotal; k++){
          let idx = Math.floor(k*step);
          while(idx < kept.length && keepSet.has(idx)) idx++;
          if(idx < kept.length) keepSet.add(idx);
        }
        // 被抽掉的：门/炮台要把对应图块还原，保持成对
        for(let k=0;k<kept.length;k++){
          if(keepSet.has(k)) continue;
          const t7t = kept[k][2] & 0x7F;
          if(t7t === 0x1B) dropGateTiles(kept[k][0], kept[k][1]);
          else if(t7t === 0x05 || t7t === 0x06) dropCannonTile(kept[k][0], kept[k][1]);
        }
        const thin = [];
        for(let k=0;k<kept.length;k++) if(keepSet.has(k)) thin.push(kept[k]);
        trimmed += kept.length - thin.length;
        kept = thin;
      }
      const final = [];
      const all = markers.map(m=>[m[0], m[1], null, true]).concat(kept.map(o=>[o[0], o[1], o[2], false]));
      all.sort((a,b)=>a[0]-b[0]);
      for(const t of all){ if(t[3]) final.push(t[0], t[1]); else final.push(t[0], t[1], t[2]); }
      final.push(0xEF);
      e.spawns[s] = final;
    }
    // ===== 最终配对对账（不管中间哪一步动过图块，收尾一律保证成对）=====
    // 灰炮台：座子(图块) ↔ 精灵 0x85/0x86 必须一一对应
    // 门：5-6 图块 ↔ 精灵 0x1B 必须一一对应
    const ct = CANNON_TILE[level];
    const roleF = TILE_ROLE[level];
    const gFill = (roleF.ground && roleF.ground.length) ? roleF.ground[0] : (roleF.road && roleF.road.length ? roleF.road[0] : 0);
    for(let s=0; s<e.spawns.length; s++){
      const blk = e.layoutBlocks[e.idx[s]];
      const list = e.spawns[s];
      if(!blk || !list) continue;
      // 收集精灵锚点
      const cannonAt = new Set(), gateAt = new Set();
      let i = 0;
      while(i < list.length){
        const y = list[i];
        if(y === 0xEF) break;
        if(y === 0xF0 || y === 0xF1 || y === 0xF2){ i += 2; continue; }
        const yy = list[i], xx = list[i+1] & 0x7F, tt = list[i+2];
        if(tt === 0x85 || tt === 0x86) cannonAt.add(((ROWS-1) - Math.round(yy/32)) + '|' + (xx >> 3));
        if((tt & 0x7F) === 0x1B) gateAt.add(((ROWS-1) - Math.round(yy/32)) + '|' + (xx >> 3));
        i += 3;
      }
      // ① 图块有、精灵没有 → 把图块还原成空地
      for(let row=0; row<ROWS; row++) for(let gx=0; gx<COLS; gx++){
        const t = getTile(blk, row, gx);
        if(ct != null && t === ct && !cannonAt.has(row + '|' + gx)){
          setTile(blk, row, gx, gFill);
          const cres2 = crescentTileFor(level);
          if(cres2 && row+1 < ROWS && getTile(blk, row+1, gx) === cres2) setTile(blk, row+1, gx, gFill);
        }
        if(t === 0x05 && gx+1 < COLS && getTile(blk, row, gx+1) === 0x06 && !gateAt.has(row + '|' + (gx+1))){
          const gf2 = (FENCE_CFG[level] && FENCE_CFG[level].fill) != null ? FENCE_CFG[level].fill : gFill;
          setTile(blk, row, gx, gf2); setTile(blk, row, gx+1, gf2);
        }
        if(t === 0x38 && gx+1 < COLS && getTile(blk, row, gx+1) === 0x39 && !gateAt.has(row + '|' + (gx+1))){
          const gf2 = (FENCE_CFG[level] && FENCE_CFG[level].fill) != null ? FENCE_CFG[level].fill : gFill;
          setTile(blk, row, gx, gf2); setTile(blk, row, gx+1, gf2);
        }
      }
      // ② 精灵有、图块没有 → 删掉这个精灵
      const keep = [];
      i = 0;
      while(i < list.length){
        const y = list[i];
        if(y === 0xEF) break;
        if(y === 0xF0 || y === 0xF1 || y === 0xF2){ keep.push([y, list[i+1], null, true]); i += 2; continue; }
        const yy = list[i], xx = list[i+1], tt = list[i+2];
        const row = (ROWS-1) - Math.round(yy/32), col = (xx & 0x7F) >> 3;
        let drop = false;
        if(tt === 0x85 || tt === 0x86){
          // L5 桥头炮台：锚点可绑墙基 63/58/55 与石块 29/30（图块不动，精灵挂结构上）
          // 合法炮台锚点：04 座子 / 石头 28-31(0x1C-0x1F) / 巷道墙基 55/58/63(0x37/0x3A/0x3F) / 要塞墙 112/115/109
          const l5Anchors = (level === 4 && row >= 0 && row < ROWS && col >= 0 && col < COLS) ?
            (() => { const tl5 = getTile(blk, row, col);
              return tl5 === 0x3F || tl5 === 0x3A || tl5 === 0x37 ||
                     (tl5 >= 0x1C && tl5 <= 0x1F) ||
                     tl5 === 0x70 || tl5 === 0x73 || tl5 === 0x6D; })() : false;
          if((ct == null || row < 0 || row >= ROWS || col < 0 || col >= COLS || getTile(blk, row, col) !== ct) && !l5Anchors) drop = true;
        }
        if((tt & 0x7F) === 0x1B){
          const tL = (row >= 0 && row < ROWS && col >= 1 && col < COLS) ? getTile(blk, row, col-1) : -1;
          const tR = (row >= 0 && row < ROWS && col >= 0 && col < COLS) ? getTile(blk, row, col) : -1;
          // 门精灵挂在门右格：5-6 门 → 06 格；56-57 门（L5 类型2 水平带）→ 57 格
          const okGate = (tR === 0x06 && tL === 0x05) || (tR === 0x39 && tL === 0x38);
          if(!okGate) drop = true;
        }
        // L2 柱子精灵(10/1F/1E)：必须锚在柱块(72/64/68/107)上——后期修路可能凿掉柱块，
        // 锚点不在柱块上的直接撤掉，不留飘空的柱子精灵（用 floor 取含格行，与生成锚点一致）
        if(level === 1 && ((tt & 0x7F) === 0x10 || (tt & 0x7F) === 0x1F || (tt & 0x7F) === 0x1E)){
          const prow = (ROWS-1) - Math.floor(yy/32);
          const pt = (prow >= 0 && prow < ROWS && col >= 0 && col < COLS) ? getTile(blk, prow, col) : -1;
          if(pt !== 0x48 && pt !== 0x40 && pt !== 0x44 && pt !== 0x6B) drop = true;
        }
        // 汽艇 0x08：收尾复核"还在河心吗"——中间几步的开路可能把它旁边凿成空地，
        // 那样汽艇就会开上岸/开上桥，这时直接撤掉这艘船
        if((tt & 0x7F) === 0x08){
          const brow = (ROWS-1) - Math.round((yy - 4) / 32);
          const bcol = (xx & 0x7F) >> 3;
          let okBoat = brow >= 0 && brow < ROWS && bcol >= 2 && bcol < COLS-2 && getTile(blk, brow, bcol) === 0x57;
          if(okBoat) for(let dx=-2; dx<=2; dx++){
            const t2 = getTile(blk, brow, bcol+dx);
            const isR = (t2>=0x44 && t2<=0x57) || t2===0x63 || t2===0x64;
            if(!isR || isWalkable(0, t2)){ okBoat = false; break; }
          }
          if(okBoat) for(let r2=Math.max(0,brow-2); r2<=Math.min(ROWS-1,brow+2); r2++){
            for(let c2=0; c2<COLS; c2++){ const t3 = getTile(blk, r2, c2);
              if(t3 >= 0x2C && t3 <= 0x32){ okBoat = false; break; } }
            if(!okBoat) break;
          }
          if(!okBoat) drop = true;
        }
        if(!drop) keep.push([yy, xx, tt, false]);
        i += 3;
      }
      const out2 = [];
      for(const t of keep){ if(t[3]) out2.push(t[0], t[1]); else out2.push(t[0], t[1], t[2]); }
      out2.push(0xEF);
      e.spawns[s] = out2;
    }
    return { trimmed, priTrimmed };
  }

  function randomizeBoss(edit,level,diff,rng){
    const ids=LEVEL_BOSSES[level]||[];
    const rnd=(a,b)=>a+Math.floor(rng()*(b-a+1));
    const J=(typeof window!=='undefined'&&window.JackalROM)?window.JackalROM:null;
    for(const id of ids){
      const bInfo=J&&J.BOSS_COUNT?J.BOSS_COUNT.find(b=>b.id===id):null;
      if(bInfo&&!bInfo.fixed){ const max=bInfo.max!=null?bInfo.max:128; edit.bossCount[id]=Math.min(max,rnd(diff.count[0],Math.min(diff.count[1],max))); }
      const hpInfo=J&&J.BOSS_HP?J.BOSS_HP.find(b=>b.id===id):null;
      if(hpInfo&&edit.bossHp) edit.bossHp[id]=rnd(diff.hp[0],Math.min(diff.hp[1],127));
      const pos=edit.bossPos&&edit.bossPos[id];
      // 位置随机化必须落在原版合法区间内（0~511 全随机会把 boss 丢到墙里/屏外）
      if(pos){
        const rg = (J && J.BOSS_POS_RANGE) ? J.BOSS_POS_RANGE[id] : null;
        const xr = rg && rg.x ? rg.x : [0, 511];
        const yr = rg && rg.y ? rg.y : [0, 255];
        for(let k=0;k<pos.x.length;k++) pos.x[k] = rnd(xr[0], xr[1]) & 0x1FF;
        if(pos.y) for(let k=0;k<pos.y.length;k++) pos.y[k] = rnd(yr[0], yr[1]) & 0xFF;
      }
    }
  }


  // ===== 收尾：清掉「开火即被墙挡」的灰炮台 =====
  // 灰炮台(0x05/0x06)挂在实心图块上→出生即撞墙哑火；或向下弹道被墙挡→打不出子弹。
  // 前面各放置点已尽量让弹道向下无墙，但炮台铺完之后，房间/散置障碍/森林/连通修复等
  // 后续步骤可能又在它正下方盖上实心图块，使弹道被重新堵死。这里在所有生成结束后
  // 统一复核：凡是灰炮台自身或向下弹道被实心挡住的，连座子/月湾一并移除（boss 战区不动）。
  function cleanupBlockedTurrets(e, level){
    const ctile = CANNON_TILE[level];
    const role = TILE_ROLE[level];
    const ground = PRIMARY_GROUND[level] != null ? PRIMARY_GROUND[level] : ((role.ground && role.ground.length) ? role.ground[0] : 0x35);
    const cres = crescentTileFor(level);
    const war = e._bossWarScreens || [];
    const isTurret = (t) => (t & 0x7F) === 0x05 || (t & 0x7F) === 0x06;
    const anchor = (yy, xx) => [ (ROWS-1) - Math.round(yy/32), (xx & 0x7F) >> 3 ];
    const revertSeat = (blk, row, gx) => {
      if(ctile != null && getTile(blk, row, gx) === ctile) setTile(blk, row, gx, ground);
      if(cres != null && row+1 < ROWS && getTile(blk, row+1, gx) === cres) setTile(blk, row+1, gx, ground);
    };
    for(let s=0; s<e.spawns.length; s++){
      if(war.indexOf(s) >= 0) continue;                 // boss 战区是原版，不动
      const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
      const blockedAt = (yy, xx) => {
        const [row, gx] = anchor(yy, xx);
        if(row<0 || row>=ROWS || gx<0 || gx>=COLS) return false;
        if(downLaneBlocked(blk, row, gx)) return true;
        if(isBulletSolid(getTile(blk, row, gx))) return true;
        return false;
      };
      // ① 玩家实际读到的敌人流 e.spawns[s]：移除「开火即被墙挡」的灰炮台
      const list = e.spawns[s];
      if(list){
        const out = []; let i=0;
        while(i<list.length){
          const y=list[i];
          if(y===0xEF){ out.push(0xEF); break; }
          if(y===0xF0||y===0xF1||y===0xF2){ out.push(y, list[i+1]); i+=2; continue; }
          const ty=list[i+2];
          if(isTurret(ty) && blockedAt(y, list[i+1])){ const [row,gx]=anchor(y,list[i+1]); revertSeat(blk,row,gx); i+=3; continue; }
          out.push(y, list[i+1], ty); i+=3;
        }
        e.spawns[s] = out;
      }
      // ② 结构精灵记账 e.structSprites[s]：保持一致，避免再次「只生成精灵」时复活哑火炮台
      if(e.structSprites && e.structSprites[s]){
        const keep = [];
        for(const o of e.structSprites[s]){
          if(isTurret(o[2]) && blockedAt(o[0], o[1])) continue;
          keep.push(o);
        }
        e.structSprites[s] = keep;
      }
    }
  }

  function cleanupL3LaserSprites(e, level){
    if(level !== 2 || !e.structSprites || !e._l3LaserProtect) return;
    for(const key of Object.keys(e.structSprites)){
      const s = Number(key), prot = e._l3LaserProtect[s];
      if(!prot) continue;
      const blk = e.layoutBlocks[e.idx[s]];
      e.structSprites[s] = (e.structSprites[s] || []).filter((o) => {
        if((o[2] & 0x7F) !== 0x38) return true;
        const row = (ROWS - 1) - Math.round(o[0] / 32);
        const col = (o[1] & 0x7F) >> 3;
        return !!blk && row >= 0 && row < ROWS && col >= prot.x && col < prot.x + prot.width;
      });
    }
  }

  Object.assign(NS, {
    dedupeLayoutBlocks, enforceBudget, scoreNearRoad, scoreRewardSpot, pickBestSpot, placeRoomsAndStars, placeEnemies, thinRunCount, placePowRooms, placeFlashRooms, OCCASIONAL_CFG, crescentTileFor, scatterOccasionalObstacles, CANNON_TILE, placeCannonBases, placeBridgeCannons, fillBoundSprites, enforceObjectSlots, randomizeBoss, cleanupBlockedTurrets, cleanupL3LaserSprites,
  });
})();
