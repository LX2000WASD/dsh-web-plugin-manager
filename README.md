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
| 查看 | 四源合并：include 树稳定行（`EntryOptions.id`）+ `dsh.profile.bundles` 层栈 + `package.json` 依赖 + `cordis.patch.yml` insert 行；非运行 profile 显示离线合成条目（官方 in-box 包不标记为已安装） |
| 实时启停 | 受控编辑 profile 的 `cordis.patch.yml`（managed-block 机制，保留用户内容，可逆可审阅）；变更经 loader include 直接应用，**实时生效、零重启**（绕开平台 watcher 死锁，见架构）；重启后持久 |
| 安装 | 调用官方 `dsh plugin` CLI（复用 pnpm reconcile），保护 in-box bundles（base/web-app/headless）；**非 bundle 插件自动写 insert 行并实时挂载**；git 源自动 clone 缓存，**已发布 npm 的包优先走 npm 安装** |
| 质量门 | 安装时扫描**整条加载链**（入口 + 相对 import 可达文件）的 import，对照声明依赖 + 平台白名单（`@deepseek-ai/dsh-client-*` / `cordis-plugin-*` 前缀族）；覆盖副作用导入、re-export、动态 import、minified 形态，`import type` 不误报；**声明了但未安装**的依赖同样拦截；**bundle 插件的 `cordis.patch.yml` 行名逐一校验**；任何问题自动回滚，profile 保持可启动 |
| 更新 | 管理页「检查更新」：npm 包对比 registry dist-tag；git 缓存源 `git fetch` 对比远端 HEAD；git URL 源对比安装 commit。可更新插件淡绿边框标识，更新按钮位于删除左侧（仅检测到更新时可点）。npm 走 `@latest` 重装，git 缓存 fetch+reset，均带质量门与回滚 |
| 健康检查 | 管理页「健康检查」：依赖图（包间 import 边）+ 缺失/被禁用依赖 + **循环依赖** + 重复 patch 行 id + **同名服务冲突** + **peerDependencies 版本满足性**（含官方核心包，经共享 fallback 解析）；运行中 profile 追加诊断：pending 注入根因（对比活跃服务表）、fiber 加载失败原因；输出建议加载顺序（拓扑序） |
| 环境管理 | 设置 → 插件 → 环境：启动/停止（终端或后台）、复制/转移插件、创建/重命名/删除 profile |
| 市场 | 设置一级菜单「市场」：数据源为 [awesome-dsh-plugins](https://github.com/AdamPlatin123/awesome-dsh-plugins) 结构化 catalog + PLUGINS.md 双源合并（✅/待测/已归档状态），GitHub API 补星数/更新时间，24h 缓存；**已安装条目显示「已安装」徽标并禁用安装按钮**（按 npm 包名 / 仓库 / git 缓存源匹配）；选择安装目标环境后一键安装 |
| agent 工具 | `plugin_status` / `plugin_install` / `plugin_uninstall` / `plugin_toggle`（目标 profile 由配置 `profile` 指定，默认 `web`） |

## 架构

- **Host**：`src/index.ts` —— `PluginManagerService`（`ctx.pluginManager`）+ `/api2/plugin-manager/*` REST 路由（`webServer.register`）
- **实时应用**：`src/live.ts` —— 补丁变更先经 loader include 条目直接应用（`entry.update`，与平台 watchUserPatches 同通道）再写文件。绕开平台级死锁：watcher 刷新增量卸载 HMR 依赖的 timer 行时，HMR 卸载会等待自身 disposables（含正在运行的刷新任务）造成循环等待；直接应用发生在 watcher 任务之外，卸载链可干净收敛。同时补偿平台 `applyEntryPatches` 对 patch 对象的原地改写（深克隆 + 烘焙值清理），并提供插件自有的 patch 文件 watcher（手动编辑持续实时生效，不依赖 HMR 生命周期）
- **分析引擎**：`src/analyze.ts` —— 离线依赖图/冲突/兼容性分析（与质量门共享扫描器，永不漂移）；运行时诊断读取 `ctx.reflect`（公开属性）活跃服务表
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
- **更新检测边界**：本地目录安装（非 git）无上游可比，报告"不可检测"；git URL 源需要 manifest 记录安装 commit（gitHead）才能比较
- **健康检查为静态+尽力而为**：服务冲突依赖源码正则扫描，动态注册（字符串拼接的服务名）检测不到；peer 版本比较为简化 semver（`^`/`~`/`>=`/`<=`/`>`/`<`/精确/星号）
- 市场条目来源于 awesome 目录，个别仓库可能已删除/私有（安装时报 `Repository not found`）
- **nvm 用户注意**：子进程命令（dsh/npm/pnpm/git）解析按「运行中 node 目录 → PATH → $NVM_DIR」兜底，并把命中的工具目录注入子进程与终端窗口的 PATH——即使宿主进程不在 nvm 激活的 shell 中启动（桌面启动器/服务/nohup）也能工作；仅当 dsh 完全未安装时才需要从 nvm 激活的终端启动

## 开发

```sh
pnpm run build   # host: tsc（标准装饰器转译）; client: tsdown
```

> 教训记录：host 必须用 **tsc** 构建（tsdown/rolldown 会保留原生装饰器语法，Node 不支持）；插件**不能同时导出 default（类）与 named（apply）**——Loader 会丢弃 apply。

## 相关

- 源码与 Issue：[github.com/LX2000WASD/dsh-web-plugin-manager](https://github.com/LX2000WASD/dsh-web-plugin-manager)
- 市场数据源：[awesome-dsh-plugins](https://github.com/AdamPlatin123/awesome-dsh-plugins)
- 许可证：MIT
