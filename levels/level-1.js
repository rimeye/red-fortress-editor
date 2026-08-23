/*
 * L1 · 丛林
 *
 * 本文件只保存该关卡的入口配置。
 * 实际生成算法保留在 gen-terrain.js，避免拆分时改变行为。
 */
(function registerLevelConfig() {
  'use strict';

  window.JackalGen.registerLevel(0, {
    id: 'l1',
    name: '丛林',
    terrain: 'applyStage1',
  });
})();
