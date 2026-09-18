/** standard.test.ts —— 存储层插件标准门（dsh-check）：真 cordis 入口 src/cordis.ts。
 *  无浏览器半（纯服务端插件，无 lib/client.js、无 dsh.client 声明），故 uiTests: false
 *  显式开脱；clientFile: null 同义注明。门逻辑只在 dsh-check 演进，不在包内复制（禁本地双轨）。 */
import { pluginStandardSuite } from "dsh-check";

pluginStandardSuite({ metaUrl: import.meta.url, cordisEntry: "src/cordis.ts", clientFile: null, uiTests: false });
