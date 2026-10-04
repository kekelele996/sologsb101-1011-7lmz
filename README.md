# sologsb101-1011 水文站流量测验与绳套曲线台

面向水文站**外业组**与**整编室**两类岗位的纯前端单页应用。两边数据从旧的「挤在一个库」拆成**各自持有的两个 IndexedDB**，通过「报出 / 送交」消息传递，互不覆盖：

- **外业组库 `gbhydrogaug_field`**：管测站、断面测次、垂线测深、流速测点、断面流量成果，以及对外发件箱与收到的比测结论收件箱。
- **整编室库 `gbhydrogaug_office`**：管定线号、水位流量关系点据、比测结论批次（追加留档），以及外业报出成果收件箱与只读测站名册。

核心业务规则（均有端到端测试覆盖）：

1. **落点据只认报出**：整编室只能把「外业已算出断面流量并报出」的测次成果落为关系点据，不能凭空录入；同一测次同一定线号只保留一个在案点据。
2. **报出后改动 → 只挂该条、不挡别的**：测次报出后外业再改测次头/垂线/测点，该测次版本号 +1 并通知整编，已落在点据上的那条自动 `held` 挂起等人复核，其余点据照常定线；复核可「确认有效恢复」或「判定弃用留档」。
3. **重新定线 → 结论追加、旧结论可查**：每重新定线一次就新增一批比测结论（含当时定线参数与逐点偏差），历史批次永不覆盖。
4. **送交失败只有本侧重试**：整编→外业的结论送交走整编室发件箱，失败只在整编室「按本侧重试」，外业那份数据不动；外业→整编的报出同理。
5. **旧库首次打开先迁移再启用**：发现旧单库 `gbhydrogaug` 有数据时，先把外业数据迁到外业库、点据/比测迁到整编室库（对得上报出的点据在案、无报出来源的历史点据留档但不定线），旧库只读保留，然后才启用双库。

数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口；「送交」用同浏览器内两个库的发件箱/收件箱模拟，并内置「通道故障」开关用于演示与验证失败重试。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22811**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22811），如需换端口改这一个变量即可。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5（Composition API + `<script setup>`） | 页面全部按路由懒加载 |
| 语言 | TypeScript 5.7（strict） | 构建脚本执行 `vue-tsc --noEmit` 类型检查 |
| UI 组件 | Element Plus 2.9 + @element-plus/icons-vue | 中文语言包，表格 / 表单 / 弹窗 / 徽标 |
| 构建 | Vite 6 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Pinia 2（setup store） | `stationStore` / `sectionStore` / `ratingStore` |
| 路由 | Vue Router 4（history 模式） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB） | 双库：`gbhydrogaug_field` v1 + `gbhydrogaug_office` v1，发件箱/收件箱消息传递，旧库 v2 只读迁移 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

### 外业组

| 路由 | 页面 | 主要交互 |
| --- | --- | --- |
| `/stations` | 测站台账 | 新建/编辑/删除测站（自动向整编室同步档案），按河名与集水面积筛选，卡片回显测次/已报出数 |
| `/stations/:id/sections` | 断面测次 | 新增测次，显示报出状态，对已算出成果的测次「报出成果 / 重新报出」 |
| `/sections/:id/verticals` | 垂线布设与测深 | 起点距校验、自动生成测点行、部分面积法断面流量、页面内「报出断面流量」，报出后改动提示 |
| `/verticals/:id/points` | 流速测点录入 | 逐点/批量录入流速，报出后的修改自动触发整编侧挂起通知 |
| `/field/export` | 外业成果与备份 | 报出台账、整编室送交的比测结论只读留档、外业库 JSON 导入导出、重建演示双库 |

### 整编室

| 路由 | 页面 | 主要交互 |
| --- | --- | --- |
| `/office/ratings` | 关系点据与定线 | 从外业报出成果「落为点据」、挂起点据复核（确认有效/判定弃用）、幂函数定线、重新定线并送交、通道故障开关与本侧重试 |
| `/office/archive` | 比测结论档案 | 历轮比测结论（旧结论可查）、失败送交按本侧重试、整编室库 JSON 导入导出 |

> 旧书签 `/ratings`、`/export` 会自动重定向到整编室对应页面。

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该 id，页面渲染 `<RouteMissingPanel>` 友好空态（含返回入口与可用 id 快捷跳转），不会白屏。

## 四、目录结构

```
sologsb101-1011/
├── README.md
├── docker-compose.yml          # name: gbhydrogaug，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = vue-tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 挂载 Pinia / Router / Element Plus，并打开并播种数据库
        ├── App.vue             # 顶部导航 + 上下文快捷入口 + 页脚数据概览
        ├── env.d.ts
        ├── types/              # station / section / vertical / point / rating / compare / filter
        ├── stores/             # stationStore / sectionStore / ratingStore
        ├── components/common/  # DeviationTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── hooks/              # useIdbTable / useRatingFit
        ├── pages/              # StationList / SectionList / VerticalBoard / PointEntry / RatingChart / ExportView
        ├── router/index.ts     # 路由表（路径与提示词逐字一致）
        ├── styles/main.css
        └── utils/              # flow.ts（流量计算）/ db.ts（Dexie 封装）/ export.ts（导入导出）
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22811
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
npm test           # 双库分权端到端验证（fake-indexeddb，无需浏览器）
```

## 六、数据存储说明（双库分权）

- **外业库 `gbhydrogaug_field` v1**（`utils/fieldDb.ts`）：`stations` / `sections`（带 `revision`、`reported*` 版本与报出字段）/ `verticals` / `points` / `outbox`（报出、测站同步、改动通知的发件箱）/ `inbox`（整编室比测结论收件箱）。
- **整编室库 `gbhydrogaug_office` v1**（`utils/officeDb.ts`）：`stations` + `stationRevs`（只读名册及版本）/ `inReports`（外业报出成果，落点据唯一来源）/ `ratingPoints`（点据，含 `active/held/resolved/rejected` 状态与复核留痕）/ `ratingLines`（定线号台账）/ `compareRuns`（历轮比测结论，追加留档）/ `outbox`（送交结论）/ `inbox`。
- **消息通道**（`utils/transport.ts`）：发送方只写自己库的 `outbox`，幂等投递到对方 `inbox`；`setChannelBlocked` 可置障模拟送交失败，`retrySide(side)` 只由发送方按本侧重试，接收方业务数据不变。
- **入账规则**：`utils/officeMessages.ts` 处理测站同步（高版本覆盖）、报出（旧版报出标 `superseded`、落后点据挂起）、改动通知（只挂对应测次在案点据）；`utils/fieldMessages.ts` 幂等签收比测结论。
- **首次启用**（`utils/bootstrap.ts`）：旧单库 `gbhydrogaug` 有数据则 `legacyDb.ts` 只读取出，经 `seed.ts` 的统一装配迁到两边（`mode: 'migrated'`）；否则播种双库演示数据（`mode: 'fresh'`）。旧库不删除。
- **实时同步**：两个库各自 `watchTable()` 基于 Dexie `liveQuery` 订阅，store 列表自动刷新。
- **备份与恢复**：外业库与整编室库各自导出/导入 JSON（`utils/fieldBackup.ts` / `utils/officeBackup.ts`），覆盖导入只清本方库，对方那份不动。
- **端到端验证**：`test/e2e-split.ts`（落点据只认报出、报出后改动只挂该条、复核、重新定线追加结论、失败本侧重试外业不动，24 项断言）与 `test/e2e-migrate.ts`（旧库先迁两边再启用，9 项断言）。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器 / 清空站点数据后数据不会跟随，需通过 JSON 备份迁移。
