/* ============================================================================
   Jackal (NES) level editor — ROM engine
   Pure functions, no DOM. Works in Node and browser.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JackalROM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PRG_BASE = 16;
  const BANK_SIZE = 0x4000;
  const BANK7_ROM = PRG_BASE + 7 * BANK_SIZE;

  // Level data table addresses (CPU addresses inside their bank, base $8000).
  // Levels are 0-indexed (level 0 = "Level 1").
  const LEVELS = [
    { bank: 4, idx: 0x8008, layout: 0x8015, def: 0x8615, pal: 0x8C75, idxLen: 13, blocks: 12, tiles: 102, palLen: 102 },
    { bank: 4, idx: 0x8CDB, layout: 0x8CE8, def: 0x92E8, pal: 0x9978, idxLen: 13, blocks: 12, tiles: 105, palLen: 122 },
    { bank: 5, idx: 0x8008, layout: 0x8015, def: 0x8615, pal: 0x8DE5, idxLen: 13, blocks: 12, tiles: 125, palLen: 125 },
    { bank: 4, idx: 0x99F2, layout: 0x99FF, def: 0x9FFF, pal: 0xA62F, idxLen: 13, blocks: 12, tiles: 99,  palLen: 116 },
    { bank: 4, idx: 0xA6A3, layout: 0xA6B0, def: 0xACB0, pal: 0xB360, idxLen: 13, blocks: 12, tiles: 107, palLen: 125 },
    { bank: 5, idx: 0x8E62, layout: 0x8E70, def: 0x9570, pal: 0x9DE0, idxLen: 14, blocks: 14, tiles: 135, palLen: 135 },
  ];

  const TILE_OFFSET = [0, 17, 0, 17, 17, 0];

  const LIVES_OFFSET = 0x1CA2A;

  // Fixed-bank table indexed by the spawn object type.  The high bit marks
  // boss-style health entries; the low seven bits are the mutable value.
  const ENEMY_HEALTH_BASE = 0x1FA52;
  const BOSS_HP = [
    { id: 'l1boss',   name: 'Level 1 Boss Tank',          spriteType: 0x0A, offsets: [ENEMY_HEALTH_BASE + 0x0A], defaultValue: 0x8A },
    { id: 'l2boss',   name: 'Level 2 Boss Statue Head',   spriteType: 0x18, offsets: [ENEMY_HEALTH_BASE + 0x18], defaultValue: 0x8F },
    { id: 'l3boss',   name: 'Level 3 Boss Spread Turret', spriteType: 0x25, offsets: [0x195D6, 0x195E6], defaultValue: 0x86 },
    { id: 'l4boss',   name: 'Level 4 Boss Helicopter',    spriteType: 0x40, offsets: [ENEMY_HEALTH_BASE + 0x40], defaultValue: 0xA0 },
    { id: 'l5gate',   name: 'Level 5 Electric Gate',      spriteType: 0x26, offsets: [ENEMY_HEALTH_BASE + 0x26], defaultValue: 0x81 },
    { id: 'l5door',   name: 'Level 5 Boss Door',          spriteType: 0x31, offsets: [ENEMY_HEALTH_BASE + 0x31, 0x1B07C, 0x1B084], defaultValue: 0x83 },
    { id: 'l6turret', name: '第6关 激光炮',               spriteType: 0x47, offsets: [ENEMY_HEALTH_BASE + 0x47], defaultValue: 0x8F },
    { id: 'l6boss',   name: '第6关 基地(Building HQ)',    spriteType: 0x4A, offsets: [ENEMY_HEALTH_BASE + 0x4A], defaultValue: 0xBF },
    { id: 'l6tank',   name: '第6关 大坦克',               spriteType: 0x4B, offsets: [ENEMY_HEALTH_BASE + 0x4B], defaultValue: 0xFF },
    { id: 'l6gun',    name: '第6关 挂载炮',               spriteType: 0x4F, offsets: [ENEMY_HEALTH_BASE + 0x4F], defaultValue: 0xC0 },
  ];

  // Only parameters with a verified runtime read path are listed here.  The
  // generic health table is read by the two object-initialization sites in
  // the fixed bank.  Boss-specific routines remain in BOSS_HP when they do
  // not use this table (for example the L3 spread turret).
  const SPRITE_RUNTIME_PARAMS = {
    health: {
      id: 'health',
      label: '生命值',
      min: 0,
      max: 127,
      kind: 'u7',
      nativeBase: ENEMY_HEALTH_BASE,
      hookSites: [0x1F1D0, 0x1F2C5],
      dataRows: 6,
      dataCols: 128,
    },
  };

  // Boss count (how many boss entities must be destroyed to clear the level).
  // Each entry patches the immediate operand of the "LDA #$XX" that seeds
  // LevelBossEntitiesRemaining. Lives in PRG bank 6 (stable across repack).
  const BOSS_COUNT = [
    { id: 'l1boss', name: '第1关 Boss 坦克', offset: 0x1879B, defaultValue: 4, max: 128, fixed: false },
    { id: 'l2boss', name: '第2关 Boss 雕像头', offset: 0x18FB9, defaultValue: 4, max: 50, fixed: false },
    { id: 'l3boss', name: '第3关 Boss 散弹炮塔', offset: 0x1978B, defaultValue: 6, max: 50, fixed: false },
    { id: 'l4boss', name: '第4关 Boss 直升机', offset: null, defaultValue: 1, fixed: true },
    { id: 'l5door', name: '第5关 Boss 门', offset: 0x1AF0E, defaultValue: 4, max: 50, fixed: false },
    { id: 'l6turret', name: '第6关 激光炮', offset: 0x1B65D, defaultValue: 2, max: 50, fixed: false },
    { id: 'l6tank', name: '第6关 大坦克', offset: null, defaultValue: 1, fixed: true },
  ];

  // Boss 运行时伴随对象。这里不是地图 spawn，也不经过 structSprites。
  // site.offset 指向 LDA #$XX 的立即数，前一个字节必须是 $A9。
  // sites 为空表示该 Boss 流程没有独立、可安全改写的伴随投放点，
  // 不能伪造一个地图对象或把 Boss 主体误当成伴随。
  const BOSS_COMPANION_TYPES = [
    0x00,0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x0E,0x0F,0x12,
    0x23,0x24,0x26,0x29,0x2A,0x2B,0x2C,0x2D,0x2E,0x31,0x32,0x33,0x35,0x39,
    0x42,0x46,0x47,0x4A,0x4B,
  ];
  const BOSS_COMPANIONS = [
    { id:'l1boss',     level:0, name:'第1关 Boss 运行时伴随',       sites:[{ offset:0x18817, opcode:0xA9 }], defaultValue:0x46 },
    { id:'l2boss',     level:1, name:'第2关 Boss 运行时伴随',       sites:[{ offset:0x19064, opcode:0xA9 }], defaultValue:0x07, weaponGate:[{ offset:0x18F54, opcode:0xC9 }, { offset:0x19025, opcode:0xC9 }], defaultWeaponLevel:2 },
    { id:'l3boss',     level:2, name:'第3关 Boss 运行时伴随',       sites:[{ offset:0x1984E, opcode:0xA9 }], defaultValue:0x07, weaponGate:[{ offset:0x1980F, opcode:0xC9 }], defaultWeaponLevel:2 },
    { id:'l4airdrop',  level:3, name:'第4关 Boss 空降伴随',         sites:[{ offset:0x1A8DA, opcode:0xA9 }], defaultValue:0x42 },
    { id:'l4infantry', level:3, name:'第4关 Boss 步兵伴随',         sites:[{ offset:0x1AA54, opcode:0xA9 }], defaultValue:0x01 },
    { id:'l5gate',     level:4, name:'第5关 Boss 电门流程伴随',     sites:[{ offset:0x1AF39, opcode:0xA9 }], defaultValue:0x26 },
    { id:'l5door',     level:4, name:'第5关 Boss 门流程伴随',       sites:[{ offset:0x1AF62, opcode:0xA9 }], defaultValue:0x31 },
    { id:'l5explode',  level:4, name:'第5关 Boss 结束流程伴随',     sites:[{ offset:0x1AF75, opcode:0xA9 }], defaultValue:0x46 },
    { id:'l6final',    level:5, name:'第6关 最终 Boss 红坦克伴随', sites:[{ offset:0x1B7D8, opcode:0xA9 }], defaultValue:0x07 },
  ];
  for (const entry of BOSS_COMPANIONS) {
    entry.types = BOSS_COMPANION_TYPES.slice();
    if (entry.defaultValue != null && !entry.types.includes(entry.defaultValue)) entry.types.push(entry.defaultValue);
  }

  // Boss spawn position defaults (X = horizontal 0-512, Y = vertical 0-255, optional).
  // Entries repeat to 8; values map to LB/UB (X) and V (Y) tables at build time.
    const POS_MAX = 50; // max boss positions (fixed-bank free space limit)
  function uniformPos() {
    const x = [];
    for (let i = 0; i < POS_MAX; i++) x.push(Math.round((i + 0.5) * 512 / POS_MAX) & 0x1FF);
    return x;
  }
  // Boss 出现位置的合法区间（原版表实测值的包络，反汇编取自：
  //   l2boss $900A/$900E、l3boss $97EA/$97F0/$97F6、l5door $AF75/$AF79、l6turret $B6AE/$B6B0）
  // 随机化必须落在这个区间里，否则 boss 会跑到墙里/屏外，看起来就是"位置错乱"。
  const BOSS_POS_RANGE = {
    l2boss:  { x:[188, 308] },
    l3boss:  { x:[112, 296], y:[54, 86] },
    l5door:  { x:[128, 432] },
    l6turret:{ x:[210, 302] },
  };
  const BOSS_POS_DEFAULT = {
    l2boss:  { x: uniformPos(), y: null },
    l3boss:  { x: uniformPos(), y: new Array(POS_MAX).fill(0x50) },
    l5door:  { x: uniformPos(), y: null },
    l6turret: { x: uniformPos(), y: null },
  };

  const PTR = {
    screenLoadIndex: 0x1D004,
    layoutData:      0x1D010,
    def32x32:        0x1D01C,
    palette:         0x1D028,
    layoutBank:      0x1DBFE,
    spawnAddress:    0x1F1F0,
    tileOffset:      0x1CFFE,
  };

  const SPAWN = [0x85F4, 0x8941, 0x9064, 0xA151, 0xAA5C, 0xB128];

  const GFX = {
    commonText: { bank: 2, addr: 0x8008, ppu: 0x0000 },
    commonBG:   { bank: 2, addr: 0x818A, ppu: 0x0260 },
    l1BG: { bank: 3, addr: 0x8BE1, ppu: 0x0730 },
    l2BG: { bank: 3, addr: 0x937C, ppu: 0x0730 },
    l3BG: { bank: 3, addr: 0x9B36, ppu: 0x0260 },
    l4BG: { bank: 3, addr: 0xA590, ppu: 0x0730 },
    l5BG: { bank: 3, addr: 0xAD28, ppu: 0x0730 },
    l6BG: { bank: 3, addr: 0xB4CD, ppu: 0x0260 },
  };
  const LEVEL_BG_BLOCKS = [
    ['commonText', 'commonBG', 'l1BG'],
    ['commonText', 'commonBG', 'l2BG'],
    ['commonText', 'l3BG'],
    ['commonText', 'commonBG', 'l4BG'],
    ['commonText', 'commonBG', 'l5BG'],
    ['commonText', 'l6BG'],
  ];

  // ---- enemy sprite data (for the enemy editor) ----
  const SPRITE_GFX = {
    common: { bank: 2, addr: 0x853D, ppu: 0x1000 },
    l1: { bank: 2, addr: 0x8D6A, ppu: 0x19E0 },
    l2: { bank: 2, addr: 0x923E, ppu: 0x19E0 },
    l3: { bank: 2, addr: 0x9655, ppu: 0x19E0 },
    l4: { bank: 2, addr: 0x9B6C, ppu: 0x19E0 },
    l5: { bank: 2, addr: 0xA069, ppu: 0x19E0 },
    l6: { bank: 2, addr: 0xA53A, ppu: 0x19E0 },
  };
  // sprite constructor tables live in PRG bank 1 (stable across repack)
  const SPRITE_TABLE1 = 0x81F7; // IDs 0x00-0x7F
  const SPRITE_TABLE2 = 0x8B5C; // IDs 0x80-0xFF
  // level default palettes live in the fixed bank (bank 7); 35 bytes each:
  // 2-byte PPU addr + 32 bytes palette (4 BG groups + 4 sprite groups) + $FE terminator
  const LEVEL_PALETTE_BASE = 0x1D63C;

  // Static AI-ID -> sprite-constructor mapping extracted from Bank6/7 disassembly.
  // id: spawn object type (AI table), s: sprite construction id, p: sprite palette group,
  // lvl: 图形所在关卡 CHR（关卡专属图块 >=0x9E 的对象需指定本征关卡，缺省用当前关卡）。
  // s:null 表示该对象无精灵（BG 图块绘制或纯逻辑对象），图标走 BG_ICON / 占位徽章。
  const ENEMY_AI_MAP = {
    0x1: { s: 0x12, p: 1 },          // 步兵
    0x2: { s: 0x12, p: 1 },          // 固定步兵
    0x3: { s: 0x12, p: 3 },          // 火焰兵（StationaryInfantry 交替调色板 3）
    0x4: { s: 0x12, p: 1 },          // 沼泽步兵（沼泽中动态切 0x74）
    0x5: { s: 0x1c, p: 2 },          // 灰炮塔·白弹
    0x6: { s: 0x1c, p: 2 },          // 灰炮塔·黄弹
    0x7: { s: 0x22, p: 1 },          // 红坦克
    0x8: { s: 0x3a, p: 0, lvl: 0 },  // 1关攻击艇
    0x9: { s: null },                // 1关Boss（BG 墙壁）
    0xa: { s: 0x33, p: 1, lvl: 0 },  // 1关Boss坦克
    0xb: { s: 0x44, p: 2, lvl: 0 },  // 银大坦克
    0xc: { s: 0x81, p: 1, lvl: 4 },  // 5关桥头炮塔
    0xd: { s: 0x61, p: 3, lvl: 2 },  // 3关激光充能闪光
    0xe: { s: 0x44, p: 1, lvl: 0 },  // 火焰坦克（与银坦克同构造器，调色板 1）
    0xf: { s: 0xb5, p: 0, lvl: 0 },  // 敌人吉普
    0x10: { s: null },               // 柱子·左倒（BG）
    0x11: { s: 0x54, p: 0, lvl: 2 }, // 步兵卡车（3关）
    0x12: { s: 0xa1, p: 2, lvl: 2 }, // 散弹炮塔（出土）
    0x13: { s: null },               // POW房·右出（BG）
    0x14: { s: null },               // POW房·左出（BG）
    0x15: { s: null },               // POW升级房（BG）
    0x16: { s: 0x2b, p: 0 },         // POW行走（0x2B/0x2C 挥手/行走帧）
    0x17: { s: null },               // 5关Boss（BG）
    0x18: { s: null },               // 2关Boss头像（BG）
    0x19: { s: null },               // POW坦克房（BG）
    0x1a: { s: 0x56, p: 0, lvl: 2 }, // 3关大艇
    0x1b: { s: null },               // 门（BG）
    0x1c: { s: null },               // POW房·4右（BG）
    0x1d: { s: null },               // POW房·4左（BG）
    0x1e: { s: 0x47, p: 0, lvl: 1 }, // 断柱顶（0x47/0x48 左右镜像）
    0x1f: { s: null },               // 柱子·右倒（BG）
    0x20: { s: null },               // 2关Boss（BG 雕像）
    0x21: { s: null },               // 头像·射击（BG）
    0x22: { s: null },               // 头像·待机（BG）
    0x23: { s: 0x46, p: 2, lvl: 4 }, // 5关银坦克
    0x24: { s: 0x24, p: 1 },         // 5关红坦克
    0x25: { s: 0x2d, p: 0 },         // 3关Boss（散弹炮塔群）
    0x26: { s: null },               // 5关电门（BG）
    0x27: { s: 0x25, p: 0 },         // POW上机
    0x28: { s: 0x2b, p: 0 },         // 吉普击毁POW触发（图标=行走POW）
    0x29: { s: 0x5e, p: 0, lvl: 2 }, // 潜艇
    0x2a: { s: 0x67, p: 0, lvl: 3 }, // 散弹卡车·右
    0x2b: { s: 0x67, p: 0, lvl: 3 }, // 散弹卡车·左
    0x2c: { s: 0x69, p: 0, lvl: 3 }, // 导弹发射器（悬崖）
    0x2d: { s: 0x6f, p: 0, lvl: 3 }, // 沉没导弹发射器（图标=升起最高帧 0x6F；待机隐没帧 0x6C 近乎不可见）
    0x2e: { s: 0x9f, p: 0, lvl: 5 }, // 6关导弹发射器（带门）
    0x2f: { s: 0x7c, p: 0, lvl: 3 }, // 落石·左
    0x30: { s: 0x7c, p: 0, lvl: 3 }, // 落石·右
    0x31: { s: null },               // 5关Boss快门门（BG）
    0x32: { s: 0xa5, p: 2, lvl: 3 }, // 火车（图标=火车头；本体为隐形控制器）
    0x33: { s: 0xa8, p: 1, lvl: 3 }, // 火车车厢
    0x34: { s: 0x86, p: 0, lvl: 0 }, // 火焰流（坦克/火焰兵喷出的火焰）
    0x35: { s: 0x73, p: 1, lvl: 3 }, // 地雷（显形时调色板闪烁）
    0x36: { s: 0x10, p: 2 },         // 敌弹（普通圆弹；大黑弹为 0x4A）
    0x37: { s: 0x41, p: 3, lvl: 1 }, // 炸弹（轰炸机/吉普投下）
    0x38: { s: 0x5f, p: 3, lvl: 2 }, // 3关激光（0x5F 长/0x60 短）
    0x39: { s: 0x19, p: 2 },         // 黑白导弹
    0x3a: { s: 0x4e, p: 3, lvl: 1 }, // 攻击机（定点）
    0x3b: { s: 0x4e, p: 3, lvl: 1 }, // 攻击机（任意位置）
    0x3c: { s: 0x31, p: 0 },         // 飞越直升机（0x31/0x32 旋翼帧）
    0x3d: { s: 0x2f, p: 0 },         // 降落直升机·右（0x2F/0x30 旋翼帧）
    0x3e: { s: 0x2f, p: 0 },         // 降落直升机·左
    0x3f: { s: null },               // POW放下点（纯逻辑，无图形）
    0x40: { s: 0x7e, p: 2, lvl: 3 }, // 4关Boss（大直升机）
    0x41: { s: null },               // 4关Boss爆炸（辅助）
    0x42: { s: 0xab, p: 0, lvl: 3 }, // 4关空降兵
    0x43: { s: 0x9b, p: 0, lvl: 5 }, // 6关武直
    0x44: { s: null },               // 电梯（BG 图块动画）
    0x45: { s: null },               // 6关Boss加载（无图形）
    0x46: { s: null },               // 关卡结束检测（无图形）
    0x47: { s: 0xca, p: 0, lvl: 5 }, // 6关激光炮
    0x48: { s: null },               // 激光炮冲击（无图形）
    0x49: { s: null },               // 激光炮图形加载（无图形）
    0x4a: { s: null },               // 6关最终Boss（BG 堡垒）
    0x4b: { s: 0xfc, p: 1, lvl: 5 }, // 最终Boss大坦克（本体 0xD3 仅单图块锚点+BG履带；图标取可见炮塔 0xFC，与 0x4F 同形）
    0x4c: { s: 0xd5, p: 0, lvl: 5 }, // Boss坦克火焰喷射
    0x4d: { s: null },               // 火焰喷射尖端（纯判定）
    0x4e: { s: null },               // 停靠吉普/坦克（BG 图块）
    0x4f: { s: 0xfc, p: 1, lvl: 5 }, // 6关Boss坦克炮塔
    0x50: { s: 0x2e, p: 0 },         // 星星·清屏
    0x51: { s: 0x2e, p: 0 },         // 星星·武器升级
    0x52: { s: 0x2e, p: 0 },         // 星星·1UP
    0x53: { s: null },               // 停靠吉普/坦克·藏星星（BG 图块）
  };

  // BG 图块对象的图标：4x4 个 8x8 图块（32x32px），取自 tblObjectControlledGraphicsUpdate
  // （Bank7 反汇编）。lvl = 该图块数据对应的本征关卡 BG CHR；
  // pal = 原版关卡中该对象覆盖图块实际使用的 BG 调色板组（实测 spawn 处大块 pal 字节）。
  const BG_ICON = {
    0x13: { lvl: 0, pal: 1, tiles: [0x4d,0x4b,0x60,0x63, 0x4e,0x50,0x55,0x64, 0x4f,0x22,0x22,0x22, 0x4b,0x4b,0x56,0x64] }, // POW房·右出
    0x14: { lvl: 0, pal: 1, tiles: [0x63,0x48,0x48,0x53, 0x64,0x51,0x50,0x4e, 0x22,0x52,0x52,0x4f, 0x64,0x48,0x48,0x4a] }, // POW房·左出
    0x15: { lvl: 0, pal: 1, tiles: [0x9d,0x9e,0x9f,0xa0, 0xa1,0xa2,0xa3,0x93, 0x94,0xa2,0xa3,0x94, 0xc0,0xa4,0xa4,0xc0] }, // POW升级房
    0x1b: { lvl: 0, pal: 3, tiles: [0x22,0x22,0x22,0x22, 0x24,0x22,0x22,0x25, 0x24,0x22,0x22,0x25, 0x23,0x23,0x23,0x23] }, // 门
    0x10: { lvl: 1, pal: 1, tiles: [0x22,0x73,0x22,0x74, 0x73,0x75,0x73,0x75, 0x22,0xa2,0xa3,0x22, 0xf1,0x9b,0x9c,0xf2] }, // 柱子（断裂态）
    0x1f: { lvl: 1, pal: 3, tiles: [0x22,0x73,0x22,0x74, 0x73,0x75,0x73,0x75, 0x22,0xa2,0xa3,0x22, 0xf1,0x9b,0x9c,0xf2] }, // 柱子（断裂态）
    0x31: { lvl: 4, pal: 1, tiles: [0x8f,0x8f,0x8f,0x8f, 0x90,0x91,0x91,0x90, 0x90,0x91,0x91,0x90, 0xba,0xbb,0xbb,0xba] }, // 5关Boss快门门（关闭）
  };
  // 1C/1D（4人POW房）复用 2 人房图形
  BG_ICON[0x1c] = BG_ICON[0x13];
  BG_ICON[0x1d] = BG_ICON[0x14];


  // 标题画面字体映射（CHR 在 bank 1 $9B37，tile 0x11-0x2A = A-Z，0x2C = 空格）
  const TITLE_FONT = {
    charToTile(ch) {
      const c = ch.toUpperCase();
      if (c === ' ') return 0x2C;
      if (c >= 'A' && c <= 'Z') return 0x11 + (c.charCodeAt(0) - 65);
      if (c === ',') return 0x0C;
      if (c === '-') return 0x0D;
      if (c === '.') return 0x0E;
      if (c === "'") return 0x0F;
      if (c === '!') return 0x10;
      return 0x2C; // 未知字符 → 空格
    },
    tileToChar(t) {
      if (t === 0x2C || t === 0x2B || t === 0x00) return ' ';
      if (t >= 0x11 && t <= 0x2A) return String.fromCharCode(t - 0x11 + 65);
      if (t === 0x0C) return ',';
      if (t === 0x0D) return '-';
      if (t === 0x0E) return '.';
      if (t === 0x0F) return "'";
      if (t === 0x10) return '!';
      return '?';
    },
  };
  // bank 0 中标题画面 credits（制作人员/署名）文字数据起点
  const TITLE_CREDITS_OFFSET = 0xB387;

  function bankRom(bank, cpuAddr) { return PRG_BASE + bank * BANK_SIZE + (cpuAddr - 0x8000); }
  function read16(rom, off) { return rom[off] | (rom[off + 1] << 8); }
  function write16(rom, off, v) { rom[off] = v & 0xFF; rom[off + 1] = (v >> 8) & 0xFF; }

  function levelTableRom(rom, level, table) { const L = LEVELS[level]; return bankRom(L.bank, L[table]); }
  function levelTableSize(level, table) {
    const L = LEVELS[level];
    if (table === 'idx') return L.idxLen;
    if (table === 'layout') return L.blocks * 128;
    if (table === 'def') return L.tiles * 16;
    if (table === 'pal') return L.palLen;
    return 0;
  }
  function getLevelData(rom, level) {
    const L = LEVELS[level];
    return {
      level,
      idx: Array.from(rom.subarray(levelTableRom(rom, level, 'idx'), levelTableRom(rom, level, 'idx') + L.idxLen)),
      layout: Array.from(rom.subarray(levelTableRom(rom, level, 'layout'), levelTableRom(rom, level, 'layout') + L.blocks * 128)),
      def: Array.from(rom.subarray(levelTableRom(rom, level, 'def'), levelTableRom(rom, level, 'def') + L.tiles * 16)),
      pal: Array.from(rom.subarray(levelTableRom(rom, level, 'pal'), levelTableRom(rom, level, 'pal') + L.palLen)),
    };
  }

  function decodeRLEBlock(rom, gfxName) {
    const g = GFX[gfxName];
    const base = bankRom(g.bank, g.addr);
    const chr = new Uint8Array(0x1000);
    let i = base + 2;
    let pos = g.ppu & 0xFFF;
    while (true) {
      const c = rom[i++];
      if (c === 0xFF) break;
      if (c < 0x80) {
        const count = c; const value = rom[i++];
        for (let k = 0; k < count; k++) { chr[pos & 0xFFF] = value; pos++; }
      } else {
        const count = c & 0x7F;
        for (let k = 0; k < count; k++) { chr[pos & 0xFFF] = rom[i++]; pos++; }
      }
    }
    return chr;
  }
  function buildLevelCHR(rom, level) {
    const chr = new Uint8Array(0x1000);
    for (const name of LEVEL_BG_BLOCKS[level]) {
      const g = GFX[name];
      const blk = decodeRLEBlock(rom, name);
      const ppu = g.ppu & 0xFFF;
      for (let k = ppu; k < 0x1000; k++) chr[k] = blk[k];
    }
    return chr;
  }

  // Konami RLE for sprite pattern tables ($7F = subsection end, $FF = end)
  function decodeSpriteRLE(rom, bank, addr, maxLen) {
    const base = bankRom(bank, addr);
    const out = [];
    let p = base + 2; // skip 2-byte PPU address header
    const end = base + maxLen;
    while (p < end) {
      const b = rom[p++];
      if (b === 0xFF) break;
      if (b === 0x7F) continue;
      if (b & 0x80) {
        const n = b & 0x7F;
        for (let k = 0; k < n && p < end; k++) out.push(rom[p++]);
      } else {
        const v = rom[p++];
        const n = b === 0 ? 256 : b;
        for (let k = 0; k < n; k++) out.push(v);
      }
    }
    return out;
  }
  // 4KB sprite pattern table (256 tiles x 16B) for a level
  function buildSpriteCHR(rom, level) {
    const chr = new Uint8Array(0x1000);
    const common = decodeSpriteRLE(rom, SPRITE_GFX.common.bank, SPRITE_GFX.common.addr, 0x0A00);
    for (let k = 0; k < common.length && k < 0x9E0; k++) chr[k] = common[k];
    const lvl = decodeSpriteRLE(rom, SPRITE_GFX['l' + (level + 1)].bank, SPRITE_GFX['l' + (level + 1)].addr, 0x0900);
    for (let k = 0; k < lvl.length && 0x9E0 + k < 0x1000; k++) chr[0x9E0 + k] = lvl[k];
    return chr;
  }
  // parse all 256 sprite constructors -> { id: { count, parts:[[y,tile,attr,x],...] } }
  function parseSpriteConstructors(rom) {
    const cons = {};
    for (let id = 0; id < 256; id++) {
      const t = id < 0x80 ? SPRITE_TABLE1 : SPRITE_TABLE2;
      const ptr = read16(rom, bankRom(1, t) + (id & 0x7F) * 2);
      const off = bankRom(1, ptr);
      const count = rom[off];
      const parts = [];
      for (let k = 0; k < count; k++) parts.push([rom[off+1+k*4], rom[off+2+k*4], rom[off+3+k*4], rom[off+4+k*4]]);
      cons[id] = { count, parts };
    }
    return cons;
  }
  // 32 bytes: 4 BG groups + 4 sprite groups (each 4 colors)
  function getSpritePalettes(rom) {
    const pals = [];
    for (let l = 0; l < 6; l++) pals.push(Array.from(rom.subarray(LEVEL_PALETTE_BASE + l * 0x23 + 2, LEVEL_PALETTE_BASE + l * 0x23 + 2 + 32)));
    return pals;
  }
  // 2-bit pixel -> sprite palette color (index 0 is transparent).
  // pal32 layout: 4 BG groups (0-15) then 4 sprite groups (16-31).
  function spritePaletteGroup(pal32, group) {
    const g = group & 3;
    return [0x0F, pal32[16 + g * 4 + 1], pal32[16 + g * 4 + 2], pal32[16 + g * 4 + 3]];
  }

  function getLevelPalette(rom, level) {
    const addr = 0x1D63C + level * 0x23;
    return Array.from(rom.subarray(addr + 2, addr + 2 + 16));
  }

  return {
    PRG_BASE, BANK_SIZE, BANK7_ROM, LEVELS, TILE_OFFSET,
    LIVES_OFFSET, ENEMY_HEALTH_BASE, BOSS_HP, BOSS_COUNT, BOSS_COMPANIONS, BOSS_POS_DEFAULT, BOSS_POS_RANGE, POS_MAX, PTR, SPAWN, GFX, LEVEL_BG_BLOCKS,
    SPRITE_RUNTIME_PARAMS,
    bankRom, read16, write16,
    levelTableRom, levelTableSize, getLevelData,
    decodeRLEBlock, buildLevelCHR, getLevelPalette,
    ENEMY_AI_MAP, BG_ICON, buildSpriteCHR, parseSpriteConstructors, getSpritePalettes, spritePaletteGroup,
    TITLE_FONT, TITLE_CREDITS_OFFSET,
    LEVEL_PALETTE_BASE,
  };
});
