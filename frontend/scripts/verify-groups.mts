/**
 * 运行时验证（Node + fake-indexeddb，不进入前端构建）：
 * 1) v1 → v2 升级：旧单场要素补成独立接戏组、差异回填 groupId
 * 2) 挂接：跨场同名可同组、同场同名互斥、容量上限 12、落后版本留草稿列冲突
 * 3) 现场记录变化：托管差异立即失效并重算
 */
const fake = await import('fake-indexeddb')
;(globalThis as { indexedDB: typeof fake.indexedDB; IDBKeyRange: typeof fake.IDBKeyRange }).indexedDB = fake.indexedDB
;(globalThis as { IDBKeyRange: typeof fake.IDBKeyRange }).IDBKeyRange = fake.IDBKeyRange

const Dexie = (await import('dexie')).default
const dbApi = await import('../src/utils/db.ts')
const { db, initDatabase, ensureAutoGroups, attachElementToGroup } = dbApi
const { reconcileManagedConflicts } = await import('../src/utils/groupReconcile.ts')

let failures = 0
function assert(cond: boolean, message: string): void {
  if (cond) console.log(`  ✓ ${message}`)
  else {
    failures += 1
    console.error(`  ✗ ${message}`)
  }
}

const V1_STORES = {
  scenes: 'id, sceneNo, place, timeOfDay, shootOrder, state, updatedAt',
  elements: 'id, sceneId, category, name, owner, critical, updatedAt',
  shootDays: 'id, date, director, scripty, updatedAt',
  records: 'id, shootDayId, elementId, sceneId, takeNo, updatedAt',
  conflicts: 'id, elementId, recordIdA, recordIdB, severity, state, updatedAt'
}

async function main(): Promise<void> {
  /* ------------------------- 1) v1 → v2 升级 ------------------------- */
  console.log('\n[1] 旧数据升级：每个单场要素补成独立接戏组')
  await db.close()
  await db.delete()

  const legacy = new Dexie('gbcontinuity-db')
  legacy.version(1).stores(V1_STORES)
  await legacy.table('scenes').bulkPut([
    { id: 's1', sceneNo: '1', place: '内景', timeOfDay: '日', location: '客厅', excerpt: '', shootOrder: 1, state: '未拍' },
    { id: 's2', sceneNo: '2', place: '外景', timeOfDay: '日', location: '码头', excerpt: '', shootOrder: 2, state: '未拍' }
  ])
  await legacy.table('elements').bulkPut([
    { id: 'e1', sceneId: 's1', category: '服装', name: '风衣', initialState: '深蓝', owner: '林', critical: true },
    { id: 'e2', sceneId: 's2', category: '服装', name: '风衣', initialState: '深蓝', owner: '林', critical: true }
  ])
  await legacy.table('conflicts').bulkPut([
    { id: 'c1', elementId: 'e1', recordIdA: 'r1', recordIdB: 'r2', diffDesc: 'x', severity: '阻断', state: '待确认' }
  ])
  await legacy.close()

  await initDatabase()
  let groups = await db.continuityGroups.toArray()
  assert(groups.length === 2, `两个单场要素各补一个独立接戏组（实际 ${groups.length}）`)
  assert(groups.every((g) => g.auto === true && g.elementIds.length === 1), '补出的组均为 auto 单成员组')
  const upgradedConflict = await db.conflicts.get('c1')
  assert(Boolean(upgradedConflict?.groupId), '旧差异已回填 groupId')
  assert(upgradedConflict?.managed === true, '旧差异标记为托管')

  /* ------------------------- 2) 挂接规则 ------------------------- */
  console.log('\n[2] 挂接：跨场同名可同组、同场同名互斥、容量、版本冲突留草稿')
  const g1 = groups.find((g) => g.elementIds.includes('e1'))!

  const attachOk = await attachElementToGroup(g1.id, 'e2', { baseVersion: g1.version, originTab: '页签A' })
  assert(attachOk.accepted === true, '跨场次同名要素挂接成功')
  let group = await db.continuityGroups.get(g1.id)
  assert(group!.elementIds.length === 2, '组内现有 2 个成员')

  // 同场次同名互斥：再建一个 s1 里同名「风衣」的独立要素，不能挂入 g1
  await db.elements.put({
    id: 'e-dup', sceneId: 's1', category: '服装', name: '风衣', initialState: '深蓝', owner: '林', critical: true
  })
  await db.transaction('rw', [db.elements, db.continuityGroups, db.conflicts], ensureAutoGroups)
  let sameNameError = ''
  try {
    const cur = await db.continuityGroups.get(g1.id)
    await attachElementToGroup(g1.id, 'e-dup', { baseVersion: cur!.version, originTab: '同场同名测试' })
  } catch (error) {
    sameNameError = error instanceof Error ? error.message : ''
  }
  assert(sameNameError.includes('同名'), `同场次同名要素被拒绝（${sameNameError}）`)

  // 落后版本 → 留草稿列冲突（用一个未入组的新场次要素，携带过期版本号）
  await db.scenes.put({
    id: 's9', sceneNo: '9', place: '外景', timeOfDay: '夜', location: '夜巷',
    excerpt: '', shootOrder: 9, state: '未拍'
  })
  await db.elements.put({
    id: 'e-stale', sceneId: 's9', category: '服装', name: '风衣夜场', initialState: '深蓝', owner: '林', critical: false
  })
  await db.transaction('rw', [db.elements, db.continuityGroups, db.conflicts], ensureAutoGroups)
  const stale = await attachElementToGroup(g1.id, 'e-stale', { baseVersion: g1.version, originTab: '页签B-落后' })
  assert(stale.accepted === false, '落后版本的挂接被拒绝')
  if (!stale.accepted) {
    const draft = await db.elementDrafts.get(stale.draftId)
    const dc = await db.draftConflicts.get(stale.conflictId)
    assert(Boolean(draft) && draft.originTab === '页签B-落后', '已保留落后页签的草稿')
    group = await db.continuityGroups.get(g1.id)
    assert(Boolean(dc) && dc.state === '待处理' && dc.latestVersion === group!.version, '已列出挂接冲突')
  }

  // 容量：补到 12 场，再挂第 13 场应被拒
  for (let i = 3; i <= 13; i += 1) {
    await db.scenes.put({
      id: `s${i}`, sceneNo: `${i}`, place: '内景', timeOfDay: '日', location: `地点${i}`,
      excerpt: '', shootOrder: i, state: '未拍'
    })
    await db.elements.put({
      id: `cap-e${i}`, sceneId: `s${i}`, category: '服装', name: `风衣第${i}场`,
      initialState: '深蓝', owner: '林', critical: false
    })
  }
  await db.transaction('rw', [db.elements, db.continuityGroups, db.conflicts], ensureAutoGroups)
  let capacityError = ''
  for (let i = 3; i <= 12; i += 1) {
    const cur = await db.continuityGroups.get(g1.id)
    const res = await attachElementToGroup(g1.id, `cap-e${i}`, { baseVersion: cur!.version, originTab: '容量测试' })
    if (!res.accepted) capacityError = `第 ${i} 场挂接意外被拒：${res.reason}`
  }
  assert(capacityError === '', capacityError || '再挂 10 个场次成功，组达到 12 场上限（已有 s1、s2）')
  group = await db.continuityGroups.get(g1.id)
  const memberScenes = new Set((await db.elements.where('id').anyOf(group!.elementIds).toArray()).map((e) => e.sceneId))
  assert(memberScenes.size === 12, `组内去重场次恰为 12（实际 ${memberScenes.size}）`)
  let overCapacity = ''
  try {
    const cur = await db.continuityGroups.get(g1.id)
    await attachElementToGroup(g1.id, 'cap-e13', { baseVersion: cur!.version, originTab: '容量测试' })
  } catch (error) {
    overCapacity = error instanceof Error ? error.message : ''
  }
  assert(overCapacity.includes('12'), `第 13 个场次被拒绝（${overCapacity}）`)

  /* ------------------------- 3) 记录变化失效重算 ------------------------- */
  console.log('\n[3] 现场记录变化：托管差异立即失效，重算后恢复')
  await dbApi.resetDatabase()
  const windcoat = await db.continuityGroups.filter((g) => g.name.includes('女主蓝色风衣')).first()
  assert(Boolean(windcoat), '演示数据含跨场次风衣接戏组')
  // 用实时比对口径（拍摄日 + 镜次时间轴）计算应有差异数
  const { computeManagedCandidates } = await import('../src/utils/groupReconcile.ts')
  const expectedCount = computeManagedCandidates(
    await db.records.toArray(),
    await db.elements.toArray(),
    await db.shootDays.toArray(),
    await db.continuityGroups.toArray()
  ).filter((c) => c.groupId === windcoat!.id).length

  // 模拟现场记录变化的失效路径（db.putRecord 即删该组托管差异）
  const rec004 = await db.records.get('rec-004')
  await dbApi.putRecord({ ...rec004! })
  const managedDuring = await db.conflicts.filter((c) => c.managed && c.groupId === windcoat!.id).toArray()
  assert(managedDuring.length === 0, '记录写入后该组托管差异立即失效')

  const created = await reconcileManagedConflicts()
  const managedAfter = await db.conflicts.filter((c) => c.managed && c.groupId === windcoat!.id).toArray()
  assert(managedAfter.length === expectedCount, `重算后差异数量与时间轴比对一致（${managedAfter.length} 条）`)
  assert(created >= 0, '重算返回新建数量')

  await db.close()
  console.log(`\n${failures === 0 ? '全部断言通过 ✅' : `${failures} 条断言失败 ❌`}`)
  if (failures > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
