export interface GalerkinLevel {
  n: number;
  rs: number;
  size: number;
  active: Uint8Array;
  selfDiag: Float32Array;
  diag: Float32Array;
  cE: Float32Array;
  cN: Float32Array;
  x: Float32Array;
  rhs: Float32Array;
  res: Float32Array;
}

export interface PcgSolveResult {
  iterations: number;
  initialResidual: number;
  finalResidual: number;
  relativeResidual: number;
  converged: boolean;
}

export interface PcgScratchBuffers {
  x: Float32Array;
  r: Float32Array;
  p: Float32Array;
  ap: Float32Array;
}

export function computeMgLevelCount(gridN: number): number {
  let levels = 1;
  let n = gridN;
  while (n >= 12 && (n & 1) === 0 && levels < 6) {
    n >>= 1;
    levels++;
  }
  return levels;
}

export function createGalerkinHierarchy(gridN: number): GalerkinLevel[] {
  const numLevels = computeMgLevelCount(gridN);
  const levels: GalerkinLevel[] = [];
  for (let l = 0; l < numLevels; l++) {
    const n = gridN >> l;
    const rs = n + 2;
    const size = rs * rs;
    levels.push({
      n,
      rs,
      size,
      active: new Uint8Array(size),
      selfDiag: new Float32Array(size),
      diag: new Float32Array(size),
      cE: new Float32Array(size),
      cN: new Float32Array(size),
      x: new Float32Array(size),
      rhs: new Float32Array(size),
      res: new Float32Array(size),
    });
  }
  return levels;
}

export function syncPeriodicGhostFloat(
  arr: Float32Array,
  n: number,
  rs: number,
  periodicX: boolean,
  periodicY: boolean
): void {
  if (periodicX) {
    for (let j = 1; j <= n; j++) {
      const row = j * rs;
      arr[row] = arr[row + n];
      arr[row + n + 1] = arr[row + 1];
    }
  }
  if (periodicY) {
    const topGhost = (n + 1) * rs;
    const topInner = n * rs;
    const botInner = rs;
    for (let i = 0; i <= n + 1; i++) {
      arr[i] = arr[topInner + i];
      arr[topGhost + i] = arr[botInner + i];
    }
  }
}

export function syncPeriodicGhostByte(
  arr: Uint8Array,
  n: number,
  rs: number,
  periodicX: boolean,
  periodicY: boolean
): void {
  if (periodicX) {
    for (let j = 1; j <= n; j++) {
      const row = j * rs;
      arr[row] = arr[row + n];
      arr[row + n + 1] = arr[row + 1];
    }
  }
  if (periodicY) {
    const topGhost = (n + 1) * rs;
    const topInner = n * rs;
    const botInner = rs;
    for (let i = 0; i <= n + 1; i++) {
      arr[i] = arr[topInner + i];
      arr[topGhost + i] = arr[botInner + i];
    }
  }
}

export function syncLevelOperatorHalos(
  lvl: GalerkinLevel,
  periodicX: boolean,
  periodicY: boolean
): void {
  if (periodicX) {
    for (let j = 1; j <= lvl.n; j++) {
      const row = j * lvl.rs;
      lvl.cE[row] = lvl.cE[row + lvl.n];
      lvl.cE[row + lvl.n + 1] = lvl.cE[row + 1];
    }
  } else {
    for (let j = 1; j <= lvl.n; j++) {
      const row = j * lvl.rs;
      lvl.cE[row] = 0;
    }
  }

  if (periodicY) {
    const topInner = lvl.n * lvl.rs;
    const topGhost = (lvl.n + 1) * lvl.rs;
    for (let i = 1; i <= lvl.n; i++) {
      lvl.cN[i] = lvl.cN[topInner + i];
      lvl.cN[topGhost + i] = lvl.cN[lvl.rs + i];
    }
  } else {
    for (let i = 1; i <= lvl.n; i++) {
      lvl.cN[i] = 0;
    }
  }
}

export function coarsenGalerkinHierarchy(
  levels: GalerkinLevel[],
  periodicX: boolean,
  periodicY: boolean
): void {
  syncLevelOperatorHalos(levels[0], periodicX, periodicY);

  for (let l = 0; l < levels.length - 1; l++) {
    const f = levels[l];
    const c = levels[l + 1];
    c.active.fill(0);
    c.selfDiag.fill(0);
    c.cE.fill(0);
    c.cN.fill(0);
    c.diag.fill(1);

    for (let J = 1; J <= c.n; J++) {
      const fj = 2 * J - 1;
      for (let I = 1; I <= c.n; I++) {
        const fi = 2 * I - 1;
        const cIdx = I + J * c.rs;
        const f00 = fi + fj * f.rs;
        const f10 = f00 + 1;
        const f01 = f00 + f.rs;
        const f11 = f01 + 1;

        const act = f.active[f00] | f.active[f10] | f.active[f01] | f.active[f11];
        c.active[cIdx] = act;
        if (!act) continue;

        c.selfDiag[cIdx] =
          f.selfDiag[f00] + f.selfDiag[f10] + f.selfDiag[f01] + f.selfDiag[f11];
        c.cE[cIdx] = f.cE[f10] + f.cE[f11];
        c.cN[cIdx] = f.cN[f01] + f.cN[f11];
      }
    }

    syncLevelOperatorHalos(c, periodicX, periodicY);

    for (let J = 1; J <= c.n; J++) {
      let cIdx = 1 + J * c.rs;
      for (let I = 1; I <= c.n; I++, cIdx++) {
        if (!c.active[cIdx]) {
          c.diag[cIdx] = 1;
          continue;
        }
        const d =
          c.selfDiag[cIdx] +
          c.cE[cIdx - 1] +
          c.cE[cIdx] +
          c.cN[cIdx - c.rs] +
          c.cN[cIdx];
        c.diag[cIdx] = d > 1e-12 ? d : 1;
      }
    }
  }
}

export function smoothGalerkin(
  lvl: GalerkinLevel,
  sweeps: number,
  reverse: boolean,
  periodicX: boolean,
  periodicY: boolean
): void {
  const active = lvl.active;
  const diag = lvl.diag;
  const cE = lvl.cE;
  const cN = lvl.cN;
  const x = lvl.x;
  const rhs = lvl.rhs;
  const rs = lvl.rs;

  for (let s = 0; s < sweeps; s++) {
    for (let stepColor = 0; stepColor < 2; stepColor++) {
      if (periodicX || periodicY) {
        syncPeriodicGhostFloat(x, lvl.n, rs, periodicX, periodicY);
      }
      const color = reverse ? 1 - stepColor : stepColor;
      for (let j = 1; j <= lvl.n; j++) {
        let i = 1 + ((j + color) & 1);
        let idx = i + j * rs;
        for (; i <= lvl.n; i += 2, idx += 2) {
          if (!active[idx]) continue;
          const nb =
            cE[idx - 1] * x[idx - 1] +
            cE[idx] * x[idx + 1] +
            cN[idx - rs] * x[idx - rs] +
            cN[idx] * x[idx + rs];
          x[idx] = (rhs[idx] + nb) / diag[idx];
        }
      }
    }
  }
  if (periodicX || periodicY) {
    syncPeriodicGhostFloat(x, lvl.n, rs, periodicX, periodicY);
  }
}

export function runGalerkinVCycle(
  levels: GalerkinLevel[],
  l: number,
  preSweeps: number,
  postSweeps: number,
  coarseSweeps: number,
  periodicX: boolean,
  periodicY: boolean
): void {
  const lvl = levels[l];
  if (l === levels.length - 1) {
    smoothGalerkin(lvl, coarseSweeps, false, periodicX, periodicY);
    smoothGalerkin(lvl, coarseSweeps, true, periodicX, periodicY);
    return;
  }

  smoothGalerkin(lvl, preSweeps, false, periodicX, periodicY);

  const active = lvl.active;
  const diag = lvl.diag;
  const cE = lvl.cE;
  const cN = lvl.cN;
  const x = lvl.x;
  const rhs = lvl.rhs;
  const res = lvl.res;
  const rs = lvl.rs;

  if (periodicX || periodicY) {
    syncPeriodicGhostFloat(x, lvl.n, rs, periodicX, periodicY);
  }

  for (let j = 1; j <= lvl.n; j++) {
    let idx = 1 + j * rs;
    for (let i = 1; i <= lvl.n; i++, idx++) {
      if (!active[idx]) {
        res[idx] = 0;
        continue;
      }
      const ax =
        diag[idx] * x[idx] -
        (cE[idx - 1] * x[idx - 1] +
          cE[idx] * x[idx + 1] +
          cN[idx - rs] * x[idx - rs] +
          cN[idx] * x[idx + rs]);
      res[idx] = rhs[idx] - ax;
    }
  }

  const coarse = levels[l + 1];
  coarse.x.fill(0);

  for (let J = 1; J <= coarse.n; J++) {
    const fj = 2 * J - 1;
    for (let I = 1; I <= coarse.n; I++) {
      const fi = 2 * I - 1;
      const cIdx = I + J * coarse.rs;
      if (!coarse.active[cIdx]) {
        coarse.rhs[cIdx] = 0;
        continue;
      }
      const f00 = fi + fj * rs;
      const f10 = f00 + 1;
      const f01 = f00 + rs;
      const f11 = f01 + 1;
      coarse.rhs[cIdx] = res[f00] + res[f10] + res[f01] + res[f11];
    }
  }

  runGalerkinVCycle(
    levels,
    l + 1,
    preSweeps,
    postSweeps,
    coarseSweeps,
    periodicX,
    periodicY
  );

  for (let J = 1; J <= coarse.n; J++) {
    const fj = 2 * J - 1;
    for (let I = 1; I <= coarse.n; I++) {
      const fi = 2 * I - 1;
      const cIdx = I + J * coarse.rs;
      if (!coarse.active[cIdx]) continue;
      const e = coarse.x[cIdx];
      const f00 = fi + fj * rs;
      const f10 = f00 + 1;
      const f01 = f00 + rs;
      const f11 = f01 + 1;
      if (active[f00]) x[f00] += e;
      if (active[f10]) x[f10] += e;
      if (active[f01]) x[f01] += e;
      if (active[f11]) x[f11] += e;
    }
  }

  smoothGalerkin(lvl, postSweeps, true, periodicX, periodicY);
}

/**
 * Risolve A * x = b sull'operatore di livello 0 tramite PCG precondizionato
 * con V-cycle Galerkin, restituendo residui espliciti e stato di convergenza.
 */
export function solveGalerkinPCG(
  levels: GalerkinLevel[],
  scratch: PcgScratchBuffers,
  maxIter: number,
  relTol: number,
  absTol: number,
  periodicX: boolean,
  periodicY: boolean,
  zeroMeanMode: boolean
): PcgSolveResult {
  const l0 = levels[0];
  const n = l0.n;
  const rs = l0.rs;
  const active = l0.active;
  const diag = l0.diag;
  const cE = l0.cE;
  const cN = l0.cN;

  const cgX = scratch.x;
  const cgR = scratch.r;
  const cgP = scratch.p;
  const cgAp = scratch.ap;

  if (periodicX || periodicY) {
    syncPeriodicGhostFloat(cgX, n, rs, periodicX, periodicY);
  }

  let bNormSq = 0;
  let r0Sq = 0;
  for (let j = 1; j <= n; j++) {
    let idx = 1 + j * rs;
    for (let i = 1; i <= n; i++, idx++) {
      if (!active[idx]) {
        cgR[idx] = 0;
        continue;
      }
      const bVal = cgR[idx];
      bNormSq += bVal * bVal;
      const ax =
        diag[idx] * cgX[idx] -
        (cE[idx - 1] * cgX[idx - 1] +
          cE[idx] * cgX[idx + 1] +
          cN[idx - rs] * cgX[idx - rs] +
          cN[idx] * cgX[idx + rs]);
      const rVal = bVal - ax;
      cgR[idx] = rVal;
      r0Sq += rVal * rVal;
    }
  }

  const bNorm = Math.sqrt(bNormSq);
  const initialResidual = Math.sqrt(r0Sq);
  if (!Number.isFinite(initialResidual) || !Number.isFinite(bNorm)) {
    return {
      iterations: 0,
      initialResidual: NaN,
      finalResidual: NaN,
      relativeResidual: NaN,
      converged: false,
    };
  }

  // Confronta rispetto al massimo tra absTol e la scala reale di b (evita falsi rollback al floor Float32)
  const effectiveTarget = Math.max(absTol, relTol * Math.max(bNorm, initialResidual));
  if (initialResidual <= effectiveTarget) {
    return {
      iterations: 0,
      initialResidual,
      finalResidual: initialResidual,
      relativeResidual: bNorm > 0 ? initialResidual / bNorm : 0,
      converged: true,
    };
  }

  const targetSq = effectiveTarget * effectiveTarget;

  l0.rhs.set(cgR);
  l0.x.fill(0);
  runGalerkinVCycle(levels, 0, 2, 2, 12, periodicX, periodicY);

  let rzOld = 0;
  for (let j = 1; j <= n; j++) {
    let idx = 1 + j * rs;
    for (let i = 1; i <= n; i++, idx++) {
      if (!active[idx]) continue;
      const z = l0.x[idx];
      cgP[idx] = z;
      rzOld += cgR[idx] * z;
    }
  }

  let currentRSq = r0Sq;
  let iterations = 0;
  let converged = false;

  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;
    if (periodicX || periodicY) {
      syncPeriodicGhostFloat(cgP, n, rs, periodicX, periodicY);
    }

    let pAp = 0;
    for (let j = 1; j <= n; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= n; i++, idx++) {
        if (!active[idx]) continue;
        const ap =
          diag[idx] * cgP[idx] -
          (cE[idx - 1] * cgP[idx - 1] +
            cE[idx] * cgP[idx + 1] +
            cN[idx - rs] * cgP[idx - rs] +
            cN[idx] * cgP[idx + rs]);
        cgAp[idx] = ap;
        pAp += cgP[idx] * ap;
      }
    }

    if (!Number.isFinite(pAp) || pAp <= 1e-26) {
      converged = currentRSq <= targetSq;
      break;
    }

    const alpha = rzOld / pAp;
    if (!Number.isFinite(alpha)) {
      converged = false;
      break;
    }

    let rSq = 0;
    for (let j = 1; j <= n; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= n; i++, idx++) {
        if (!active[idx]) continue;
        cgX[idx] += alpha * cgP[idx];
        const rNext = cgR[idx] - alpha * cgAp[idx];
        cgR[idx] = rNext;
        rSq += rNext * rNext;
      }
    }

    currentRSq = rSq;
    if (!Number.isFinite(currentRSq)) {
      converged = false;
      break;
    }

    if (currentRSq <= targetSq) {
      converged = true;
      break;
    }

    l0.rhs.set(cgR);
    l0.x.fill(0);
    runGalerkinVCycle(levels, 0, 2, 2, 12, periodicX, periodicY);

    let rzNew = 0;
    for (let j = 1; j <= n; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= n; i++, idx++) {
        if (active[idx]) rzNew += cgR[idx] * l0.x[idx];
      }
    }

    if (!Number.isFinite(rzNew) || Math.abs(rzOld) <= 1e-28) {
      converged = currentRSq <= targetSq;
      break;
    }

    const beta = rzNew / rzOld;
    for (let j = 1; j <= n; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= n; i++, idx++) {
        if (active[idx]) cgP[idx] = l0.x[idx] + beta * cgP[idx];
      }
    }
    rzOld = rzNew;
  }

  if (zeroMeanMode) {
    let sum = 0;
    let cnt = 0;
    for (let j = 1; j <= n; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= n; i++, idx++) {
        if (active[idx]) {
          sum += cgX[idx];
          cnt++;
        }
      }
    }
    if (cnt > 0) {
      const mean = sum / cnt;
      for (let j = 1; j <= n; j++) {
        let idx = 1 + j * rs;
        for (let i = 1; i <= n; i++, idx++) {
          if (active[idx]) cgX[idx] -= mean;
        }
      }
    }
  }

  if (periodicX || periodicY) {
    syncPeriodicGhostFloat(cgX, n, rs, periodicX, periodicY);
  }

  const finalResidual = Math.sqrt(Math.max(0, currentRSq));
  return {
    iterations,
    initialResidual,
    finalResidual,
    relativeResidual: initialResidual > 0 ? finalResidual / initialResidual : 0,
    converged,
  };
}
