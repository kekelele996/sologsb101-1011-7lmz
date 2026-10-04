import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

/**
 * 双库分权路由：
 * 外业组：/stations、/stations/:id/sections、/sections/:id/verticals、/verticals/:id/points、/field/export
 * 整编室：/office/ratings（定线号/点据/比测）、/office/archive（结论档案与送交重试）
 * 旧路径 /ratings、/export 重定向到整编室，保证旧书签可用。
 */
const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/stations' },
  {
    path: '/stations',
    name: 'station-list',
    component: () => import('@/pages/StationList.vue'),
    meta: { title: '测站台账', icon: 'Odometer', side: 'field' }
  },
  {
    path: '/stations/:id/sections',
    name: 'section-list',
    component: () => import('@/pages/SectionList.vue'),
    meta: { title: '断面测次', icon: 'Files', side: 'field' }
  },
  {
    path: '/sections/:id/verticals',
    name: 'vertical-board',
    component: () => import('@/pages/VerticalBoard.vue'),
    meta: { title: '垂线布设与测深', icon: 'Histogram', side: 'field' }
  },
  {
    path: '/verticals/:id/points',
    name: 'point-entry',
    component: () => import('@/pages/PointEntry.vue'),
    meta: { title: '流速测点录入', icon: 'DataLine', side: 'field' }
  },
  {
    path: '/field/export',
    name: 'field-export',
    component: () => import('@/pages/FieldExport.vue'),
    meta: { title: '外业成果与备份', icon: 'FolderOpened', side: 'field' }
  },
  {
    path: '/office/ratings',
    name: 'office-ratings',
    component: () => import('@/pages/OfficeRatings.vue'),
    meta: { title: '关系点据与定线', icon: 'TrendCharts', side: 'office' }
  },
  {
    path: '/office/archive',
    name: 'office-archive',
    component: () => import('@/pages/OfficeArchive.vue'),
    meta: { title: '比测结论档案', icon: 'PieChart', side: 'office' }
  },
  // 旧路径兼容
  { path: '/ratings', redirect: '/office/ratings' },
  { path: '/export', redirect: '/office/archive' },
  { path: '/:pathMatch(.*)*', redirect: '/stations' }
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : '水文站流量测验与绳套曲线台'
  document.title = `${title} · 水文站流量测验与绳套曲线台`
})

export default router
