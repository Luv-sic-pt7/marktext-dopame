# MarkText for Dopame OS · MVP 0.1.0

在 Dopame/acdert 中复用 MarkText 的 Muya 编辑器，支持人与获授权 Agent 按固定文档版本进行写作、审阅、确认和交付。本分支公开 MVP 0.1.0 源码，按《MVP方案.md》v1.1 的 M1–M12 记录开发验证；已有多标签、源码、目录等功能保留。0.1.0 的历史开发记录、本次复验和未测边界见 [公开验收摘要](docs/acceptance-public.md)。

源码基线为 `6bcca964e73b3fe1f5d981cea9f3b79f82968ebe`；上游为 MarkText v0.23.0，提交 `18fdc1eddc7d36d9b205180d058982f71f4f6373`。完整 Git 历史与原 MIT LICENSE 保留，移植代码位于 `packages/dopame`，不启动 Electron。0.2.0 是单独版本，不属于本分支。第三方依赖按各自许可使用，见 [第三方声明](THIRD-PARTY-NOTICES.txt)。

## 源码与运行包

`git clone` 和 GitHub 自动生成的 `Source code (zip/tar.gz)` 提供源码，需要按下文安装依赖并构建。可直接加载的 Release 运行包由 `tools/build-release.ts` 生成，包含 `packages/marktext-dopame` 应用、提供 `marktext-agent` 服务的 `packages/marktext-workspace` 协作桌面、工具桥和启动脚本。编辑器需要配套桌面服务，两者随运行包一起交付。

## 本地开发

需要 Bun 1.4.4、Node 24 和 acde/acdert/SDK 0.0.9。分别在本目录、`app`、`desktop` 执行 `bun install --frozen-lockfile --ignore-scripts`。不需要运行上游 Electron 的 postinstall。

```sh
bun test tests
bun x --no-install tsc --noEmit
# app 目录，用 Node 运行 Vue 检查器
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
# 回到本目录
bun tools/test-native.ts
bun tools/build-release.ts /absolute/path/to/new-release-directory
```

构建脚本产出可加载应用、桌面/服务、独立 MCP 工具桥、最小客户端、协议和文件摘要，并可收录公开验收摘要；原始运行证据和日志需另行审阅，不会自动复制到包内。运行最终包不需要 Vite 开发服务器；主机需提供兼容的 acde/acdert 和 Bun。真实 Agent 会话和官方硬件验证按用户要求后置。

## 使用

1. 解压构建后的 Release 运行包，在运行包目录执行 `sh scripts/run.sh`。脚本一起加载编辑器应用和提供 `marktext-agent` 的协作桌面；也可按 [运行和卸载说明](docs/deployment.md) 安装这两个配套包。
2. 人工编辑可直接使用。导入文件默认复制到私有工作区；保存目标显示在文档标题下方。点击“导出”选择 .md 交付位置；“原位打开文件”会回写所选文件。
3. 在协作桌面选择本服务生成的管理员凭证，配对不同调用方，分别赋予必要资源和动作。该操作不会自动赋予全部文档权限。
4. 按 [工具接入](docs/tools.md) 为每个 Agent 配置自己的 MCP 进程。文档能力经工具目录发现；回执、结果、固定产物均通过结构化接口取得。

文档资料不是授权指令，引用也不是凭证。配对凭证仅保存在私有文件，不能放入正文、命令行 token 参数或前端配置。不要把运行目录或 `endpoint.json` 作为跨 Agent 文档结果；结果使用 `DocumentRef` / `ArtifactRef` 与有限授权。

限制、恢复方式、漏洞审计与未完成项见 [安全与可靠性](docs/security.md)、[团队契约](docs/team-handoff.md) 和验收记录。没有设置两个 Agent 的产品人数上限；最低验收中的两个真实会话需要独立证据。
