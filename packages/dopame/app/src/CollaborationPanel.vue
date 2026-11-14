<script setup lang="ts">
withDefaults(
  defineProps<{
    connected: boolean
    error: string
    tasks: any[]
    loading?: boolean
  }>(),
  { loading: false }
)
const emit = defineEmits<{
  close: []
  refresh: []
  proposal: [id: string]
}>()
const stateNames: Record<string, string> = {
  queued: '排队中',
  'waiting-approval': '等待确认',
  running: '进行中',
  committing: '正在提交',
  recovering: '正在恢复',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消'
}
const capabilityNames: Record<string, string> = {
  'documents.list': '文档列表',
  'documents.create': '创建文档',
  'documents.read': '读取文档',
  'documents.outline': '读取大纲',
  'documents.patch': '修改文档',
  'documents.propose': '修改建议',
  'documents.apply': '应用建议',
  'documents.save': '保存文档',
  'documents.export': '导出文档'
}
const time = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})
</script>

<template>
  <aside
    class="task-drawer"
    aria-label="协作任务"
    :aria-busy="loading"
    @keydown.esc.stop.prevent="emit('close')"
  >
    <div class="drawer-heading">
      <h2>协作任务</h2>
      <button type="button" aria-label="关闭协作任务" @click="emit('close')">×</button>
    </div>
    <p class="connection-state" role="status" aria-label="协作连接">
      {{ connected ? '已连接 Agent OS' : '尚未配对' }}
    </p>
    <p v-if="!connected" class="connection-help quiet">
      完成系统配对后，已授权调用方的文档任务会显示在这里。
    </p>
    <div class="task-actions">
      <button type="button" aria-label="刷新任务" :disabled="loading" @click="emit('refresh')">
        {{ loading ? '刷新中…' : '刷新任务' }}
      </button>
    </div>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-else-if="connected && !tasks.length && !loading" class="quiet">目前没有协作任务</p>
    <div v-for="task in tasks" :key="task.taskId" class="task-row">
      <div>
        <strong>{{ capabilityNames[task.capability] ?? task.capability }}</strong>
        <span class="task-state">{{ stateNames[task.state] ?? task.state }}</span>
      </div>
      <p>{{ task.source.label }} · {{ task.stage }}</p>
      <small class="num">
        {{ time.format(new Date(task.updatedAt)) }} · {{ task.taskId.slice(0, 8) }}
      </small>
      <p v-if="task.error" class="error-text">{{ task.error.code }} · {{ task.error.message }}</p>
      <button v-if="task.proposalId" type="button" @click="emit('proposal', task.proposalId)">
        查看建议差异
      </button>
    </div>
  </aside>
</template>

<style scoped>
.connection-state {
  margin: 18px 0 6px;
  font-size: 13px;
  font-weight: 500;
}
.connection-help {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
}
.task-actions {
  margin: 14px 0;
}
.task-actions button {
  padding: 5px 10px;
  border-color: var(--border);
  font-size: 13px;
}
.drawer-heading button {
  min-width: 36px;
  min-height: 36px;
}
.task-state {
  white-space: nowrap;
}
@media (max-width: 760px) {
  .drawer-heading button,
  .task-actions button,
  .task-row button {
    min-height: 44px;
    min-width: 44px;
  }
}
</style>
