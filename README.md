# dsh-web-plugin-manager

[![npm version](https://img.shields.io/npm/v/dsh-web-plugin-manager)](https://www.npmjs.com/package/dsh-web-plugin-manager)
[![License](https://img.shields.io/npm/l/dsh-web-plugin-manager)](LICENSE)

在 Web UI 中一键管理 DeepSeek Harness (DSH) 插件：查看、实时启停、安装/卸载、更新检测、健康检查（依赖/冲突/兼容性分析）、环境管理、插件市场。bundle 与非 bundle 插件全覆盖。

> ⚠️ **强烈建议：先装管理器，再装其他插件**
>
> 本插件管理器自带**质量门与健康检查**（安装时全链依赖扫描 + bundle patch 行校验 + 安装即回滚；安装后可做依赖图/冲突/循环/peer 兼容性分析）。**在安装其他插件之前，先把管理器本身装进 profile**——这样后续每一个插件的安装都会经过检测，能显著减少"装上就炸、重启起不来"的情况。即使某个插件有问题，质量门也会在安装时拦截并回滚，profile 保持可启动。
>
> 若已存在未经验证的插件导致 profile 无法启动：先用 `dsh --profile <name> --patch <empty.yml>` 等方式排查，或手动清理对应依赖/`cordis.patch.yml` 行后，再安装管理器接管。

## 安装

```sh
# 方式一（推荐）：从 npm 安装（务必带 @latest）
dsh plugin --profile <name> add dsh-web-plugin-manager@latest

# 方式二：从源码构建
cd /path/to/dsh-web-plugin-manager
pnpm install && pnpm run build
dsh plugin --profile <name> add .
```

重启 profile 后，Web UI 的 **设置** 会出现 **插件管理** 标签页与 **市场** 一级菜单。

## 更新

```sh
# 命令方式（推荐）：升级到最新版（重写 specifier，质量门 + 失败自动回滚到旧版本）
dshpm update dsh-web-plugin-manager --profile NAME
# 等价命令（pnpm 语义）
dsh plugin --profile NAME add dsh-web-plugin-manager@latest
```

**UI 自更新**：打开 **设置 → 插件管理**，「检查更新」会列出全部已装插件（**含管理器自身**），有新版时点对应卡片上的「更新」即可——管理器可以一键更新自己，失败自动装回上一版本；更新后需重启 profile 生效。

**注意**：

- **add 不带版本号不会升级**：profile 里已声明旧版本（如 `^0.1.2`）时，`dsh plugin add`（即 `pnpm add`）保留原 specifier 不升；`dsh plugin update`（即 `pnpm update`）也只在已声明的范围内重解析。跨版本升级必须用 `add ...@latest` 或 `dshpm update`。
- **@latest 解析到旧版时**：先查 `pnpm config get registry` 是否为镜像源（npmmirror 等 dist-tag 同步滞后 + pnpm 元数据缓存），用 `pnpm add dsh-web-plugin-manager@latest --registry=https://registry.npmjs.org` 强制走官方源；**显式指定版本号（如 `@0.3.8`）永远可靠**。
- **pnpm 11 用户**：pnpm 11 默认 `minimumReleaseAge: 1440`（24 小时）——发布不足 24 小时的版本会被扣住，导致「当天发版当天点更新装不上」或解析到旧版。在 profile 的 `pnpm-workspace.yaml` 中加 `minimumReleaseAge: 0`（或 `minimumReleaseAgeExclude` 白名单）即可；dsh 不会覆盖该文件，改动会保留。

## CLI（dshpm）

用户让 AI 安装插件时，AI 默认会跑裸 `dsh plugin add` / `pnpm add`——这绕过了全部防护。本包提供 `dshpm` bin（随插件安装进入 profile 的 node_modules，也可 `node <profile>/node_modules/dsh-web-plugin-manager/dist/cli.js` 直接调用），所有变更走与 Web UI 完全相同的受保护链路（质量门 + 自动回滚 + 分析 + insert 行维护）：

```sh
dshpm install <source> --profile <name>   # npm 名 / github:user/repo / git URL / tarball / 本地路径
dshpm remove <name>    --profile <name>   # insert 行 + 包依赖一并清理
dshpm update <name>    --profile <name>   # 升级到 @latest（重写 specifier，质量门+回滚）
dshpm mount <name>     --profile <name>   # 补挂载官方 CLI 手动安装的未挂载依赖
dshpm list             --profile <name>   # bundle 层栈 / 已装包 / insert 行
dshpm analyze          --profile <name>   # 健康检查，有问题退出码 1
```

配合注入的提示词与工具守卫，AI 会在尝试裸命令前/时被引导到 `plugin_install` 工具或 `dshpm`。

## 功能

| 能力 | 说明 |
|---|---|
| 查看 | 合并展示层栈/依赖/挂载行/运行条目；手动安装未挂载的依赖显示「未挂载」并可一键挂载 |
| 实时启停 | managed 块编辑 patch，经 loader 直接应用，实时生效、重启后持久 |
| 安装 | 官方 dsh plugin CLI + 质量门 + 自动回滚；非 bundle 自动写挂载行并实时加载；git 源自动 clone、已发布 npm 优先 |
| 更新 | 检查更新（npm dist-tag / git HEAD / 安装 commit），更新带质量门与回滚；**含管理器自身（自更新）**——管理页可直接点更新升级 dsh-web-plugin-manager，失败自动装回旧版本 |
| 健康检查 | 依赖图/缺失/循环/重复行 id/同名注册冲突（服务/工具/section/路由）/peer 版本/官方包重复；运行中追加 pending 与失败诊断 |
| 环境管理 | 启停、复制/转移插件、创建/重命名/删除 profile（官方 profile 只读） |
| 市场 | 静态索引（topic:dsh-plugin 全量 ~3100 条，多源兜底 + gzip + 磁盘缓存）+ awesome 精选覆盖层；服务端已安装判定（包名/repository 双向/git 源/目录探测）；更新检测（索引版本对比，含橙标更新按钮）；同名包冲突消解；24h 缓存、15s 超时、代理支持、失败负缓存 |
| agent 工具 | plugin_status/install/uninstall/toggle + 安装守卫（拦截裸命令并引导）+ 提示词注入 |

功能与限制的详细说明见 [docs/feature-reference.md](docs/feature-reference.md)（随仓库与 npm 包发布）。

## 架构

- **Host**：`src/index.ts` —— `PluginManagerService`（`ctx.pluginManager`）+ `/api2/plugin-manager/*` REST 路由（`webServer.register`）
- **实时应用**：`src/live.ts` —— 补丁变更先经 loader include 条目直接应用（`entry.update`，与平台 watchUserPatches 同通道）再写文件。绕开平台级死锁：watcher 刷新增量卸载 HMR 依赖的 timer 行时，HMR 卸载会等待自身 disposables（含正在运行的刷新任务）造成循环等待；直接应用发生在 watcher 任务之外，卸载链可干净收敛。同时补偿平台 `applyEntryPatches` 对 patch 对象的原地改写（深克隆 + 烘焙值清理），并提供插件自有的 patch 文件 watcher（手动编辑持续实时生效，不依赖 HMR 生命周期）
- **分析引擎**：`src/analyze.ts` —— 离线依赖图/冲突/兼容性分析（与质量门共享扫描器，永不漂移）；运行时诊断读取 `ctx.reflect`（公开属性）活跃服务表
- **Patch 编辑**：`src/patch.ts` —— 标记块（`# dsh-plugin-manager:managed:start/end`）追加/移除，行级操作，原子写入（tmp + rename）；处理 YAML 陷阱（`@` 包名引号、空数组文档 `[]`、纯注释文件恢复模板）
- **稳定行视图**：Loader entry id 每次挂载随机，patch 定位必须用 include 树行 id（`EntryOptions.id`，官方语义稳定）
- **Agent 工具**：`src/tools.ts` —— 依赖注入避免循环依赖；host 提供 tools 服务时注册
- **安装守卫**：`src/guard.ts` —— `tools.guard` 拒绝裸 `dsh plugin`/pnpm 变更命令（只读 verb 放行），拒绝原因直接给模型指路 `plugin_*` 工具与 `dshpm`；`systemPrompt.section`（order 300）常驻提示同一条规则
- **CLI**：`src/cli.ts` —— 复用 `installProtected`/`installWithSource`/`removeProtected`/`updateProtected`（ctx 可空：无宿主进程时跳过 live 应用，文件级操作与 Web UI 完全一致）；`dshpm list/analyze` 直接读 profile 文件
- **Client**：`src/client/` —— 注册 `settings.plugins.tab`（all 遮蔽官方只读列表 + manager）+ `settings.section`（marketplace）；同源 fetch 调 REST
- **通信**：官方 webServer 路由 + 同源 fetch（不走 Typert Remote）

## 已知限制

- 禁用被依赖的条目可能导致 profile 启动失败（官方 fail-loud 设计）；恢复：手动删除该 profile `cordis.patch.yml` 里的 managed 块
- 安装来自 git 的 bundle 需在终端放行 `pnpm allowBuilds`（命令输出会回显）
- 随机行（无显式 id 的挂载行）不可经此启停（id 每次挂载变化）
- git 子包安装：多包仓库用 `#路径:<dir>` 约定指定子目录
- 质量门可能误伤未声明运行时依赖的插件（保守策略，可加白名单）
- 官方包只能 peerDependencies（普通依赖会装出第二份拷贝并劫持官方 loader 行，`undefined.prepare` 类故障）
- 安装守卫只拦 agent 工具调用，拦不住用户在终端手工执行裸 `dsh plugin`
- 更新检测边界：本地目录安装（非 git）报告"不可检测"；git URL 源需 manifest 记录安装 commit（gitHead）
- 健康检查为静态+尽力而为：同名注册冲突依赖源码正则扫描（动态拼接的名字检测不到）；语义冲突（两个插件做相反的事）无同名可查，不在检测范围
- 手动安装的插件不会自动挂载：管理器显示「未挂载」并提供「挂载」/ `dshpm mount`，不擅自改变 profile 行为
- 错误版本恢复指引（0.3.0/0.3.1/0.3.4 已在 npm 标记 deprecated，使用 0.3.5）：旧版本声明有缺陷（官方包普通依赖装重复拷贝 / 守卫绕过 / 未声明 js-yaml），安装旧版会在 profile 里留下问题。升级到 0.3.5 即可自动清理——`dsh plugin --profile <name> add dsh-web-plugin-manager@latest`（pnpm 剪除孤儿重复包）后重启实例；若实例已无法启动，先手动删除 `node_modules/@deepseek-ai/` 下的 dsh-tools/schemastery/cosmokit 再更新
- 市场条目来源于 awesome 目录，个别仓库可能已删除/私有
- 市场代理：host 读 `HTTP_PROXY`/`HTTPS_PROXY`；系统代理/规则模式加速器对 Node 进程无效（undici 不读系统代理）——把代理写进环境变量或改 TUN/全局模式
- 市场索引项目（DSH-Plugins-Marketplace）为第三方维护：索引数据问题（打错 tag/非插件仓库）由精选覆盖层与安装质量门兜底；GitHub API 未认证限流 60/h 仅影响 catalog 独有条目的星数富化（量小，403/429 即停止，列表不受影响）
- nvm 用户注意：子进程命令按「运行中 node 目录 → PATH → $NVM_DIR」兜底并注入 PATH——宿主进程不在 nvm 激活的 shell 中启动也能工作；仅当 dsh 未安装时才需从 nvm 激活终端

## 开发

```sh
pnpm run build   # host: tsc（标准装饰器转译）; client: tsdown
```

> 教训记录：host 必须用 **tsc** 构建（tsdown/rolldown 会保留原生装饰器语法，Node 不支持）；插件**不能同时导出 default（类）与 named（apply）**——Loader 会丢弃 apply。

## 相关

- 源码与 Issue：[github.com/LX2000WASD/dsh-web-plugin-manager](https://github.com/LX2000WASD/dsh-web-plugin-manager)
- 市场数据源：[awesome-dsh-plugins](https://github.com/AdamPlatin123/awesome-dsh-plugins)
- 许可证：MIT
