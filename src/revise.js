'use strict';

/**
 * 纸样改版（按裁片型号修订）纯逻辑模块。
 *
 * 一次改版针对一个型号的【当前纸样版本】提交：新多边形轮廓、是否允许 180° 旋转、目标总件数。
 * 规则（全部满足才产出 plan；否则返回 { errors } 或 { status:409, error, conflicts }，原方案不变）：
 *
 *  - 已裁件（cut）：继续使用各自旧轮廓/方向，卷号、坐标、方向、必用卷、裁剪清单均不变；不允许删减。
 *  - 锁定未裁件（locked、已排）：必须在【原位】满足新轮廓/新旋转策略、布边、瑕疵、切线
 *    （由已裁段障碍体现）及与其他保留件不重叠，否则【整次拒绝】。
 *  - 其余未裁同型号件：一律改用新轮廓，原必用卷约束不变。
 *  - 缩减（目标件数 < 当前件数）：先删未排件，仍不足再按【id 降序】删未锁定的已排件；
 *    绝不删除已裁件或锁定件（删不够即输入错误拒绝）。
 *  - 扩增（目标件数 > 当前件数）：新增件进入未排区，无必用卷约束。
 *  - 未锁定已排件按【id 升序】在原位校验：以当前已确认保留的件（已裁件、锁定件、此前校验通过的件）
 *    为障碍；失效者退回未排区并注明原因（不影响其他件，不导致整次拒绝）。
 *  - 存在未裁件时：至少一卷的切线后剩余段能容下新外接尺寸，且每个被必用卷也必须能容下。
 *
 * 本模块只做“规划”，不触碰数据库；由 server 在事务中按 plan 落库。
 */

const geom = require('./geom');

const UNPLACED_AFTER_REVISE = '纸样改版后尚未排入（请重新优化排样）';

function pieceLabel(p) {
  return `裁片「${p.name}#${p.seq}」`;
}

/** 取一件在给定纸样版本、放置参数下的绝对多边形 */
function absPolygon(type, p) {
  return geom.toAbsolute(type.verts, p.rotation, type.bw, type.bh, p.x, p.y);
}

/**
 * 计算单条多边形与障碍（瑕疵矩形 + 其他裁片多边形）的冲突描述。
 * obstacles: { defects: [{x,y,w,h}], pieces: [{p, type}] }
 * 返回冲突字符串数组（空数组=无冲突）。
 */
function collisions(poly, rollLabel, selfId, obstacles) {
  const out = [];
  for (const d of obstacles.defects) {
    if (geom.polygonsInteriorOverlap(poly, geom.rectPoly(d.x, d.y, d.w, d.h))) {
      out.push(`卷「${rollLabel}」瑕疵区#${d.id}（${d.x},${d.y} ${d.w}×${d.h}mm）`);
    }
  }
  for (const o of obstacles.pieces) {
    if (o.p.id === selfId) continue;
    const oPoly = absPolygon(o.type, o.p);
    if (geom.polygonsInteriorOverlap(poly, oPoly)) {
      const tag = o.p.cut ? '（已裁）' : o.p.locked ? '（已锁定）' : '';
      out.push(`卷「${rollLabel}」裁片「${o.p.name}#${o.p.seq}」${tag}`);
    }
  }
  return out;
}

/**
 * 规划一次改版。
 *
 * @param {object} args
 *   model      { id, name, currentTypeId }
 *   currentType  当前版本 { id, name, verts, allowRotate, bw, bh }
 *   newSpec      { vertices:[[int,int],...], allowRotate:boolean, quantity:int }
 *   typesById    Map<typeId, { id, name, verts, bw, bh }>  全部纸样版本（旧版本用于已裁/保留件）
 *   placements   全部 placement（含字段 id, pieceTypeId, modelId, rollId, requiredRollId, seq,
 *                               x, y, rotation, placed, locked, cut, name）
 *   rolls        [{ id, label, width, length, cutLine, defects:[{id,x,y,w,h}] }]
 * @returns 成功 { plan:{...} }；输入非法 { errors:[...] }；整次拒绝 { status:409, error, conflicts }
 */
function planRevision({ model, currentType, newSpec, typesById, placements, rolls }) {
  const errors = [];
  const rollById = new Map(rolls.map((r) => [r.id, r]));

  // ---- 1. 新轮廓与件数基础校验 ----
  const polyErr = geom.validatePolygon(newSpec && newSpec.vertices);
  if (polyErr) errors.push(`新纸样轮廓不合法：${polyErr}`);
  const quantity = newSpec ? newSpec.quantity : undefined;
  if (!Number.isInteger(quantity) || quantity < 1) {
    errors.push('目标总件数必须为正整数');
  }

  const modelPieces = placements.filter((p) => p.modelId === model.id);
  const cutPieces = modelPieces.filter((p) => p.cut);
  const lockedPieces = modelPieces.filter((p) => p.cut === 0 && p.locked === 1);
  const protectedCount = cutPieces.length + lockedPieces.length;

  if (Number.isInteger(quantity) && quantity >= 1 && quantity < protectedCount) {
    errors.push(
      `目标件数 ${quantity} 小于不可删减件数 ${protectedCount}` +
        `（已裁 ${cutPieces.length} 件、已锁定 ${lockedPieces.length} 件，均不得删除），无法缩减到该件数`
    );
  }
  if (errors.length > 0) return { errors };

  const norm = geom.normalize(newSpec.vertices);
  const newType = {
    name: currentType.name,
    verts: norm.pts,
    bw: norm.w,
    bh: norm.h,
    allowRotate: newSpec.allowRotate === true,
    quantity,
  };

  // ---- 2. 删减 / 扩增选择 ----
  // 未裁件（不含锁定）：可被删除或改版本；锁定件与已裁件必保留
  const removableUnplaced = modelPieces
    .filter((p) => p.cut === 0 && p.locked === 0 && p.placed === 0)
    .sort((a, b) => b.id - a.id); // 占位排序，删除时按下文规则
  const removablePlaced = modelPieces
    .filter((p) => p.cut === 0 && p.locked === 0 && p.placed === 1)
    .sort((a, b) => b.id - a.id); // id 降序删除
  const survivors = new Set(modelPieces.map((p) => p.id));

  let toRemove = modelPieces.length - quantity; // >0 需删减
  const deleteIds = [];
  if (toRemove > 0) {
    // 先删未排件（未排件之间无位置之分，按 id 降序）
    for (const p of removableUnplaced) {
      if (toRemove <= 0) break;
      deleteIds.push(p.id);
      survivors.delete(p.id);
      toRemove--;
    }
    // 再按 id 降序删未锁定已排件
    for (const p of removablePlaced) {
      if (toRemove <= 0) break;
      deleteIds.push(p.id);
      survivors.delete(p.id);
      toRemove--;
    }
    if (toRemove > 0) {
      return {
        errors: [
          `目标件数 ${quantity} 无法达到：可删件不足（已裁件与锁定件不得删除）`,
        ],
      };
    }
  }
  const addCount = Math.max(0, quantity - modelPieces.length + deleteIds.length);

  // 保留件中，需要改用新版本的未裁件（已裁件保留旧版本）
  const survivingUncut = modelPieces.filter((p) => survivors.has(p.id) && p.cut === 0);
  const repointIds = survivingUncut.map((p) => p.id);

  // ---- 3. 容量前提：有未裁件时，至少一卷切线后剩余段可容纳外接尺寸；各必用卷也须可容纳 ----
  const newUncutCount = survivingUncut.length + addCount;
  if (newUncutCount > 0) {
    const fits = (r) => newType.bw <= r.width && newType.bh <= r.length - (r.cutLine || 0);
    const anyRoll = rolls.some(fits);
    if (!anyRoll) {
      return {
        status: 400,
        error:
          `新轮廓外接尺寸 ${newType.bw}×${newType.bh}mm 在全部 ${rolls.length} 卷的切线后剩余段内都无法容纳，改版被拒绝（原方案不变）`,
        conflicts: rolls.map(
          (r) =>
            `卷「${r.label}」（${r.width}×${r.length}mm，切线 ${r.cutLine || 0}mm，剩余 ${r.length - (r.cutLine || 0)}mm）`
        ),
      };
    }
    // 各保留未裁件的必用卷必须可容纳（扩增新件无必用卷）
    for (const p of survivingUncut) {
      if (p.requiredRollId == null) continue;
      const r = rollById.get(p.requiredRollId);
      if (!r || !fits(r)) {
        const label = r ? r.label : '#' + p.requiredRollId;
        return {
          status: 400,
          error:
            `${pieceLabel(p)}有必用卷「${label}」，但新轮廓外接尺寸 ${newType.bw}×${newType.bh}mm 无法放入该卷` +
            (r ? `（${r.width}×${r.length}mm，切线 ${r.cutLine || 0}mm，剩余 ${r.length - (r.cutLine || 0)}mm）` : '') +
            `，改版被拒绝（原方案不变；可先取消相关件的必用卷约束）`,
          conflicts: [`${pieceLabel(p)} 必用卷「${label}」`],
        };
      }
    }
  }

  // ---- 4. 组装障碍 ----
  // 恒定保留障碍：同方案中【不属于本型号被改版本保留集】的已放置件——
  // 其他型号的件、以及本型号的已裁件（旧轮廓）恒为障碍。
  const baseObstaclesByRoll = new Map();
  for (const r of rolls) {
    baseObstaclesByRoll.set(r.id, { defects: r.defects.slice(), pieces: [] });
  }
  for (const q of placements) {
    if (!q.placed) continue;
    if (q.modelId === model.id) {
      // 本型号：仅已裁件（旧轮廓）作为恒定障碍；未裁保留件在下方逐步加入
      if (q.cut === 1 && survivors.has(q.id)) {
        baseObstaclesByRoll.get(q.rollId).pieces.push({ p: q, type: typesById.get(q.pieceTypeId) });
      }
      continue;
    }
    baseObstaclesByRoll.get(q.rollId).pieces.push({ p: q, type: typesById.get(q.pieceTypeId) });
  }

  /** 用新版本判断单个保留已排件在原位是否合法；返回原因字符串或 null */
  function checkInPlace(p, obstacleSet) {
    const r = rollById.get(p.rollId);
    if (!r) return '所在卷已不存在';
    if (p.rotation === 180 && !newType.allowRotate) {
      return '新纸样不允许 180° 旋转，而该件当前为 180°';
    }
    const w = newType.bw;
    const h = newType.bh;
    if (p.x < 0 || p.y < 0 || p.x + w > r.width || p.y + h > r.length) {
      return `新轮廓外接尺寸 ${w}×${h}mm 使其在原位 (${p.x},${p.y}) 超出卷「${r.label}」布边（${r.width}×${r.length}mm）`;
    }
    if ((r.cutLine || 0) > 0 && p.y < r.cutLine) {
      return `新轮廓使其进入卷「${r.label}」已裁段（切线 ${r.cutLine}mm，未裁件须 y≥${r.cutLine}）`;
    }
    const poly = geom.toAbsolute(newType.verts, p.rotation, w, h, p.x, p.y);
    const hits = collisions(poly, r.label, p.id, obstacleSet);
    if (hits.length > 0) return `新轮廓在原位与 ${hits.join('、')} 冲突`;
    return null;
  }

  // ---- 5. 锁定未裁保留件：原位必须全部满足，否则整次拒绝 ----
  const lockedSurvivors = survivingUncut
    .filter((p) => p.locked === 1 && p.placed === 1)
    .sort((a, b) => a.id - b.id);
  const gateConflicts = [];
  for (const p of lockedSurvivors) {
    // 门控阶段：与【所有保留的已放置件】相互校验（含尚未逐个校验的未锁定件，它们用新轮廓原位评估）
    const obstacles = {
      defects: baseObstaclesByRoll.get(p.rollId).defects,
      pieces: [...baseObstaclesByRoll.get(p.rollId).pieces],
    };
    for (const q of placements) {
      if (!q.placed || q.id === p.id || !survivors.has(q.id)) continue;
      if (q.modelId !== model.id || q.cut === 1) continue; // 其他型号/已裁件已在 base
      // 本型号未裁保留件：用新轮廓原位
      obstacles.pieces.push({ p: q, type: newType });
    }
    const reason = checkInPlace(p, obstacles);
    if (reason) gateConflicts.push(`${pieceLabel(p)}（已锁定）：${reason}`);
  }
  if (gateConflicts.length > 0) {
    return {
      status: 409,
      error: '有锁定件在原位无法满足新纸样（轮廓/旋转/布边/瑕疵/切线/与保留件重叠），整次改版已拒绝，原方案不变',
      conflicts: gateConflicts,
    };
  }

  // ---- 6. 未锁定已排保留件：id 升序原位校验，失效者退回未排区 ----
  // 障碍集先放全部恒定保留 + 锁定保留件（新轮廓原位）；通过校验的未锁定件依次加入。
  const obstacleByRoll = new Map();
  for (const r of rolls) {
    obstacleByRoll.set(r.id, {
      defects: baseObstaclesByRoll.get(r.id).defects,
      pieces: baseObstaclesByRoll.get(r.id).pieces.slice(),
    });
  }
  for (const p of lockedSurvivors) {
    obstacleByRoll.get(p.rollId).pieces.push({ p, type: newType });
  }

  const movablePlaced = survivingUncut
    .filter((p) => p.locked === 0 && p.placed === 1)
    .sort((a, b) => a.id - b.id);
  const bounced = []; // { id, reason }
  for (const p of movablePlaced) {
    const reason = checkInPlace(p, obstacleByRoll.get(p.rollId));
    if (reason) {
      bounced.push({ id: p.id, reason: '改版校验未过原位：' + reason });
    } else {
      obstacleByRoll.get(p.rollId).pieces.push({ p, type: newType });
    }
  }
  const bouncedIds = new Set(bounced.map((b) => b.id));

  // ---- 7. 汇总落库计划 ----
  const maxSeq = modelPieces.reduce((m, p) => Math.max(m, p.seq), 0);
  const newPieces = [];
  for (let i = 0; i < addCount; i++) newPieces.push({ seq: maxSeq + 1 + i });

  return {
    plan: {
      modelId: model.id,
      name: newType.name,
      newType,                 // { name, verts, bw, bh, allowRotate, quantity }
      deleteIds,               // 被删除的 placement id
      repointIds,              // 改用新版本的未裁保留件（含将退回未排区者）
      bounced,                 // [{ id, reason }] 退回未排区的未锁定件
      newPieces,               // [{ seq }] 扩增的新件（未排、无必用卷）
      counts: {
        before: modelPieces.length,
        target: quantity,
        cut: cutPieces.length,
        deleted: deleteIds.length,
        bounced: bounced.length,
        added: addCount,
      },
    },
  };
}

module.exports = { planRevision, UNPLACED_AFTER_REVISE };
