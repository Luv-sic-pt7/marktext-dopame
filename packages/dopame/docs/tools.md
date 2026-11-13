# Agent 工具接入

本项目提供标准 MCP stdio 业务入口，工具名以 `marktext_` 开头；和 `acde mcp` 的开发调试工具分开。协议连接后通过 `tools/list` 发现工具，普通 Agent 不需要导入私有 SDK。MCP 注册、目录可读、确定性宿主联调、真实模型会话和官方设备验收是不同的证据。

## 每个会话独立配置

先由管理员创建 client 身份并授予必要范围。为写作和审阅会话分别启动一个 MCP 进程，使用各自的 0600 client 凭证文件。命令参数只包含路径：

```sh
bun /path/to/release/tools/marktext-mcp.js \
  --endpoint-file /private/service-state/endpoint.json \
  --credential-file /private/service-state/client-writer.json
```

支持 stdio MCP 的宿主可采用以下配置，具体配置文件位置由所用宿主决定：

```json
{
  "mcpServers": {
    "marktext": {
      "command": "bun",
      "args": ["/path/to/release/tools/marktext-mcp.js", "--endpoint-file", "/private/service-state/endpoint.json", "--credential-file", "/private/service-state/client-writer.json"]
    }
  }
}
```

Codex 的 stdio 命令注册方式可参考[官方 MCP 文档](https://developers.openai.com/codex/mcp/)。本项目不会自动改写用户已有宿主配置。移除相应 MCP server 项即可卸载工具桥，客户端凭证的撤销在协作桌面执行；移除配置不等于撤销已发出的授权。

## 文档能力

单一能力定义在 protocol.ts，版本化副本由 `bun tools/generate-contract.ts` 生成。目录按当前有效权限过滤，工具调用仍逐次鉴权，缓存的工具描述不能覆盖撤销。执行策略是本项目元数据，未冒充 Dopame 原生字段。

| 工具 | 用途 | 执行依赖 |
| --- | --- | --- |
| marktext_documents_create | 标题及 Markdown/固定产物创建文档 | 执行器 |
| marktext_documents_read / outline | 读取指定已发布 revision | 服务，不唤醒编辑器 |
| marktext_documents_propose | 保留原文，提交修改建议与差异 | 服务 |
| marktext_documents_apply | 核对版本后应用建议 | 执行器，预授权或用户批准 |
| marktext_documents_save | 将指定版本保存到已授权目标 | 执行器 |
| marktext_documents_export | 导出已发布版本的固定 Markdown 产物 | 服务 |
| marktext_documents_list / patch | 已有附加能力：分页列表、范围修改 | 服务 / 执行器 |

文档工具参数为 `{requestId, input, workflowId?, parentTaskId?, deadlineAt?}`。requestId 由发起方为一个逻辑任务稳定生成；断线重试保持相同 ID 和参数。文档引用必须显式包含 owner、documentId、revision，不读取“当前标签”猜测目标。

每次提交返回 taskId 和接受状态。用 marktext_get_task 查询状态，终态后用 marktext_get_result 获取结果。服务在线且已有结果时，这些查询不调用 open。任务未结束会返回 RESULT_NOT_READY；断开连接不会自动取消任务。

大于 64KiB 的请求元数据不接受全文。使用 begin_upload / write_chunk / commit_upload 上传最多 2MiB UTF-8 正文，再把 ArtifactRef 传给 create 或 propose。read_artifact 按字节范围返回 base64，客户端按顺序拼接后解码，不能逐块独立解码而截断中文或 emoji。建议差异 JSON 同样受 2MiB 产物上限约束，过大的差异明确失败。

## 协作交接

写作会话创建后，将文档的 read/propose 等有限动作通过 share 转授给已配对审阅身份。审阅会话不能凭知道 documentId 获得访问权。建议返回后，可以将 proposal 和 task 的读取权转交给写作会话，或由用户在编辑器查看差异并确认应用。apply/save 仍各自需要相应文档权限；仅建议权限不能修改正文。

导出的 ArtifactRef 是固定内容摘要版本，修改文档不会改变旧产物。转交引用时同时转交有限授权。撤销来源授权会使下游派生访问失效；不声称能收回此前已被合法读取、复制到其它位置的明文。

## 最小 TypeScript 客户端

交付包的 client 目录包含 ESM、类型声明和 package.json，不依赖源码目录：

```ts
import { createClient } from '@marktext/dopame-client'
import { HttpTransport, readPrivateJson } from '@marktext/dopame-client/http'
const credential = readPrivateJson('/private/client-writer.json')
const client = createClient(new HttpTransport('/private/endpoint.json'), credential.token)
const capabilities = await client.listCapabilities()
const receipt = await client.request('documents.create', { title: '报告', markdown: '# 报告\n' }, 'stable-workflow-create-1')
const { task, result } = await client.wait(receipt.taskId)
```

上述路径只用于宿主本机配置；跨 Agent 的文档交接使用引用和授权。协议与工具格式依据 [MCP 工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)、[stdio 传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。
