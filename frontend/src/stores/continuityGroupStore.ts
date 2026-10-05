/**
 * 接戏组 store：组内只认一份基准，维护场次挂接 / 移出、基准版本与跨页签草稿冲突。
 * 所有写操作都带「发起时基于的版本号」：落后于最新版本时保留草稿并登记冲突。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { ContinuityGroup } from '@/types/continuityGroup'
import type { FilterModel } from '@/types/filter'
import {
  attachElementToGroup,
  detachElementFromGroup,
  putContinuityGroup,
  removeContinuityGroup,
  updateGroupBaseline as updateGroupBaselineRow,
  updateGroupMeta,
  ROW_REVISION,
  type GroupMutationOutcome
} from '@/utils/db'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'

export const GROUP_FILTER_KEYS = ['categories', 'criticalOnly']

export const useContinuityGroupStore = defineStore('continuityGroup', () => {
  const filters = ref<FilterModel>({ keyword: '', categories: [], criticalOnly: false })
  const selectedGroupId = ref<string | null>(null)
  /** 最近一次被拒（版本落后）保留下来的草稿提示 */
  const lastConflictMessage = ref('')

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', categories: [], criticalOnly: false }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, GROUP_FILTER_KEYS)
  }

  function select(id: string | null): void {
    selectedGroupId.value = id
  }

  async function createGroup(payload: Omit<ContinuityGroup, 'id' | 'elementIds' | 'version' | 'auto'>): Promise<string> {
    const now = Date.now()
    const id = createId('cg')
    await putContinuityGroup({
      ...payload,
      id,
      elementIds: [],
      version: 1,
      auto: false,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    })
    selectedGroupId.value = id
    return id
  }

  async function updateMeta(id: string, patch: Parameters<typeof updateGroupMeta>[1]): Promise<void> {
    await updateGroupMeta(id, patch)
  }

  /** 挂接场次要素：容量 / 同名校验由 db 层抛错；版本落后返回 rejected */
  async function attach(
    groupId: string,
    elementId: string,
    options: { baseVersion: number; originTab: string; baselineState?: string; note?: string }
  ): Promise<GroupMutationOutcome> {
    try {
      return await attachElementToGroup(groupId, elementId, options)
    } catch (error) {
      lastConflictMessage.value = error instanceof Error ? error.message : '挂接失败'
      throw error
    }
  }

  async function detach(
    groupId: string,
    elementId: string,
    options: { baseVersion: number; originTab: string; note?: string }
  ): Promise<GroupMutationOutcome> {
    return detachElementFromGroup(groupId, elementId, options)
  }

  async function updateBaseline(
    groupId: string,
    baselineState: string,
    options: { baseVersion: number; originTab: string; note?: string }
  ): Promise<GroupMutationOutcome> {
    return updateGroupBaselineRow(groupId, baselineState, options)
  }

  async function remove(id: string): Promise<void> {
    await removeContinuityGroup(id)
    if (selectedGroupId.value === id) selectedGroupId.value = null
  }

  return {
    filters,
    selectedGroupId,
    lastConflictMessage,
    setFilters,
    resetFilters,
    applyQuery,
    select,
    createGroup,
    updateMeta,
    attach,
    detach,
    updateBaseline,
    remove
  }
})
