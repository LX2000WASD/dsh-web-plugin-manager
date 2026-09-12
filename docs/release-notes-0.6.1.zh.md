# dsh-web-plugin-manager 0.6.1 更新通知

**插件市场大提速 + 兼容官方 0.1.5-rc.1**

- **市场页几乎秒开**:重复打开插件市场从原来的数秒等待降到几乎无感,首次加载也快了近一半;对 dsh.so 索引源的请求量大幅下降,弱网环境下不再拖慢页面。
- **兼容最新官方版本**:全面适配 DeepSeek Harness 0.1.5-rc.1,已在真实环境完整验证;旧版 DSH 不受影响,无需陪同升级。
- **修复若干问题**:健康检查此前会漏检一类特殊打包的插件(string exports),现已纳入检查;个别场景下切换环境后,迟到的检查结果不再串台显示;命令行工具的一个路径安全问题已修复。
- **升级方式**:在「管理」页签对 dsh-web-plugin-manager 执行更新,或运行 `dshpm update dsh-web-plugin-manager`。

反馈与建议欢迎提交 issue:https://github.com/LX2000WASD/dsh-web-plugin-manager
