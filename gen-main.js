/* 主流程：generateLevel 编排全部分层模块，并暴露公开 API（window.JackalGen） */
(function () {
  'use strict';
  const NS = window.JackalGen;
  const restoreL3LaserArrays = NS.restoreL3LaserArrays;
  const {
    COLS, ROWS, EMPTY, TILE_ROLE, GEN_THEME, LEVEL_UNIQUE, COMMON_TYPES, resolveEnemyPool, MAX_SCREENS, maxSpritesForLevel, normalizeCounts, DIFF_LEVELS, DIFF_RANGE, lerp, diffAt, GEN_DIFF, MAX_OBJ_SLOTS, SAFE_PER_SCREEN, SAFE_PRIORITY_PER_SCREEN, BOSS_APPROACH_SCREENS, BOSS_APPROACH_MAX, BOSS_SCREEN_MAX, BOSS_APPROACH_PRIORITY_MAX, PRIMARY_GROUND, STRONG_ENEMIES, FACILITY_IDS, NO_RANDOM_SPAWN, LEVEL_BOSSES, seededRandom, initTemplates, idxAt, getTile, setTile, rowToY, gxToX, roleOf, isWalkable, STRUCTURES, AIRPORTS, stampStructure, snapshotBossWar, CRESCENT_TILE, screenExitOk, SEGMENT_COUNTS, buildSegments, segType, genSegmentScreen, applySegmentFeature, scatterObstacles, FENCE_CFG, stampL1Fences, applyStage1, applyStage2, stampL3WaterBlock, applyStage3, applyStage4, alleywayScreen, applyStage5, applyStage6, generateMapFromScratch, riverRowSpan, drawRiverRow, planRiverRows, ensureRightSealBridges, makeL1River, planL1River, enhanceL1River, crossFrontierD, levelCrossable2, pushSpawnRaw, enhanceLevelTerrain, airportBlocksCorridor, placeAirport, tryPlaceAirportAt, buildChapters, chapterOf, buildRoadSkeleton, carveSpawnSafeZone, stampForests, reEncloseGrass, dedupeLayoutBlocks, enforceBudget, scoreNearRoad, scoreRewardSpot, pickBestSpot, placeRoomsAndStars, placeEnemies, thinRunCount, placePowRooms, placeFlashRooms, OCCASIONAL_CFG, crescentTileFor, scatterOccasionalObstacles, CANNON_TILE, placeCannonBases, placeBridgeCannons, fillBoundSprites, enforceObjectSlots, randomizeBoss, bfsReachable, ensurePairConnected, widenOneWideRuns, screenBottomToTopWalkable, finalConnectivityRepair, voidOpenRoadStrict, validateLevel, cleanupBlockedTurrets, cleanupL3LaserSprites,
  } = NS;

  function cleanupL3EdgeResidue(e, boss) {
    // For this cleanup only the actual Boss screen is protected; post-Boss
    // screens in the generic boss-war set are ordinary screens for this rule.
    const bossScreens = new Set();
    if (boss != null && boss >= 0) bossScreens.add(boss);
    const bossBlocks = new Set();
    for (const screen of bossScreens) if (screen >= 0 && screen < e.idx.length) bossBlocks.add(e.idx[screen]);
    const pending = [];
    for (let screen = 0; screen < e.idx.length; screen++) {
      if (bossScreens.has(screen)) continue;
      let blockIndex = e.idx[screen];
      let block = e.layoutBlocks[blockIndex];
      if (!block) continue;
      if (bossBlocks.has(blockIndex)) {
        block = block.slice();
        e.layoutBlocks.push(block);
        blockIndex = e.layoutBlocks.length - 1;
        e.idx[screen] = blockIndex;
      }
      for (let row = 0; row < ROWS; row++) {
        for (let gx = 0; gx < COLS; gx++) {
          // User-facing tile 27 is decimal 27 (0x1B), used by the old L3 edge wall.
          const tile = getTile(block, row, gx) & 0x7F;
          if (tile === 0x1B || tile === 0x27) pending.push([block, row, gx]);
        }
      }
    }
    for (const [block, row, edge] of pending) setTile(block, row, edge, 0x07);
  }

  function ensureL3LaserBindings(e) {
    if (!e._l3LaserScreens || !e.structSprites) return;
    // Rebuild from the final tiles and the laser's own second-column anchor.
    // Never infer the anchor from arbitrary 0x50 terrain tiles.
    const anchors = new Map();
    for (const screen of e._l3LaserScreens) {
      const p = e._l3LaserProtect && e._l3LaserProtect[screen];
      const part = p && (p.parts ? p.parts[0] : p);
      if (!part) continue;
      const block = e.layoutBlocks[e.idx[screen]];
      let anchor = -1;
      for (let col = part.x; col < Math.min(COLS, part.x + 4); col++) {
        if ([0, 4].some(row => (getTile(block, row, col) & 0x7F) === 0x50)) { anchor = col; break; }
      }
      if (anchor < 0) continue;
      anchors.set(screen, anchor);
      const list = e.structSprites[screen] || (e.structSprites[screen] = []);
      e.structSprites[screen] = list.filter(o => (o[2] & 0x7F) !== 0x38);
    }
    const screens = Array.from(e._l3LaserScreens).sort((a, b) => a - b);
    for (let i = 0; i < screens.length; i++) {
      const screen = screens[i], col = anchors.get(screen);
      const block = e.layoutBlocks[e.idx[screen]];
      if (!block || col == null) continue;
      const rows = [];
      for (let row = 0; row < ROWS; row++) {
        if ((getTile(block, row, col) & 0x7F) === 0x50) rows.push({ screen, row });
      }
      const next = screens[i + 1];
      if (next === screen + 1 && anchors.get(next) === col) {
        const nextBlock = e.layoutBlocks[e.idx[next]];
        if (nextBlock && (getTile(nextBlock, 0, col) & 0x7F) === 0x50) rows.push({ screen: next, row: 0 });
      }
      for (let j = 0; j + 1 < rows.length; j++) {
        const a = rows[j], b = rows[j + 1];
        if (b.screen === a.screen && b.row - a.row === 4) {
          // Display midpoint between the physical rows 0 and 4 (ROM y=160).
          e.structSprites[a.screen].push([160, gxToX(col) + 4, 0x38, true]);
        } else if (b.screen === a.screen + 1 && a.row === 4 && b.row === 0) {
          // ROM places the cross-screen inter-layer 38 at the next screen's
          // entrance (raw y=40), rather than on the row-1 tile center.
          e.structSprites[b.screen].push([40, gxToX(col) + 4, 0x38, true]);
        }
      }
    }
  }

  function syncL3LaserBindingsToSpawns(e) {
    if (!e._l3LaserScreens || !e.structSprites) return;
    for (const screen of e._l3LaserScreens) {
      const source = e.spawns[screen] || [0xEF];
      const list = [];
      for (let i = 0; i < source.length && source[i] !== 0xEF;) {
        if (i + 2 >= source.length) break;
        if ((source[i + 2] & 0x7F) !== 0x38) list.push(source[i], source[i + 1], source[i + 2]);
        i += 3;
      }
      list.push(0xEF);
      const additions = (e.structSprites[screen] || []).filter(o => (o[2] & 0x7F) === 0x38);
      for (const [yy, xx, type] of additions) {
        let found = false;
        for (let i = 0; i + 2 < list.length && list[i] !== 0xEF; i += 3) {
          if ((list[i + 2] & 0x7F) === 0x38 && list[i] === yy && (list[i + 1] & 0x7F) === (xx & 0x7F)) { found = true; break; }
        }
        if (!found) {
          const at = list.indexOf(0xEF);
          list.splice(at < 0 ? list.length : at, 0, yy, xx, type | 0x80);
        }
      }
      e.spawns[screen] = list;
    }
  }

  // ===== 主流程 =====
  function generateLevel(edit, level, opts){
    opts=opts||{};
    const seed=(opts.seed!=null?opts.seed:(Math.random()*0x7fffffff))>>>0;
    const rng=seededRandom(seed);
    const e=edit.levels[level];
    const cfg=GEN_THEME[level];
    if(!e||!cfg) return { ok:false, issues:['无关卡/主题数据'] };
    if(opts.doMap !== false){ // 只生成精灵(不重生成地图)时保留地图派生状态，否则绑定精灵会丢
      e._fences = null; // 重置围栏记录（每次生成全新）
      e._riverCells = null; // 重置河流保护格
      e._aptCells = null;   // 重置机场保护格
      e._whiteCells = null; // 重置 L2 白块保护格
      e._fenceRects = null; // 重置围栏矩形记录
      e._roomSprites = null; // 重置闪人房必需精灵
    }

    let boss=e.idx.length-1;
    for(let s=e.spawns.length-1;s>=0;s--){ const l=e.spawns[s]; if(l&&l.indexOf(0xF0)>=0){ boss=s; break; } }
    const nScreens=boss;

    let diffKey=opts.difficulty;
    if(!diffKey||diffKey==='auto') diffKey=1+Math.floor(rng()*DIFF_LEVELS);
    const lv=parseInt(diffKey,10);
    const diff=GEN_DIFF[lv]||GEN_DIFF[5];
    const rndInt=(a,b)=>a+Math.floor(rng()*(b-a+1));

    // 0. 清空旧 spawn（只保留 Boss 标记 0xF0/0xF1/0xF2），防止连点累积
    for(let s=0; s<boss; s++){
      const list = e.spawns[s];
      if(!list) continue;
      const cleaned = [];
      let i = 0;
      while(i < list.length){
        const y = list[i];
        if(y === 0xEF) break;
        if(y === 0xF0 || y === 0xF1 || y === 0xF2){
          cleaned.push(y, list[i+1]); i += 2; continue;
        }
        i += 3;
      }
      cleaned.push(0xEF);
      e.spawns[s] = cleaned;
    }
    if(opts.doMap !== false){ e.structSprites = {}; } // 重生成地图才清空；只生成精灵沿用已绑定结构精灵
    // 篇章划分
    // 激光阵保护状态必须随地图重建清空，避免旧种子屏幕被误判为受保护。
    if(opts.doMap !== false){
      e._l3LaserScreens = null;
      e._l3LaserProtect = null;
    }
    const chapters = buildChapters(nScreens, rng);

    // 1. 道路骨架
    const skel = buildRoadSkeleton(nScreens,rng,level);
    const startCol = skel.cols[0];

    // 2. 地图生成 + 关级地形增强
    const l1river = (level===0 && boss>=5) ? planL1River(boss, rng) : null; // L1 斜河流/直河流/桥/汽艇系统
    const bossWar = snapshotBossWar(e, level); // 生成前保存 boss 战区原版块
    e._bossWarScreens = bossWar.screens;            // 供连通/开路/加宽等生成后修复跳过战区
    if(opts.doMap!==false){
      generateMapFromScratch(e, level, nScreens, rng, skel, chapters, l1river, bossWar);
      placeAirport(e, level, boss, rng, skel, l1river); // 每关 1 个飞机场（地形增强后放，避免被覆盖）
    }

    // 2.1 出生点保护
    if(opts.doMap!==false){
      carveSpawnSafeZone(e, level, startCol, rng);
    }

    // 2.2 逐对屏连通性检查 + 修复（L3 激光阵由结构自身设计通路，不开路）
    if(opts.doMap!==false && level!==2){
      for(let s=0; s<boss-1; s++){
        ensurePairConnected(e, level, s, skel, rng);
      }
      widenOneWideRuns(e, level); // 1 格宽通道补宽（跳过起点/Boss）
      // 重铺 L1 围栏（避免被河流/连通修复截断）；河流屏不铺围栏（清除残留）
      if(level === 0 && e._fences){
        const fenceTiles = new Set([0x0A,0x09,0x08,0x0B,0x0F,0x10,0x07,0x21,0x22,0x0C,0x0D,0x05,0x06]);
        for(const s in e._fences){
          const blk = e.layoutBlocks[e.idx[s]];
          if(!blk) continue;
          // 该屏水格（L1 河流带 0x50~0x57 等）数量
          let wc = 0;
          for(let k=0;k<128;k++){
            const t = blk[k];
            if((t>=0x52&&t<=0x57)||t===0x50||t===0x51||t===0x65) wc++;
          }
          if(wc >= 8){
            // 河流屏：把围栏残留清成地面（不重铺），避免围栏被河流截断
            for(const cells of e._fences[s]){
              for(const c of cells){
                if(e._aptCells && e._aptCells.has(s + '|' + ((ROWS-1-c[0])*COLS+c[1]))) continue;
                const idx = (7-c[0])*16+c[1];
                if(fenceTiles.has(blk[idx])) setTile(blk, c[0], c[1], 0x58);
              }
            }
            continue;
          }
          for(const cells of e._fences[s]){
            for(const c of cells){
              // 机场格不重铺围栏：机场是后放的，重铺会把机场建筑凿出一条 33/34 竖线
              if(e._aptCells && e._aptCells.has(s + '|' + ((ROWS-1-c[0])*COLS+c[1]))) continue;
              setTile(blk, c[0], c[1], c[2]);
            }
          }
        }
      }
    }

    // 2.3 灰炮台座：图块 ↔ 精灵 5/6 强绑定（放在连通性修复之后，避免座子被铲掉）
    if(opts.doMap!==false) placeCannonBases(e, level, rng, skel, l1river, normalizeCounts(opts.counts || {}));
    // 2.3b L5 桥头炮台：绑石块(29/30)/墙基(63/58/55)/围栏带门桥，数量节制(≤5)
    if(opts.doMap!==false) placeBridgeCannons(e, level, rng);
    // 2.4 偶尔出现的散置障碍 41/42/43（各关通用，低密度，堵路即回滚）
    if(opts.doMap!==false) scatterOccasionalObstacles(e, level, rng, skel);
    // 2.4b L1 草结构（图块 51-66，不规则团块 + 散点草丛，堵路即回滚，避开 boss 战区）
    if(opts.doMap!==false) stampForests(e, level, rng, skel);
    // 2.5 闪人房（POW 升级房）：约每 3~4 屏 1~2 个，偶尔在围栏里
    if(opts.doMap!==false) placeFlashRooms(e, level, rng, skel, normalizeCounts(opts.counts || {}));
    // 2.6 普通战俘房：固定放在围栏里（88 空地留给吉普吸人）
    if(opts.doMap!==false) placePowRooms(e, level, rng, skel, normalizeCounts(opts.counts || {}));

    // 3. 敌人 / 精灵 / 星星道具 分类生成
    // 生成等级 = 难度等级（越高敌人越强、道具越多）
    const doSprite = opts.doSprite !== false;  // 精灵池主开关（敌人+精灵设施+星星道具）
    const doEnemy  = opts.doEnemy !== undefined ? (opts.doEnemy !== false) : doSprite;
    const doStar   = opts.doStar !== undefined ? (opts.doStar !== false) : doSprite;
    const doBoss   = !!opts.doBoss;            // Boss 默认不随机
    // 兵种池：'level'(本关) | 'all'(全部6关) | 数组(多选关)
    const poolCfg = resolveEnemyPool(level, opts.pool);
    const eCfg = poolCfg ? { ...cfg, enemies: poolCfg } : cfg;
    const parity = opts.parity || { mode:'even' };
    const counts = normalizeCounts(opts.counts || {});
    const enemyTypes = opts.enemyTypes || null;
    // 3.0 只生成精灵（地图不动）时：先把加载地图上的图块绑定精灵补全
    //   （灰炮台座/POW房/闪人房/门/机场/汽艇），绑定位置先填充满，
    //   数量设置里的多余部分再由 placeRoomsAndStars 随机撒到空位。
    if(opts.doMap === false && (doSprite || doStar)){
      fillBoundSprites(e, level, rng);
    }
    if(doEnemy || doSprite){
      placeEnemies(e,level,eCfg,skel,diff,rng,rndInt,startCol,chapters,{doEnemy,doSprite,parity,enemyDensity:opts.enemyDensity||1,enemyPerScreen:opts.enemyPerScreen,enemyTotal:opts.enemyTotal||0,counts,enemyTypes});
    }
    // 4. 房间/星星
    if(doSprite || doStar){
      placeRoomsAndStars(e,level,eCfg,skel,diff,rng,rndInt,chapters,{doSprite,doStar,counts,spriteTotal:opts.spriteTotal||0,enemyTypes});
    }
    // 4.5 最终出生点安全区清理
    if(opts.doMap!==false||doEnemy||doSprite||doStar) carveSpawnSafeZone(e, level, startCol, rng);
    // 4.55 收尾连通性修复；L3 激光阵不执行开路，保留结构原貌。
    if(opts.doMap!==false && level!==2){
      for(let s=0; s<boss-1; s++) ensurePairConnected(e, level, s, skel, rng);
      finalConnectivityRepair(e, level, startCol, rng);   // 按真实可达性兜底开路
      widenOneWideRuns(e, level);
      voidOpenRoadStrict(e, level, skel);                 // 严格 2 宽开路：生成/围栏组合堵路 → 用空格开路
      reEncloseGrass(e, level);   // 连通修复可能凿掉草边缘 → 把露空的全草 53 重新围好
    }
    // 4.6 对象槽限量：游戏只有 16 个对象槽，超量会导致设施强制挤掉对象（Boss 可能被挤掉）
    if(doEnemy||doSprite||doStar) enforceObjectSlots(e, level);
    // 4.65 boss 战区二次恢复：战区是原版，图块与精灵都不许被生成/对象槽对账改动
    if(opts.doMap!==false){
      for(const s of bossWar.screens){
        const blockIdx = e.idx[s];
        if(blockIdx < 0 || blockIdx >= e.layoutBlocks.length) continue;
        const saved = bossWar.blocks.get(blockIdx);
        if(saved) e.layoutBlocks[blockIdx] = saved.slice();
      }
    }
    for(const s of bossWar.screens){
      const savedSp = bossWar.spawns.get(s);
      if(savedSp) e.spawns[s] = savedSp.slice();
    }
    // 5. 随机 Boss（默认不随机，保持原版）
    if(doBoss) randomizeBoss(edit,level,diff,rng);

    // 5.5 去重 layoutBlocks + 预算钳制（L3 激光阵不执行连通性开路）
    //      预算靠「合并 layout 块共用」收敛，**不减屏数**（保留用户设置的屏数）。
    //      合并可能把窄路带进来，故收敛后再跑一遍连通/宽度修复，再复检预算。
    if(opts.doMap!==false){
      dedupeLayoutBlocks(e);
      enforceBudget(e, level, boss, rng);
      if(level!==2){
        for(let s=0; s<boss-1; s++) ensurePairConnected(e, level, s, skel, rng);
        finalConnectivityRepair(e, level, startCol, rng);
        widenOneWideRuns(e, level);
        voidOpenRoadStrict(e, level, skel);
        reEncloseGrass(e, level);
      }
      dedupeLayoutBlocks(e);
      enforceBudget(e, level, boss, rng);
    }
    // 5.7 boss 战区最终恢复：前面 5.5 的 dedupe/修复可能改动战区（合并块/凿路），
    //       这里按"原版块内容"重新落回 boss 战区，确保 boss 战区图块与精灵绝对不被生成改动。
    if(opts.doMap!==false){
      for(const s of bossWar.screens){
        const blockIdx = e.idx[s];
        if(blockIdx < 0 || blockIdx >= e.layoutBlocks.length) continue;
        const saved = bossWar.blocks.get(blockIdx);
        if(saved) e.layoutBlocks[blockIdx] = saved.slice();
      }
      for(const s of bossWar.screens){
        const savedSp = bossWar.spawns.get(s);
        if(savedSp) e.spawns[s] = savedSp.slice();
      }
    }
    // 5.75 出生点最终保护：前面的连通修复/加宽/开路/围栏/去重都可能又盖了墙，
    //      这里在一切图块改动之后最后清一遍, 保证首屏入口走廊永不卡吉普。
    if(opts.doMap!==false) carveSpawnSafeZone(e, level, startCol, rng);
    // L3 彻底移除 0x26/0x27：普通屏、激光阵屏和 Boss 屏都不保留。
    if(opts.doMap!==false && level===2) {
      const seenBlocks = new Set();
      for(let screen=0; screen<e.idx.length; screen++) {
        const blockIndex = e.idx[screen];
        if(seenBlocks.has(blockIndex)) continue;
        seenBlocks.add(blockIndex);
        const block = e.layoutBlocks[blockIndex];
        if(!block) continue;
        for(let row=0; row<ROWS; row++) for(let gx=0; gx<COLS; gx++) {
          const tile = getTile(block, row, gx);
          // 第3关不保留旧结构图块：26/27 以及 53/54/55。
          // Legacy full-map cleanup removed: edge residue is handled below.
        }
      }
    }
    // 5.8 清掉「开火即被墙挡」的灰炮台：炮台铺完后房间/散置障碍/森林/连通修复可能
    //     又在它正下方盖了实心图块，统一复核移除（boss 战区原版不动）。
    if(opts.doMap!==false) {
      if(level === 2 && restoreL3LaserArrays) restoreL3LaserArrays(e);
      cleanupBlockedTurrets(e, level);
      cleanupL3LaserSprites(e, level);
    }
    // Run after every map/content mutation so old airport/template edge residue cannot return.
    if(level === 2) {
      // Terrain repair and deduplication can overwrite a laser tile after the
      // first restore. Re-stamp the protected 4x7 units at the final stage,
      // then derive bindings from those final tiles below.
      if(opts.doMap !== false && restoreL3LaserArrays) restoreL3LaserArrays(e);
      cleanupL3EdgeResidue(e, boss);
    }
    if(level === 2) ensureL3LaserBindings(e);
    if(level === 2) syncL3LaserBindingsToSpawns(e);
    // 6. 最终 BFS 验证（兜底）
    const issues=validateLevel(e,level,skel,startCol);
    return { ok:issues.length===0,difficulty:diff.level,issues,seed,nScreens,chapters:chapters.length };
  }

  Object.assign(NS, { generateLevel });
})();
