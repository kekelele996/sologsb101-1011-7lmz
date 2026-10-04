<script setup lang="ts">
/**
 * 应用外壳：按岗位切换两套导航——
 * 外业组（测站/测次/垂线/测点/成果备份）与整编室（关系点据定线/比测结论档案）。
 * 两边各自持有自己的库，导航徽标分别统计。
 */
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  DataLine,
  Files,
  FolderOpened,
  Histogram,
  Odometer,
  PieChart,
  Promotion,
  TrendCharts
} from '@element-plus/icons-vue'
import { useStationStore } from '@/stores/stationStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useRatingStore } from '@/stores/ratingStore'
import { FIELD_DB_NAME, FIELD_DB_VERSION } from '@/utils/fieldDb'
import { OFFICE_DB_NAME, OFFICE_DB_VERSION } from '@/utils/officeDb'
import { bootstrap } from '@/utils/bootstrap'
import { flushSide } from '@/utils/transport'
import { applyOfficeInbox } from '@/utils/officeMessages'
import { applyFieldInbox } from '@/utils/fieldMessages'

const route = useRoute()
const router = useRouter()
const stationStore = useStationStore()
const sectionStore = useSectionStore()
const ratingStore = useRatingStore()

onMounted(async () => {
  stationStore.start()
  sectionStore.start()
  ratingStore.start()
  await bootstrap()
  // 每次回到应用都尝试把积压消息投递、入账（幂等）
  await flushSide('field')
  await flushSide('office')
  await applyOfficeInbox()
  await applyFieldInbox()
})

/** 当前岗位（路由 meta.side 决定） */
const side = computed<'field' | 'office'>(() =>
  route.meta.side === 'office' ? 'office' : 'field'
)

const fieldNav = computed(() => [
  { key: '/stations', label: '测站台账', icon: Odometer, badge: String(stationStore.stations.length) },
  { key: '/field/export', label: '外业成果 / 备份', icon: FolderOpened, badge: '' }
])

const officeNav = computed(() => [
  {
    key: '/office/ratings',
    label: '关系点据与定线',
    icon: TrendCharts,
    badge: String(ratingStore.ratingPoints.filter((p) => p.status === 'active' || p.status === 'resolved').length)
  },
  {
    key: '/office/archive',
    label: '比测结论档案',
    icon: PieChart,
    badge: ratingStore.failedDispatchCount > 0 ? String(ratingStore.failedDispatchCount) : ''
  }
])

const navItems = computed(() => (side.value === 'field' ? fieldNav.value : officeNav.value))

const activeKey = computed(() => {
  if (route.path.startsWith('/stations/')) return '/stations'
  if (route.path.startsWith('/sections/')) return '/stations'
  if (route.path.startsWith('/verticals/')) return '/stations'
  if (route.path.startsWith('/stations')) return '/stations'
  if (route.path.startsWith('/office/archive')) return '/office/archive'
  if (route.path.startsWith('/office/ratings')) return '/office/ratings'
  if (route.path.startsWith('/field/export')) return '/field/export'
  return route.path
})

/** 层级页面的上下文快捷入口 */
const contextLinks = computed(() => {
  const links: Array<{ label: string; path: string }> = []
  const id = route.params.id as string | undefined
  if (side.value !== 'field') return links
  if (route.path.startsWith('/stations/') && id) {
    links.push({ label: '该站断面测次', path: `/stations/${id}/sections` })
  }
  if (route.path.startsWith('/sections/') && id) {
    const section = sectionStore.sectionById(id)
    if (section) links.push({ label: '所属测站断面', path: `/stations/${section.stationId}/sections` })
    links.push({ label: '该断面垂线', path: `/sections/${id}/verticals` })
  }
  if (route.path.startsWith('/verticals/') && id) {
    const vertical = sectionStore.verticals.find((item) => item.id === id)
    if (vertical) links.push({ label: '所属断面垂线', path: `/sections/${vertical.sectionId}/verticals` })
  }
  return links
})

function go(path: string): void {
  void router.push(path)
}

function switchSide(target: 'field' | 'office'): void {
  if (target === side.value) return
  void router.push(target === 'field' ? '/stations' : '/office/ratings')
}

const heldCount = computed(() => ratingStore.heldPoints.length)
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="app-header__brand">
        <span class="app-header__mark">水</span>
        <div>
          <h1 class="app-header__title">水文站流量测验与绳套曲线台</h1>
          <p class="app-header__sub">
            {{ side === 'field' ? '外业组：测次 · 垂线测深 · 流速测点 · 断面流量报出' : '整编室：定线号 · 关系点据 · 比测结论' }}
          </p>
        </div>
      </div>

      <div class="app-header__right">
        <div class="app-side-switch">
          <button
            type="button"
            class="app-side-switch__btn"
            :class="{ 'is-active': side === 'field' }"
            @click="switchSide('field')"
          >
            <el-icon><DataLine /></el-icon> 外业组
          </button>
          <button
            type="button"
            class="app-side-switch__btn"
            :class="{ 'is-active': side === 'office' }"
            @click="switchSide('office')"
          >
            <el-icon><Promotion /></el-icon> 整编室
            <em v-if="heldCount > 0" class="app-side-switch__dot" :title="`${heldCount} 条点据挂起待复核`" />
          </button>
        </div>
        <nav class="app-nav">
          <button
            v-for="item in navItems"
            :key="item.key"
            class="app-nav__item"
            :class="{ 'is-active': activeKey === item.key }"
            type="button"
            @click="go(item.key)"
          >
            <el-icon><component :is="item.icon" /></el-icon>
            <span>{{ item.label }}</span>
            <em v-if="item.badge" class="app-nav__badge">{{ item.badge }}</em>
          </button>
        </nav>
      </div>
    </header>

    <div v-if="contextLinks.length > 0" class="app-context">
      <span class="app-context__label">当前上下文：</span>
      <el-button v-for="link in contextLinks" :key="link.path" size="small" text type="primary" @click="go(link.path)">
        {{ link.label }}
      </el-button>
    </div>

    <main class="app-main">
      <router-view v-slot="{ Component }">
        <component :is="Component" />
      </router-view>
    </main>

    <footer class="app-footer">
      <span>
        外业库 {{ FIELD_DB_NAME }} v{{ FIELD_DB_VERSION }} · 整编室库 {{ OFFICE_DB_NAME }} v{{ OFFICE_DB_VERSION }}
        · 数据仅存于本浏览器 IndexedDB，两边各自持有。
      </span>
      <span v-if="side === 'field'">
        测站 {{ stationStore.stations.length }} · 测次 {{ sectionStore.sections.length }} · 垂线
        {{ sectionStore.verticals.length }} · 测点 {{ sectionStore.points.length }}
      </span>
      <span v-else>
        点据 {{ ratingStore.ratingPoints.length }}（挂起 {{ heldCount }}）· 报出成果
        {{ ratingStore.reports.length }} · 结论批次 {{ ratingStore.compareRuns.length }}
      </span>
    </footer>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.app-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 24px;
  background: linear-gradient(120deg, #0b3c5d 0%, #0f4c75 55%, #116d8c 100%);
  color: #eaf6fb;
}

.app-header__brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.app-header__mark {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.14);
  border: 1px solid rgba(255, 255, 255, 0.3);
  font-size: 20px;
  font-weight: 700;
}

.app-header__title {
  margin: 0;
  font-size: 18px;
  letter-spacing: 1px;
}

.app-header__sub {
  margin: 2px 0 0;
  font-size: 12px;
  letter-spacing: 1px;
  color: rgba(234, 246, 251, 0.75);
}

.app-header__right {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
}

.app-side-switch {
  display: inline-flex;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 999px;
  padding: 2px;
  background: rgba(255, 255, 255, 0.06);
}

.app-side-switch__btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: #eaf6fb;
  font-size: 13px;
  cursor: pointer;
}

.app-side-switch__btn.is-active {
  background: #eaf6fb;
  color: #0f4c75;
  font-weight: 600;
}

.app-side-switch__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #e6a23c;
  border: 1px solid #fff;
}

.app-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.app-nav__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: #eaf6fb;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.18s ease;
}

.app-nav__item:hover {
  background: rgba(255, 255, 255, 0.16);
}

.app-nav__item.is-active {
  background: #eaf6fb;
  color: #0f4c75;
  font-weight: 600;
}

.app-nav__badge {
  font-style: normal;
  font-size: 11px;
  padding: 0 6px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.18);
}

.app-context {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 8px 24px 0;
}

.app-context__label {
  font-size: 12px;
  color: #5b6b78;
}

.app-main {
  flex: 1;
  width: 100%;
  max-width: 1360px;
  margin: 0 auto;
  padding: 16px 24px 32px;
}

.app-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 24px 20px;
  font-size: 12px;
  color: #6b7d8b;
}
</style>
