# 影视场景连戏与道具接续核对台（gbcontinuity）

面向剧组场记与服装道具部门的本地化核对工具：把剧本场次拆成连戏要素清单，按拍摄日逐条记录现场服装、道具、妆发与陈设的实际状态，自动比对同一场景在不同拍摄日之间的差异，提示冲突并跟踪解决，最后生成连戏核对报告。

核心动作：**建场次与拍摄顺序 → 登记连戏要素 → 录现场状态与镜次 → 比对差异 → 消解冲突并导出报告**。

同一件戏服或道具会在几场里接着用。过去每场各建一条连戏要素，某场改了基准，后面的场次照旧拿旧值比对。现在把连戏要素**接成接戏组**：组内只认一份基准，场次可挂接或移出；同一场次里的同名连戏要素只能属于一个接戏组；现场记录变化后，组内按拍摄日、镜次排出的差异立即失效重算。两个页签同时挂接同一要素时，只接受基于最新版本的一方，另一方保留草稿并列出冲突。接戏组容量超过 12 个场次时拒绝继续挂接；旧数据升级时每个单场要素补成独立接戏组；报告按接戏组汇总。

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
| 状态管理 | Pinia（setup store） | `sceneStore` / `elementStore` / `groupStore` / `recordStore` / `conflictStore` |
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
| `/elements` | 连戏要素登记 | Element、Scene | 按场次与类别分组展示、维护初始状态与责任人、关键要素标记与高亮、增删改、挂接到接戏组 |
| `/groups` | 接戏组管理 | ContinuityGroup、Element、Record | 跨场道具接成一组、组内一份基准、场次挂接/移出、容量 12 场上限、同场同名要素唯一、版本冲突草稿、差异按拍摄日镜次失效重算 |
| `/shootdays` | 现场状态记录 | ShootDay、Record、Element | 建立拍摄日并勾选当日场次、按镜次逐条录入当前状态与照片说明、同要素保留历次快照、记录差异角标 |
| `/conflicts` | 连戏差异比对与冲突提示 | Conflict、Record | **重新比对生成差异**、并排展示记录 A / 记录 B、严重程度与解决状态流转、解决后回写要素初始状态并留痕 |
| `/report` | 连戏核对报告与结构版本导出 | 全部模型 | 场次核对小结、风险分统计、本地库版本查看、报告 / 整库 JSON 导出与导入 |

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
        ├── types/              # scene.ts element.ts group.ts shootDay.ts record.ts conflict.ts filter.ts
        ├── stores/             # sceneStore elementStore groupStore recordStore conflictStore
        ├── components/common/  # ConflictTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useContinuityDiff.ts useGroupDiff.ts useIdbTable.ts
        ├── utils/              # diff.ts db.ts export.ts seed.ts uuid.ts query.ts
        ├── pages/              # SceneList ElementRegistry GroupBoard ShootDayLog ConflictBoard ReportExport
        ├── styles/main.css
        └── router/index.ts
```

---

## 六、数据存储说明

- **IndexedDB 库名**：`gbcontinuity-db`（Dexie 封装），结构版本号 `version(2)`，并带 `upgrade()` 迁移逻辑：v1 为历史行补齐行修订号与时间戳；v2 把每个单场要素补成独立接戏组（组名取要素名、基准取初始状态、成员只含该要素自己）。
- **分表存储**：`scenes` 场次、`elements` 连戏要素、`groups` 接戏组、`shootDays` 拍摄日、`records` 现场记录、`conflicts` 连戏差异，共 6 张表；每行带 `revision` / `createdAt` / `updatedAt`。
- **接戏组规则**：组内只认一份基准（`baselineState`），场次可挂接或移出；同一场次的同名要素只能属于一个接戏组；容量上限 12 个场次，满员拒绝继续挂接。挂接采用乐观并发：提交时携带草稿基于的 revision，与组当前 revision 不一致则拒绝，被拒一方保留草稿并列出版本冲突。现场记录变化后，组内成员记录指纹（id + updatedAt）随之改变，与组上缓存的 `diffFingerprint` 不一致即判定差异已失效，触发立即重算。
- **首屏自动播种**：`utils/db.ts` 的 `initDatabase()` 在 `scenes` 表为空时调用 `seedDatabase()`，灌入互相引用的演示数据（场次 → 连戏要素 → 接戏组 → 拍摄日 → 现场记录 → 差异），其中「女主蓝色风衣」跨 sc-001 / sc-003 接成多场组，其余要素为独立组（模拟旧数据升级），并包含 1 条「阻断 / 待确认」与 1 条「轻微 / 待确认」差异；播种幂等。
- **差异算法**：`utils/diff.ts` 对状态文本做归一化（去掉空白与标点、颜色/款式同义写法归组，如「藏青 / 深蓝」视为同一色），归一后仍有差异才生成条目；关键要素的状态变化判为「阻断」，一般要素的状态变化判为「需处理」，仅照片说明 / 镜次变化判为「轻微」。接戏组差异由 `useGroupDiff` 把组内成员记录按拍摄日、镜次排成时间轴，做跨场次接续比对。
- **无后端**：没有 API 服务、没有数据库容器；容器本身无状态，不挂载任何卷。
- **级联规则**：删除场次会级联删除其要素、现场记录与相关差异，并把要素从接戏组移出；删除要素会从接戏组移出；删除拍摄日会删除当日记录与相关差异。
