/**
 * 接戏组 store：维护接戏组清单、挂接/移出、基准更新与版本冲突草稿。
 * 挂接采用乐观并发：提交时携带草稿基于的 revision，与组当前 revision 不一致则拒绝，
 * 被拒绝的一方保留草稿并列出版本冲突（两个页签同时挂接同一要素的场景）。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ContinuityGroup, GroupDraft, VersionConflict } from '@/types/group'
import { GROUP_CAPACITY_LIMIT, VersionConflictError } from '@/types/group'
import {
  attachElementToGroup,
  bumpGroupRevision,
  detachElementFromGroup,
  putGroup,
  removeGroup,
  touchGroupDiff,
  updateGroupBaseline,
  type GroupRow
} from '@/utils/db'
import { createId } from '@/utils/uuid'

export const useGroupStore = defineStore('group', () => {
  /** 挂接草稿：版本冲突时保留的未生效挂接操作 */
  const drafts = ref<GroupDraft[]>([])
  /** 版本冲突列表：两个页签同时挂接同一要素，基于旧版本的一方被拒绝 */
  const conflicts = ref<VersionConflict[]>([])

  async function createGroup(
    payload: Omit<ContinuityGroup, 'id' | 'diffFingerprint' | 'lastDiffAt'>
  ): Promise<string> {
    const now = Date.now()
    const id = createId('group')
    const row: GroupRow = {
      ...payload,
      id,
      capacity: payload.capacity ?? GROUP_CAPACITY_LIMIT,
      diffFingerprint: '',
      lastDiffAt: 0,
      revision: 1,
      createdAt: now,
      updatedAt: now
    }
    await putGroup(row)
    return id
  }

  /**
   * 挂接要素到接戏组。
   * @param expectedRevision 草稿基于的组 revision（打开挂接对话框时捕获）
   * 版本冲突时抛 VersionConflictError，同时保留草稿并列出冲突。
   */
  async function attach(
    groupId: string,
    elementId: string,
    expectedRevision: number,
    meta?: { elementName?: string; sceneId?: string; groupName?: string }
  ): Promise<GroupRow> {
    try {
      return await attachElementToGroup(groupId, elementId, expectedRevision)
    } catch (error) {
      if (error instanceof VersionConflictError) {
        const now = Date.now()
        const draft: GroupDraft = {
          id: createId('draft'),
          groupId,
          groupName: meta?.groupName ?? error.groupName,
          elementId,
          elementName: meta?.elementName ?? error.elementName,
          sceneId: meta?.sceneId ?? '',
          expectedRevision,
          createdAt: now
        }
        drafts.value.push(draft)
        const conflict: VersionConflict = {
          id: createId('vconflict'),
          groupId,
          groupName: meta?.groupName ?? error.groupName,
          elementId,
          elementName: meta?.elementName ?? error.elementName,
          expectedRevision,
          latestRevision: error.latestRevision,
          message: error.message,
          createdAt: now
        }
        conflicts.value.push(conflict)
      }
      throw error
    }
  }

  async function detach(groupId: string, elementId: string): Promise<void> {
    await detachElementFromGroup(groupId, elementId)
  }

  async function updateBaseline(groupId: string, baselineState: string, baselineNote: string): Promise<void> {
    await updateGroupBaseline(groupId, baselineState, baselineNote)
  }

  async function remove(id: string): Promise<void> {
    await removeGroup(id)
  }

  /** 记录差异比对指纹（现场记录变化后指纹失效，触发重算） */
  async function touchDiff(groupId: string, fingerprint: string): Promise<void> {
    await touchGroupDiff(groupId, fingerprint)
  }

  /** 递增组 revision（模拟其他页签已提交更新，用于演示乐观并发冲突） */
  async function simulateConcurrentUpdate(groupId: string): Promise<number> {
    return bumpGroupRevision(groupId)
  }

  function dismissConflict(conflictId: string): void {
    conflicts.value = conflicts.value.filter((item) => item.id !== conflictId)
  }

  function removeDraft(draftId: string): void {
    drafts.value = drafts.value.filter((item) => item.id !== draftId)
  }

  return {
    drafts,
    conflicts,
    createGroup,
    attach,
    detach,
    updateBaseline,
    remove,
    touchDiff,
    simulateConcurrentUpdate,
    dismissConflict,
    removeDraft
  }
})
