# dsh-web-plugin-manager 功能参考（工作区文档）

README 只保留功能速览；本文件存放功能与限制的细致说明，供开发与排障查阅。

## 查看

- **四源合并**：include 树稳定行（`EntryOptions.id`，官方语义稳定，Loader 挂载 id 每次随机，patch 定位必须用它）+ `dsh.profile.bundles` 层栈 + `package.json` 依赖 + `cordis.patch.yml` insert 行
- 非运行 profile 显示离线合成条目（官方 in-box 包 base/web-app/headless 不标记为已安装）
- **已安装但未挂载的依赖**：官方 CLI/pnpm 手动安装的非 bundle 插件只写依赖、不写挂载行（从未被加载）——list() 合成为 `unmounted` 条目，目录页显示「未挂载」标签与「挂载」按钮，一键补写 managed insert 行（运行中 profile 实时生效）

## 实时启停

- 受控编辑 profile 的 `cordis.patch.yml`：`# dsh-plugin-manager:managed:start/end` 标记块，行级操作、原子写入（tmp + rename），保留用户内容，可逆可审阅
- 变更先经 loader include 条目直接应用（`entry.update`，与平台 watchUserPatches 同通道）再写文件——绕开平台 watcher 死锁（HMR 卸载等待自身 disposables 循环等待），实时生效、零重启
- 插件自有的 patch 文件 watcher：手动编辑持续实时生效，不依赖 HMR 生命周期
- 5s 超时兜底；跨 profile 隔离（仅作用于运行中宿主 profile）
- 随机行（无显式 id 的挂载行）不可经此启停——id 每次挂载变化

## 安装

- 调用官方 `dsh plugin` CLI（pnpm reconcile），保护 in-box bundles（base/web-app/headless 从 `dsh.profile.bundles` 恢复）
- 非 bundle 插件自动写 managed insert 行并实时挂载；bundle 插件进入层栈，重启后加载
- git 源自动 clone 进 `$DSH_HOME/plugin-manager-src` 缓存；已发布 npm 的包优先走 npm 安装（npm-first）
- 安装即质量门（见下），任何问题自动回滚，profile 保持可启动
- **行 id 冲突预检**：slugify 后的行 id 与既有行（insert 行同名不同包、用户顶层行）冲突时拒绝安装并回滚——避免 loader 拒绝整棵树

## 质量门（安装时）

- 扫描整条加载链（入口 + 相对 import 可达文件，BFS 有界）的 import，对照声明依赖 + 平台白名单
- 白名单：`@deepseek-ai/dsh-client-*` / `cordis-plugin-*` 前缀族 + cordis / react 等 loader 提供项
- 覆盖副作用导入、re-export、动态 import、minified 形态；`import type` 不误报
- 声明了但未安装的依赖同样拦截；bundle 插件 `cordis.patch.yml` 行名逐一校验
- **官方包只能 peerDependencies**：普通 `dependencies` 命中安装兜底闭包的 `@deepseek-ai/*` 一律拦截回滚——普通依赖会在 profile 内装出第二份官方拷贝，loader 最近优先解析劫持官方行，模块身份（unique symbol/class）分裂导致 `Cannot read properties of undefined (reading 'prepare')` 类运行时故障；写 `peerDependencies` 即可（`autoInstallPeers: false` 下经共享兜底目录解析，全 profile 共享一份）。豁免名单 `OFFICIAL_DEP_ALLOWED`（analyze.ts）：`@deepseek-ai/schemastery`——官方 cookbook 允许的运行时 validator，`ValidationError` 用 `Symbol.for` 全局符号 duck-typed、schema 为纯函数闭包，双拷贝不分裂身份（官方 @deepseek-ai/dsh-llm-deepseek 即按 dependencies 声明）

## 更新

- npm 包对比 registry dist-tag `latest`；git 缓存源（link: 路径是 git 仓库）`git fetch` 对比远端 HEAD（@{u} 回退 FETCH_HEAD）；git URL 源 `ls-remote` 对比安装 commit（gitHead）
- 可更新卡片淡绿边框，更新按钮在删除左侧（仅检测到更新可点），详情显示当前/最新版本
- 更新动作：npm `@latest` 重装 / git 缓存 fetch+reset 后重跑官方 add / git URL 源重解析，均带质量门与回滚
- 边界：本地目录安装（非 git）无上游可比，报告"不可检测"；git URL 源需要 manifest 记录安装 commit（gitHead）

## 健康检查（`src/analyze.ts`，离线引擎）

- 依赖图：全包 entry imports → providers（含 pnpm symlink、exports 子路径）→ 包间依赖边；拓扑排序输出（加载顺序提示，cordis 激活本身是服务可用性驱动）
- 缺失依赖（imports 无提供者且未声明）、被禁用依赖、循环依赖（DFS）、重复 patch 行 id
- **同名注册冲突**（确定性 fail-loud 故障）：服务名（new Service/ctx.provide）、工具名（ctx.tools.register）、prompt section 名（ctx.systemPrompt.section）、web 路由路径（ctx.webServer.register）——源码正则扫描，动态注册（字符串拼接的名字）检测不到
- peerDependencies 版本满足性（简化 semver：`^`/`~`/`>=`/`<=`/`>`/`<`/精确/星号），含经共享 fallback 解析的官方核心包
- **官方包重复安装**（official-duplicate）：`@deepseek-ai/*` 同时存在于 profile node_modules 与安装兜底目录 → 报肇事插件（哪个依赖引入的）与修复指引
- 运行时诊断（宿主）：pending 注入根因（静态 inject 声明 vs 活跃服务表）、fiber 加载失败原因（`_error`）
- **作用效果冲突（语义冲突）不在静态检测范围**：两个插件做相反的事（互相矛盾的 prompt 指导、竞争同一事件流）没有同名可查，只能靠运行时观察尽力而为

### 分级自动修复（管理页健康检查区）

- **A 级（安全默认，一键自动修 / 单条「修复」）**：`duplicate-row-id`（保留第一个删其余重复顶层行）、`disabled-dependency`（恢复启用被依赖条目）、`official-duplicate`（删除 profile node_modules 里的重复官方包拷贝 + 清理 manifest 声明）
- **B 级（建议 + 行内确认，不弹窗）**：`service/tool/section/route-conflict`——建议"禁用后注册者"，按钮两态（执行建议 → 确认执行？）
- **C 级（只输出）**：`missing-import` / `circular-dependency` / `peer-mismatch` / 运行时诊断
- 交互：行内按钮 + 状态反馈（已修复 ✓），执行细节进命令输出区；`fixAll` 批量跑 A 级；修复后自动重新分析
- 服务端：`fixIssue(profile, action, target)` / `fixAll(profile)`（mutation mutex 串行，A 级动作执行前不二次确认）

## 环境管理

- 设置 → 插件 → 环境：启动/停止（终端或后台）、复制/转移插件（按记录源重装）、创建/重命名/删除 profile
- 官方 profile（web/headless）只读，不可管理

## 市场

- **静态索引为主**：[DSH-Plugins-Marketplace](https://github.com/bradeGithub/DSH-Plugins-Marketplace) 的 CI 索引 `registry.json.gz`（topic:dsh-plugin 全量 ~3100 仓库，含星数/更新时间/pkg_name/版本/分类，每 2 小时更新）——多源兜底链：`api.github.com contents`（有 `GH_TOKEN`/`GITHUB_TOKEN` 带认证）→ jsDelivr CDN（`generated_at` 新鲜度 6h 校验）→ `raw.githubusercontent` → 本地磁盘缓存（上次成功完整索引）→ GitHub 搜索 API（topic:dsh-plugin，残缺应急，不落盘）；索引条目自带星数，不再逐个打 GitHub API
- **精选覆盖层**：[awesome-dsh-plugins](https://github.com/AdamPlatin123/awesome-dsh-plugins) 结构化 catalog（catalog/plugins/*.json + tombstones）+ PLUGINS.md 双源合并，叠加在索引之上（状态徽标/精选描述/包名/分类），精选独有条目追加；24h 缓存，空结果不写正缓存
- **dsh.so 验证/安全叠加**：[dsh.so](https://www.dsh.so) 独立索引（1630 条，全部带 verification L1–L5 + 自动化安全扫描）按仓库名叠加 verification/security 徽标到卡片（TAG 行与 awesome 状态徽标同行，不新增条目、不作安装源）；dsh.so 索引独立磁盘缓存 24h，失败降级不阻塞；注意扫描为静态启发式，`high` 风险可能是误报（如本管理器自身也被标 high）——徽标是"装前留意"信号，最终判定仍是安装质量门
- **已安装判定在服务端**（每请求按目标 profile 计算，12 并发池标注）：① npm 包名（registry pkg_name / 仓库名）② manifest `repository` 双向匹配（同名不同仓库不误判）③ git 缓存源 owner-repo 身份 ④ `~/.dsh/skills|.agent-presets` 目录探测；返回 `installed` / `installedVersion` / `latestVersion`（索引版本字段）/ `updateAvailable`（仅严格更高才提示，回滚不误报）
- **同名包冲突消解**：同一 pkg_name 只保留一条（已安装优先、否则星数高者），`dropped` 计数透传前端提示「N 个同名包已隐藏」
- 卡片动作：未安装 → 安装；已装无新版 → 绿色「已安装 vX」；已装有新版 → 橙色「更新」（npm 包走受保护 update 链路重写 specifier + 质量门 + 回滚，git-only 源重装）；星数排序时已安装置顶
- 卡片布局：标题省略号不挤占按钮区；短 meta 行（星数缩写 2.5K / 来源 npm包|git仓库 / 类型占位）；TAG 行（审核状态 + 功能分类本地化）；单/双列切换（localStorage 记忆）；**增量渲染**——首屏 120 条 + 触底加载更多 + `content-visibility: auto`（~3000 条列表不卡顿，无需服务端分页）
- **缓存**：进程内存镜像（listing 与 profile 无关，切 profile 只重算已安装标记，零磁盘 IO）+ 磁盘 24h 缓存 + 失败负缓存 5min + registry 原始索引缓存；`refresh=1` 是唯一强制网络路径
- **网络健壮性**：每请求 15s 超时（AbortSignal.timeout）；支持 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`（undici ProxyAgent——Node 全局 fetch 会丢弃 dispatcher 选项，市场请求必须走 undici 自身 fetch）；失败原因负缓存 5 分钟（`marketplace-failure.json`，避免每次进页重跑全量 GitHub 往返）；索引全挂且无缓存时空列表直接显示失败原因
- GitHub API 未认证限流 60/h：仅 catalog 独有条目的星数富化会打 API（量小）；403/429 停止富化（星数降级用上次快照元数据），列表本身不受影响；raw 兜底源可达时列表保持非空
- 系统代理/规则模式加速器对 Node 进程无效（undici 不读系统代理）——市场为空且此类加速器用户，把代理地址写进环境变量，或改 TUN/全局模式

## agent 工具与安装守卫

- `plugin_status` / `plugin_install` / `plugin_uninstall` / `plugin_toggle`（目标 profile 由配置 `profile` 指定，默认 `web`）；依赖注入避免循环导入
- `plugin_search`：自然语言检索市场（本地索引，name 3 分 / topics 2 分 / 描述 1 分加权，空查询按星数；中英文分词），结果带已安装标记与仓库链接，并提示"安装前先浏览仓库"（索引元数据无法判断质量，安装本身走质量门）
- 安装守卫（`src/guard.ts`）：`tools.guard` 拒绝 bash/run_code 中裸 `dsh plugin add/remove/update` 与指向 profile 目录的 `pnpm add/remove`（只读 verb list/status/dump-config/help 放行），拒绝原因直接给模型指路 `plugin_*` 工具与 `dshpm`；`systemPrompt.section`（order 300）常驻提示同一规则
- 守卫只拦 agent 工具调用，拦不住用户在终端手工执行裸命令

## 多类型安装（skill / agent 预设）

- 类型检测分层：根/嵌套 `agent.cordis.yml` → 预设（官方单文件判定，preset.yml 仅显示元数据）；根 package.json 声明 DSH 能力 → cordis 插件；根 `SKILL.md` → skill；嵌套预设/插件/技能根；其余（含含 install.sh 的仓库——**永不自动执行第三方脚本**）→ 非三类，拒绝安装并加入市场屏蔽名单
- skill 安装到官方根 `<dshHome>/skills`（frontmatter name 优先，技能集合仓库逐个装，跳过点目录/node_modules/vendored）；**chokidar watch 默认开启 → 安装/删除即热加载**；预设安装到 `<dshHome>/.agent-presets`（目录名即 preset id，官方每次会话发现重读）；预设的管理（复制/删除/默认）由官方设置页完成
- 安装记录 `installed-kinds.json`（市场安装的来源/类型/位置/时间，串行队列读写）；市场已安装判定与卡片类型徽标（skill/预设/插件）来自记录
- 市场卸载：管理页「技能与预设」区块（记录列表 + 卸载 + git 源重新拉取）；`dshpm uninstall-kind <owner/repo>`；skill/预设删目录含路径越界防护，cordis 按记录逐个走受保护 remove
- 屏蔽名单：安装时检测为非三类的仓库写入 `blocked-repos.json`，市场所有列表路径（缓存/新拉/兜底）统一过滤，响应带 `blocked`/`blockedRepos`；市场页提供「解除屏蔽」

## 插件拥有的 Agent 预设（归属管理）

- **背景**：预设目录名是 preset id，不是所属插件——插件（如 dsh-agent-rp）自带的伴随预设是插件自己复制进 `<dshHome>/.agent-presets` 的，卸载插件后预设成为孤儿（选择器残留、选中报错）。归属标记回答「这个目录是谁的、还是原版吗」。
- **标准标记**（本管理器安装预设时写入）：`.dsh-preset-owner.json` = `{format: 0, owners: [包名], digest: sha256(agent.cordis.yml[+preset.yml])}`，不覆盖已有标记。
- **兼容读取**（生态既有惯例，只读不写）：gamelike-plugin-manage 的 `.plugin-manage-owner.json`（owners 数组）、dsh-agent-rp 的 `.dsh-agent-rp-owner.json`（owner 字符串 + format + digest，严格校验 format）。标准标记损坏 → 视为无归属（不删）；兼容标记损坏/format 不符 → 单个跳过。
- **卸载清理**（remove / uninstall-kind / plugin_uninstall）：只删「唯一 owner == 被卸载插件 且 digest 匹配（用户未修改）」的预设；用户改过的跳过并报告；多 owner 预设（归属重叠）不处理；system 信任预设绝不碰；删除优先走宿主 `agentPresets.remove()`（处理 settings.default 与 standing 会话），宿主不可用（CLI）降级直删（rmRetry + 路径守卫）。**预设是全局的：其他 profile 仍安装该插件时不清理**。
- **禁用归档 / 启用恢复**（setEnabled）：禁用插件把其拥有的预设目录移出 user root（`<dshHome>/plugin-manager-cache/preset-archive/`，含用户修改版，零数据损失，选择器即时消失）；重新启用自动移回（同名冲突保留新预设并提示）。禁用**从不删除**——宿主 broken 判定只查 YAML 语法、不反映「引用的插件被禁用」，且临时禁用不应毁数据。
- **已知限制**：CLI 直删路径不清宿主 settings.default（无 ctx）；skill 无此问题（SKILL.md 不引用插件代码，残留无害）。


- 类型检测分层：根/嵌套 `agent.cordis.yml` → 预设（官方单文件判定，preset.yml 仅显示元数据）；根 package.json 声明 DSH 能力 → cordis 插件；根 `SKILL.md` → skill；嵌套预设/插件/技能根；其余（含含 install.sh 的仓库——**永不自动执行第三方脚本**）→ 非三类，拒绝安装并加入市场屏蔽名单
- skill 安装到官方根 `<dshHome>/skills`（frontmatter name 优先，技能集合仓库逐个装，跳过点目录/node_modules/vendored）；**chokidar watch 默认开启 → 安装/删除即热加载**；预设安装到 `<dshHome>/.agent-presets`（目录名即 preset id，官方每次会话发现重读）；预设的管理（复制/删除/默认）由官方设置页完成
- 安装记录 `installed-kinds.json`（市场安装的来源/类型/位置/时间，串行队列读写）；市场已安装判定与卡片类型徽标（skill/预设/插件）来自记录
- 市场卸载：管理页「技能与预设」区块（记录列表 + 卸载 + git 源重新拉取）；`dshpm uninstall-kind <owner/repo>`；skill/预设删目录含路径越界防护，cordis 按记录逐个走受保护 remove
- 屏蔽名单：安装时检测为非三类的仓库写入 `blocked-repos.json`，市场所有列表路径（缓存/新拉/兜底）统一过滤，响应带 `blocked`/`blockedRepos`；市场页提供「解除屏蔽」

## CLI（dshpm）

- bin 随插件安装进入 profile 的 node_modules；也可 `node <profile>/node_modules/dsh-web-plugin-manager/dist/cli.js` 直接调用；`--home` 指定 DSH_HOME
- 所有变更走与 Web UI 完全相同的受保护链路：pnpm add/remove（官方 CLI）→ 质量门 → 自动回滚 → 安装后分析 → insert 行维护；ctx 可空：无宿主进程时跳过 live 应用，文件级操作与 Web UI 一致
- 命令：
  - `dshpm install <source>`：npm 名 / github:user/repo / git URL / tarball / 本地路径
  - `dshpm remove <name>`：insert 行 + 包依赖一并清理（含 node_modules）
  - `dshpm mount <name>`：补挂载官方 CLI 手动安装的未挂载依赖
  - `dshpm list`：bundle 层栈 / 已装包 / insert 行
  - `dshpm analyze`：健康检查全文输出，有问题退出码 1

## 架构模块

- Host：`src/index.ts` —— `PluginManagerService`（`ctx.pluginManager`）+ `/api2/plugin-manager/*` REST（`webServer.register`）
- 实时应用：`src/live.ts`；分析引擎：`src/analyze.ts`（与质量门共享扫描器，永不漂移）；Patch 编辑：`src/patch.ts`（YAML 陷阱：`@` 包名引号、空数组文档 `[]`、纯注释文件恢复模板）；网络助手：`src/net.ts`（超时 + 代理）；Agent 工具：`src/tools.ts`；守卫与提示：`src/guard.ts`；CLI：`src/cli.ts`
- Client：`src/client/` —— `settings.plugins.tab`（all 遮蔽官方只读列表 + manager + environments）+ `settings.section`（marketplace）；同源 fetch 调 REST（不走 Typert Remote）

## 已知限制明细

- 禁用被依赖的条目可能导致 profile 启动失败（官方 fail-loud 设计）；恢复：手动编辑该 profile 的 `cordis.patch.yml` 删除 managed 块
- 安装来自 git 的 bundle 需要用户在终端放行 `pnpm allowBuilds`（命令输出会回显）
- git 子包安装：多包仓库用 `#路径:<dir>` 约定指定子目录（`#ref` 是 git ref）
- 质量门可能误伤：未声明运行时依赖的插件会被拦截回滚（保守策略）；若插件确实由 Loader/host 提供该模块，需在 manifest 声明或加入白名单
- 市场条目来源于静态索引 + awesome 目录，个别仓库可能已删除/私有（安装时报 `Repository not found`）；索引项目本身是第三方维护（社区项目），其数据问题（打错 tag、非插件仓库）由精选覆盖层与安装质量门兜底
- nvm 用户注意：子进程命令（dsh/npm/pnpm/git）解析按「运行中 node 目录 → PATH → $NVM_DIR」兜底，并把命中的工具目录注入子进程与终端窗口的 PATH——宿主进程不在 nvm 激活的 shell 中启动（桌面启动器/服务/nohup）也能工作；仅当 dsh 完全未安装时才需要从 nvm 激活的终端启动
