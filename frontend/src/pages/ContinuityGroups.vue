<script setup lang="ts">
/**
 * /groups 接戏组：同一件戏服 / 道具跨场次接续时只认一份基准。
 * - 场次可挂接或移出；同场次同名要素只能属于一个接戏组；容量上限 12 个场次
 * - 挂接 / 改基准必须基于最新版本，落后页签的修改保留草稿并列出冲突
 * - 现场记录变化后，组内按拍摄日、镜次排出的差异立即失效重算
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Link, RefreshRight } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import ConflictTag from '@/components/common/ConflictTag.vue'
import {
  db,
  adoptDraftConflict,
  discardDraftConflict,
  removeDraft,
  type ContinuityGroupRow,
  type DraftConflictRow,
  type ElementRow,
  type RecordRow,
  type SceneRow,
  type ShootDayRow
} from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useContinuityDiff } from '@/hooks/useContinuityDiff'
import { useContinuityGroupStore } from '@/stores/continuityGroupStore'
import { useConflictStore } from '@/stores/conflictStore'
import { GROUP_MAX_SCENES, createEmptyContinuityGroup } from '@/types/continuityGroup'
import { ELEMENT_CATEGORIES } from '@/types/element'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'

const route = useRoute()
const router = useRouter()
const store = useContinuityGroupStore()
const conflictStore = useConflictStore()

const { rows: groups, ready } = useIdbTable<ContinuityGroupRow>(() => db.continuityGroups, {
  compare: (a, b) => Number(b.auto) - Number(a.auto) || a.name.localeCompare(b.name, 'zh-Hans-CN')
})
const { rows: elements } = useIdbTable<ElementRow>(() => db.elements)
const { rows: scenes } = useIdbTable<SceneRow>(() => db.scenes, { compare: (a, b) => a.shootOrder - b.shootOrder })
const { rows: records } = useIdbTable<RecordRow>(() => db.records)
const { rows: shootDays } = useIdbTable<ShootDayRow>(() => db.shootDays)
const { rows: draftConflicts } = useIdbTable<DraftConflictRow>(() => db.draftConflicts, {
  compare: (a, b) => b.createdAt - a.createdAt
})

/** 组级时间轴比对：差异与基准偏离 */
const diff = useContinuityDiff(records, elements, shootDays, groups)

const selects = computed<FilterSelectConfig[]>(() => [
  { key: 'categories', label: '类别', options: ELEMENT_CATEGORIES.map((item) => ({ label: item, value: item })) }
])

const ORIGIN_TAB = '接戏组页'

function sceneOf(sceneId: string): SceneRow | undefined {
  return scenes.value.find((item) => item.id === sceneId)
}

function sceneLabel(sceneId: string): string {
  const scene = sceneOf(sceneId)
  return scene ? `第 ${scene.sceneNo} 场 · ${scene.location}` : '场次已删除'
}

function elementOf(elementId: string): ElementRow | undefined {
  return elements.value.find((item) => item.id === elementId)
}

interface MemberView {
  element: ElementRow
  scene: SceneRow | undefined
  recordCount: number
  latestState: string
}

function membersOf(group: ContinuityGroupRow): MemberView[] {
  return group.elementIds
    .map((id) => elementOf(id))
    .filter((item): item is ElementRow => Boolean(item))
    .map((element) => {
      const own = records.value
        .filter((record) => record.elementId === element.id)
        .sort((a, b) => {
          const da = shootDays.value.find((day) => day.id === a.shootDayId)?.date ?? ''
          const dbDate = shootDays.value.find((day) => day.id === b.shootDayId)?.date ?? ''
          return da.localeCompare(dbDate) || a.takeNo.localeCompare(b.takeNo, 'zh-Hans-CN')
        })
      return {
        element,
        scene: sceneOf(element.sceneId),
        recordCount: own.length,
        latestState: own[own.length - 1]?.currentState ?? element.initialState
      }
    })
    .sort((a, b) => (a.scene?.shootOrder ?? 99) - (b.scene?.shootOrder ?? 99))
}

function sceneCountOf(group: ContinuityGroupRow): number {
  return new Set(membersOf(group).map((item) => item.element.sceneId)).size
}

function groupOpenConflicts(groupId: string): number {
  return diff.candidatesByGroup(groupId).length
}

function driftOf(elementId: string): boolean {
  return diff.baselineDrifts.value.some((item) => item.elementId === elementId)
}

const filteredGroups = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const categories = Array.isArray(store.filters.categories) ? store.filters.categories : []
  const criticalOnly = store.filters.criticalOnly === true
  return groups.value.filter((group) => {
    const label = `${group.name} ${group.baselineState} ${group.owner}`.toLowerCase()
    if (keyword && !label.includes(keyword)) return false
    if (categories.length > 0 && !categories.includes(group.category)) return false
    if (criticalOnly && !group.critical) return false
    return true
  })
})

const pendingDraftConflicts = computed(() => draftConflicts.value.filter((item) => item.state === '待处理'))

const totals = computed(() => ({
  groupCount: groups.value.length,
  crossSceneCount: groups.value.filter((group) => sceneCountOf(group) > 1).length,
  memberCount: groups.value.reduce((sum, group) => sum + group.elementIds.length, 0),
  openConflictCount: diff.diffCount.value,
  driftCount: diff.baselineDrifts.value.length,
  pendingDraftCount: pendingDraftConflicts.value.length
}))

/* ------------------------------ 新建接戏组 ------------------------------ */
const createDialog = ref(false)
const createFormRef = ref<FormInstance>()
const createForm = reactive(createEmptyContinuityGroup())
const createRules: FormRules = {
  name: [{ required: true, message: '请填写接戏组名称', trigger: 'blur' }],
  baselineState: [{ required: true, message: '请填写组内唯一基准状态', trigger: 'blur' }]
}

function openCreate(): void {
  Object.assign(createForm, createEmptyContinuityGroup())
  createDialog.value = true
}

async function submitCreate(): Promise<void> {
  const valid = await createFormRef.value?.validate().catch(() => false)
  if (!valid) return
  await store.createGroup({ ...createForm })
  ElMessage.success('接戏组已建立，可继续挂接各场次的同名要素')
  createDialog.value = false
}

/* ------------------------------ 挂接 ------------------------------ */
const attachDialog = ref(false)
const attachGroup = ref<ContinuityGroupRow | null>(null)
const attachElementId = ref('')
/** 挂接时的页签版本快照：弹窗打开即锁定，提交时与组当前版本比较 */
const attachBaseVersion = ref(0)
const attachForm = reactive({ baselineState: '', note: '' })

interface AttachCandidate {
  id: string
  label: string
  sceneId: string
  alreadyInThis: boolean
  sameSceneBlocked: boolean
  inOtherGroupName: string
}

const attachCandidates = computed<AttachCandidate[]>(() => {
  const group = attachGroup.value
  if (!group) return []
  const memberIds = new Set(group.elementIds)
  return elements.value
    .filter((element) => element.category === group.category)
    .map((element) => {
      const otherGroup = groups.value.find((item) => item.id !== group.id && item.elementIds.includes(element.id))
      return {
        id: element.id,
        label: `${element.name}（${sceneLabel(element.sceneId)}）`,
        sceneId: element.sceneId,
        alreadyInThis: memberIds.has(element.id),
        sameSceneBlocked: false,
        inOtherGroupName: otherGroup?.name ?? ''
      }
    })
})

function openAttach(group: ContinuityGroupRow): void {
  attachGroup.value = group
  attachElementId.value = ''
  attachBaseVersion.value = group.version
  attachForm.baselineState = group.baselineState
  attachForm.note = ''
  attachDialog.value = true
}

const attachFull = computed(() => (attachGroup.value ? sceneCountOf(attachGroup.value) >= GROUP_MAX_SCENES : false))

async function submitAttach(): Promise<void> {
  const group = attachGroup.value
  if (!group || !attachElementId.value) {
    ElMessage.warning('请选择要挂接的连戏要素')
    return
  }
  try {
    const outcome = await store.attach(group.id, attachElementId.value, {
      baseVersion: attachBaseVersion.value,
      originTab: ORIGIN_TAB,
      note: attachForm.note
    })
    if (outcome.accepted) {
      ElMessage.success('已挂接到接戏组，组内只认这一份基准')
      attachDialog.value = false
    } else {
      ElMessageBox.alert(
        `${outcome.reason}。该修改未入库，已保留为草稿并在页面底部「挂接冲突」中列出。`,
        '版本冲突',
        { type: 'warning', confirmButtonText: '查看冲突' }
      ).then(() => {
        // 滚动到冲突区
        document.querySelector('.draft-conflict-card')?.scrollIntoView({ behavior: 'smooth' })
      }).catch(() => undefined)
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '挂接失败')
  }
}

/* ------------------------------ 移出 ------------------------------ */
async function detach(group: ContinuityGroupRow, elementId: string): Promise<void> {
  try {
    await ElMessageBox.confirm('移出后该要素将退回为独立接戏组，组内相关差异会立即失效重算，是否继续？', '移出确认', {
      type: 'warning',
      confirmButtonText: '确认移出'
    })
  } catch {
    return
  }
  const outcome = await store.detach(group.id, elementId, { baseVersion: group.version, originTab: ORIGIN_TAB })
  if (outcome.accepted) ElMessage.success('已移出接戏组')
  else ElMessage.warning(outcome.reason)
}

/* ------------------------------ 改基准 ------------------------------ */
const baselineDialog = ref(false)
const baselineGroup = ref<ContinuityGroupRow | null>(null)
const baselineBaseVersion = ref(0)
const baselineForm = reactive({ baselineState: '', note: '' })
const baselineFormRef = ref<FormInstance>()
const baselineRules: FormRules = {
  baselineState: [{ required: true, message: '请填写新的连戏基准', trigger: 'blur' }]
}

function openBaseline(group: ContinuityGroupRow): void {
  baselineGroup.value = group
  baselineBaseVersion.value = group.version
  baselineForm.baselineState = group.baselineState
  baselineForm.note = ''
  baselineDialog.value = true
}

async function submitBaseline(): Promise<void> {
  const group = baselineGroup.value
  const valid = await baselineFormRef.value?.validate().catch(() => false)
  if (!valid || !group) return
  const outcome = await store.updateBaseline(group.id, baselineForm.baselineState, {
    baseVersion: baselineBaseVersion.value,
    originTab: ORIGIN_TAB,
    note: baselineForm.note
  })
  if (outcome.accepted) {
    ElMessage.success('连戏基准已更新，全组统一按新基准比对')
    baselineDialog.value = false
  } else {
    ElMessage.warning(`${outcome.reason}，已保留草稿并列出冲突`)
    baselineDialog.value = false
  }
}

/* ------------------------------ 立即重算 ------------------------------ */
async function reconcileNow(): Promise<void> {
  const created = await conflictStore.reconcile()
  ElMessage.success(`组内差异已按拍摄日、镜次失效重算，生成 ${created} 条差异`)
}

/* ------------------------------ 删除接戏组 ------------------------------ */
async function remove(group: ContinuityGroupRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除接戏组「${group.name}」后，其 ${group.elementIds.length} 个要素会各自退回独立接戏组，托管差异一并清除，是否继续？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '确认删除' }
    )
  } catch {
    return
  }
  await store.remove(group.id)
  ElMessage.success('接戏组已删除')
}

async function adoptConflict(conflict: DraftConflictRow): Promise<void> {
  try {
    await adoptDraftConflict(conflict.id)
    ElMessage.success('已采用草稿，按接戏组最新版本重新应用')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '采用失败')
  }
}

async function discardConflict(conflict: DraftConflictRow): Promise<void> {
  await discardDraftConflict(conflict.id)
  ElMessage.success('已丢弃该落后草稿')
}

async function deleteConflictRow(conflict: DraftConflictRow): Promise<void> {
  await removeDraft(conflict.draftId)
}

function onFilterChange(next: FilterModel): void {
  store.setFilters(next)
}

onMounted(() => {
  store.applyQuery(route.query)
})

watch(
  () => store.filters,
  (value) => {
    void router.replace({ path: route.path, query: filtersToQuery(value) })
  },
  { deep: true }
)

const switchValue = computed({
  get: () => store.filters.criticalOnly === true,
  set: (value: boolean) => store.setFilters({ ...store.filters, criticalOnly: value })
})
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">接戏组（跨场次接续）</h2>
        <p class="page__subtitle">
          同一件戏服 / 道具在多场接续时，组内只认一份连戏基准；场次可挂接或移出，同名要素在同一场只属于一个组。
        </p>
      </div>
      <div>
        <el-button :icon="RefreshRight" @click="reconcileNow">按记录失效重算差异</el-button>
        <el-button type="primary" :icon="Link" @click="openCreate">新建接戏组</el-button>
      </div>
    </div>

    <div class="badge-row">
      <StatBadge label="接戏组" :value="totals.groupCount" suffix="组" icon="Files" tone="primary" />
      <StatBadge label="跨场次组" :value="totals.crossSceneCount" suffix="组" icon="Connection" tone="info" />
      <StatBadge label="挂接要素" :value="totals.memberCount" suffix="项" icon="Grid" tone="success" />
      <StatBadge label="当前差异" :value="totals.openConflictCount" suffix="条" icon="WarningFilled" tone="danger" />
      <StatBadge label="基准偏离" :value="totals.driftCount" suffix="处" icon="TrendCharts" tone="warning" />
      <StatBadge label="挂接冲突" :value="totals.pendingDraftCount" suffix="条" icon="Flag" tone="danger" />
    </div>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索接戏组名称 / 基准 / 责任人…"
      switch-label="仅看关键接戏"
      :switch-value="switchValue"
      has-switch
      @update:model-value="onFilterChange"
      @update:switch-value="(v: boolean) => (switchValue = v)"
      @reset="store.resetFilters()"
    />

    <EmptyPanel
      v-if="ready && filteredGroups.length === 0"
      title="还没有接戏组"
      description="每个连戏要素升级时已自动补成独立接戏组；新建接续组后把各场次同名要素挂接进来，即可共用一份基准。"
      create-text="新建接戏组"
      @create="openCreate"
    />

    <div v-else class="group-list">
      <el-card v-for="group in filteredGroups" :key="group.id" shadow="never" class="group-card">
        <template #header>
          <div class="group-card__head">
            <div class="group-card__title">
              <strong>{{ group.name }}</strong>
              <el-tag size="small" effect="dark">{{ group.category }}</el-tag>
              <el-tag v-if="group.critical" type="danger" size="small">关键接戏</el-tag>
              <el-tag v-if="group.auto" type="info" size="small" effect="plain">单场独立组</el-tag>
              <el-tag size="small" effect="plain">v{{ group.version }}</el-tag>
            </div>
            <div class="group-card__actions">
              <el-button link type="primary" size="small" @click="openAttach(group)">挂接场次</el-button>
              <el-button link type="primary" size="small" @click="openBaseline(group)">修改基准</el-button>
              <el-button link type="danger" size="small" @click="remove(group)">删除组</el-button>
            </div>
          </div>
        </template>

        <el-alert
          :title="`组内唯一连戏基准：${group.baselineState}`"
          type="info"
          :closable="false"
          show-icon
          class="baseline-alert"
        />

        <div class="group-card__meta">
          <el-tag size="small" effect="plain">挂接场次 {{ sceneCountOf(group) }} / {{ GROUP_MAX_SCENES }}</el-tag>
          <el-tag size="small" effect="plain">要素 {{ group.elementIds.length }} 项</el-tag>
          <el-tag size="small" effect="plain">责任人 {{ group.owner || '—' }}</el-tag>
          <el-tag v-if="groupOpenConflicts(group.id) > 0" type="danger" size="small">
            时间轴差异 {{ groupOpenConflicts(group.id) }} 条
          </el-tag>
        </div>

        <el-table :data="membersOf(group)" size="small" border stripe class="member-table">
          <el-table-column label="场次" min-width="170">
            <template #default="{ row }">
              <div>{{ sceneLabel(row.element.sceneId) }}</div>
            </template>
          </el-table-column>
          <el-table-column prop="element.name" label="连戏要素" min-width="150" />
          <el-table-column label="最新现场状态" min-width="200">
            <template #default="{ row }">
              <span>{{ row.latestState }}</span>
            </template>
          </el-table-column>
          <el-table-column label="与基准" width="110" align="center">
            <template #default="{ row }">
              <el-tag
                :type="driftOf(row.element.id) ? 'danger' : 'success'"
                size="small"
                effect="plain"
              >
                {{ driftOf(row.element.id) ? '偏离' : '一致' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="记录" width="80" align="right">
            <template #default="{ row }">{{ row.recordCount }} 次</template>
          </el-table-column>
          <el-table-column label="操作" width="100" fixed="right">
            <template #default="{ row }">
              <el-button
                link
                type="danger"
                size="small"
                :disabled="group.auto && group.elementIds.length <= 1"
                @click="detach(group, row.element.id)"
              >
                移出
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>

    <!-- 挂接冲突（落后页签的草稿） -->
    <el-card v-if="draftConflicts.length > 0" shadow="never" class="draft-conflict-card">
      <template #header>
        <div class="card-title">
          <span>挂接冲突与落后草稿</span>
          <span class="muted">只接受基于最新版本的一方，另一方保留草稿</span>
        </div>
      </template>
      <el-table :data="draftConflicts" size="small" border stripe>
        <el-table-column label="接戏组" min-width="160">
          <template #default="{ row }">{{ groups.find((g) => g.id === row.groupId)?.name ?? row.groupId }}</template>
        </el-table-column>
        <el-table-column prop="kind" label="操作" width="80" />
        <el-table-column label="版本" width="110">
          <template #default="{ row }">
            <el-tag size="small" type="danger" effect="plain">v{{ row.baseVersion }} → v{{ row.latestVersion }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="draftBaseline" label="草稿基准" min-width="170" />
        <el-table-column prop="currentBaseline" label="当前基准" min-width="170" />
        <el-table-column prop="originTab" label="来源页签" width="150" />
        <el-table-column label="状态 / 操作" width="200" fixed="right">
          <template #default="{ row }">
            <ConflictTag :state="row.state === '待处理' ? '待确认' : '已解决'" />
            <div v-if="row.state === '待处理'" class="draft-actions">
              <el-button link type="success" size="small" @click="adoptConflict(row)">采用草稿</el-button>
              <el-button link type="warning" size="small" @click="discardConflict(row)">丢弃</el-button>
              <el-button link type="danger" size="small" @click="deleteConflictRow(row)">清除</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 新建接戏组 -->
    <el-dialog v-model="createDialog" title="新建接戏组" width="520px">
      <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-width="100px">
        <el-form-item label="组名称" prop="name">
          <el-input v-model="createForm.name" placeholder="如：女主蓝色风衣（12A/15 接续）" />
        </el-form-item>
        <el-form-item label="类别">
          <el-radio-group v-model="createForm.category">
            <el-radio-button v-for="item in ELEMENT_CATEGORIES" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="连戏基准" prop="baselineState">
          <el-input v-model="createForm.baselineState" type="textarea" :rows="2" placeholder="组内各场次统一比对的唯一基准状态" />
        </el-form-item>
        <el-form-item label="责任人">
          <el-input v-model="createForm.owner" placeholder="如：服化组-林岚" />
        </el-form-item>
        <el-form-item label="关键接戏">
          <el-switch v-model="createForm.critical" active-text="关键（状态差异判为阻断）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" @click="submitCreate">建立</el-button>
      </template>
    </el-dialog>

    <!-- 挂接场次要素 -->
    <el-dialog v-model="attachDialog" :title="`挂接场次要素 · ${attachGroup?.name ?? ''}`" width="600px">
      <el-alert
        v-if="attachFull"
        :title="`接戏组容量上限为 ${GROUP_MAX_SCENES} 个场次，当前已满，拒绝继续挂接`"
        type="error"
        :closable="false"
        show-icon
        class="attach-alert"
      />
      <el-alert
        v-else
        :title="`当前挂接 ${attachGroup ? sceneCountOf(attachGroup) : 0} / ${GROUP_MAX_SCENES} 个场次；同一页签基于 v${attachBaseVersion} 提交，落后会保留草稿。`"
        type="info"
        :closable="false"
        show-icon
        class="attach-alert"
      />
      <el-form label-width="100px">
        <el-form-item label="选择要素" required>
          <el-select v-model="attachElementId" class="full" filterable placeholder="选择其它场次里的同名（或同一实体）要素">
            <el-option
              v-for="candidate in attachCandidates.filter((item) => !item.alreadyInThis)"
              :key="candidate.id"
              :label="candidate.label"
              :value="candidate.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="基准状态">
          <el-input v-model="attachForm.baselineState" type="textarea" :rows="2" placeholder="挂接后组内统一使用的基准（留空则沿用当前基准）" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="attachForm.note" placeholder="本次挂接说明（冲突时随草稿保留）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="attachDialog = false">取消</el-button>
        <el-button type="primary" :disabled="attachFull" @click="submitAttach">挂接</el-button>
      </template>
    </el-dialog>

    <!-- 修改基准 -->
    <el-dialog v-model="baselineDialog" title="修改接戏组基准" width="520px">
      <el-alert
        :title="`当前版本 v${baselineBaseVersion}；若另一页签已先提交，你的修改将保留草稿并列出冲突。`"
        type="warning"
        :closable="false"
        show-icon
        class="attach-alert"
      />
      <el-form ref="baselineFormRef" :model="baselineForm" :rules="baselineRules" label-width="100px">
        <el-form-item label="新基准" prop="baselineState">
          <el-input v-model="baselineForm.baselineState" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="baselineForm.note" placeholder="改基准原因（冲突时随草稿保留）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="baselineDialog = false">取消</el-button>
        <el-button type="primary" @click="submitBaseline">提交新基准</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.full {
  width: 100%;
}

.group-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.group-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.group-card__title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.group-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 0;
}

.baseline-alert {
  margin-bottom: 4px;
}

.attach-alert {
  margin-bottom: 12px;
}

.member-table {
  margin-top: 8px;
}

.draft-actions {
  margin-top: 2px;
}

.draft-conflict-card {
  margin-top: 16px;
  border-left: 4px solid #c0392b;
}
</style>
