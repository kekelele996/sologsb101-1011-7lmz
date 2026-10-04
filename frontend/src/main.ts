import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import App from '@/App.vue'
import router from '@/router'
import { bootstrap } from '@/utils/bootstrap'
import '@/styles/main.css'

const app = createApp(App)

Object.entries(ElementPlusIconsVue).forEach(([key, component]) => {
  app.component(key, component)
})

app.use(createPinia())
app.use(router)
app.use(ElementPlus, { locale: zhCn })

app.mount('#app')

// 首屏启用双库分权：旧单库先迁移到外业库/整编室库两边再启用；
// 全新环境则播种双库演示数据。完成后 store 的 liveQuery 自动推送到页面。
void bootstrap()
