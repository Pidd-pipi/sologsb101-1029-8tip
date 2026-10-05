/**
 * 连戏要素 store：维护要素清单、责任人与筛选条件。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Element } from '@/types/element'
import type { FilterModel } from '@/types/filter'
import { putElement, removeElement, updateElement as updateElementRow, ensureAutoGroups, db, ROW_REVISION } from '@/utils/db'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'

export const ELEMENT_FILTER_KEYS = ['categories', 'sceneIds']

export const useElementStore = defineStore('element', () => {
  const filters = ref<FilterModel>({ keyword: '', categories: [], sceneIds: [] })
  const selectedElementId = ref<string | null>(null)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', categories: [], sceneIds: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, ELEMENT_FILTER_KEYS)
  }

  function select(id: string | null): void {
    selectedElementId.value = id
  }

  async function createElement(payload: Omit<Element, 'id'>): Promise<string> {
    const now = Date.now()
    const id = createId('element')
    await putElement({ ...payload, id, revision: ROW_REVISION, createdAt: now, updatedAt: now })
    // 新要素先落成独立接戏组，等待在接戏组页与其它场次挂接（与旧数据升级规则一致）
    await db.transaction('rw', [db.elements, db.continuityGroups, db.conflicts], ensureAutoGroups)
    selectedElementId.value = id
    return id
  }

  async function updateElement(id: string, patch: Partial<Element>): Promise<void> {
    await updateElementRow(id, patch)
  }

  async function deleteElement(id: string): Promise<void> {
    await removeElement(id)
    if (selectedElementId.value === id) selectedElementId.value = null
  }

  return { filters, selectedElementId, setFilters, resetFilters, applyQuery, select, createElement, updateElement, deleteElement }
})
