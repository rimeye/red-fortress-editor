/* 连通性与验证：BFS 跨屏可达 / 逐对屏连通 / 通道加宽 / 连通修复 / 关卡验证 */
(function () {
  'use strict';
  const NS = window.JackalGen;
  const {
    COLS, ROWS, EMPTY, TILE_ROLE, GEN_THEME, LEVEL_UNIQUE, COMMON_TYPES, resolveEnemyPool, MAX_SCREENS, maxSpritesForLevel, normalizeCounts, DIFF_LEVELS, DIFF_RANGE, lerp, diffAt, GEN_DIFF, MAX_OBJ_SLOTS, SAFE_PER_SCREEN, SAFE_PRIORITY_PER_SCREEN, BOSS_APPROACH_SCREENS, BOSS_APPROACH_MAX, BOSS_SCREEN_MAX, BOSS_APPROACH_PRIORITY_MAX, PRIMARY_GROUND, STRONG_ENEMIES, FACILITY_IDS, NO_RANDOM_SPAWN, LEVEL_BOSSES, seededRandom, initTemplates, idxAt, getTile, setTile, rowToY, gxToX, roleOf, isWalkable, isStoneTile, STRUCTURES, AIRPORTS, stampStructure, snapshotBossWar, CRESCENT_TILE, screenExitOk,
  } = NS;

  // ===== §5.3 + §5.9 BFS 跨屏可达性验证 =====
  function bfsReachable(e, level, startCol){
    const n = e.idx.length;
    if(!n) return { ok:false, reachedTop:false, reachable:0, totalRoad:0, roadMinWidth:0, blockedScreens:[] };
    let boss = n-1;
    for(let s=e.spawns.length-1; s>=0; s--){ const l=e.spawns[s]; if(l && l.indexOf(0xF0)>=0){ boss=s; break; } }
    const screens = Math.min(boss+1, n);
    const visited = [];
    for(let s=0;s<screens;s++) visited.push(new Uint8Array(128));
    const q = [];
    let totalRoad = 0, reachable = 0;
    const enq = (s,row,gx) => {
      if(s<0||s>=screens||row<0||row>=ROWS||gx<0||gx>=COLS) return false;
      const v = visited[s];
      const k = (ROWS-1-row)*COLS+gx;
      if(v[k]) return false;
      const blk = e.layoutBlocks[e.idx[s]];
      if(!blk) return false;
      if(!isWalkable(level, blk[k])) return false;
      v[k] = 1; reachable++; q.push([s,row,gx]); return true;
    };
    for(let s=0;s<screens;s++){
      const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
      for(let k=0;k<128;k++) if(isWalkable(level, blk[k])) totalRoad++;
    }
    const sc = startCol != null ? startCol : 4;
    for(let dx=-1; dx<=1; dx++){
      enq(0, ROWS-1, Math.max(0,Math.min(COLS-1,sc+dx)));
      enq(0, ROWS-2, Math.max(0,Math.min(COLS-1,sc+dx)));
    }
    let head = 0;
    let reachedTop = false;
    while(head < q.length){
      const [s,row,gx] = q[head++];
      if(s >= boss-1 && row <= 0) reachedTop = true;
      if(row-1 >= 0) enq(s,row-1,gx);
      else if(s+1 < screens) enq(s+1, ROWS-1, gx);   // 屏 s 顶行 → 屏 s+1 底行（前进方向）
      if(row+1 < ROWS) enq(s,row+1,gx);
      else if(s-1 >= 0) enq(s-1, 0, gx);             // 屏 s 底行 → 屏 s-1 顶行（后退方向）
      if(gx+1 < COLS) enq(s,row,gx+1);
      if(gx-1 >= 0) enq(s,row,gx-1);
    }
    // 道路宽度只统计普通屏（不含 boss 战区：战斗竞技场，窄缝是设计使然）
    // 真卡脖判定 = 关键性检查：把窄缝格子全部堵死后，从起点仍 BFS 不到顶 → 该缝是唯一通道；
    // 屏角孤立 1 格地等非关键窄条（堵死照样到顶）不判失败。
    const roadScreens = Math.min(boss, n);
    const reachTopWithWalls = (wallKeys) => {
      const vis = [];
      for(let i=0;i<screens;i++) vis.push(new Uint8Array(128));
      const q2 = [];
      const enq2 = (s2,row2,gx2) => {
        if(s2<0||s2>=screens||row2<0||row2>=ROWS||gx2<0||gx2>=COLS) return false;
        const k=(ROWS-1-row2)*COLS+gx2;
        if(vis[s2][k]) return false;
        if(wallKeys.has(s2+'|'+k)) return false;
        const blk2 = e.layoutBlocks[e.idx[s2]];
        if(!blk2 || !isWalkable(level, blk2[k])) return false;
        vis[s2][k]=1; q2.push([s2,row2,gx2]); return true;
      };
      for(let dx=-1; dx<=1; dx++){
        enq2(0, ROWS-1, Math.max(0,Math.min(COLS-1,sc+dx)));
        enq2(0, ROWS-2, Math.max(0,Math.min(COLS-1,sc+dx)));
      }
      let head2 = 0, top = false;
      while(head2 < q2.length){
        const [s2,row2,gx2] = q2[head2++];
        if(s2 >= boss-1 && row2 <= 0) top = true;
        if(row2-1 >= 0) enq2(s2,row2-1,gx2);
        else if(s2+1 < screens) enq2(s2+1, ROWS-1, gx2);
        if(row2+1 < ROWS) enq2(s2,row2+1,gx2);
        else if(s2-1 >= 0) enq2(s2-1, 0, gx2);
        if(gx2+1 < COLS) enq2(s2,row2,gx2+1);
        if(gx2-1 >= 0) enq2(s2,row2,gx2-1);
      }
      return top;
    };
    let roadMinWidth = 99;
    for(let s=0;s<roadScreens;s++){
      const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
      for(let row=0;row<ROWS;row++){
        let run=0, runStart=0;
        const closeRun = (endGx) => {
          if(run>0){
            if(run<2){
              const wallKeys = new Set();
              for(let gx=runStart; gx<endGx; gx++){
                wallKeys.add(s+'|'+((ROWS-1-row)*COLS+gx));
              }
              if(!reachTopWithWalls(wallKeys)) roadMinWidth=run;
            }
            run=0;
          }
        };
        for(let gx=0;gx<COLS;gx++){
          if(isWalkable(level, getTile(blk,row,gx))){ if(run===0) runStart=gx; run++; }
          else closeRun(gx);
        }
        closeRun(COLS);
      }
    }
    const blockedScreens = [];
    for(let s=0;s<screens;s++){
      const v = visited[s];
      let any=false; for(let k=0;k<128;k++) if(v[k]){any=true;break;}
      if(!any) blockedScreens.push(s);
    }
    return { ok:reachedTop, reachedTop, reachable, totalRoad, roadMinWidth: roadMinWidth===99?0:roadMinWidth, blockedScreens };
  }

  // ===== 围栏格保护集 =====
  // 围栏是完整建筑：门(5-6/56-57/POW门精灵/空地)开在骨架列并上下打通，
  // 连通性修复不得再在围栏上另凿空地（用户规格：只要围栏有门结构就绝对能连通）
  function fenceCellSet(e){
    const set = new Set();
    if(e && e._fences) for(const ss in e._fences)
      for(const cells of e._fences[ss]) for(const c of cells)
        set.add(ss + '|' + ((ROWS-1-c[0])*COLS + c[1]));
    return set;
  }

  // ===== §5.3 逐对屏连通性保证（核心：游戏只能往前走，不能回头）=====
  // 检查屏幕 s 顶行(row 0)与屏幕 s+1 底行(row ROWS-1)是否有重叠可通行列
  function ensurePairConnected(e, level, s, skel, rng){
    const role = TILE_ROLE[level];
    const groundTiles = role.ground && role.ground.length ? role.ground : role.road;
    const pickGround = () => (PRIMARY_GROUND[level] != null ? PRIMARY_GROUND[level] : groundTiles[0]);
    const prot = e._riverCells, aprot = e._aptCells, fprot = fenceCellSet(e);
    const isProt = (sc,row,gx) => { const k = sc + '|' + ((ROWS-1-row)*COLS+gx);
      return !!((prot && prot.has(k)) || (aprot && aprot.has(k)) || (fprot && fprot.has(k))); };
    const bossWarSet = e._bossWarScreens ? new Set(e._bossWarScreens) : new Set();
    // 挖格：受保护的河流格不动（保住完整河流结构）
    const carve = (blk, sc, row, gx) => { if(isProt(sc,row,gx)) return; if(isStoneTile(level, getTile(blk,row,gx))) return; if(bossWarSet.has(sc)) return; setTile(blk, row, gx, pickGround()); };
    // 竖直通道列：优先挑一条完全不碰河流保护格的 2 格宽列
    const pickChannelCol = (sc) => {
      const base = (skel && skel.cols && skel.cols[sc] != null) ? skel.cols[sc] : Math.floor(COLS/2);
      let bestCol = base, bestHits = 1e9;
      for(let off=0; off<COLS-1; off++){
        for(const c of [base+off, base-off]){
          if(c < 0 || c+1 >= COLS) continue;
          let hits = 0;
          for(let row=0; row<ROWS; row++){ if(isProt(sc,row,c)) hits++; if(isProt(sc,row,c+1)) hits++; }
          if(hits < bestHits){ bestHits = hits; bestCol = c; }
          if(hits === 0) return c;
        }
      }
      return bestCol;
    };
    const blkA = e.layoutBlocks[e.idx[s]];
    const blkB = e.layoutBlocks[e.idx[s+1]];
    if(!blkA || !blkB) return;

    // 1. 收集屏 s 顶行(row 0)和屏 s+1 底行(row ROWS-1)的可通行列
    const topCols = new Set();
    const botCols = new Set();
    for(let gx=0; gx<COLS; gx++){
      if(isWalkable(level, getTile(blkA, 0, gx))) topCols.add(gx);
      if(isWalkable(level, getTile(blkB, ROWS-1, gx))) botCols.add(gx);
    }

    // 2. 检查是否有重叠（至少 2 列重叠才能保证 2 格宽通道）
    let overlap = 0;
    for(const gx of topCols){
      if(botCols.has(gx)) overlap++;
    }

    // 3. 如果不重叠或重叠不足 2 列，在道路骨架列附近挖通
    if(overlap < 2){
      const col = pickChannelCol(s);
      for(let dx=0; dx<2; dx++){
        const gx = Math.max(0, Math.min(COLS-1, col + dx));
        // 挖通屏 s 顶行 2 格
        carve(blkA, s, 0, gx);
        carve(blkA, s, 1, gx);
        // 挖通屏 s+1 底行 2 格
        carve(blkB, s+1, ROWS-1, gx);
        carve(blkB, s+1, ROWS-2, gx);
      }
    }

    // 4. 屏内底到顶连通性：BFS 检查屏 s 底行(row ROWS-1)可达顶行(row 0)
    //    如果不可达，在 road skeleton 列挖一条垂直通道
    if(!screenBottomToTopWalkable(e, level, s)){
      const col = pickChannelCol(s);
      for(let row=0; row<ROWS; row++){
        for(let dx=0; dx<2; dx++){
          const gx = Math.max(0, Math.min(COLS-1, col + dx));
          if(!isWalkable(level, getTile(blkA, row, gx))) carve(blkA, s, row, gx);
        }
      }
    }
    // 屏 s+1 同理
    if(!screenBottomToTopWalkable(e, level, s+1)){
      const col = pickChannelCol(s+1);
      for(let row=0; row<ROWS; row++){
        for(let dx=0; dx<2; dx++){
          const gx = Math.max(0, Math.min(COLS-1, col + dx));
          if(!isWalkable(level, getTile(blkB, row, gx))){
            carve(blkB, s+1, row, gx);
          }
        }
      }
    }
  }

  // 把全关 1 格宽通道补宽成 2 格（吉普需要 2 格）；跳过起点屏与 Boss 战区
  function widenOneWideRuns(e, level){
    const role = TILE_ROLE[level];
    const prot = e._riverCells, aprot = e._aptCells, wprot = e._whiteCells, fprot = fenceCellSet(e);
    const isProt = (s,row,gx) => { const k = s + '|' + ((ROWS-1-row)*COLS+gx);
      return !!((prot && prot.has(k)) || (aprot && aprot.has(k)) || (wprot && wprot.has(k)) || (fprot && fprot.has(k))); };
    const groundT = PRIMARY_GROUND[level] != null ? PRIMARY_GROUND[level] : ((role.ground && role.ground.length) ? role.ground[0] : 0);
    const isBoss = [];
    for(let s=e.spawns.length-1; s>=0; s--){ const l=e.spawns[s]; if(l && l.indexOf(0xF0)>=0) isBoss[s]=1; }
    for(let s=1; s<e.idx.length; s++){
      if(isBoss[s]) continue;
      const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
      for(let row=0; row<ROWS; row++){
        let run=0, runStart=0;
        const closeRun = (end) => {
          if(run === 1){
            const gx = runStart;
            // 这 1 格本身就是河流结构（82/76/78 等可走河岸格）→ 不是路，不补宽
            if(isProt(s,row,gx)){ run = 0; return; }
            const cand = [];
            if(gx > 0 && !isWalkable(level, getTile(blk,row,gx-1))) cand.push(gx-1);
            if(gx+1 < COLS && !isWalkable(level, getTile(blk,row,gx+1))) cand.push(gx+1);
            // 受保护的河流格永不补宽（保住完整河流结构；过河点由桥保证）；石块也绝不补宽（保持建筑完整）
            const free = cand.filter(c => !isProt(s,row,c) && !isStoneTile(level, getTile(blk,row,c)));
            let pickGx = -1;
            for(const c of free){ if(roleOf(level, getTile(blk,row,c)) !== 'water'){ pickGx = c; break; } }
            if(pickGx < 0 && free.length) pickGx = free[0];
            // 没有可补的非河流格 → 不补（河流结构完整优先；过河点由桥保证）
            if(pickGx >= 0) setTile(blk,row,pickGx, groundT);
          }
          run = 0;
        };
        for(let gx=0; gx<COLS; gx++){
          if(isWalkable(level, getTile(blk,row,gx))){ if(run===0) runStart=gx; run++; }
          else closeRun(gx);
        }
        closeRun(COLS);
      }
    }
  }

  // 单屏内 BFS：从底行任意可通行格出发，能否到达顶行？
  function screenBottomToTopWalkable(e, level, s){
    const blk = e.layoutBlocks[e.idx[s]];
    if(!blk) return false;
    const visited = new Uint8Array(128);
    const q = [];
    // 从底行所有可通行格入队
    for(let gx=0; gx<COLS; gx++){
      if(isWalkable(level, getTile(blk, ROWS-1, gx))){
        const k = (ROWS-1-ROWS+1)*COLS+gx; // row=ROWS-1 → idx=(ROWS-1-(ROWS-1))*COLS+gx = 0*COLS+gx
        // Actually: idxAt(ROWS-1, gx) = (ROWS-1-(ROWS-1))*COLS+gx = gx
        // Let me just use the k index directly
        const ki = idxAt(ROWS-1, gx);
        visited[ki] = 1;
        q.push([ROWS-1, gx]);
      }
    }
    if(!q.length) return false;
    let head = 0;
    while(head < q.length){
      const [row, gx] = q[head++];
      if(row === 0) return true; // 到达顶行
      const dirs = [[row+1,gx],[row-1,gx],[row,gx+1],[row,gx-1]];
      for(const [nr, ngx] of dirs){
        if(nr<0||nr>=ROWS||ngx<0||ngx>=COLS) continue;
        const k = idxAt(nr, ngx);
        if(visited[k]) continue;
        if(!isWalkable(level, blk[k])) continue;
        visited[k] = 1;
        q.push([nr, ngx]);
      }
    }
    return false;
  }

  // ===== 收尾连通性修复（按真实可达性）=====
  // 前面的 ensurePairConnected 只看"两屏衔接行是否有 2 列同时可走"，
  // 但那些列可能在屏内根本走不到（被水块/岩壁围住），于是仍然断路。
  // 这里直接跑全关 BFS，找到"前进最远处"，在那里按可达列凿一条 2 格宽通道，反复直到通。
  function finalConnectivityRepair(e, level, startCol, rng){
    let boss = e.idx.length-1;
    for(let s=e.spawns.length-1; s>=0; s--){ const l=e.spawns[s]; if(l && l.indexOf(0xF0)>=0){ boss=s; break; } }
    const role = TILE_ROLE[level];
    const groundTiles = role.ground && role.ground.length ? role.ground : role.road;
    const pickGround = () => (PRIMARY_GROUND[level] != null ? PRIMARY_GROUND[level] : groundTiles[0]);
    const sc = startCol != null ? startCol : 4;
    for(let attempt=0; attempt<24; attempt++){
      // 全关 1 格宽 BFS（屏 s 顶行接屏 s+1 底行）
      const screens = boss+1;
      const seen = [];
      for(let i=0;i<screens;i++) seen.push(new Uint8Array(128));
      const q = [];
      const enq = (s,row,gx) => {
        if(s<0||s>=screens||row<0||row>=ROWS||gx<0||gx>=COLS) return;
        const k=(ROWS-1-row)*COLS+gx;
        if(seen[s][k]) return;
        const blk=e.layoutBlocks[e.idx[s]];
        if(!blk || !isWalkable(level, blk[k])) return;
        seen[s][k]=1; q.push([s,row,gx]);
      };
      for(let dx=-2; dx<=2; dx++){ enq(0, ROWS-1, sc+dx); enq(0, ROWS-2, sc+dx); }
      let maxS = 0, best = null;
      for(let i=0;i<q.length;i++){
        const [s,row,gx] = q[i];
        if(s > maxS || (s === maxS && (!best || row < best[1]))){ if(s >= maxS){ maxS = s; best = [s,row,gx]; } }
        enq(s,row-1,gx); if(row===0) enq(s+1,ROWS-1,gx);
        enq(s,row+1,gx); if(row===ROWS-1) enq(s-1,0,gx);
        enq(s,row,gx-1); enq(s,row,gx+1);
      }
      if(maxS >= boss-1) return true;                 // 已经能走到 boss 前一屏
      if(!best) return false;
      // 在最远屏按"可达列"往上凿 2 格宽，并把上一屏底部同列也凿开
      const cAll = [];
      for(let gx=0; gx+1<COLS; gx++){
        if(seen[maxS][(ROWS-1-best[1])*COLS+gx] || seen[maxS][(ROWS-1-best[1])*COLS+gx+1]) cAll.push(gx);
      }
      // 优先挑不碰河流/机场/围栏保护格的列；实在没有再退回中间那列（保通行优先）
      const prot = e._riverCells, aprot = e._aptCells, wprot = e._whiteCells, fprot = fenceCellSet(e);
      const hits = (sIdx, col) => {
        let n = 0;
        for(let row=0; row<ROWS; row++) for(let dx=0; dx<2; dx++){
          const k = sIdx + '|' + ((ROWS-1-row)*COLS + Math.min(COLS-1, col+dx));
          if((prot && prot.has(k)) || (aprot && aprot.has(k)) || (wprot && wprot.has(k)) || (fprot && fprot.has(k))) n++;
        }
        return n;
      };
      let c;
      if(cAll.length){
        let bestC = cAll[0], bestHit = 1e9;
        for(const cc of cAll){
          const h = hits(maxS, cc) + (maxS+1 <= boss ? hits(maxS+1, cc) : 0);
          if(h < bestHit){ bestHit = h; bestC = cc; }
          if(h === 0) break;
        }
        c = bestC;
      } else {
        c = Math.max(0, Math.min(COLS-2, best[2]));
      }
      const blkA = e.layoutBlocks[e.idx[maxS]];
      const blkB = (maxS+1 <= boss) ? e.layoutBlocks[e.idx[maxS+1]] : null;
      // 凿格时跳过围栏保护格：围栏门列已打通，就是通行口，不再凿围栏
      const bossWarSet = e._bossWarScreens ? new Set(e._bossWarScreens) : new Set();
      const notFence = (sIdx, row, gx) => {
        const k = sIdx + '|' + ((ROWS-1-row)*COLS+gx);
        if(fprot && fprot.has(k)) return false;
        if(isStoneTile(level, getTile(e.layoutBlocks[e.idx[sIdx]], row, gx))) return false;
        if(bossWarSet.has(sIdx)) return false;               // boss 战区是原版，绝不凿
        return true;
      };
      if(blkA) for(let row=0; row<=best[1]; row++) for(let dx=0; dx<2; dx++){
        const gx = Math.max(0, Math.min(COLS-1, c+dx));
        if(!notFence(maxS, row, gx)) continue;
        if(!isWalkable(level, getTile(blkA,row,gx))) setTile(blkA, row, gx, pickGround());
      }
      if(blkB) for(let row=ROWS-1; row>=ROWS-3; row--) for(let dx=0; dx<2; dx++){
        const gx = Math.max(0, Math.min(COLS-1, c+dx));
        if(!notFence(maxS+1, row, gx)) continue;
        if(!isWalkable(level, getTile(blkB,row,gx))) setTile(blkB, row, gx, pickGround());
      }
    }
    return false;
  }

  // ===== §5.9 验证通过器 =====
  function validateLevel(e, level, skel, startCol, shrunk){
    const issues = [];
    const cols = skel.cols || skel;
    const n = e.idx.length;
    let boss = n-1;
    for(let s=e.spawns.length-1; s>=0; s--){ const l=e.spawns[s]; if(l && l.indexOf(0xF0)>=0){ boss=s; break; } }

    // (1) BFS 连通性
    const bfs = bfsReachable(e, level, startCol);
    if(!bfs.ok){
      issues.push('BFS不连通：起点→Boss屏不可达（到达'+bfs.reachable+'/'+bfs.totalRoad+'路格）');
    } else if(bfs.totalRoad > 0 && bfs.reachable / bfs.totalRoad < 0.35){
      issues.push('连通率低：仅'+Math.round(bfs.reachable/bfs.totalRoad*100)+'%路格可达起点');
    }

    // (2) 出生点安全区
    const block0 = e.layoutBlocks[e.idx[0]];
    if(block0){
      // jeep 固定在首屏底部中央入口走廊：道路列(startCol)与屏幕中央列都必须全程可行走
      const minGx = Math.max(0, Math.min(startCol-2, 4));
      const maxGx = Math.min(COLS-1, Math.max(startCol+3, 12));
      let safeBad = 0;
      for(let row = 0; row < ROWS; row++){
        for(let gx = minGx; gx <= maxGx; gx++){
          if(!isWalkable(level, getTile(block0,row,gx))) safeBad++;
        }
      }
      if(safeBad > 0) issues.push('出生点安全区有'+safeBad+'格障碍');
      const list0 = e.spawns[0];
      if(list0){
        let bad=0;
        let i=0;
        while(i<list0.length){
          const y=list0[i]; if(y===0xEF)break;
          if(y===0xF0||y===0xF1||y===0xF2){ i+=2; continue; }
          const yy=list0[i], xx=list0[i+1]&0x7F;
          const gxPos = xx >> 3;
          const screenPx = 239 - yy;
          const rowPos = Math.floor(screenPx / 32);
          const inSafe = (rowPos >= ROWS-3) && (gxPos >= minGx) && (gxPos <= maxGx);
          if(inSafe) bad++;
          i+=3;
        }
        if(bad>0) issues.push('出生点安全区有'+bad+'个敌人/设施');
      }
    }

    // (3) 构图评分
    let isolated = 0, obstacleCount = 0, walkableCount = 0, groundFill = 0;
    const screens = Math.min(boss, n);
    for(let s=0;s<screens;s++){
      const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
      for(let row=0;row<ROWS;row++){
        for(let gx=0;gx<COLS;gx++){
          const t = getTile(blk,row,gx);
          const r = roleOf(level,t);
          if(r==='obstacle'){
            obstacleCount++;
            let neigh=0;
            if(row>0 && roleOf(level,getTile(blk,row-1,gx))==='obstacle') neigh++;
            if(row<ROWS-1 && roleOf(level,getTile(blk,row+1,gx))==='obstacle') neigh++;
            if(gx>0 && roleOf(level,getTile(blk,row,gx-1))==='obstacle') neigh++;
            if(gx<COLS-1 && roleOf(level,getTile(blk,row,gx+1))==='obstacle') neigh++;
            if(neigh===0) isolated++;
          } else if(r==='road'||r==='mixed'){
            if(TILE_ROLE[level].ground.indexOf(t) >= 0) groundFill++;
            else walkableCount++;
          }
        }
      }
    }
    const totalTiles = screens * 128 || 1;
    const emptyRatio = walkableCount / totalTiles;
    if(bfs.roadMinWidth > 0 && bfs.roadMinWidth < 2){
      issues.push('道路最窄仅'+bfs.roadMinWidth+'格（<2要求）');
    }
    if(obstacleCount>0 && isolated/obstacleCount > 0.22){
      issues.push('孤立障碍过多：'+isolated+'/'+obstacleCount+'（'+Math.round(isolated/obstacleCount*100)+'%）');
    }
    if(emptyRatio > 0.82 && !shrunk){
      issues.push('空地占比过高：'+Math.round(emptyRatio*100)+'%（>82%）');
    }
    if(((walkableCount + groundFill) / totalTiles) < 0.30 && screens >= 3){
      issues.push('空地占比过低：'+Math.round(emptyRatio*100)+'%（<30%，可能堵路）');
    }

    // (4) 预算检查（与 repack placeGroup 同口径：关卡 bank = idx+layout+def+pal；
    //     spawn 表放独立 spawnBank，不占关卡 bank）
    let budget = 0;
    for(let s=0;s<e.idx.length;s++) budget += 1;
    for(let b=0;b<e.layoutBlocks.length;b++) budget += e.layoutBlocks[b]?e.layoutBlocks[b].length:0;
    budget += e.def.length + e.pal.length;
    if(budget > 0x3FF8) issues.push('数据超预算：'+budget+'字节（上限'+0x3FF8+'）');

    return issues;
  }

  // ===== 严格 2 宽开路（用户：生成/围栏组合堵路 → 用空格开路，哪里堵就开哪里）=====
  // 编辑器 isWalkable 会漏判实心图块（子弹实心 0x12/0x13/0x11 等 + 结构石块/石柱），
  // 导致修复认为路没堵而真机堵住。这里用"严格阻挡模型"逐屏找 2 宽竖道：
  //   底行 → 顶行，若有任意一行连不成 ≥2 格宽的通行带，就把挡路的实心格凿成地面。
  // 受保护格（河流/机场/白块/围栏自身的门 = 通行口）不凿：门已通，绝对保留。
  // 每关"严格实心"图块集（真机会挡住吉普，但编辑器 isWalkable/isBulletSolid 可能漏判）：
  //   围栏桩/栏板/墙/门底(0x12,0x13,0x18,0x1C,0x21,0x22,0x20,0x3B,0x37,0x35,0x36,0x38,0x3C,0x3D,0x3E,0x3F,0x14,0x16,0x17,0x0B)、
  //   结构石块(L5 0x14-0x1F)、石柱(L2 0x48/0x40/0x6B/0x44)。
  // 门格 0x05/0x06 / 门开口 0x39/0x3A / 主地面 / road 仍判可通行。
  const STRICT_SOLID = [
    new Set([0x21,0x22]),                                                       // L0 围栏桩
    new Set([0x48,0x40,0x6B,0x44,0x18,0x1C]),                                 // L1 石柱 + 围栏桩
    new Set([0x3B,0x37,0x35,0x36,0x38,0x3C,0x3D,0x3E,0x3F]),                 // L3 围栏栏板/墙/门底
    new Set([0x20,0x21]),                                                       // L4 围栏桩
    new Set([0x14,0x15,0x16,0x17,0x18,0x19,0x1A,0x1B,0x1C,0x1D,0x1E,0x1F,0x12,0x13,0x3C,0x3D,0x3E]), // L5 石块 + 围栏桩/类型2栏板
    new Set([0x14,0x16,0x18,0x13,0x17,0x0B]),                                 // L6 围栏带
  ];
  const strictBlockedTile = (level, t) => {
    const set = STRICT_SOLID[level];
    if(set && set.has(t)) return true;                                          // 漏判的围栏/结构块
    if(isStoneTile && isStoneTile(level, t)) return true;                       // L5 石块
    if(NS.isBulletSolid && NS.isBulletSolid(t)) return true;                     // 子弹实心（含月湾 0x11 等）
    if(!isWalkable(level, t)) return true;                                       // 编辑器本身判阻挡
    return false;
  };
  function voidOpenRoadStrict(e, level, skel){
    let boss = e.idx.length-1;
    for(let s=e.spawns.length-1; s>=0; s--){ const l=e.spawns[s]; if(l && l.indexOf(0xF0)>=0){ boss=s; break; } }
    const role = TILE_ROLE[level];
    const groundT = PRIMARY_GROUND[level] != null ? PRIMARY_GROUND[level] : ((role.ground && role.ground.length) ? role.ground[0] : (role.road&&role.road[0]));
    const isBoss = {};
    for(let s=e.spawns.length-1; s>=0; s--){ const l=e.spawns[s]; if(l && l.indexOf(0xF0)>=0) isBoss[s]=1; }
    const scOf = (s) => (skel && skel.cols && skel.cols[s] != null) ? skel.cols[s] : Math.floor(COLS/2);
    for(let s=0; s<boss; s++){
      if(isBoss[s]) continue;
      // L3 激光阵是跨屏结构，通路只允许使用阵列生成时标记的弯道空格。
      if(level === 2 && e._l3LaserScreens && e._l3LaserScreens.has(s)) continue;
      const blk = e.layoutBlocks[e.idx[s]]; if(!blk) continue;
      for(let attempt=0; attempt<6; attempt++){
        // 检查：是否存在一条 2 宽竖道（每行都有相邻两格同时非严格阻挡）
        let ok = true;
        for(let row=0; row<ROWS; row++){
          let twoWide = false;
          for(let gx=0; gx+1<COLS; gx++){
            if(!strictBlockedTile(level, getTile(blk,row,gx)) && !strictBlockedTile(level, getTile(blk,row,gx+1))){ twoWide = true; break; }
          }
          if(!twoWide){ ok = false; break; }
        }
        if(ok) break;
        // 不 ok：在骨架列附近凿一条 2 宽竖道（找骨架列附近第一个每行都能 2 宽的列带）
        const sc = scOf(s);
        let done = false;
        for(let off=0; off<=8 && !done; off++){
          for(const sgn of (off===0?[0]:[1,-1])){
            const c = sc + sgn*off;
            if(c < 0 || c+1 >= COLS) continue;
            let feasible = true;
            for(let row=0; row<ROWS; row++){
              const a = getTile(blk,row,c), b = getTile(blk,row,c+1);
              if(strictBlockedTile(level,a) || strictBlockedTile(level,b)){ feasible = false; break; }
            }
            if(feasible){ done = true; break; }
          }
          if(done) break;
        }
        // 没有天然 2 宽列带 → 强行凿（哪里堵就凿哪里）：以骨架列为中心，向左/右扩 2 宽竖道
        let c = Math.max(0, Math.min(COLS-2, sc));
        // 先试 sc..sc+1；若整列全可通行则不用凿，否则凿开该列带的每个实心格
        for(let row=0; row<ROWS; row++){
          for(let dx=0; dx<2; dx++){
            const gx = Math.max(0, Math.min(COLS-1, c+dx));
            if(strictBlockedTile(level, getTile(blk,row,gx))) setTile(blk, row, gx, groundT);
          }
        }
        // 若骨架列带最左列恰好贴屏幕边无法成 2 宽，往右挪；反之往左挪
        if(c === 0) c = Math.max(0, Math.min(COLS-2, sc + 1));
        else if(c === COLS-2) c = Math.max(0, Math.min(COLS-2, sc - 1));
      }
    }
  }

  Object.assign(NS, {
    bfsReachable, ensurePairConnected, widenOneWideRuns, screenBottomToTopWalkable, finalConnectivityRepair, voidOpenRoadStrict, validateLevel,
  });
})();
