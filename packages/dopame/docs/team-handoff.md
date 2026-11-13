# 四人交接与独立入口

本表将 MVP v1.1 的 A/B/C/D 分工对应到当前源码。它是可供四名开发成员使用的交接方式，不表示本轮实际由四人或四个模型开发，也不把开发成员数计为真实 Agent 会话数。

| 成员 | 独占模块 | 独立运行入口 | 真实集成切换 |
| --- | --- | --- | --- |
| A 编辑交互 | app/src/App.vue、editor-adapter.ts、ui-store.ts、style.css | `bun run preview:editor`，真实 Muya＋显式内存文件预览 | 正式 app/src/main.ts 注入真实 controller，nativeSelection=true |
| B 文档文件 | document-controller.ts、file-port.ts、checkpoint | `bun test tests/controller-interleavings.test.ts`，FakeEditor/内存文件＋真实状态库 | main.ts 注入 acde:fs，不更改文档命令 |
| C 协议服务 | protocol/client/state-store/state-process、services、gateway | `bun test tests/state-store.test.ts tests/gateway-mcp.test.ts tests/wake-policy.test.ts` | 同一协议定义用于 pipe/loopback/MCP；普通身份无 worker 管理权 |
| D 接入集成 | main.ts、桌面、配置、tools、E2E、交付材料 | `bun tools/test-native.ts`，隔离 acdert 状态、两独立 stdio 验证进程 | 最终包和真实 Agent 工具宿主；模拟宿主不能满足 M3/M4 |

预览配置没有 marktext-agent 依赖，并始终显示“模拟文件”提示；不用于持久化、授权或运行时验收。正式应用保留 fs、openFiles 和必需的 marktext-agent 服务声明。

预览命令会复用 app 的依赖，构建独立浏览器预览后启动本地静态服务。修改界面后重新执行该命令并刷新页面；该入口不承诺开发服务器热更新。

## 共享契约

- EditorBridge：flush、capture、replaceExternal、load；编辑器不直接保存文件。外部修改进入一个撤销步骤，IME 组合期间延后切换和提交。
- DocumentController：明确文档 ID/revision 的唯一正文命令；输入改变 revision，保存只更新已保存快照；不同文档队列独立，同文档提交串行。
- FilePort：授权 root/相对路径或句柄；UTF-8/BOM/换行与无修改原字节保存；private checkpoint 条件写入；返回稳定错误。
- TaskClient：发现、提交、查询、产物分块；请求身份来自配对凭证，workflow/parent 引用只关联流程。
- WorkerPort：独立凭证、instanceId/lease、提交前复查、checkpoint taskId、finish/recover；不暴露给 MCP 普通调用方。
- ExecutionPolicy：ownerAppId、service/executor 依赖、快照条件和窗口需求，由 protocol.ts 维护。当前 read/outline/propose/export 的指定已发布快照可直达服务；不把它冒充尚未同步的实时编辑内容。
- WakePolicy：只为 queued/recovering 的目标任务请求 MarkText；在线复用，同轮并发合并，离线一轮最多三次且间隔十秒。公开 open 可能前置目标窗口；不承诺后台启动或零焦点变化。

协议和 Schema 调整由 C 合并，组合入口与桌面配置由 D 合并；A/B 通过导出契约接线。共同固定上游/SDK，安全依赖修补单独记录原因、锁文件和回归结果。模块 Mock、原生验证和最终验收分别记证据，不能以文件存在代表完成。
