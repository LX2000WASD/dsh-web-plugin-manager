# dsh-web-plugin-manager

[![npm version](https://img.shields.io/npm/v/dsh-web-plugin-manager)](https://www.npmjs.com/package/dsh-web-plugin-manager)
[![License](https://img.shields.io/npm/l/dsh-web-plugin-manager)](LICENSE)

在 Web UI 中一键管理 DeepSeek Harness (DSH) 插件：查看、实时启停、安装/卸载、环境管理、插件市场。bundle 与非 bundle 插件全覆盖。

## 安装

```sh
# 方式一（推荐）：从 npm 安装
dsh plugin --profile <name> add dsh-web-plugin-manager

# 方式二：从源码构建
cd /path/to/dsh-web-plugin-manager
pnpm install && pnpm run build
dsh plugin --profile <name> add .
```

重启 profile 后，Web UI 的 **设置** 会出现 **插件管理** 标签页与 **市场** 一级菜单。

## 功能

| 能力 | 说明 |
|---|---|
| 查看 | 四源合并：include 树稳定行（`EntryOptions.id`）+ `dsh.profile.bundles` 层栈 + `package.json` 依赖 + `cordis.patch.yml` insert 行 |
| 实时启停 | 受控编辑 profile 的 `cordis.patch.yml`（managed-block 机制，保留用户内容，可逆可审阅）；**配置 HMR 即时生效，零重启**，重启后持久 |
| 安装 | 调用官方 `dsh plugin` CLI（复用 pnpm reconcile），保护 in-box bundles（base/web-app/headless）；**非 bundle 插件自动写 insert 行并实时挂载**；git 源自动 clone 缓存，**已发布 npm 的包优先走 npm 安装** |
| 卸载 | bundle 走官方 remove；非 bundle（managed insert 行）实时卸载 |
| 质量门 | 安装后扫描入口 import vs 声明依赖（LOADER_PROVIDED 白名单放行平台包），未声明运行时依赖自动回滚，避免实例启动失败 |
| 环境管理 | 设置 → 插件 → 环境：启动/停止（终端或后台）、复制/转移插件、创建/重命名/删除 profile |
| 市场 | 设置一级菜单「市场」：数据源为 [awesome-dsh-plugins](https://github.com/AdamPlatin123/awesome-dsh-plugins) 的 PLUGINS.md（✅/待测 状态列）+ GitHub repo API 补星数/更新时间，24h 缓存；选择安装目标环境后一键安装 |
| agent 工具 | `plugin_status` / `plugin_install` / `plugin_uninstall` / `plugin_toggle`（目标 profile 由配置 `profile` 指定，默认 `web`） |

## 架构

- **Host**：`src/index.ts` —— `PluginManagerService`（`ctx.pluginManager`）+ `/api2/plugin-manager/*` REST 路由（`webServer.register`）
- **Patch 编辑**：`src/patch.ts` —— 标记块（`# dsh-plugin-manager:managed:start/end`）追加/移除，行级操作，原子写入（tmp + rename）；处理 YAML 陷阱（`@` 包名引号、空数组文档 `[]`、纯注释文件恢复模板）
- **稳定行视图**：Loader entry id 每次挂载随机，patch 定位必须用 include 树行 id（`EntryOptions.id`，官方语义稳定）
- **Agent 工具**：`src/tools.ts` —— 依赖注入避免循环依赖；host 提供 tools 服务时注册
- **Client**：`src/client/` —— 注册 `settings.plugins.tab`（all 遮蔽官方只读列表 + manager）+ `settings.section`（marketplace）；同源 fetch 调 REST
- **通信**：官方 webServer 路由 + 同源 fetch（不走 Typert Remote）

## 已知限制

- **禁用被依赖的条目可能导致 profile 启动失败**（官方 fail-loud 设计）；恢复方法：手动编辑该 profile 的 `cordis.patch.yml` 删除 managed 块
- 安装来自 git 的 bundle 需要用户在终端放行 `pnpm allowBuilds`（命令输出会回显）
- 随机行（无显式 id 的挂载行）不可经此启停——它们的 id 每次挂载变化，无法被 patch 定位
- **git 子包安装**：多包仓库用 `#路径:<dir>` 约定指定子目录（`#ref` 是 git ref）
- **质量门可能误伤**：未声明运行时依赖的插件会被拦截回滚（保守策略）；若插件确实由 Loader/host 提供该模块，需在插件 manifest 声明或加入白名单
- 市场条目来源于 awesome 目录，个别仓库可能已删除/私有（安装时报 `Repository not found`）

## 开发

```sh
pnpm run build   # host: tsc（标准装饰器转译）; client: tsdown
```

> 教训记录：host 必须用 **tsc** 构建（tsdown/rolldown 会保留原生装饰器语法，Node 不支持）；插件**不能同时导出 default（类）与 named（apply）**——Loader 会丢弃 apply。

## 相关

- 源码与 Issue：[github.com/LX2000WASD/dsh-web-plugin-manager](https://github.com/LX2000WASD/dsh-web-plugin-manager)
- 市场数据源：[awesome-dsh-plugins](https://github.com/AdamPlatin123/awesome-dsh-plugins)
- 许可证：MIT
