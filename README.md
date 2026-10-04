# sologsb101-1011 水文站流量测验与绳套曲线台

面向水文站**外业组**与**整编室**两类角色的纯前端单页应用。两边各持一个本地库、互不回写：外业组把测次、垂线测深、流速测点逐层落档并算出断面流量；整编室只按外业**已算出且已报出**的测次落水位—流量关系点据，完成幂函数定线并留存比测结论。外业报出后再补录垂线测点，整编室引用该成果的那条点据会先挂起等人复核，不挡别的点据；重新定线后比测结论按版本留档、旧结论可查。数据全部保存在浏览器本地（IndexedDB，两个分库），不依赖任何后端服务或外部接口。

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
| 持久化 | Dexie 4（IndexedDB 双库） | 外业库 `gbhydrogaug-field`、整编库 `gbhydrogaug-office`；旧共库 `gbhydrogaug`（v2）首次打开自动迁移到两边后删除；liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 归属 / 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/stations` | 测站台账 | 外业主本（共享台账）：Station、Section、Rating | 新建/编辑/删除测站（同步只读副本给整编室），按河名与集水面积分档筛选，卡片回显测次数、最新水位、挂起点据与比测合格率 |
| `/stations/:id/sections` | 断面测次列表与测法标记 | 外业：Section、Discharge | 新增测次；回显自动算出的断面流量与「外业自存 / 已报出」状态；一键报出给整编室 |
| `/sections/:id/verticals` | 垂线布设与测深 | 外业：Vertical、Point、Discharge | 起点距重复校验、按测点数生成测点行、部分面积法断面流量自动重算落库（成果版本 rN）、报出/重报 |
| `/verticals/:id/points` | 流速测点录入 | 外业：Point、Discharge | 逐点录入相对水深与流速、批量粘贴、批量改流速、权重归一；一改测点断面成果即重算 |
| `/ratings` | 水位流量关系点据与定线 | 整编：Rating、Compare、CompareConclusion（只读外业 Section/Discharge） | 只从「已报出断面流量」的测次送交快照落点据；与外业对账挂起异常点据；挂起条「采用新成果 / 继续挂起 / 作废」；幂函数定线、残差挂红、曲线、结论版本历史、送交失败本侧重试 |
| `/export` | 比测偏差分析与导出 | 外业 + 整编全部模型 | 按测站出检测结论、挂起清单、比测清单、九表全量 JSON 导入导出、清空重建演示数据 |

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
        ├── main.ts             # 挂载 Pinia / Router / Element Plus，并执行两侧分库迁移与启用
        ├── App.vue             # 顶部导航（外业 / 整编分区）+ 上下文快捷入口 + 页脚双库概览
        ├── env.d.ts
        ├── types/              # station / section / vertical / point / discharge / rating / compare / filter
        ├── stores/             # stationStore（台账主本+副本同步）/ sectionStore（外业+成果）/ ratingStore（整编+对账+结论版本+送交）
        ├── components/common/  # DeviationTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── hooks/              # useIdbTable / useRatingFit
        ├── pages/              # StationList / SectionList / VerticalBoard / PointEntry / RatingChart / ExportView
        ├── router/index.ts     # 路由表（路径与提示词逐字一致）
        ├── styles/main.css
        └── utils/              # flow.ts（流量计算）/ db.ts（双库、迁移、成果重算、跨侧对账）/ export.ts（九表导入导出）
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22811
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

## 六、数据存储说明（外业 / 整编两侧分库）

### 6.1 两个库各自持有

| 库（IndexedDB） | 持有方 | 表 |
| --- | --- | --- |
| `gbhydrogaug-field` | 外业组 | `stations`（共享台账主本）、`sections`（测次）、`verticals`（垂线测深）、`points`（流速测点）、`discharges`（断面流量成果） |
| `gbhydrogaug-office` | 整编室 | `stations`（台账只读副本）、`ratings`（定线号 / 关系点据）、`compares`（当前比测结论）、`conclusions`（结论版本历史 + 送交状态） |

- 数据只允许「外业 → 整编」单向只读送交，整编室任何操作都不会回写外业库；外业改垂线测点也不会直接动整编室的点据。
- 结构版本 `v3`，由 `frontend/src/utils/db.ts` 统一封装（`fieldDb` / `officeDb`），页面组件不直接 new Dexie。

### 6.2 断面流量成果（外业 `discharges`）

- 垂线的起点距 / 水深或任一测点的相对水深 / 流速 / 权重变化，自动按部分面积法重算并覆盖本测次成果；成果带输入指纹 `inputHash` 与版本 `revision`。
- 未报出前反复试算始终为 `r1`；**报出**只在本侧成果打 `reported` 标记。报出后内容再变，版本升到 `r2、r3…`。

### 6.3 整编落点据、挂起与人工复核

- 落点据对话框只列「已算出断面流量且已报出」的测次；落库时带走快照（水位、断面流量、`sourceRevision`）。
- 「与外业对账」（打开 `/ratings`、点对账按钮或导出页刷新时自动执行）比对版本：外业报出后又改过的源测次，其点据置为**挂起**，退出定线与比测统计，**只挂这一条，不挡同线 / 同站其他点据**。
- 挂起条必须人工处理：**采用新成果**（刷新快照与版本并恢复）、**继续挂起** 或 **作废**。

### 6.4 重新定线、结论版本与送交失败

- 重新定线后当前比测记录原地刷新，并向 `conclusions` 追加一版（含定线参数、合格率、残差、生成时间、送交状态）；**旧版本永不覆盖**，在「结论历史」中可查。
- 每版结论独立送交：失败仅在整编库本侧标记「送交失败」并累计次数，点「重试」只改整编库，**外业那份成果不动**。页内开关可模拟下一版送交失败用于演示。

### 6.5 旧库数据迁移

- 旧版共库 `gbhydrogaug`（v1/v2，数据没有归属）：第一次打开先迁移到两边——测站 / 测次 / 垂线 / 测点归外业，并按现有垂线测点补算断面流量成果（标记已报出）；台账副本、关系点据（按测站 + 测次号挂回源测次与成果版本）、比测记录与首版结论历史归整编——核对行数一致后删除旧共库，再启用应用。localStorage 标记保证只迁移一次。
- 全新环境两侧都空时幂等播种演示数据（3 测站 / 5 测次 / 10 垂线 / 26 测点 / 5 条已报出断面成果 / 13 点据 / 3 线首版结论，C 线含 2 个超限点）。

### 6.6 其他

- **实时同步**：`watchTable()` 基于 Dexie `liveQuery` 订阅，store 列表自动刷新。
- **备份与恢复**：`/export` 导出九张表的 JSON 快照（兼容读取旧版六表备份），支持「覆盖导入」与「追加导入（重新分配 id）」；备份时间写入 `localStorage`。
- **离线可用**：纯静态资源，无任何网络请求；换浏览器 / 清空站点数据需通过 JSON 备份迁移。
