/**
 * 挂接草稿与冲突：
 * 两个页签（编辑会话）同时对同一接戏组发起挂接 / 基准修改时，
 * 只接受基于最新版本（baseVersion === group.version）的一方；
 * 落后的一方不入库，保留草稿并登记一条冲突，供人工在「接戏组」页处理。
 */

/** 草稿类型 */
export type DraftKind = '挂接' | '移出' | '基准'

/** 挂接 / 移出 / 改基准被拒后保留的草稿 */
export interface ElementDraft {
  id: string
  /** 发起操作的接戏组 */
  groupId: string
  /** 涉及的连戏要素（基准修改草稿可缺省） */
  elementId: string
  kind: DraftKind
  /** 草稿提交时携带的基准状态（挂接 / 改基准时使用） */
  baselineState: string
  /** 发起时该组的版本号 */
  baseVersion: number
  /** 发起页签名（同一浏览器内用标签页标题 / 页面路径区分） */
  originTab: string
  /** 草稿备注 */
  note: string
}

/** 草稿处理状态 */
export type DraftConflictState = '待处理' | '已采用' | '已丢弃'

/** 挂接冲突：记录被拒草稿与组当前最新版本之间的差异 */
export interface DraftConflict {
  id: string
  draftId: string
  groupId: string
  /** 冲突要素（基准冲突可缺省） */
  elementId: string
  kind: DraftKind
  /** 草稿基于的版本号 */
  baseVersion: number
  /** 组当前最新版本号 */
  latestVersion: number
  /** 草稿里的基准状态 */
  draftBaseline: string
  /** 组当前基准状态 */
  currentBaseline: string
  state: DraftConflictState
  /** 处理留痕 */
  resolvedNote: string
  resolvedAt: string
}

export const DRAFT_KINDS: DraftKind[] = ['挂接', '移出', '基准']
export const DRAFT_CONFLICT_STATES: DraftConflictState[] = ['待处理', '已采用', '已丢弃']

export function createEmptyDraft(): Omit<ElementDraft, 'id'> {
  return { groupId: '', elementId: '', kind: '挂接', baselineState: '', baseVersion: 0, originTab: '', note: '' }
}
