<script setup lang="ts">
/**
 * 整编室 · 关系点据与定线：
 *  - 点据只能从外业已报出的断面流量成果落入（收件区选取），不能凭空录入；
 *  - 报出后外业改动 → 相关点据自动挂起（held），人工「确认有效/判定弃用」；
 *  - 重新定线按在案点据拟合、追加比测结论批次并送交外业（旧结论留存）；
 *  - 可模拟送交失败：失败后只由整编室按本侧重试，外业那份不动。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  CircleCheck,
  CircleClose,
  Promotion,
  Refresh,
  RefreshRight,
  TrendCharts,
  Warning
} from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import DeviationTag from '@/components/common/DeviationTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useRatingStore, type ReportOption } from '@/stores/ratingStore'
import { isChannelBlocked, setChannelBlocked } from '@/utils/transport'
import { curveFlow } from '@/types/rating'
import type { RatingPoint } from '@/types/office'

const store = useRatingStore()

const blockOfficeToField = ref(false)
const busy = ref(false)
const newLineNo = ref('')
const reviewNote = ref('')
const reviewingId = ref<string | null>(null)
const reviewDialogVisible = ref(false)

const lineNos = computed(() => (store.lineNos.length > 0 ? store.lineNos : ['A']))
const fit = computed(() => store.activeFit)

const stationNameOf = (id: string): string => store.stationNameOf(id)

/** 待落点的外业报出成果（当前线、未在案、未被取代） */
const inboxReports = ref<ReportOption[]>([])
async function loadReports(): Promise<void> {
  inboxReports.value = await store.reportOptions(store.activeLineNo)
}

const availableInbox = computed(() => inboxReports.value.filter((r) => !r.used))

async function refreshAll(): Promise<void> {
  const result = await store.refreshInbox()
  await loadReports()
  await store.syncDispatchStates()
  if (result.reports > 0) ElMessage.success(`收到 ${result.reports} 份新的断面流量报出`)
  if (result.held > 0) ElMessage.warning(`${result.held} 条点据因外业报出后改动已挂起，待复核`)
}

function selectLine(lineNo: string): void {
  store.setActiveLine(lineNo)
  void loadReports()
}

async function addPoint(report: ReportOption): Promise<void> {
  try {
    await store.addPointFromReport(report.id, store.activeLineNo)
    ElMessage.success(`已把测次 ${report.measureNo} 的报出成果落到 ${store.activeLineNo} 线`)
    await loadReports()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '落点失败')
  }
}

async function addNewLine(): Promise<void> {
  const lineNo = newLineNo.value.trim()
  if (!lineNo) {
    ElMessage.warning('请输入定线号，如 D')
    return
  }
  const stationId = store.stations[0]?.id ?? ''
  if (!stationId) {
    ElMessage.warning('还没有测站名册（等待外业档案同步）')
    return
  }
  await store.addLine(lineNo, stationId)
  newLineNo.value = ''
  store.setActiveLine(lineNo)
  await loadReports()
  ElMessage.success(`已新增定线号 ${lineNo}`)
}

function statusTag(point: RatingPoint): { type: 'success' | 'warning' | 'info' | 'danger'; text: string } {
  switch (point.status) {
    case 'active':
      return { type: 'success', text: '在案' }
    case 'resolved':
      return { type: 'success', text: '复核有效' }
    case 'held':
      return { type: 'warning', text: '挂起待复核' }
    case 'rejected':
      return { type: 'danger', text: '已弃用' }
  }
}

/** 曲线坐标（只画在案点据） */
const chart = computed(() => {
  const rows = store.pointRows.filter((r) => r.point.status === 'active' || r.point.status === 'resolved')
  if (rows.length === 0) {
    return { samples: '', points: [] as Array<{ id: string; cx: number; cy: number; over: boolean }>, min: 0, max: 0, flowMax: 0 }
  }
  const stages = rows.map((r) => r.point.stageM)
  const flows = rows.map((r) => r.point.flowM3s)
  const min = Math.min(...stages)
  const max = Math.max(...stages)
  const flowMax = Math.max(...flows) * 1.1
  const left = 52
  const right = 328
  const top = 20
  const bottom = 190
  const toX = (stage: number) => (max - min < 1e-6 ? (left + right) / 2 : left + ((stage - min) / (max - min)) * (right - left))
  const toY = (flow: number) => bottom - (flow / flowMax) * (bottom - top)
  const samples = Array.from({ length: 13 }, (_, index) => {
    const stage = min + ((max - min) * index) / 12
    const value = fit.value.valid ? curveFlow(fit.value, stage) : 0
    return `${toX(stage).toFixed(1)},${toY(value).toFixed(1)}`
  }).join(' ')
  return {
    samples,
    min,
    max,
    flowMax,
    points: rows.map((r) => ({
      id: r.point.id,
      cx: toX(r.point.stageM),
      cy: toY(r.point.flowM3s),
      over: r.verdict === '超限'
    }))
  }
})

/** 重新定线 → 追加比测结论 → 送交外业（失败仅本侧 outbox 留痕） */
async function refitAndSend(): Promise<void> {
  busy.value = true
  try {
    const { run } = await store.refitAndDispatch()
    if (run.dispatchStatus === 'delivered') {
      ElMessage.success(
        `${store.activeLineNo} 线重新定线完成：合格 ${run.qualified}/${run.total}，比测结论已送交外业`
      )
    } else {
      ElMessage.warning(`比测结论已生成但送交失败：${run.lastDispatchError || '通道故障'}。可点「按本侧重试送交」。`)
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '定线失败')
  } finally {
    busy.value = false
  }
}

async function retryDispatch(): Promise<void> {
  busy.value = true
  try {
    const result = await store.retryDispatch()
    if (result.sent > 0) ElMessage.success(`已按本侧重试送交 ${result.sent} 条结论（外业那份数据未改动）`)
    else if (result.stillFailing > 0) ElMessage.warning('通道仍故障，继续保留在本侧发件箱待重试')
    else ElMessage.success('发件箱已清空')
  } finally {
    busy.value = false
  }
}

function openReview(point: RatingPoint): void {
  reviewingId.value = point.id
  reviewNote.value = point.holdNote
  reviewDialogVisible.value = true
}

async function doReview(action: 'resolve' | 'reject'): Promise<void> {
  if (!reviewingId.value) return
  try {
    if (action === 'resolve') {
      await store.resolvePoint(reviewingId.value, reviewNote.value || '复核确认有效')
      ElMessage.success('点据已恢复参与定线')
    } else {
      await store.rejectPoint(reviewingId.value, reviewNote.value || '复核判定弃用')
      ElMessage.success('点据已弃用（记录留档，不再参与定线）')
    }
    reviewDialogVisible.value = false
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '复核失败')
  }
}

async function removePoint(point: RatingPoint): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除点据「${point.measureNo}」？历史比测结论仍会保留。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await store.deletePoint(point.id)
  await loadReports()
  ElMessage.success('点据已删除')
}

function toggleBlock(value: boolean): void {
  blockOfficeToField.value = value
  setChannelBlocked('office', 'field', value)
  ElMessage.info(value ? '已模拟「整编 → 外业」通道故障：送交将失败并只在整编侧待重试' : '通道已恢复，可重试送交')
}

onMounted(async () => {
  blockOfficeToField.value = isChannelBlocked('office', 'field')
  await refreshAll()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">关系点据与定线 <span class="page__sub">（整编室）</span></h2>
        <p class="gb-hint">
          点据只从外业已算出断面流量并报出的测次落入；挂起点据不参与定线也不挡别的。重新定线后比测结论追加留存并送交外业。
        </p>
      </div>
      <div class="page__actions">
        <el-select :model-value="store.activeLineNo" class="page__line-select" @change="(v: unknown) => selectLine(String(v))">
          <el-option v-for="lineNo in lineNos" :key="lineNo" :label="`${lineNo} 线`" :value="lineNo" />
        </el-select>
        <el-button :icon="RefreshRight" @click="refreshAll">收取报出</el-button>
        <el-button type="primary" :icon="TrendCharts" :loading="busy" @click="refitAndSend">重新定线并送交</el-button>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="在案点据" :value="store.fittingPointsOfActiveLine.length" suffix="点" icon="DataLine" />
      <StatBadge
        label="定线系数 a"
        :value="fit.valid ? fit.a : '—'"
        :suffix="fit.valid ? `b=${fit.b}` : '未定线'"
        tone="info"
        icon="TrendCharts"
      />
      <StatBadge
        label="平均残差"
        :value="fit.valid ? fit.meanResidualPct : '—'"
        suffix="%"
        :tone="fit.valid && fit.meanResidualPct <= store.deviationLimitPct ? 'success' : 'warning'"
        icon="Histogram"
      />
      <StatBadge
        label="挂起待复核"
        :value="store.heldPoints.length"
        suffix="点"
        :tone="store.heldPoints.length > 0 ? 'warning' : 'success'"
        icon="Warning"
      />
    </div>

    <el-alert
      v-if="store.heldPoints.length > 0"
      type="warning"
      show-icon
      :closable="false"
      :title="`有 ${store.heldPoints.length} 条点据因外业报出后又改动垂线/测点而挂起，等人复核（不影响其他点据定线）。`"
    />

    <!-- 外业报出收件区：落点据唯一入口 -->
    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>外业报出成果 · 可落点据（{{ store.activeLineNo }} 线）</h3>
        <span class="gb-hint">整编室落点据只认这里；已被更新版本取代的报出不显示</span>
      </div>
      <EmptyPanel
        v-if="availableInbox.length === 0"
        title="暂无可落的报出成果"
        description="等待外业组报出断面流量，或点右上角「收取报出」。同一测次在同一线号只保留一个在案点据。"
        compact
      />
      <el-table v-else :data="availableInbox" border size="small" class="gb-table-compact">
        <el-table-column prop="measureNo" label="测次号" min-width="130" />
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
            <span class="gb-mono">{{ row.flowM3s.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="垂线/测点" width="110" align="center">
          <template #default="{ row }">{{ row.verticalCount }} / {{ row.pointCount }}</template>
        </el-table-column>
        <el-table-column label="报出时间" min-width="160">
          <template #default="{ row }">
            <span class="gb-mono">{{ new Date(row.reportedAt).toLocaleString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" :icon="Promotion" @click="addPoint(row)">落为点据</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="page__newline">
        <span class="gb-hint">新增定线号：</span>
        <el-input v-model="newLineNo" placeholder="如 D" maxlength="8" class="page__newline-input" />
        <el-button size="small" @click="addNewLine">建线</el-button>
      </div>
    </el-card>

    <div class="page__grid">
      <el-card shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>{{ store.activeLineNo }} 线点据</h3>
          <span class="gb-hint">挂起/弃用点据不参与拟合</span>
        </div>
        <EmptyPanel
          v-if="store.pointRows.length === 0"
          title="该线还没有点据"
          description="从上方外业报出成果里「落为点据」。"
          compact
        />
        <el-table v-else :data="store.pointRows" border stripe size="small" class="gb-table-compact">
          <el-table-column label="水位" width="80" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.point.stageM.toFixed(2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="实测流量" width="90" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.point.flowM3s.toFixed(1) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="曲线流量" width="90" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.predicted > 0 ? row.predicted.toFixed(1) : '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="残差" width="160">
            <template #default="{ row }">
              <DeviationTag :deviation-pct="row.residualPct" :verdict="row.verdict" :limit="store.deviationLimitPct" />
            </template>
          </el-table-column>
          <el-table-column label="测次" min-width="120">
            <template #default="{ row }">
              <div class="gb-mono">{{ row.point.measureNo }}</div>
              <div class="gb-hint">v{{ row.point.sourceRevision }}</div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="statusTag(row.point).type" effect="plain">
                {{ statusTag(row.point).text }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="200" fixed="right">
            <template #default="{ row }">
              <el-button
                v-if="row.point.status === 'held'"
                size="small"
                type="warning"
                :icon="Warning"
                @click="openReview(row.point)"
              >
                复核
              </el-button>
              <el-button size="small" type="danger" plain :icon="CircleClose" @click="removePoint(row.point)">
                删除
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>{{ store.activeLineNo }} 线关系曲线</h3>
          <el-icon><TrendCharts /></el-icon>
        </div>
        <svg v-if="store.fittingPointsOfActiveLine.length > 0" viewBox="0 0 360 220" class="page__chart">
          <line x1="52" y1="190" x2="340" y2="190" stroke="#b9cfdd" />
          <line x1="52" y1="20" x2="52" y2="190" stroke="#b9cfdd" />
          <text x="52" y="208" class="gb-chart-axis">{{ chart.min.toFixed(2) }}</text>
          <text x="300" y="208" class="gb-chart-axis">{{ chart.max.toFixed(2) }} m</text>
          <polyline v-if="fit.valid" :points="chart.samples" fill="none" stroke="#0f4c75" stroke-width="2" />
          <circle
            v-for="point in chart.points"
            :key="point.id"
            :cx="point.cx"
            :cy="point.cy"
            r="4.5"
            :fill="point.over ? '#c0392b' : '#7fd1e8'"
            :stroke="point.over ? '#7b241c' : '#0f4c75'"
          />
        </svg>
        <EmptyPanel v-else title="暂无可绘制的点据" description="从报出成果落点据后生成曲线。" compact />
        <p class="gb-hint">红点为残差超限点；挂起/弃用点据不参与曲线。</p>
      </el-card>
    </div>

    <!-- 送交与重试（失败只有整编侧重试） -->
    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>送交外业 · 故障与重试</h3>
        <span class="gb-hint">比测结论重算后送交外业；送交失败只在整编室发件箱重试，外业那份数据不动</span>
      </div>
      <div class="page__dispatch">
        <el-switch
          :model-value="blockOfficeToField"
          active-text="模拟「整编 → 外业」通道故障"
          inline-prompt
          @change="toggleBlock"
        />
        <el-button :icon="Refresh" :loading="busy" :disabled="store.failedDispatchCount === 0" @click="retryDispatch">
          按本侧重试送交{{ store.failedDispatchCount > 0 ? `（${store.failedDispatchCount} 条待重试）` : '' }}
        </el-button>
        <el-tag v-if="store.latestRun" size="small" effect="plain">
          最新一轮：合格 {{ store.latestRun.qualified }} / 超限 {{ store.latestRun.overLimit }} ·
          送交状态「{{ ({ delivered: '已送达', failed: '失败待重试', pending: '发送中', none: '未送交' })[store.latestRun.dispatchStatus] }}」
        </el-tag>
      </div>
    </el-card>

    <!-- 挂起复核对话框 -->
    <el-dialog v-model="reviewDialogVisible" title="挂起点据复核" width="520px">
      <p class="gb-hint">
        外业在报出后改动了该测次的垂线或测点。确认新成果可信可「确认有效」恢复参与定线；判定不可用则「弃用」（记录留档）。
      </p>
      <el-input v-model="reviewNote" type="textarea" :rows="3" placeholder="复核意见" />
      <template #footer>
        <el-button @click="reviewDialogVisible = false">取消</el-button>
        <el-button type="success" :icon="CircleCheck" @click="doReview('resolve')">确认有效</el-button>
        <el-button type="danger" :icon="CircleClose" @click="doReview('reject')">判定弃用</el-button>
      </template>
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
  width: 110px;
}
.page__grid {
  display: grid;
  grid-template-columns: minmax(520px, 1.5fr) minmax(320px, 1fr);
  gap: 14px;
  align-items: start;
}
.page__chart {
  width: 100%;
  height: 240px;
}
.page__newline {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
.page__newline-input {
  width: 120px;
}
.page__dispatch {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
}
@media (max-width: 1180px) {
  .page__grid {
    grid-template-columns: 1fr;
  }
}
</style>
