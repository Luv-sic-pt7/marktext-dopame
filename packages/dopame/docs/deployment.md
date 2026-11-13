# 构建、运行与卸载

交付包由 `tools/build-release.ts` 生成。`packages/marktext-dopame` 为应用，`packages/marktext-workspace` 为桌面及 marktext-agent 服务；`tools/marktext-mcp.js` 为独立业务工具桥。包内不含 Electron、Node 原生扩展或开发机二进制。

## 环境与启动

开发验证环境：macOS / Apple M4、acde 0.0.9、acdert 0.0.9、SDK 0.0.9、Bun 1.4.4，API contract level 1。目标设备必须提供兼容 acdert 和 Bun 1.4.4+，服务会从主机 PATH、HOME/.bun/bin 或 MARKTEXT_BUN 查找 Bun。不把 Mac 上的 Bun 二进制复制到 Linux。

将交付目录复制到目标机器，确保 `acde`、`bun` 在 PATH 中，再运行：

```sh
./scripts/run.sh
```

该脚本只加载交付目录中的构建包；使用 acde 启动运行时控制会话，不启动 Vite，也不需要源码或 node_modules。桌面里的 MarkText 按钮打开编辑器。第一次启动会生成独立的管理员和 worker 凭证；人工编辑不要求先配对 Agent。

需要长期安装时运行 `./scripts/install.sh`。acde 会将两个包安装到当前用户的包目录。已安装后可以 `acde dev --desktop marktext-workspace` 启动；已有桌面要使用本应用时也必须具备 marktext-agent 配套服务。

acde 0.0.9 将带 manifest 的预构建目录按手写包安装为符号链接。安装后保留交付目录的位置，移动交付目录后重新安装；卸载仅删除安装链接，不删除交付目录。

## 状态与权限

服务状态由 `ServiceContext.state` 决定。默认 XDG 布局下，管理员凭证位于 `$XDG_STATE_HOME/acde/marktext-workspace/marktext-agent/administrator.json`，通常 XDG_STATE_HOME 为 `~/.local/state`。以桌面实际生成的路径为准。该目录还包含 worker.json、client-*.json、collaboration.sqlite 和 endpoint.json，目录 0700、凭证和端点文件 0600。

在协作桌面选择管理员凭证后，建立调用方身份并选择授权资源、动作、有效期和转授权权限。不同真实 Agent 会话使用不同 client 凭证。普通客户端没有配对、管理员、任意路径、任意 shell 或执行器接口。

`endpoint.json` 指向随机端口的本机服务入口，只允许 127.0.0.1、Bearer 配对鉴权、JSON POST；带 Origin 的请求拒绝。端点在状态进程重启后更新。工具桥每次请求重新读取它，已有身份和任务无需重新配对。

## 停止、卸载与迁移

正常关闭编辑器会保存私有草稿并等待当前执行工作收束。结束本次运行时会停止其服务。不要手工删除待核对任务的 checkpoint 或数据库。

`scripts/uninstall.sh` 只卸载本项目两个安装包；应先停止使用这些包的会话。脚本不删除笔记、草稿、授权或服务状态。迁移、重置和删除数据应在导出文档、核对任务并停止服务后由用户明确执行。

## 真机验收

用户明确将真实 Agent 会话与官方真机测试后置。目前没有官方连接入口。后续需在官方设备上安装同一份带摘要的最终包，记录环境、安装日志、人工编辑、两个真实 Agent 工具会话、离线/重启和窗口行为。M9 在实际完成前保持未测，不能以本机测试替代。

安装包 ID 为 marktext-dopame-app，应用 ID 为 marktext-dopame。脚本使用安装包 ID 卸载；工具引用和打开窗口使用应用 ID。两者已通过隔离 XDG 安装/卸载检查。
