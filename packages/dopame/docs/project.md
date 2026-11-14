# 参赛项目与移植说明

MarkText for Dopame OS 采用“移植＋改造”路线：复用 MarkText v0.23.0 的 Muya 编辑核心，替换 Electron 宿主相关调用，并增加获授权 Agent 的文档能力。比赛期间新增工作集中在 packages/dopame，上游固定提交、完整 Git 历史与许可保留。

| 原有依赖或功能 | Dopame 实现 | 验证入口 |
| --- | --- | --- |
| Electron main/preload、IPC | 普通 Vue 页面与 acde:* 系统模块，DocumentController 统一正文命令 | app/src/main.ts、App.vue |
| Node 文件/原生对话框 | acde:fs、标准文件句柄与文件选择器 | file-port.ts、原生导入/原位保存/冲突测试 |
| Electron 窗口/菜单 | acde:window 标题、菜单、关闭与请求事件 | main.ts、App.vue |
| 编辑器和源码模式 | 实际 Muya、CodeMirror 5；保留上游源文件，构建时适配旧装饰器、Prism 与位图/选区行为 | editor-adapter.ts、vite.config.ts |
| 后台文档能力 | marktext-agent 桌面服务、Bun 状态进程、SQLite 持久化、独立 stdio MCP 桥 | protocol/state-store/public-gateway/mcp-bridge |
| 结果交接 | 具名文档版本和不可变 ArtifactRef，有限资源授权与撤销 | 双身份原生工作流测试 |

服务直接处理指定已发布快照、任务状态、建议、导出和固定产物读取。创建、应用和文件保存使用同一执行器，离线时合并唤醒目标 MarkText。公开 open 可能前置该窗口，不承诺平台尚未验证的后台启动、NPU 调度或 Dopa 隔离。

赛题对应：Web/JS 形态使用 acde/acdert；移植功能有实际 API 替换和编辑证据；改造功能有业务工具目录、版本和权限；提交物包括源码、包、客户端、说明、验收材料与路演稿。评分仍由官方评审决定，功能条数、知名度和会话数不等于得分。

原文依据为用户提供的 ReturnAI 赛题 HTML 与 MVP方案.md v1.1。当前本机环境和官方真机分开记录，官方真机测试按用户要求后置。M3/M4 的真实 Agent 会话未以确定性进程替代。

MVP 0.1.0 的公开源码以 `6bcca964e73b3fe1f5d981cea9f3b79f82968ebe` 为基线，上游为 `18fdc1eddc7d36d9b205180d058982f71f4f6373`，保留完整 Git 历史与原许可。公开整理使用后续提交，原始提交内容仍可从 Git 历史追溯。0.2.0 为单独版本，不并入本次 0.1.0 发布。

远端发布流程：将 0.1.0 基线及公开整理提交推送到公开 fork `Luv-sic-pt7/marktext-dopame` 的 `dopame-mvp-0.1.0` 分支，运行包单独通过 Release 发布。本次采用 `6bcca964e73b3fe1f5d981cea9f3b79f82968ebe` 已构建的组件，配合公开整理文档重打包；498 个组件运行文件与原 0.1.0 交付逐字节一致。公开整理未更改运行源码；今后可从本分支运行 `tools/build-release.ts` 重新构建，并核对版本和 `release-manifest.json`。GitHub 自动生成的 Source code 归档用于源码获取；运行包包含应用和提供 `marktext-agent` 的协作桌面，解压后在包目录执行 `sh scripts/run.sh`。公开验证范围见 [公开验收摘要](acceptance-public.md)，原始运行证据与日志不自动入包。
