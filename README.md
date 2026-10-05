# 影视场景连戏与道具接续核对台（gbcontinuity）

面向剧组场记与服装道具部门的本地化核对工具：把剧本场次拆成连戏要素清单，按拍摄日逐条记录现场服装、道具、妆发与陈设的实际状态，自动比对同一场景在不同拍摄日之间的差异，提示冲突并跟踪解决，最后生成连戏核对报告。

核心动作：**建场次与拍摄顺序 → 登记连戏要素 → 接成接戏组（组内只认一份基准）→ 录现场状态与镜次 → 比对差异 → 消解冲突并导出报告**。

纯前端单页应用（Vue 3 + TypeScript + Element Plus + Vite + Pinia + Vue Router + Dexie），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB），刷新或重启浏览器后仍然存在。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:22829**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改；容器名固定为 `${COMPOSE_PROJECT_NAME:-gbcontinuity}-frontend`。
> 容器无状态：不连接数据库、不挂载命名卷，数据全部在浏览器本地，迁移设备请使用应用内「导出整库备份 / 导入备份」。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3（`<script setup>` + Composition API） | 全部页面与组件使用组合式 API |
| 语言 | TypeScript（`strict: true`，无 `any`） | `npm run build` 内含 `vue-tsc --noEmit` 类型检查 |
| UI 组件库 | Element Plus 2.x（含 `@element-plus/icons-vue`） | 表格、卡片、对话框、表单、下拉菜单交互 |
| 构建工具 | Vite 6 | 开发服务器端口 22829 |
| 状态管理 | Pinia（setup store） | `sceneStore` / `elementStore` / `continuityGroupStore` / `recordStore` / `conflictStore` |
| 路由 | Vue Router 4（history 模式） | nginx 侧配合 `try_files` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装） | 库名 `gbcontinuity-db`，含结构版本号与 upgrade 迁移 |
| 容器化 | Docker 多阶段构建：`node:20-alpine` → `nginx:alpine` | 构建阶段执行类型检查与打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:22829
npm run build      # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview    # 本地预览构建产物（http://localhost:22829）
```

---

## 四、页面与路由

| 路由 | 模块 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/scenes` | 剧本场次与拍摄顺序台账 | Scene、Conflict | 新建/编辑/删除场次、**拖拽调序并自动重编号**、按内外景与日/夜筛选、卡片回显要素数与未解决冲突数、筛选同步 URL query |
| `/elements` | 连戏要素登记 | Element、Scene、ContinuityGroup | 按场次与类别分组展示、维护初始状态与责任人、关键要素标记与高亮、显示所属接戏组与统一基准、增删改 |
| `/groups` | 接戏组（跨场次接续） | ContinuityGroup、ElementDraft、DraftConflict | 同一件戏服/道具跨场次挂接或移出、**组内只认一份基准**、版本号乐观锁、容量上限 12 场、同场同名互斥、落后页签保留草稿并列出冲突 |
| `/shootdays` | 现场状态记录 | ShootDay、Record、Element、ContinuityGroup | 建立拍摄日并勾选当日场次、按镜次逐条录入当前状态与照片说明、同要素保留历次快照、录入时带出所属接戏组基准、记录差异角标 |
| `/conflicts` | 连戏差异比对与冲突提示 | Conflict、Record、ContinuityGroup | **现场记录变化后按拍摄日+镜次失效重算**、按接戏组时间轴并排展示记录 A / 记录 B、严重程度与解决状态流转、解决后回写接戏组基准并留痕 |
| `/report` | 连戏核对报告与结构版本导出 | 全部模型 | **按接戏组汇总**（基准/挂接场次/差异/基准偏离）、场次核对小结、风险分统计、本地库版本查看、报告 / 整库 JSON 导出与导入 |

---

## 五、目录结构

```
sologsb101-1029/
├── README.md
├── docker-compose.yml
├── .env / .env.example
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files SPA fallback + gzip
    ├── .dockerignore
    ├── index.html / vite.config.ts / tsconfig.json / package.json
    ├── public/favicon.svg
    └── src/
        ├── main.ts  App.vue  env.d.ts
        ├── types/              # scene.ts element.ts continuityGroup.ts elementDraft.ts shootDay.ts record.ts conflict.ts filter.ts
        ├── stores/             # sceneStore elementStore continuityGroupStore recordStore conflictStore
        ├── components/common/  # ConflictTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useContinuityDiff.ts useIdbTable.ts
        ├── utils/              # diff.ts db.ts groupReconcile.ts autoReconcile.ts export.ts seed.ts uuid.ts query.ts
        ├── pages/              # SceneList ElementRegistry ContinuityGroups ShootDayLog ConflictBoard ReportExport
        ├── styles/main.css
        └── router/index.ts
```

---

## 六、数据存储说明

- **IndexedDB 库名**：`gbcontinuity-db`，结构版本号 `version(2)`（v1 为场次/要素/拍摄日/记录/差异五表，v2 新增接戏组、挂接草稿、挂接冲突），`upgrade()` 会为历史行补齐字段，并**把每个旧的单场要素自动补成一个独立接戏组**。
- **分表存储**：`scenes` 场次、`elements` 连戏要素、`shootDays` 拍摄日、`records` 现场记录、`conflicts` 连戏差异、`continuityGroups` 接戏组、`elementDrafts` 挂接草稿、`draftConflicts` 挂接冲突，共 8 张表；每行带 `revision` / `createdAt` / `updatedAt`。
- **接戏组规则**：组内只认一份 `baselineState`；场次可挂接或移出；**同一场次里的同名连戏要素只能属于一个接戏组**；单组去重场次容量上限 **12**，超过拒绝继续挂接；挂接 / 改基准带版本号乐观锁，落后页签的修改不入库，**保留草稿并登记一条挂接冲突**，可在接戏组页采用或丢弃。
- **差异失效重算**：现场记录新增 / 修改 / 删除，或要素挂接关系变化后，所属接戏组的托管差异（`managed=true`）立即失效，后台观察器按拍摄日日期 + 镜次重排时间轴并整体重算；同一对记录的已解决留痕在内容未变时保留。
- **首屏自动播种**：`utils/db.ts` 的 `initDatabase()` 在 `scenes` 表为空时调用 `seedDatabase()`，灌入互相引用的演示数据（含跨 12A/15 场的风衣接戏组、1 条阻断、1 条轻微差异与 1 条跨页签挂接冲突），保证差异页、接戏组页与报告页首次打开就有内容；播种幂等。
- **差异算法**：`utils/diff.ts` 对状态文本做归一化（去掉空白与标点、颜色/款式同义写法归组，如「藏青 / 深蓝」视为同一色），归一后仍有差异才生成条目；关键接戏组的状态变化判为「阻断」，一般要素的状态变化判为「需处理」，仅照片说明 / 镜次变化判为「轻微」。
- **无后端**：没有 API 服务、没有数据库容器；容器本身无状态，不挂载任何卷。
- **级联规则**：删除场次会级联删除其要素、现场记录并清理接戏组挂接与相关差异；删除拍摄日会删除当日记录并失效相关接戏组差异；删除接戏组时成员要素各自退回独立接戏组。
