/** standard.test.ts —— 中立库标准门（dsh-check）：本包无 cordis 服务端入口、无浏览器半，
 *  只跑通用纪律子集——越仓路径 / 跨插件引用（白名单见 ADR-008）/ 双语 README / 工具链。
 *  门逻辑只在 dsh-check 演进，不在包内复制（禁本地双轨）。 */
import { pluginStandardSuite } from "dsh-check";

pluginStandardSuite({ metaUrl: import.meta.url, cordisEntry: null });
