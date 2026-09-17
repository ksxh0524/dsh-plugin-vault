/**
 * Commitlint 配置（scope 按包内模块组织，agent 从改动文件路径机械推导）。
 *
 * scope → 路径映射：
 *   store    → src/store.ts（SQLite 引擎：open/close/写串行）
 *   schema   → src/schema.ts（表结构 + 版本门）
 *   registry → src/registry.ts（vault 注册表三级注入）
 *   refs     → src/refs.ts（引用计数 + tombstone）
 *   tests    → tests/**（单测与 fixture）
 *   infra    → 根级（package.json/.husky/README/tsconfig）
 */
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "header-max-length": [2, "always", 100],
    "body-max-line-length": [2, "always", 160],
    "scope-enum": [2, "always", ["store", "schema", "registry", "refs", "tests", "infra"]],
    "scope-case": [2, "always", "lower-case"],
    // 中文 subject 常见，且允许 AI/API/SRC/GUI 等缩写开头：关掉大小写启发式。
    "subject-case": [0],
  },
};
