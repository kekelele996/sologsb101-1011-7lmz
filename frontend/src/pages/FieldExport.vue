<script setup lang="ts">
/**
 * 外业 · 成果与备份：
 *  - 各测次断面流量报出状态（外业属主数据）；
 *  - 整编室送交来的比测结论（只读，按批次留存，新旧都可查）；
 *  - 外业库 JSON 导入导出（不含整编室点据/定线）。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download, RefreshRight, Upload } from '@element-plus/icons-vue'
import type { UploadFile } from 'element-plus'
import StatBadge from '@/components/common/StatBadge.vue'
import DeviationTag from '@/components/common/DeviationTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useStationStore } from '@/stores/stationStore'
import { useSectionStore } from '@/stores/sectionStore'
import { fieldDb, FIELD_DB_NAME, FIELD_DB_VERSION, readLastBackupAt } from '@/utils/fieldDb'
import { listConclusions } from '@/utils/fieldMessages'
import { resetBothDatabases } from '@/utils/bootstrap'
import {
  exportFieldJson,
  importFieldBackup,
  readFileText,
  validateFieldBackup,
  type FieldBackupPayload
} from '@/utils/fieldBackup'
import type { CompareConclusionPayload } from '@/types/dispatch'

const stationStore = useStationStore()
const sectionStore = useSectionStore()

const conclusions = ref<Array<{ id: string; receivedAt: number; payload: CompareConclusionPayload }>>([])
const detailRun = ref<CompareConclusionPayload | null>(null)
const detailVisible = ref(false)
const lastBackupAt = ref<string | null>(null)
const fileList = ref<UploadFile[]>([])
const overwriteOnImport = ref(true)
const importing = ref(false)
const exporting = ref(false)
const counts = ref({ stations: 0, sections: 0, verticals: 0, points: 0, outbox: 0, inbox: 0 })

const stationNameOf = (id: string): string => stationStore.stationById(id)?.name ?? '未知测站'

const reportedRows = computed(() =>
  sectionStore.sections
    .filter((s) => s.reported)
    .sort((a, b) => Date.parse(b.reportedAt ?? '') - Date.parse(a.reportedAt ?? ''))
)

const dirtyReportedCount = computed(
  () => sectionStore.sections.filter((s) => s.reported && s.revision > s.reportedRevision).length
)

async function refresh(): Promise<void> {
  const [stations, sections, verticals, points, outbox, inbox, rows] = await Promise.all([
    fieldDb.stations.count(),
    fieldDb.sections.count(),
    fieldDb.verticals.count(),
    fieldDb.points.count(),
    fieldDb.outbox.count(),
    fieldDb.inbox.count(),
    listConclusions()
  ])
  counts.value = { stations, sections, verticals, points, outbox, inbox }
  conclusions.value = rows
  lastBackupAt.value = readLastBackupAt()
}

function openDetail(row: { payload: CompareConclusionPayload }): void {
  detailRun.value = row.payload
  detailVisible.value = true
}

async function handleExport(): Promise<void> {
  exporting.value = true
  try {
    const result = await exportFieldJson()
    ElMessage.success(`已导出 ${result.fileName}（${result.total} 条外业记录）`)
    await refresh()
  } finally {
    exporting.value = false
  }
}

async function handleImport(): Promise<void> {
  const file = fileList.value[0]?.raw
  if (!file) {
    ElMessage.warning('请先选择外业库备份 JSON')
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
    const validation = validateFieldBackup(parsed)
    if (!validation.ok || !validation.payload) {
      ElMessage.error(`备份校验失败：${validation.errors.join('；')}`)
      return
    }
    const payload: FieldBackupPayload = validation.payload
    await ElMessageBox.confirm(
      overwriteOnImport.value
        ? '覆盖模式会先清空外业库（整编室库不动），确认导入？'
        : '追加模式可能产生重复主键，建议仅作恢复用途。确认导入？',
      '导入确认',
      { type: 'warning', confirmButtonText: '继续导入', cancelButtonText: '取消' }
    )
    await importFieldBackup(payload, overwriteOnImport.value)
    ElMessage.success('外业库导入完成（整编室那份未改动）')
    await refresh()
  } finally {
    importing.value = false
  }
}

async function handleReset(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '将清空外业库与整编室库并重建演示双库数据（用于重新演示分权流程）。确认继续？',
      '重置双库',
      { type: 'warning', confirmButtonText: '清空并重建', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await resetBothDatabases()
  await refresh()
  ElMessage.success('双库已重建为演示数据')
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
        <h2 class="page__title">外业成果与备份</h2>
        <p class="gb-hint">
          这里只放外业组持有的数据：测次断面流量报出状态、整编室送交的比测结论（只读留档），以及外业库备份。
        </p>
      </div>
      <el-button :icon="RefreshRight" @click="refresh">刷新</el-button>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="测站 / 测次" :value="`${counts.stations} / ${counts.sections}`" icon="Odometer" />
      <StatBadge label="垂线 / 测点" :value="`${counts.verticals} / ${counts.points}`" tone="info" icon="Histogram" />
      <StatBadge label="已报出测次" :value="reportedRows.length" suffix="次" tone="success" icon="Promotion" />
      <StatBadge
        label="报出后有改动"
        :value="dirtyReportedCount"
        suffix="次"
        :tone="dirtyReportedCount > 0 ? 'warning' : 'success'"
        icon="WarningFilled"
      />
    </div>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>断面流量报出台账</h3>
        <span class="gb-hint">整编室只认这些已算出断面流量的测次落点据</span>
      </div>
      <EmptyPanel
        v-if="reportedRows.length === 0"
        title="还没有报出的测次"
        description="在测次下补齐垂线测深与流速测点，算出断面流量后点「报出成果」。"
        compact
      />
      <el-table v-else :data="reportedRows" border stripe size="small" class="gb-table-compact">
        <el-table-column prop="measureNo" label="测次号" min-width="140" />
        <el-table-column label="测站" min-width="120">
          <template #default="{ row }">{{ stationNameOf(row.stationId) }}</template>
        </el-table-column>
        <el-table-column label="水位 (m)" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.stageM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="报出流量 (m³/s)" width="150" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ (row.reportedFlowM3s ?? 0).toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="版本 / 状态" width="170" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">v{{ row.reportedRevision }}</el-tag>
            <el-tag
              v-if="row.revision > row.reportedRevision"
              size="small"
              type="warning"
              effect="plain"
              style="margin-left: 4px"
            >
              报出后已改动 v{{ row.revision }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="报出时间" min-width="170">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.reportedAt ? new Date(row.reportedAt).toLocaleString('zh-CN') : '—' }}</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>整编室送交的比测结论</h3>
        <span class="gb-hint">外业只读留档；整编室重新定线后送交新一轮，旧结论照旧可查</span>
      </div>
      <EmptyPanel
        v-if="conclusions.length === 0"
        title="还没有收到比测结论"
        description="整编室重新定线并送交后，结论会出现在这里。"
        compact
      />
      <el-table v-else :data="conclusions" border stripe size="small" class="gb-table-compact">
        <el-table-column label="定线号" width="90" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.payload.lineNo }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="测站" min-width="120">
          <template #default="{ row }">{{ row.payload.stationName }}</template>
        </el-table-column>
        <el-table-column label="定线成果 Q=a(H-H0)^b" min-width="260">
          <template #default="{ row }">
            <span v-if="row.payload.fit.valid" class="gb-mono">
              a={{ row.payload.fit.a }} · b={{ row.payload.fit.b }} · H0={{ row.payload.fit.h0 }}
            </span>
            <span v-else class="gb-hint">未定线</span>
          </template>
        </el-table-column>
        <el-table-column label="合格 / 超限" width="130" align="center">
          <template #default="{ row }">
            <el-tag size="small" type="success" effect="plain">{{ row.payload.summary.qualified }}</el-tag>
            /
            <el-tag size="small" :type="row.payload.summary.overLimit > 0 ? 'danger' : 'info'" effect="plain">
              {{ row.payload.summary.overLimit }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="比测人" width="100">
          <template #default="{ row }">{{ row.payload.operator }}</template>
        </el-table-column>
        <el-table-column label="收到时间" min-width="170">
          <template #default="{ row }">
            <span class="gb-mono">{{ new Date(row.receivedAt).toLocaleString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="openDetail(row)">查看明细</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>外业库 JSON 备份</h3>
        <span class="gb-hint">
          {{ FIELD_DB_NAME }} v{{ FIELD_DB_VERSION }} · 最近备份
          {{ lastBackupAt ? new Date(lastBackupAt).toLocaleString('zh-CN') : '尚未备份' }}
        </span>
      </div>
      <el-form label-width="110px">
        <el-form-item label="导入模式">
          <el-radio-group v-model="overwriteOnImport">
            <el-radio :value="true">覆盖（仅清外业库，整编室不动）</el-radio>
            <el-radio :value="false">追加</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="备份文件">
          <el-upload v-model:file-list="fileList" :auto-upload="false" :limit="1" accept="application/json">
            <el-button :icon="Upload">选择外业库 JSON</el-button>
          </el-upload>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Upload" :loading="importing" @click="handleImport">导入</el-button>
          <el-button :icon="Download" :loading="exporting" @click="handleExport">导出外业库</el-button>
          <el-button type="danger" plain @click="handleReset">重建演示双库</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-dialog v-model="detailVisible" title="比测结论明细" width="720px">
      <div v-if="detailRun">
        <p class="gb-hint">
          {{ detailRun.stationName }} · {{ detailRun.lineNo }} 线 · 比测人 {{ detailRun.operator }} ·
          {{ new Date(detailRun.concludedAt).toLocaleString('zh-CN') }}
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
          <el-table-column label="偏差判定" width="190">
            <template #default="{ row }">
              <DeviationTag :deviation-pct="row.deviationPct" :verdict="row.verdict" :limit="8" />
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
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}
</style>
