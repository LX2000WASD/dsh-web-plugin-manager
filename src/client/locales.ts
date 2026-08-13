/**
 * Locale copy for the plugin-manager settings tab.
 */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  tab: '管理',
  heading: '插件管理',
  intro: '为所选 profile 安装、删除、启停插件。启停变更在下次重启后生效（Web HMR 已关闭）。',
  profileLabel: 'Profile',
  refresh: '刷新',
  packages: '已安装包',
  entries: '运行时条目',
  noPackages: '还没有依赖。在下方安装一个 bundle。',
  installPlaceholder: 'npm 包名、github:user/repo、tarball 或 ./路径',
  installButton: '安装',
  installing: '安装中…',
  removeButton: '删除',
  enableButton: '启用',
  disableButton: '停用',
  enabled: '已启用',
  disabled: '已停用',
  restartHint: '重启 profile 后补丁更改生效。',
  commandOutput: '命令输出',
  error: '错误',
  bundleBadge: 'bundle',
  dependencyBadge: '依赖',
  phase: '状态',
  entryId: '条目',
  module: '模块',
  confirmRemove: '从 profile 中删除此包？',
} satisfies Record<string, string>

/** Plugin manager locale key union. */
export type PluginManagerLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  tab: 'Manage',
  heading: 'Plugin Manager',
  intro: 'Install, remove, and toggle plugins for the selected profile. Enable/disable changes apply on the next restart (Web HMR is off).',
  profileLabel: 'Profile',
  refresh: 'Refresh',
  packages: 'Installed packages',
  entries: 'Runtime entries',
  noPackages: 'No dependencies yet. Install a bundle below.',
  installPlaceholder: 'npm package, github:user/repo, tarball, or ./path',
  installButton: 'Install',
  installing: 'Installing…',
  removeButton: 'Remove',
  enableButton: 'Enable',
  disableButton: 'Disable',
  enabled: 'enabled',
  disabled: 'disabled',
  restartHint: 'Restart the profile for patch changes to take effect.',
  commandOutput: 'Command output',
  error: 'Error',
  bundleBadge: 'bundle',
  dependencyBadge: 'dependency',
  phase: 'phase',
  entryId: 'entry',
  module: 'module',
  confirmRemove: 'Remove this package from the profile?',
} satisfies Record<PluginManagerLocaleKey, string>
