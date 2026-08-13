# dsh-plugin-manager

在 Web UI 中一键管理 DeepSeek Harness 插件（bundle + 非 bundle 插件）：查看、实时启停、安装、删除、agent 工具。

## 功能（V2）

| 能力 | 说明 |
|---|---|
| 查看 | 四源合并：include 树稳定行（`EntryOptions.id`）+ `dsh.profile.bundles` 层栈 + `package.json` 依赖 + `cordis.patch.yml` insert 行 |
| 实时启停 | 受控编辑 profile 的 `cordis.patch.yml`（managed-block 机制，保留用户内容，可逆可审阅）；**配置 HMR 即时生效，零重启**（boot 自动挂载 watch-only HMR，官方 0811 机制），重启后持久 |
| 安装 | 调用官方 `dsh plugin` CLI（复用 pnpm reconcile），保护 in-box bundles（base/web-app/headless）；**非 bundle 插件自动写 insert 行并实时挂载**；安装后按依赖 key 解析真实包名 |
| 卸载 | bundle 走官方 remove；非 bundle（managed insert 行）实时卸载 |
| agent 工具 | `plugin_status` / `plugin_install` / `plugin_uninstall` / `plugin_toggle`（目标 profile 由配置 `profile` 指定，默认 `web`） |
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
- **Patch 编辑**：`src/patch.ts` —— 文件末尾追加/移除标记块（`# dsh-plugin-manager:managed:start/end`），行级操作，不重写用户内容；处理 YAML 陷阱（`@` 包名引号、空数组文档 `[]`、纯注释文件恢复模板、空块清理）
- **稳定行视图**：Loader entry id 每次挂载随机（`Math.random` hex），patch 定位必须用 include 树行 id（`EntryOptions.id`，官方语义稳定）；随机行（无显式 id）不可经 patch 启停，UI 不提供开关
- **Agent 工具**：`src/tools.ts` —— 依赖注入（`PluginToolsHost`）避免循环依赖；`ctx.inject(['tools'])` 在 host 提供 tools 服务时注册（web 有、headless 无则跳过）
- **Client**：`src/client/` —— 注册 `settings.plugins.tab` 两个 tab：`all`（遮蔽官方只读列表：bundle patch 禁用 `ui-settings-plugin-inventory` + 同 id 低 priority 双保险，卸载自动恢复）+ `manager`（安装/卸载）；同源 fetch 调 REST
- **通信**：不走 Typert Remote（独立插件无法携带生成的 reflection 产物；且 SRC 发现只覆盖 root context 服务）——用官方 webServer 路由 + 同源 fetch

## 已知限制

- **禁用被依赖的条目可能导致 profile 启动失败**（官方 fail-loud 设计）；恢复方法：手动编辑该 profile 的 `cordis.patch.yml` 删除 `# dsh-plugin-manager:managed:start/end` 之间的禁用块
- 安装来自 git 的 bundle 需要用户在终端放行 `pnpm allowBuilds`（命令输出会回显）
- 随机行（无显式 id 的挂载行）不可经此启停——它们的 id 每次挂载变化，无法被 patch 定位

## 构建

```sh
pnpm run build   # host: tsc（标准装饰器转译）; client: tsdown
```

> 教训记录：host 必须用 **tsc** 构建（tsdown/rolldown 会保留原生装饰器语法，Node 不支持；`experimentalDecorators` 旧语义与 Typert 的 ESM 装饰器不兼容）；插件**不能同时导出 default（类）与 named（apply）**——Loader 会丢弃 apply（官方 AGENTS.md 明示）。
