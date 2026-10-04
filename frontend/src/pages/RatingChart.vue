<script setup lang="ts">
/**
 * 模块 5：/ratings 水位流量关系点据与定线（整编室）
 *
 * - 落点据只认外业组已算出断面流量、且已报出的测次（送交快照：水位 / 流量 / 成果版本）；
 * - 幂函数拟合 Q = a×(H-H0)^b，仅正常点据参与，残差超限挂红；
 * - 外业报出后又改垂线测点的源测次，其点据自动挂起等人复核，只挂一条不挡别的；
 * - 重新定线后比测结论追加新版本，旧版本照旧可查；
 * - 送交失败只在本侧（整编库）重试，外业那份成果不动。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  CircleCheck,
  Connection,
  Delete,
  Refresh,
  RefreshRight,
  Timer,
  TrendCharts,
  View,
  Warning
} from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import StatBadge from '@/components/common/StatBadge.vue'
import DeviationTag from '@/components/common/DeviationTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useRatingStore } from '@/stores/ratingStore'
import { useStationStore } from '@/stores/stationStore'
import type { Rating, RatingFitResult } from '@/types/rating'
import type { CompareConclusion } from '@/types/compare'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const ratingStore = useRatingStore()
const stationStore = useStationStore()

/* ----------------------- 从已报出测次送交落点据 ----------------------- */
const dialogVisible = ref(false)
const submitting = ref(false)
const form = reactive({
  sectionId: '',
  lineNo: 'A'
})

/** 落点据对话框里可选的测次（已报出且当前版本尚未在该定线号落过） */
const dialogCandidates = computed(() =>
  ratingStore.reportedCandidates.filter(
    (candidate) => !candidate.usedByLines.includes(form.lineNo.trim() || 'A')
  )
)

const selectedCandidate = computed(() => ratingStore.candidateOfSection(form.sectionId))

/** 当前定线号下正常点据的拟合结果 */
const fit = computed<RatingFitResult>(() => ratingStore.activeFit)
const lineNos = computed(() => (ratingStore.lineNos.length > 0 ? ratingStore.lineNos : ['A']))

/** 当前定线号点据（正常 + 挂起） */
const pointRows = computed(() => ratingStore.pointRows)

const currentLineRows = computed(() =>
  pointRows.value
    .filter((row) => {
      const keyword = ratingStore.filter.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${row.rating.measureNo}${row.rating.lineNo}${ratingStore.stationNameOf(row.rating.stationId)}`
        if (!haystack.includes(keyword)) return false
      }
      if (ratingStore.filter.stationIds.length > 0 && !ratingStore.filter.stationIds.includes(row.rating.stationId))
        return false
      if (ratingStore.filter.statuses.length > 0 && !ratingStore.filter.statuses.includes(row.rating.status))
        return false
      return true
    })
)

const suspendedRows = computed(() => pointRows.value.filter((row) => row.rating.status === '挂起'))
const allSuspended = computed(() => ratingStore.suspendedRatings)
const failedDeliveries = computed(() => ratingStore.failedDeliveries)
const currentConclusion = computed<CompareConclusion | null>(() =>
  ratingStore.currentConclusion(ratingStore.activeLineNo)
)

const filterModel = computed<FilterModel>(() => ({
  keyword: ratingStore.filter.keyword,
  stationIds: ratingStore.filter.stationIds,
  lineNos: ratingStore.filter.lineNos,
  verdicts: ratingStore.filter.verdicts,
  statuses: ratingStore.filter.statuses
}))

/** 关系曲线坐标：横轴水位、纵轴流量（挂起点据画成灰色空心，不参与曲线） */
const chart = computed(() => {
  const active = pointRows.value.filter((row) => row.rating.status === '正常')
  const rows = active.length > 0 ? active : pointRows.value
  if (rows.length === 0) {
    return { samples: '', points: [] as Array<{ id: string; cx: number; cy: number; verdict: string; status: string }>, stageMin: 0, stageMax: 0, flowMax: 0 }
  }
  const stages = rows.map((row) => row.rating.stageM)
  const flows = rows.map((row) => row.rating.flowM3s)
  const stageMin = Math.min(...stages)
  const stageMax = Math.max(...stages)
  const flowMax = Math.max(...flows) * 1.1
  const left = 52
  const right = 328
  const top = 20
  const bottom = 190
  const toX = (stageM: number): number =>
    stageMax - stageMin < 1e-6 ? (left + right) / 2 : left + ((stageM - stageMin) / (stageMax - stageMin)) * (right - left)
  const toY = (flowM3s: number): number => bottom - (flowM3s / flowMax) * (bottom - top)
  const sampleCount = 13
  const samples = Array.from({ length: sampleCount }, (_, index) => {
    const stageM = stageMin + ((stageMax - stageMin) * index) / (sampleCount - 1 || 1)
    const value = fit.value.valid ? fit.value.a * Math.pow(Math.max(stageM - fit.value.h0, 1e-6), fit.value.b) : 0
    return `${toX(stageM).toFixed(1)},${toY(value).toFixed(1)}`
  }).join(' ')
  return {
    samples,
    points: pointRows.value.map((row) => ({
      id: row.rating.id,
      cx: toX(row.rating.stageM),
      cy: toY(row.rating.flowM3s),
      verdict: row.residualPct && Math.abs(row.residualPct) > ratingStore.deviationLimitPct ? '超限' : '合格',
      status: row.rating.status
    })),
    stageMin,
    stageMax,
    flowMax
  }
})

/* ------------------------------ 结论历史 ------------------------------ */
const historyVisible = ref(false)
const historyRows = computed<CompareConclusion[]>(() => ratingStore.conclusionHistory(ratingStore.activeLineNo))

const deliveryTagType = (status: CompareConclusion['delivery']['status']): 'success' | 'warning' | 'info' =>
  status === '送交成功' ? 'success' : status === '送交失败' ? 'warning' : 'info'

/* -------------------------------- 动作 -------------------------------- */

function openCreate(): void {
  form.lineNo = ratingStore.activeLineNo
  const firstUsable = ratingStore.reportedCandidates.find(
    (candidate) => !candidate.usedByLines.includes(form.lineNo)
  )
  form.sectionId = firstUsable?.sectionId ?? ''
  dialogVisible.value = true
}

async function submitCreate(): Promise<void> {
  if (!form.sectionId) {
    ElMessage.warning('请选择一条外业已报出断面流量的测次')
    return
  }
  submitting.value = true
  try {
    const rating = await ratingStore.createRatingFromSection({
      sectionId: form.sectionId,
      lineNo: form.lineNo.trim() || 'A'
    })
    ratingStore.setActiveLine(rating.lineNo)
    dialogVisible.value = false
    ElMessage.success(`已按测次 ${rating.measureNo} 的报出成果落点据并重算 ${rating.lineNo} 线`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '落点据失败')
  } finally {
    submitting.value = false
  }
}

async function removeRating(rating: Rating): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除 ${rating.measureNo} 水位 ${rating.stageM.toFixed(2)} m 的点据将同时删除其当前比测记录（旧结论版本仍可查），确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await ratingStore.removeRating(rating.id)
  ElMessage.success('点据已删除，比测结论已重算')
}

async function refit(): Promise<void> {
  const rev = await ratingStore.rebuildCompares(ratingStore.activeLineNo)
  const result = fit.value
  if (result.valid) {
    ElMessage.success(
      `定线完成（结论 v${rev}）：Q = ${result.a}×(H-${result.h0})^${result.b}，平均残差 ${result.meanResidualPct}%；旧结论已留档可查`
    )
  } else {
    ElMessage.warning(result.message || '当前点据不足以定线')
  }
}

async function startNewLine(): Promise<void> {
  let answer: { value: string }
  try {
    answer = (await ElMessageBox.prompt('输入新的定线号（如 A / B / C，或年份编号）', '新建定线号', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      inputValue: String.fromCharCode(65 + Math.min(lineNos.value.length, 25))
    })) as unknown as { value: string }
  } catch {
    return
  }
  const lineNo = answer.value.trim()
  if (!lineNo) {
    ElMessage.warning('定线号不能为空')
    return
  }
  ratingStore.setActiveLine(lineNo)
  ElMessage.info(`已切换到 ${lineNo} 线，从外业已报出测次落点据后即可定线`)
}

async function reconcile(): Promise<void> {
  const suspended = await ratingStore.reconcileWithField()
  if (suspended.length === 0) {
    ElMessage.success('对账完成：所有点据引用的都是外业最新报出成果')
  } else {
    ElMessage.warning(`对账发现 ${suspended.length} 条点据的源测次报出后又改过，已挂起等人复核（不挡其他点据）`)
  }
}

async function resumeWithLatest(rating: Rating): Promise<void> {
  const discharge = ratingStore.fieldDischarges.find((item) => item.sectionId === rating.sectionId)
  try {
    await ElMessageBox.confirm(
      `采用测次 ${rating.measureNo} 的外业最新成果（r${discharge?.revision ?? '?'}，流量 ${discharge?.flowM3s.toFixed(2) ?? '—'} m³/s）刷新该点据并恢复定线？`,
      '复核：采用新成果',
      { type: 'info', confirmButtonText: '采用并恢复', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await ratingStore.resumeRatingWithLatest(rating.id)
  ElMessage.success('已采用最新成果，点据恢复正常并重算结论')
}

async function rejectRating(rating: Rating): Promise<void> {
  try {
    await ElMessageBox.confirm(`作废并删除挂起点据 ${rating.measureNo}？该线比测结论会重算。`, '复核：作废点据', {
      type: 'warning',
      confirmButtonText: '作废',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await ratingStore.rejectSuspendedRating(rating.id)
  ElMessage.success('挂起点据已作废')
}

async function keepSuspended(rating: Rating): Promise<void> {
  await ratingStore.keepSuspendedRating(rating.id)
  ElMessage.info('已保持挂起，不影响其他点据参与定线')
}

async function retryDeliveries(): Promise<void> {
  const { success, failed } = await ratingStore.retryFailedDeliveries()
  if (failed === 0) ElMessage.success(`送交成功 ${success} 版结论（仅整编室侧重试，外业成果未动）`)
  else ElMessage.warning(`重试完成：成功 ${success} 版，仍失败 ${failed} 版`)
}

function toggleFailureSimulation(): void {
  ratingStore.setSimulateDeliveryFailure(!ratingStore.simulateDeliveryFailure)
  ElMessage.info(
    ratingStore.simulateDeliveryFailure
      ? '已开启「下次送交失败」演示：重新定线产生的新结论会送交失败，可用重试按钮按本侧重试'
      : '已关闭送交失败演示，下版结论将正常送交'
  )
}

function verdictOf(rating: Rating): '合格' | '超限' | '挂起' {
  if (rating.status === '挂起') return '挂起'
  const compare = ratingStore.compares.find((item) => item.ratingId === rating.id)
  return compare?.verdict ?? '合格'
}

function handleLineChange(lineNo: string | number | boolean | undefined): void {
  ratingStore.setActiveLine(String(lineNo))
  void ratingStore.rebuildCompares(String(lineNo))
}

function handleFilterChange(): void {
  void router.replace({
    query: {
      ...(ratingStore.filter.keyword.trim() ? { kw: ratingStore.filter.keyword.trim() } : {}),
      ...(ratingStore.filter.stationIds.length ? { stations: ratingStore.filter.stationIds.join(',') } : {}),
      ...(ratingStore.filter.lineNos.length ? { lines: ratingStore.filter.lineNos.join(',') } : {}),
      ...(ratingStore.filter.verdicts.length ? { verdict: ratingStore.filter.verdicts.join(',') } : {}),
      ...(ratingStore.filter.statuses.length ? { status: ratingStore.filter.statuses.join(',') } : {}),
      ...(ratingStore.simulateDeliveryFailure ? { failDelivery: '1' } : {})
    }
  })
}

function handleReset(): void {
  ratingStore.resetFilter()
  void router.replace({ query: {} })
}

onMounted(async () => {
  if (stationStore.stations.length === 0) await initDatabase()
  const query = route.query
  ratingStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    stationIds: typeof query.stations === 'string' ? query.stations.split(',') : [],
    lineNos: typeof query.lines === 'string' ? query.lines.split(',') : [],
    verdicts:
      typeof query.verdict === 'string'
        ? (query.verdict.split(',').filter((item) => item === '合格' || item === '超限') as Array<'合格' | '超限'>)
        : [],
    statuses:
      typeof query.status === 'string'
        ? (query.status.split(',').filter((item) => item === '正常' || item === '挂起') as Array<'正常' | '挂起'>)
        : []
  })
  if (query.failDelivery === '1') ratingStore.setSimulateDeliveryFailure(true)
  // 打开先与外业成果对账：报出后又改过的点据先挂起
  const suspended = await ratingStore.reconcileWithField()
  if (suspended.length > 0) {
    ElMessage.warning(`${suspended.length} 条点据因外业报出后改了垂线测点已挂起，等待人工复核`)
  }
  void ratingStore.rebuildCompares(ratingStore.activeLineNo)
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">水位流量关系点据与定线（整编室）</h2>
        <p class="gb-hint">
          落点据只认外业组已算出断面流量并报出的测次；快照定版后两边互不冲账。外业报出后再改垂线测点，对应点据自动挂起等人复核。
        </p>
      </div>
      <div class="page__actions">
        <el-select :model-value="ratingStore.activeLineNo" class="page__line-select" @change="handleLineChange">
          <el-option v-for="lineNo in lineNos" :key="lineNo" :label="`${lineNo} 线`" :value="lineNo" />
        </el-select>
        <el-button @click="startNewLine">新建定线号</el-button>
        <el-button :icon="Connection" @click="reconcile">与外业对账</el-button>
        <el-button :icon="Refresh" @click="refit">重新定线</el-button>
        <el-button type="primary" :icon="TrendCharts" @click="openCreate">按报出测次落点据</el-button>
      </div>
    </div>

    <el-alert
      v-if="failedDeliveries.length > 0"
      type="warning"
      show-icon
      :closable="false"
      class="page__alert"
    >
      <template #title>
        有 {{ failedDeliveries.length }} 版比测结论送交失败，仅整编室本侧待重试（外业成果未受影响）：
        <el-button size="small" type="warning" :icon="RefreshRight" @click="retryDeliveries">按本侧重试送交</el-button>
      </template>
    </el-alert>

    <el-alert
      v-if="allSuspended.length > 0"
      type="error"
      show-icon
      :closable="false"
      class="page__alert"
      :title="`${allSuspended.length} 条点据挂起待复核：源测次报出后外业又改了垂线 / 测点，挂起条不参与定线、不挡其他点据`"
    />

    <FilterBar
      :model-value="filterModel"
      :selects="[
        {
          key: 'stationIds',
          label: '测站',
          options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
        },
        { key: 'lineNos', label: '定线号', options: lineNos.map((lineNo) => ({ label: `${lineNo} 线`, value: lineNo })) },
        {
          key: 'statuses',
          label: '状态',
          options: [
            { label: '正常', value: '正常' },
            { label: '挂起待核', value: '挂起' }
          ]
        },
        {
          key: 'verdicts',
          label: '判定',
          options: [
            { label: '合格', value: '合格' },
            { label: '超限', value: '超限' }
          ]
        }
      ]"
      keyword-placeholder="搜索测次号 / 定线号 / 测站"
      @change="handleFilterChange"
      @reset="handleReset"
    />

    <div class="gb-stats-row">
      <StatBadge label="当前线点据" :value="pointRows.filter((row) => row.rating.status === '正常').length" suffix="点" icon="DataLine" />
      <StatBadge label="挂起待核" :value="allSuspended.length" suffix="点" :tone="allSuspended.length > 0 ? 'danger' : 'success'" icon="Warning" />
      <StatBadge
        label="当前结论"
        :value="currentConclusion ? `v${currentConclusion.conclusionRev}` : '—'"
        :suffix="currentConclusion ? `合格率 ${currentConclusion.qualifyRatePct}%` : '未定线'"
        tone="info"
        icon="CircleCheck"
      />
      <StatBadge
        label="平均残差"
        :value="fit.valid ? fit.meanResidualPct : '—'"
        suffix="%"
        :tone="fit.valid && fit.meanResidualPct <= ratingStore.deviationLimitPct ? 'success' : 'warning'"
        icon="Histogram"
      />
    </div>

    <el-alert v-if="!fit.valid" type="warning" show-icon :closable="false"
      :title="fit.message || '当前定线号下正常点据不足，至少需要 3 个实测点才能定线（挂起点据不参与）'" />
    <el-alert v-else type="success" show-icon :closable="false" class="page__alert">
      <template #title>
        {{ fit.lineNo }} 线当前结论 v{{ currentConclusion?.conclusionRev ?? '-' }}：
        Q = {{ fit.a }} × (H - {{ fit.h0 }})^{{ fit.b }}；样本 {{ fit.sampleCount }} 点，平均残差 {{ fit.meanResidualPct }}%，
        最大残差 {{ fit.maxResidualPct }}%；
        <el-button size="small" text type="primary" :icon="View" @click="historyVisible = true">查看结论历史</el-button>
        <el-tag size="small" :type="deliveryTagType(currentConclusion?.delivery.status ?? '待送交')" effect="plain">
          {{ currentConclusion?.delivery.status ?? '待送交' }}
        </el-tag>
      </template>
    </el-alert>

    <div class="page__grid">
      <EmptyPanel
        v-if="currentLineRows.length === 0"
        title="该定线号下还没有关系点据"
        description="点「按报出测次落点据」，从外业组已报出断面流量的测次中选择；整编室不手工编造水位流量。"
        action-text="按报出测次落点据"
        @action="openCreate"
      />

      <el-table v-else :data="currentLineRows" border stripe class="gb-table-compact">
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.rating.status === '挂起'" size="small" type="danger" effect="dark">挂起待核</el-tag>
            <el-tag v-else size="small" type="success" effect="plain">正常</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="水位 (m)" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.rating.stageM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="报出流量 (m³/s)" width="140" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.rating.flowM3s.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="曲线流量" width="130" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.rating.status === '正常' && row.predicted > 0 ? row.predicted.toFixed(1) : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="残差 / 判定" width="190">
          <template #default="{ row }">
            <DeviationTag
              v-if="row.rating.status === '正常'"
              :deviation-pct="row.residualPct"
              :verdict="verdictOf(row.rating) === '超限' ? '超限' : '合格'"
              :limit="ratingStore.deviationLimitPct"
            />
            <el-tooltip v-else content="外业报出后又改了垂线测点，等待人工复核" placement="top">
              <el-tag type="danger" size="small" effect="plain"><el-icon><Warning /></el-icon> 源成果已变更</el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="测站 / 测次 / 版本" min-width="210">
          <template #default="{ row }">
            <div>{{ ratingStore.stationNameOf(row.rating.stationId) }}</div>
            <div class="gb-hint gb-mono">
              {{ row.rating.measureNo || '未标记测次' }} · 引用 r{{ row.rating.sourceRevision }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="250" fixed="right">
          <template #default="{ row }">
            <template v-if="row.rating.status === '挂起'">
              <el-button size="small" type="success" :icon="CircleCheck" @click="resumeWithLatest(row.rating)">采用新成果</el-button>
              <el-button size="small" type="warning" plain @click="keepSuspended(row.rating)">继续挂起</el-button>
              <el-button size="small" type="danger" plain :icon="Delete" @click="rejectRating(row.rating)">作废</el-button>
            </template>
            <el-button v-else size="small" type="danger" plain :icon="Delete" @click="removeRating(row.rating)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-card shadow="never" class="page__chart-card">
        <div class="gb-panel-title">
          <h3>{{ ratingStore.activeLineNo }} 线关系曲线</h3>
          <el-icon><TrendCharts /></el-icon>
        </div>
        <svg v-if="pointRows.length > 0" viewBox="0 0 360 220" class="page__chart">
          <line x1="52" y1="190" x2="340" y2="190" stroke="#b9cfdd" />
          <line x1="52" y1="20" x2="52" y2="190" stroke="#b9cfdd" />
          <text x="6" y="24" class="gb-chart-axis">{{ chart.flowMax.toFixed(0) }}</text>
          <text x="14" y="194" class="gb-chart-axis">0</text>
          <text x="52" y="208" class="gb-chart-axis">{{ chart.stageMin.toFixed(2) }}</text>
          <text x="300" y="208" class="gb-chart-axis">{{ chart.stageMax.toFixed(2) }} m</text>
          <polyline v-if="fit.valid" :points="chart.samples" fill="none" stroke="#0f4c75" stroke-width="2" />
          <circle
            v-for="point in chart.points"
            :key="point.id"
            :cx="point.cx"
            :cy="point.cy"
            r="4.5"
            :fill="point.status === '挂起' ? '#ffffff' : point.verdict === '超限' ? '#c0392b' : '#7fd1e8'"
            :stroke="point.status === '挂起' ? '#7f8c8d' : point.verdict === '超限' ? '#7b241c' : '#0f4c75'"
            :stroke-dasharray="point.status === '挂起' ? '2 2' : undefined"
          />
        </svg>
        <EmptyPanel v-else title="暂无可绘制的点据" description="从已报出断面流量的测次落点据后自动生成关系曲线。" compact />
        <p class="gb-hint">红点残差超限；空心灰点为挂起待核（不参与定线）。</p>
      </el-card>
    </div>

    <el-alert
      v-if="suspendedRows.length > 0"
      type="warning"
      show-icon
      :closable="false"
      class="page__alert"
      :title="`当前线 ${suspendedRows.length} 条挂起点据：源测次报出后外业补录了垂线 / 测点，已退出定线。复核可「采用新成果」恢复或「作废」，不挡其他点据。`"
    />

    <!-- 送交失败演示开关：失败只落在整编库本侧 -->
    <el-card shadow="never" class="gb-panel page__demo">
      <div class="gb-panel-title">
        <h3><el-icon><Timer /></el-icon> 送交通道（整编室侧）</h3>
        <span class="gb-hint">失败与重试只写整编库结论行，外业组那份断面流量不动。</span>
      </div>
      <div class="page__demo-row">
        <el-switch
          :model-value="ratingStore.simulateDeliveryFailure"
          active-text="模拟下版结论送交失败"
          @change="toggleFailureSimulation"
        />
        <el-button size="small" :disabled="failedDeliveries.length === 0" :icon="RefreshRight" @click="retryDeliveries">
          重试全部失败送交（{{ failedDeliveries.length }}）
        </el-button>
        <el-button size="small" :icon="View" @click="historyVisible = true">查看结论历史</el-button>
      </div>
    </el-card>

    <!-- 落点据：只选已报出测次 -->
    <el-dialog v-model="dialogVisible" title="按外业报出测次落点据" width="600px" :close-on-click-modal="false">
      <el-form label-width="100px">
        <el-form-item label="定线号" required>
          <el-input v-model="form.lineNo" placeholder="如 A / B / C" maxlength="8" />
        </el-form-item>
        <el-form-item label="报出测次" required>
          <el-select v-model="form.sectionId" placeholder="只列已算出断面流量并报出的测次" class="page__full" filterable>
            <el-option
              v-for="candidate in dialogCandidates"
              :key="candidate.sectionId"
              :value="candidate.sectionId"
              :label="`${candidate.measureNo}｜${ratingStore.stationNameOf(candidate.stationId)}｜${candidate.stageM.toFixed(2)} m｜${candidate.flowM3s.toFixed(1)} m³/s（r${candidate.revision}）`"
            />
          </el-select>
        </el-form-item>
        <div v-if="selectedCandidate" class="page__snapshot">
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="水位">{{ selectedCandidate.stageM.toFixed(2) }} m</el-descriptions-item>
            <el-descriptions-item label="断面流量">{{ selectedCandidate.flowM3s.toFixed(2) }} m³/s</el-descriptions-item>
            <el-descriptions-item label="测法">{{ selectedCandidate.method }}</el-descriptions-item>
            <el-descriptions-item label="成果版本">r{{ selectedCandidate.revision }}</el-descriptions-item>
          </el-descriptions>
          <p class="gb-hint">落点据时带走此刻快照；此后外业再改垂线测点会升版本，本点据自动挂起待核。</p>
        </div>
        <el-alert
          v-else
          type="info"
          :closable="false"
          title="没有可落的测次：请外业组先在测次列表算出断面流量并点「报出」"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" :disabled="!form.sectionId" @click="submitCreate">
          送交快照并落点据
        </el-button>
      </template>
    </el-dialog>

    <!-- 结论历史 -->
    <el-dialog v-model="historyVisible" :title="`${ratingStore.activeLineNo} 线比测结论历史（旧结论可查）`" width="720px">
      <el-table :data="historyRows" border size="small" class="gb-table-compact">
        <el-table-column prop="conclusionRev" label="版本" width="70" align="center">
          <template #default="{ row }">v{{ row.conclusionRev }}</template>
        </el-table-column>
        <el-table-column label="定线参数" min-width="220">
          <template #default="{ row }">
            <span class="gb-mono">Q={{ row.a }}×(H-{{ row.h0 }})^{{ row.b }}</span>
          </template>
        </el-table-column>
        <el-table-column label="样本 / 超限" width="100" align="center">
          <template #default="{ row }">{{ row.sampleCount }} / {{ row.overLimitCount }}</template>
        </el-table-column>
        <el-table-column label="平均残差" width="90" align="right">
          <template #default="{ row }">{{ row.meanResidualPct }}%</template>
        </el-table-column>
        <el-table-column label="合格率" width="80" align="right">
          <template #default="{ row }">{{ row.qualifyRatePct }}%</template>
        </el-table-column>
        <el-table-column label="送交" width="150">
          <template #default="{ row }">
            <el-tag size="small" :type="deliveryTagType(row.delivery.status)" effect="plain">
              {{ row.delivery.status }}{{ row.delivery.attempts > 1 ? ` ×${row.delivery.attempts}` : '' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="生成时间" min-width="160">
          <template #default="{ row }">
            <span class="gb-mono">{{ new Date(row.concludedAt).toLocaleString('zh-CN') }}</span>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button type="primary" @click="historyVisible = false">关闭</el-button>
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
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__alert {
  margin-top: -2px;
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

.page__chart-card {
  border: 1px solid #d8e4ec;
}

.page__chart {
  width: 100%;
  height: 240px;
}

.page__full {
  width: 100%;
}

.page__snapshot {
  margin: 4px 0 0 100px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.page__demo {
  border-style: dashed;
}

.page__demo-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

@media (max-width: 1180px) {
  .page__grid {
    grid-template-columns: 1fr;
  }
}
</style>
