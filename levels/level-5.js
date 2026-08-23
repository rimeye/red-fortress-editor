/*
 * L5 · 要塞
 *
 * 本文件只保存该关卡的入口配置。
 * 实际生成算法保留在 gen-terrain.js，避免拆分时改变行为。
 */
(function registerLevelConfig() {
  'use strict';

  window.JackalGen.registerLevel(4, {
    id: 'l5',
    name: '要塞',
    terrain: 'applyStage5',
  });
})();
