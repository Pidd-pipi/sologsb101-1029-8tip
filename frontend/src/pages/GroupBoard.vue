<script setup lang="ts">
/** /groups 接戏组管理：同一件道具跨场次接成一组，组内只认一份基准，场次可挂接或移出 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus, Refresh } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import ConflictTag from '@/components/common/ConflictTag.vue'
import {
  db,
  type ElementRow,
  type GroupRow,
  type RecordRow,
  type SceneRow,
  type ShootDayRow
} from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useGroupDiff } from '@/hooks/useGroupDiff'
import { useGroupStore } from '@/stores/groupStore'
import { GROUP_CAPACITY_LIMIT, createEmptyGroup, type ContinuityGroup } from '@/types/group'
import { ELEMENT_CATEGORIES } from '@/types/element'
import type { FilterModel } from '@/types/filter'

const route = useRoute()
const router = useRouter()
const store = useGroupStore()

const { rows: groups, ready } = useIdbTable<GroupRow>(() => db.groups, {
  compare: (a, b) => b.updatedAt - a.updatedAt
})
const { rows: elements } = useIdbTable<ElementRow>(() => db.elements)
const { rows: scenes } = useIdbTable<SceneRow>(() => db.scenes, { compare: (a, b) => a.shootOrder - b.shootOrder })
const { rows: records } = useIdbTable<RecordRow>(() => db.records)
const { rows: shootDays } = useIdbTable<ShootDayRow>(() => db.shootDays)

const filters = ref<FilterModel>({ keyword: '' })
const selectedGroupId = ref<string | null>(null)

const selectedGroup = computed<GroupRow | null>(
  () => groups.value.find((item) => item.id === selectedGroupId.value) ?? null
)

const {
  candidates: diffCandidates,
  diffCount,
  fingerprint: groupFingerprint,
  isStale
} = useGroupDiff(selectedGroup, records, elements, shootDays)

/** 组内差异失效后立即重算（更新缓存指纹） */
watch(
  () => [selectedGroupId.value, groupFingerprint.value] as const,
  ([, fingerprint]) => {
    const group = selectedGroup.value
    if (!group || !fingerprint) return
    if (group.diffFingerprint !== fingerprint) {
      void store.touchDiff(group.id, fingerprint)
    }
  }
)

/* ------------------------------ 派生数据 ------------------------------ */

function sceneOf(sceneId: string): SceneRow | null {
  return scenes.value.find((item) => item.id === sceneId) ?? null
}

function sceneLabel(sceneId: string): string {
  const scene = sceneOf(sceneId)
  return scene ? `第 ${scene.sceneNo} 场 · ${scene.location}` : '场次已删除'
}

function dayLabelOf(record: RecordRow): string {
  return shootDays.value.find((item) => item.id === record.shootDayId)?.date ?? '未知拍摄日'
}

function recordCountOf(elementId: string): number {
  return records.value.filter((item) => item.elementId === elementId).length
}

/** 已属于某个接戏组的要素（不能再挂到别的组） */
const attachedElementIds = computed(() => new Set(groups.value.flatMap((g) => g.elementIds)))

/** 可挂接要素：尚未属于任何接戏组 */
const availableElements = computed(() =>
  elements.value.filter((item) => !attachedElementIds.value.has(item.id))
)

/** 选中组的成员要素 */
const memberElements = computed<ElementRow[]>(() => {
  if (!selectedGroup.value) return []
  return selectedGroup.value.elementIds
    .map((id) => elements.value.find((item) => item.id === id))
    .filter((item): item is ElementRow => Boolean(item))
})

/** 组列表（带筛选） */
const filteredGroups = computed(() => {
  const keyword = String(filters.value.keyword ?? '').trim().toLowerCase()
  return groups.value.filter((group) => {
    if (!keyword) return true
    const memberNames = memberElements.value.map((item) => item.name).join(' ')
    return `${group.name} ${group.baselineState} ${memberNames}`.toLowerCase().includes(keyword)
  })
})

const totals = computed(() => ({
  groupCount: groups.value.length,
  attachedSceneCount: groups.value.reduce((sum, g) => sum + g.sceneIds.length, 0),
  diffCount: diffCount.value,
  conflictCount: store.conflicts.length
}))

/* ------------------------------ 新建接戏组 ------------------------------ */
const createDialog = ref(false)
const createFormRef = ref<FormInstance>()
const createForm = reactive<Omit<ContinuityGroup, 'id' | 'diffFingerprint' | 'lastDiffAt'>>(createEmptyGroup())
const createRules: FormRules = {
  name: [{ required: true, message: '请填写组名', trigger: 'blur' }],
  category: [{ required: true, message: '请选择类别', trigger: 'change' }],
  baselineState: [{ required: true, message: '请填写基准状态', trigger: 'blur' }]
}

function openCreate(): void {
  Object.assign(createForm, createEmptyGroup())
  createForm.elementIds = []
  createForm.sceneIds = []
  createDialog.value = true
}

async function submitCreate(): Promise<void> {
  const valid = await createFormRef.value?.validate().catch(() => false)
  if (!valid) return
  const selected = createForm.elementIds
  const sceneIds = [...new Set(selected.map((id) => elements.value.find((e) => e.id === id)?.sceneId).filter(Boolean))] as string[]
  const id = await store.createGroup({ ...createForm, elementIds: selected, sceneIds })
  createDialog.value = false
  selectedGroupId.value = id
  ElMessage.success('接戏组已建立')
}

/* ------------------------------ 挂接要素 ------------------------------ */
const attachDialog = ref(false)
const attachFormRef = ref<FormInstance>()
const attachElementId = ref('')
/** 草稿基于的组 revision：打开挂接对话框时捕获，提交时携带用于乐观并发校验 */
const attachExpectedRevision = ref(0)
const attachRules: FormRules = {
  attachElementId: [{ required: true, message: '请选择要挂接的要素', trigger: 'change' }]
}

function openAttach(): void {
  if (!selectedGroup.value) return
  if (availableElements.value.length === 0) {
    ElMessage.info('没有可挂接的要素（所有要素都已属于某个接戏组）')
    return
  }
  attachElementId.value = availableElements.value[0].id
  attachExpectedRevision.value = selectedGroup.value.revision
  attachDialog.value = true
}

async function submitAttach(): Promise<void> {
  const valid = await attachFormRef.value?.validate().catch(() => false)
  if (!valid || !selectedGroup.value) return
  const element = elements.value.find((item) => item.id === attachElementId.value)
  const groupName = selectedGroup.value.name
  try {
    await store.attach(selectedGroup.value.id, attachElementId.value, attachExpectedRevision.value, {
      elementName: element?.name ?? '',
      sceneId: element?.sceneId ?? '',
      groupName
    })
    attachDialog.value = false
    ElMessage.success('要素已挂接到接戏组')
  } catch (error) {
    if (error instanceof Error && error.name === 'VersionConflictError') {
      ElMessage.error('挂接未生效：接戏组已被其他页签更新，草稿已保留')
    } else {
      ElMessage.error(error instanceof Error ? error.message : '挂接失败')
    }
  }
}

async function detach(elementId: string): Promise<void> {
  if (!selectedGroup.value) return
  try {
    await ElMessageBox.confirm('移出该要素不会删除要素本身，是否继续？', '移出确认', { type: 'warning' })
  } catch {
    return
  }
  await store.detach(selectedGroup.value.id, elementId)
  ElMessage.success('要素已移出接戏组')
}

/* ------------------------------ 编辑基准 ------------------------------ */
const baselineDialog = ref(false)
const baselineForm = reactive({ baselineState: '', baselineNote: '' })

function openBaseline(): void {
  if (!selectedGroup.value) return
  baselineForm.baselineState = selectedGroup.value.baselineState
  baselineForm.baselineNote = selectedGroup.value.baselineNote
  baselineDialog.value = true
}

async function submitBaseline(): Promise<void> {
  if (!selectedGroup.value) return
  if (!baselineForm.baselineState.trim()) {
    ElMessage.warning('请填写基准状态')
    return
  }
  await store.updateBaseline(selectedGroup.value.id, baselineForm.baselineState, baselineForm.baselineNote)
  baselineDialog.value = false
  ElMessage.success('基准已更新，全组按新基准比对')
}

/* ------------------------------ 删除组 ------------------------------ */
async function removeGroup(): Promise<void> {
  if (!selectedGroup.value) return
  try {
    await ElMessageBox.confirm(
      `删除接戏组「${selectedGroup.value.name}」不会删除要素本身，是否继续？`,
      '删除确认',
      { type: 'warning' }
    )
  } catch {
    return
  }
  await store.remove(selectedGroup.value.id)
  selectedGroupId.value = null
  ElMessage.success('接戏组已删除')
}

/* ------------------------------ 并发演示 ------------------------------ */
async function simulateConcurrent(): Promise<void> {
  if (!selectedGroup.value) return
  const rev = await store.simulateConcurrentUpdate(selectedGroup.value.id)
  ElMessage.info(`已模拟其他页签提交（组 revision → v${rev}），此时再挂接会触发版本冲突`)
}

function onFilterChange(next: FilterModel): void {
  filters.value = next
}

onMounted(() => {
  if (typeof route.query.groupId === 'string') selectedGroupId.value = route.query.groupId
})

watch(selectedGroupId, (id) => {
  if (id) void router.replace({ path: route.path, query: { groupId: id } })
})
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">接戏组管理</h2>
        <p class="page__subtitle">同一件道具跨场次接成一组，组内只认一份基准；场次可挂接或移出，容量上限 {{ GROUP_CAPACITY_LIMIT }} 场。</p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新建接戏组</el-button>
    </div>

    <div class="badge-row">
      <StatBadge label="接戏组" :value="totals.groupCount" suffix="组" icon="Files" tone="primary" />
      <StatBadge label="挂接场次" :value="totals.attachedSceneCount" suffix="场" icon="Grid" tone="info" />
      <StatBadge label="组内差异" :value="totals.diffCount" suffix="条" icon="WarningFilled" tone="danger" />
      <StatBadge label="版本冲突" :value="totals.conflictCount" suffix="条" icon="DataLine" tone="warning" />
    </div>

    <FilterBar
      :model-value="filters"
      keyword-placeholder="搜索组名 / 基准 / 成员要素…"
      @update:model-value="onFilterChange"
    />

    <EmptyPanel
      v-if="ready && groups.length === 0"
      title="还没有接戏组"
      description="把跨场复用的道具接成一组，组内只认一份基准，自动按拍摄日与镜次排出差异。"
      create-text="新建接戏组"
      @create="openCreate"
    />

    <el-row v-else :gutter="16">
      <el-col :span="8">
        <el-card shadow="never">
          <template #header>
            <div class="card-title"><span>接戏组（{{ filteredGroups.length }}）</span><span class="muted">点击选择</span></div>
          </template>
          <div class="group-list">
            <div
              v-for="group in filteredGroups"
              :key="group.id"
              class="group-item"
              :class="{ 'is-active': group.id === selectedGroupId }"
              @click="selectedGroupId = group.id"
            >
              <div class="group-item__head">
                <strong>{{ group.name }}</strong>
                <el-tag size="small" effect="dark">{{ group.category }}</el-tag>
              </div>
              <div class="group-item__base">基准：{{ group.baselineState || '未设置' }}</div>
              <div class="group-item__meta">
                <el-tag size="small" effect="plain">{{ group.sceneIds.length }} / {{ group.capacity }} 场</el-tag>
                <el-tag v-if="isStale(group)" size="small" type="warning" effect="plain">差异已失效</el-tag>
              </div>
            </div>
          </div>
        </el-card>
      </el-col>

      <el-col :span="16">
        <el-card v-if="!selectedGroup" shadow="never">
          <EmptyPanel title="未选择接戏组" description="在左侧选择一个接戏组查看成员与差异。" :show-create="false" />
        </el-card>

        <template v-else>
          <el-card shadow="never" class="detail-card">
            <template #header>
              <div class="card-title">
                <span>
                  {{ selectedGroup.name }}
                  <el-tag size="small" effect="dark">{{ selectedGroup.category }}</el-tag>
                </span>
                <div>
                  <el-button link type="primary" size="small" @click="openAttach">挂接要素</el-button>
                  <el-button link type="primary" size="small" @click="openBaseline">编辑基准</el-button>
                  <el-button link type="danger" size="small" @click="removeGroup">删除</el-button>
                </div>
              </div>
            </template>

            <el-descriptions :column="2" border size="small" class="detail-desc">
              <el-descriptions-item label="组内基准" :span="2">
                {{ selectedGroup.baselineState || '未设置' }}
                <div v-if="selectedGroup.baselineNote" class="muted">{{ selectedGroup.baselineNote }}</div>
              </el-descriptions-item>
              <el-descriptions-item label="挂接场次">
                {{ selectedGroup.sceneIds.length }} / {{ selectedGroup.capacity }}
                <el-tag
                  v-if="selectedGroup.sceneIds.length >= selectedGroup.capacity"
                  size="small"
                  type="danger"
                  effect="plain"
                >已满</el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="最近比对">
                {{ selectedGroup.lastDiffAt ? new Date(selectedGroup.lastDiffAt).toLocaleString('zh-CN') : '尚未比对' }}
                <el-tag v-if="isStale(selectedGroup)" size="small" type="warning" effect="plain">差异已失效</el-tag>
              </el-descriptions-item>
            </el-descriptions>

            <div class="section-title">成员要素（{{ memberElements.length }}）</div>
            <el-table :data="memberElements" stripe border size="small">
              <el-table-column prop="name" label="要素名称" min-width="150" />
              <el-table-column label="所属场次" min-width="160">
                <template #default="{ row }">{{ sceneLabel(row.sceneId) }}</template>
              </el-table-column>
              <el-table-column prop="owner" label="责任人" width="140" />
              <el-table-column label="现场记录" width="90" align="right">
                <template #default="{ row }">{{ recordCountOf(row.id) }} 次</template>
              </el-table-column>
              <el-table-column label="操作" width="90">
                <template #default="{ row }">
                  <el-button link type="danger" size="small" @click="detach(row.id)">移出</el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-card>

          <el-card shadow="never" class="detail-card">
            <template #header>
              <div class="card-title">
                <span>组内差异（按拍摄日 · 镜次）</span>
                <el-button link type="primary" size="small" :icon="Refresh" @click="selectedGroupId = selectedGroup.id">刷新</el-button>
              </div>
            </template>
            <EmptyPanel
              v-if="diffCandidates.length === 0"
              title="组内无差异"
              description="各场次的现场状态与基准一致，或记录不足两次。"
              :show-create="false"
            />
            <el-table v-else :data="diffCandidates" stripe border size="small" row-key="desc">
              <el-table-column label="较早记录" min-width="200">
                <template #default="{ row }">
                  <div class="muted">{{ dayLabelOf(row.a) }} · 镜次 {{ row.a.takeNo }}</div>
                  <div>{{ row.a.currentState || '（空）' }}</div>
                </template>
              </el-table-column>
              <el-table-column label="较晚记录" min-width="200">
                <template #default="{ row }">
                  <div class="muted">{{ dayLabelOf(row.b) }} · 镜次 {{ row.b.takeNo }}</div>
                  <div>{{ row.b.currentState || '（空）' }}</div>
                </template>
              </el-table-column>
              <el-table-column prop="desc" label="差异描述" min-width="220" />
              <el-table-column label="严重程度" width="110">
                <template #default="{ row }">
                  <ConflictTag :severity="row.severity" />
                </template>
              </el-table-column>
            </el-table>
          </el-card>

          <el-card v-if="store.conflicts.length > 0 || store.drafts.length > 0" shadow="never" class="detail-card">
            <template #header>
              <div class="card-title"><span>版本冲突与草稿</span><span class="muted">两个页签同时挂接同一要素</span></div>
            </template>
            <el-alert
              v-for="conflict in store.conflicts"
              :key="conflict.id"
              type="warning"
              :closable="false"
              class="conflict-alert"
            >
              <template #title>
                {{ conflict.message }}
                <el-button link type="primary" size="small" @click="store.dismissConflict(conflict.id)">知道了</el-button>
              </template>
            </el-alert>
            <div v-for="draft in store.drafts" :key="draft.id" class="draft-item">
              <span class="muted">草稿：</span>
              挂接「{{ draft.elementName }}」到「{{ draft.groupName }}」（基于 v{{ draft.expectedRevision }}，未生效）
              <el-button link type="danger" size="small" @click="store.removeDraft(draft.id)">丢弃草稿</el-button>
            </div>
          </el-card>
        </template>
      </el-col>
    </el-row>

    <el-dialog v-model="createDialog" title="新建接戏组" width="560px">
      <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-width="100px">
        <el-form-item label="组名" prop="name">
          <el-input v-model="createForm.name" placeholder="如：女主蓝色风衣" />
        </el-form-item>
        <el-form-item label="类别" prop="category">
          <el-radio-group v-model="createForm.category">
            <el-radio-button v-for="item in ELEMENT_CATEGORIES" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="基准状态" prop="baselineState">
          <el-input v-model="createForm.baselineState" type="textarea" :rows="2" placeholder="组内只认这一份基准" />
        </el-form-item>
        <el-form-item label="基准说明">
          <el-input v-model="createForm.baselineNote" placeholder="如：以第 3 场记录为准" />
        </el-form-item>
        <el-form-item label="初始挂接">
          <el-select v-model="createForm.elementIds" class="full" multiple placeholder="选择要挂接的要素（可后补）">
            <el-option
              v-for="item in availableElements"
              :key="item.id"
              :label="`${item.name}（${item.category} · ${sceneLabel(item.sceneId)}）`"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" @click="submitCreate">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="attachDialog" title="挂接要素到接戏组" width="520px">
      <el-form ref="attachFormRef" :model="{ attachElementId }" :rules="attachRules" label-width="100px">
        <el-form-item label="选择要素" prop="attachElementId">
          <el-select v-model="attachElementId" class="full" placeholder="选择要挂接的要素">
            <el-option
              v-for="item in availableElements"
              :key="item.id"
              :label="`${item.name}（${item.category} · ${sceneLabel(item.sceneId)}）`"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="并发版本">
          <span class="muted">草稿基于组 revision v{{ attachExpectedRevision }}；若提交前组被其他页签更新，本次挂接将被拒绝并保留草稿。</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="simulateConcurrent">模拟其他页签已提交</el-button>
        <el-button @click="attachDialog = false">取消</el-button>
        <el-button type="primary" @click="submitAttach">挂接</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="baselineDialog" title="编辑组内基准" width="520px">
      <el-form label-width="100px">
        <el-form-item label="基准状态">
          <el-input v-model="baselineForm.baselineState" type="textarea" :rows="2" placeholder="组内只认这一份基准" />
        </el-form-item>
        <el-form-item label="基准说明">
          <el-input v-model="baselineForm.baselineNote" placeholder="如：以第 3 场记录为准" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="baselineDialog = false">取消</el-button>
        <el-button type="primary" @click="submitBaseline">保存基准</el-button>
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
  gap: 10px;
  max-height: 640px;
  overflow-y: auto;
}

.group-item {
  padding: 10px 12px;
  border: 1px solid #dde7ef;
  border-radius: 10px;
  background: #fbfcfe;
  cursor: pointer;
}

.group-item.is-active {
  border-color: #5b8bb8;
  background: #f0f5fa;
}

.group-item__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.group-item__base {
  margin-top: 4px;
  font-size: 12px;
  color: #5b6b7a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-item__meta {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.detail-card {
  margin-bottom: 14px;
}

.detail-desc {
  margin-bottom: 12px;
}

.section-title {
  margin: 12px 0 8px;
  font-weight: 600;
  color: #2b3a47;
}

.conflict-alert {
  margin-bottom: 8px;
}

.draft-item {
  padding: 6px 0;
  font-size: 13px;
  color: #6b6257;
}
</style>
