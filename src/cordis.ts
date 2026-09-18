/** cordis —— dsh-plugin-vault 挂载适配层（§2.1：五工具注册）。
 *
 * 注册面：vault_put_blob / vault_get_blob / vault_db_exec / vault_db_query /
 * vault_ns_info → ctx.tools.register（真源见 ./tools.ts）。
 * 行名与包名对齐（dsh-plugin-vault）；改名必同步 package.json 与 cordis.patch.yml。
 *
 * 双面说明：包根（`.` → src/index.ts）是冻结库面（老调用方 bare import，迁移波再断）；
 * 插件壳走 `./cordis` 子路径（profile patch 行 name: dsh-plugin-vault/cordis），两面互不干扰。
 *
 * 红线：模块顶层零 IO——后端在工具 execute 期现建现用（见 tools.ts backendFor），
 * import 期与 apply 期不碰盘，boot 永不被 DB 拖死。
 */

import { VAULT_TOOL_NAMES, createVaultTools } from "./tools.ts";
import type { HostContext, VaultToolsConfig } from "./tools.ts";

export const name = "dsh-plugin-vault";
export const inject: string[] = ["tools"];

export type CordisConfig = {
  /** 库根目录（profile patch 行 config.vaultDir=<绝对路径>；空 = env DSH_VAULT_DIR > 工作区中性锚，缺席 fail-loud）。 */
  vaultDir?: string;
  /** 后端种别（缺省 local；s3 只有桩，配了即抛 not-implemented + 出路）。 */
  backend?: string;
};

export function apply(ctx: HostContext, config?: CordisConfig) {
  const toolsConfig: VaultToolsConfig = { vaultDir: config?.vaultDir, backend: config?.backend, ctx };
  const tools = createVaultTools(toolsConfig);
  const offs: Array<() => void> = [];
  for (const tool of tools) {
    const off = ctx.tools?.register(tool);
    if (typeof off === "function") offs.push(off as () => void);
  }
  ctx.logger?.info?.(
    `[dsh-plugin-vault] shell on（vaultDir=${config?.vaultDir || "(env DSH_VAULT_DIR/中性锚)"} backend=${config?.backend ?? "local"} tools=${VAULT_TOOL_NAMES.join(",")}）`,
  );
  return {
    unregister: () => {
      for (const off of offs) off();
    },
  };
}

export default { name, inject, apply };
