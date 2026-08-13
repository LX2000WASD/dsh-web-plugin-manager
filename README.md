# dsh-plugin-manager

在 Web UI 中一键管理 DeepSeek Harness 插件（bundle）：查看、启停、安装、删除。

## 功能（V1）

| 能力 | 说明 |
|---|---|
| 查看 | 三源合并：live Loader entries + `dsh.profile.bundles` 层栈 + `package.json` 依赖 |
| 启停 | 受控编辑 profile 的 `cordis.patch.yml`（managed-block 机制，保留用户内容，可逆可审阅） |
| 安装/删除 | 调用官方 `dsh plugin` CLI（复用 pnpm reconcile），并保护 in-box bundles（base/web-app/headless）不被 reconcile 误删 |
| 多 profile | 扫描 `$DSH_HOME/profiles`，UI 下拉选择 |

## 安装

```sh
cd /path/to/dsh-plugin-manager
pnpm install && pnpm run build
dsh plugin --profile <name> add .
```

重启 profile 后，Web UI 的 **设置 → 插件** 会出现新的 **管理** 标签页（与官方只读"插件列表"并列）。

## 架构

- **Host**：`src/index.ts` —— `PluginManagerService`（`ctx.pluginManager`）+ `/api2/plugin-manager/*` REST 路由（`webServer.register`，经 `ctx.inject` 等待 webServer）
- **Patch 编辑**：`src/patch.ts` —— 文件末尾追加/移除标记块（`# dsh-plugin-manager:managed:start/end`），行级操作，不重写用户内容
- **Client**：`src/client/` —— 注册 `settings.plugins.tab`（id `manager`），同源 fetch 调 REST
- **通信**：不走 Typert Remote（独立插件无法携带生成的 reflection 产物；且 SRC 发现只覆盖 root context 服务）——用官方 webServer 路由 + 同源 fetch

## 已知限制（V1）

- 启停/安装/删除后**需要重启 profile 生效**（Web HMR 被官方禁用）；
- 安装来自 git 的 bundle 需要用户在终端放行 `pnpm allowBuilds`（命令输出会回显）；
- 启停按 Loader 行 id 寻址（`include:` 前缀自动剥离）。

## 构建

```sh
pnpm run build   # host: tsc（标准装饰器转译）; client: tsdown
```

> 教训记录：host 必须用 **tsc** 构建（tsdown/rolldown 会保留原生装饰器语法，Node 不支持；`experimentalDecorators` 旧语义与 Typert 的 ESM 装饰器不兼容）；插件**不能同时导出 default（类）与 named（apply）**——Loader 会丢弃 apply（官方 AGENTS.md 明示）。
