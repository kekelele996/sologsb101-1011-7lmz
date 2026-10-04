<script setup lang="ts">
/**
 * 整编室 · 比测结论档案：
 *  - 每条定线的历轮比测结论（重新定线追加，旧结论照旧可查，不覆盖）；
 *  - 送交失败的批次在此按本侧重试（外业那份不动）；
 *  - 整编室库 JSON 导入导出。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download, Refresh, Upload } from '@element-plus/icons-vue'
import type { UploadFile } from 'element-plus'
import StatBadge from '@/components/common/StatBadge.vue'
import DeviationTag from '@/components/common/DeviationTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useRatingStore } from '@/stores/ratingStore'
import { officeDb, OFFICE_DB_NAME, OFFICE_DB_VERSION, readLastBackupAt } from '@/utils/officeDb'
import type { CompareRun } from '@/types/office'
import {
  exportOfficeJson,
  importOfficeBackup,
  readFileText,
  validateOfficeBackup,
  type OfficeBackupPayload
} from '@/utils/officeBackup'

const store = useRatingStore()

const selectedLine = ref<string>('')
const detailRun = ref<CompareRun | null>(null)
const detailVisible = ref(false)
const busy = ref(false)
const exporting = ref(false)
const importing = ref(false)
const overwriteOnImport = ref(true)
const fileList = ref<UploadFile[]>([])
const lastBackupAt = ref<string | null>(null)
const counts = ref({ reports: 0, points: 0, lines: 0, runs: 0, failed: 0, held: 0 })

const lineNos = computed(() => store.lineNos)

const shownRuns = computed(() =>
  store.compareRuns
    .filter((run) => !selectedLine.value || run.lineNo === selectedLine.value)
    .sort((a, b) => b.createdAt - a.createdAt)
)

function stationNameOf(id: string): string {
  return store.stationNameOf(id)
}

const dispatchMeta: Record<CompareRun['dispatchStatus'], { text: string; type: 'success' | 'warning' | 'info' }> = {
  delivered: { text: '已送达外业', type: 'success' },
  failed: { text: '失败·待本侧重试', type: 'warning' },
  pending: { text: '发送中', type: 'info' },
  none: { text: '未送交', type: 'info' }
}

function openDetail(run: CompareRun): void {
  detailRun.value = run
  detailVisible.value = true
}

async function resend(run: CompareRun): Promise<void> {
  busy.value = true
  try {
    await store.sendRun(run.id)
    await store.syncDispatchStates()
    const latest = store.compareRuns.find((r) => r.id === run.id)
    if (latest?.dispatchStatus === 'delivered') ElMessage.success('结论已送交外业')
    else ElMessage.warning('送交失败：已保留在整编室发件箱，可继续按本侧重试（外业那份不动）')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '送交失败')
  } finally {
    busy.value = false
  }
}

async function retryAll(): Promise<void> {
  busy.value = true
  try {
    const result = await store.retryDispatch()
    if (result.sent > 0) ElMessage.success(`已重试送交 ${result.sent} 条历史结论`)
    else if (result.stillFailing > 0) ElMessage.warning('通道仍故障，继续保留在本侧发件箱')
    else ElMessage.success('没有待重试的送交')
  } finally {
    busy.value = false
  }
}

async function refresh(): Promise<void> {
  await store.refreshInbox()
  await store.syncDispatchStates()
  const [reports, points, lines, runs, failed, held] = await Promise.all([
    officeDb.inReports.count(),
    officeDb.ratingPoints.count(),
    officeDb.ratingLines.count(),
    officeDb.compareRuns.count(),
    officeDb.compareRuns.where('dispatchStatus').equals('failed').count(),
    officeDb.ratingPoints.where('status').equals('held').count()
  ])
  counts.value = { reports, points, lines, runs, failed, held }
  lastBackupAt.value = readLastBackupAt()
  if (!selectedLine.value && lineNos.value.length > 0) selectedLine.value = lineNos.value[0]
}

async function handleExport(): Promise<void> {
  exporting.value = true
  try {
    const result = await exportOfficeJson()
    ElMessage.success(`已导出整编室库（${result.total} 条记录）`)
  } finally {
    exporting.value = false
  }
}

async function handleImport(): Promise<void> {
  const file = fileList.value[0]?.raw
  if (!file) {
    ElMessage.warning('请先选择整编室库备份 JSON')
    return
  }
  importing.value = true
  try {
    const text = await readFileText(file)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      ElMessage.error('文件不是合法 JSON')
      return
    }
    const validation = validateOfficeBackup(parsed)
    if (!validation.ok || !validation.payload) {
      ElMessage.error(`备份校验失败：${validation.errors.join('；')}`)
      return
    }
    const payload: OfficeBackupPayload = validation.payload
    await ElMessageBox.confirm(
      overwriteOnImport.value ? '覆盖模式会先清空整编室库（外业库不动），确认导入？' : '追加模式导入，确认继续？',
      '导入确认',
      { type: 'warning', confirmButtonText: '继续导入', cancelButtonText: '取消' }
    )
    await importOfficeBackup(payload, overwriteOnImport.value)
    ElMessage.success('整编室库导入完成（外业那份未改动）')
    await refresh()
  } finally {
    importing.value = false
  }
}

onMounted(() => {
  void refresh()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">比测结论档案 <span class="page__sub">（整编室）</span></h2>
        <p class="gb-hint">
          重新定线后比测结论按轮次追加留存，旧结论照旧可查；送交失败只有整编室按本侧重试，外业那份不动。
        </p>
      </div>
      <div class="page__actions">
        <el-select v-model="selectedLine" placeholder="全部定线号" clearable class="page__line-select">
          <el-option v-for="lineNo in lineNos" :key="lineNo" :label="`${lineNo} 线`" :value="lineNo" />
        </el-select>
        <el-button :icon="Refresh" :loading="busy" :disabled="counts.failed === 0" @click="retryAll">
          重试全部失败送交{{ counts.failed > 0 ? `（${counts.failed}）` : '' }}
        </el-button>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="报出成果" :value="counts.reports" suffix="份" icon="Promotion" />
      <StatBadge label="点据" :value="counts.points" suffix="点" tone="info" icon="DataLine" />
      <StatBadge label="结论批次" :value="counts.runs" suffix="轮" tone="success" icon="PieChart" />
      <StatBadge
        label="待重试送交"
        :value="counts.failed"
        suffix="条"
        :tone="counts.failed > 0 ? 'warning' : 'success'"
        icon="WarningFilled"
      />
    </div>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>历轮比测结论（旧结论可查）</h3>
        <span class="gb-hint">每一轮都保留当时的定线参数与逐点偏差，不随后续重定线被覆盖</span>
      </div>
      <EmptyPanel
        v-if="shownRuns.length === 0"
        title="还没有比测结论"
        description="在「关系点据与定线」页执行重新定线后，结论批次会追加到这里。"
      />
      <el-table v-else :data="shownRuns" border stripe class="gb-table-compact">
        <el-table-column label="定线号" width="80" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.lineNo }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="测站" min-width="120">
          <template #default="{ row }">{{ stationNameOf(row.stationId) }}</template>
        </el-table-column>
        <el-table-column label="定线 Q=a(H-H0)^b" min-width="240">
          <template #default="{ row }">
            <span v-if="row.valid" class="gb-mono">
              a={{ row.a }} · b={{ row.b }} · H0={{ row.h0 }} · R²={{ row.r2 }}
            </span>
            <span v-else class="gb-hint">未定线（点据不足）</span>
          </template>
        </el-table-column>
        <el-table-column label="合格/超限" width="120" align="center">
          <template #default="{ row }">
            <el-tag size="small" type="success" effect="plain">{{ row.qualified }}</el-tag>
            /
            <el-tag size="small" :type="row.overLimit > 0 ? 'danger' : 'info'" effect="plain">{{ row.overLimit }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="比测人 / 时间" min-width="170">
          <template #default="{ row }">
            <div>{{ row.operator }}</div>
            <div class="gb-hint gb-mono">{{ new Date(row.concludedAt).toLocaleString('zh-CN') }}</div>
          </template>
        </el-table-column>
        <el-table-column label="送交状态" width="150" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="dispatchMeta[row.dispatchStatus as CompareRun['dispatchStatus']].type" effect="plain">
              {{ dispatchMeta[row.dispatchStatus as CompareRun['dispatchStatus']].text }}
            </el-tag>
            <div v-if="row.dispatchStatus === 'failed'" class="gb-hint page__err">{{ row.lastDispatchError }}</div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="openDetail(row)">查看明细</el-button>
            <el-button
              v-if="row.dispatchStatus === 'failed' || row.dispatchStatus === 'none'"
              size="small"
              text
              type="warning"
              :loading="busy"
              @click="resend(row)"
            >
              按本侧重试
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>整编室库 JSON 备份</h3>
        <span class="gb-hint">
          {{ OFFICE_DB_NAME }} v{{ OFFICE_DB_VERSION }} · 最近备份
          {{ lastBackupAt ? new Date(lastBackupAt).toLocaleString('zh-CN') : '尚未备份' }}
        </span>
      </div>
      <el-form label-width="110px">
        <el-form-item label="导入模式">
          <el-radio-group v-model="overwriteOnImport">
            <el-radio :value="true">覆盖（仅清整编室库，外业不动）</el-radio>
            <el-radio :value="false">追加</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="备份文件">
          <el-upload v-model:file-list="fileList" :auto-upload="false" :limit="1" accept="application/json">
            <el-button :icon="Upload">选择整编室库 JSON</el-button>
          </el-upload>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Upload" :loading="importing" @click="handleImport">导入</el-button>
          <el-button :icon="Download" :loading="exporting" @click="handleExport">导出整编室库</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-dialog v-model="detailVisible" title="比测结论明细（历史留档）" width="760px">
      <div v-if="detailRun">
        <p class="gb-hint">
          {{ stationNameOf(detailRun.stationId) }} · {{ detailRun.lineNo }} 线 ·
          {{ new Date(detailRun.concludedAt).toLocaleString('zh-CN') }} · {{ detailRun.operator }}
        </p>
        <el-table :data="detailRun.items" border size="small" class="gb-table-compact">
          <el-table-column prop="measureNo" label="测次号" min-width="130" />
          <el-table-column label="水位" width="80" align="right">
            <template #default="{ row }">{{ row.stageM.toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="实测" width="90" align="right">
            <template #default="{ row }">{{ row.measuredFlow.toFixed(1) }}</template>
          </el-table-column>
          <el-table-column label="曲线" width="90" align="right">
            <template #default="{ row }">{{ row.curveFlow.toFixed(1) }}</template>
          </el-table-column>
          <el-table-column label="偏差判定" width="200">
            <template #default="{ row }">
              <DeviationTag :deviation-pct="row.deviationPct" :verdict="row.verdict" :limit="8" />
            </template>
          </el-table-column>
          <el-table-column label="当时点据状态" width="120" align="center">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ row.pointStatus === 'held' ? '挂起' : row.pointStatus === 'rejected' ? '弃用' : '在案' }}</el-tag>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.page__head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}
.page__sub {
  font-size: 13px;
  color: #8194a2;
}
.page__actions {
  display: flex;
  gap: 8px;
}
.page__line-select {
  width: 150px;
}
.page__err {
  max-width: 150px;
  color: #c0392b;
}
</style>
