import {
  clampToSolverViscosityDomainPaS,
  computeApparentViscosityPaS,
  getEffectiveBaseViscosityMpas,
  getGridResolutionForQuality,
  MIN_VISCOSITY_PAS,
} from '../constants/fluids';
import {
  ConvergenceStatus,
  DiagnosticsSnapshot,
  DomainType,
  FluidConfig,
  ProbeSample,
  ScaleRange,
  SimulationMetrics,
  VisualizationMode,
} from '../types/rheology';
import {
  coarsenGalerkinHierarchy,
  createGalerkinHierarchy,
  GalerkinLevel,
  PcgScratchBuffers,
  solveGalerkinPCG,
  syncPeriodicGhostByte,
  syncPeriodicGhostFloat,
} from './multigrid';

export interface DomainOptions {
  type: DomainType;
  channelLengthM?: number;
  channelHeightM?: number;
  topWallVxMs?: number;
  bodyForceXMs2?: number;
  bodyForceYMs2?: number;
}

export interface StepControlOptions {
  fixedDtSec?: number;
  disableAdaptiveSubsteps?: boolean;
  externalSource?: (
    xM: number,
    yM: number,
    tSec: number,
    hM: number
  ) => { fx: number; fy: number };
  externalViscosityField?: (xM: number, yM: number) => number;
}

export interface ExactDiagnosticsReport extends DiagnosticsSnapshot {
  tracerMassIntegral: number;
  kineticEnergyJKg: number;
}

interface StirrerState {
  active: boolean;
  gx0: number;
  gy0: number;
  gx1: number;
  gy1: number;
  rodRadiusGrid: number;
  tipVx: number;
  tipVy: number;
}

interface SolverSnapshot {
  u: Float32Array;
  v: Float32Array;
  p: Float32Array;
  dye: Float32Array;
  wake: Float32Array;
  muApp: Float32Array;
  elapsedSec: number;
}

const CFL_TARGET = 0.65;
const MAX_SUBSTEPS = 8;
const MAX_STEP_RETRIES = 3;
const CUT_CELL_THETA_MIN = 0.25;
const PICARD_REL_TOL = 1e-3;
const PICARD_MAX_ITER = 8;
const DIFF_REL_TOL = 2e-6;
const DIFF_ABS_TOL = 1e-10;
const DIFF_MAX_ITER = 42;
const PRESS_REL_TOL = 1e-6;
const PRESS_ABS_TOL = 1e-10;
const PRESS_MAX_ITER = 48;
const DIV_ROLLBACK_THRESHOLD = 0.05;

export class NavierStokesSolver {
  public readonly n: number;
  public readonly rowSize: number;
  public readonly gridSize: number;
  public readonly tankRadiusGrid: number;
  public readonly midGrid: number;

  private domain: DomainOptions;

  public u: Float32Array;
  public v: Float32Array;
  private uTmp: Float32Array;
  private vTmp: Float32Array;
  private uFwd: Float32Array;
  private vFwd: Float32Array;
  private uBwd: Float32Array;
  private vBwd: Float32Array;
  private uStar: Float32Array;
  private vStar: Float32Array;
  private uPicardPrev: Float32Array;
  private vPicardPrev: Float32Array;

  public p: Float32Array;
  private pPicardBase: Float32Array;
  public dye: Float32Array;
  private dyeTmp: Float32Array;
  private dyeFwd: Float32Array;

  private wake: Float32Array;
  private wakeTmp: Float32Array;
  private wakeFwd: Float32Array;
  private wakeBwd: Float32Array;

  public shearRate: Float32Array;
  public shearStress: Float32Array;
  public vorticity: Float32Array;
  private absVort: Float32Array;
  public muApp: Float32Array;
  private muSgs: Float32Array;
  private muEff: Float32Array;
  private muEffPrev: Float32Array;
  public speedField: Float32Array;

  public scalarA: Float32Array;
  public scalarB: Float32Array;

  public pMask: Uint8Array;
  public uMask: Uint8Array;
  public vMask: Uint8Array;
  private uWallFactor: Float32Array;
  private vWallFactor: Float32Array;
  private uWallTargetVel: Float32Array;
  private wallDeltaE: Float32Array;
  private wallDeltaW: Float32Array;
  private wallDeltaN: Float32Array;
  private wallDeltaS: Float32Array;
  private uRodWeight: Float32Array;
  private vRodWeight: Float32Array;
  private extForceX: Float32Array;
  private extForceY: Float32Array;

  private cgScratch: PcgScratchBuffers;
  private diffLevels: GalerkinLevel[];
  private pressLevels: GalerkinLevel[];
  private snap: SolverSnapshot;

  private rimTargetIndices: Int32Array = new Int32Array(0);
  private rimSourceIndices: Int32Array = new Int32Array(0);
  public fluidCellCount = 0;
  private refVariance = 0;
  private elapsedSec = 0;

  private emaMaxSpeed = 0.25;
  private emaMaxVort = 20;
  private emaMaxShear = 5;

  private lastDtPhysSec = 0.016;
  private lastCourant = 0;
  private lastSubsteps = 1;
  private lastTimeDilation = 1.0;
  private lastDiffResidual = 0;
  private lastPressResidual = 0;
  private lastPicardIter = 1;
  private lastPicardResidual = 0;
  private lastConvergenceStatus: ConvergenceStatus = 'converged';
  private rollbacksCount = 0;
  private lastClampedCount = 0;
  private lastSgsMeanPas = 0;
  private lastSgsMaxPas = 0;
  private lastDivRmsRaw = 0;
  private lastDivRmsNorm = 0;
  private lastDivMaxNorm = 0;
  private lastNetBoundaryFlux = 0;

  private stirrer: StirrerState = {
    active: false,
    gx0: 0,
    gy0: 0,
    gx1: 0,
    gy1: 0,
    rodRadiusGrid: 3,
    tipVx: 0,
    tipVy: 0,
  };

  constructor(gridN = 96, domain: DomainOptions = { type: 'cylindrical-tank' }) {
    this.n = gridN;
    this.rowSize = gridN + 2;
    this.gridSize = this.rowSize * this.rowSize;
    this.tankRadiusGrid = gridN * 0.45;
    this.midGrid = (gridN + 1) * 0.5;
    this.domain = { ...domain };

    const sz = this.gridSize;
    this.u = new Float32Array(sz);
    this.v = new Float32Array(sz);
    this.uTmp = new Float32Array(sz);
    this.vTmp = new Float32Array(sz);
    this.uFwd = new Float32Array(sz);
    this.vFwd = new Float32Array(sz);
    this.uBwd = new Float32Array(sz);
    this.vBwd = new Float32Array(sz);
    this.uStar = new Float32Array(sz);
    this.vStar = new Float32Array(sz);
    this.uPicardPrev = new Float32Array(sz);
    this.vPicardPrev = new Float32Array(sz);

    this.p = new Float32Array(sz);
    this.pPicardBase = new Float32Array(sz);
    this.dye = new Float32Array(sz);
    this.dyeTmp = new Float32Array(sz);
    this.dyeFwd = new Float32Array(sz);

    this.wake = new Float32Array(sz);
    this.wakeTmp = new Float32Array(sz);
    this.wakeFwd = new Float32Array(sz);
    this.wakeBwd = new Float32Array(sz);

    this.shearRate = new Float32Array(sz);
    this.shearStress = new Float32Array(sz);
    this.vorticity = new Float32Array(sz);
    this.absVort = new Float32Array(sz);
    this.muApp = new Float32Array(sz);
    this.muSgs = new Float32Array(sz);
    this.muEff = new Float32Array(sz);
    this.muEffPrev = new Float32Array(sz);
    this.speedField = new Float32Array(sz);
    this.scalarA = new Float32Array(sz);
    this.scalarB = new Float32Array(sz);

    this.pMask = new Uint8Array(sz);
    this.uMask = new Uint8Array(sz);
    this.vMask = new Uint8Array(sz);
    this.uWallFactor = new Float32Array(sz);
    this.vWallFactor = new Float32Array(sz);
    this.uWallTargetVel = new Float32Array(sz);
    this.wallDeltaE = new Float32Array(sz);
    this.wallDeltaW = new Float32Array(sz);
    this.wallDeltaN = new Float32Array(sz);
    this.wallDeltaS = new Float32Array(sz);
    this.uRodWeight = new Float32Array(sz);
    this.vRodWeight = new Float32Array(sz);
    this.extForceX = new Float32Array(sz);
    this.extForceY = new Float32Array(sz);

    this.cgScratch = {
      x: new Float32Array(sz),
      r: new Float32Array(sz),
      p: new Float32Array(sz),
      ap: new Float32Array(sz),
    };

    this.diffLevels = createGalerkinHierarchy(this.n);
    this.pressLevels = createGalerkinHierarchy(this.n);
    this.snap = {
      u: new Float32Array(sz),
      v: new Float32Array(sz),
      p: new Float32Array(sz),
      dye: new Float32Array(sz),
      wake: new Float32Array(sz),
      muApp: new Float32Array(sz),
      elapsedSec: 0,
    };

    this.buildMasks();
    this.reset(1e-3);
  }

  public static createForConfig(config: FluidConfig): NavierStokesSolver {
    return new NavierStokesSolver(getGridResolutionForQuality(config.quality), {
      type: 'cylindrical-tank',
    });
  }

  private get periodicX(): boolean {
    return this.domain.type === 'channel-x' || this.domain.type === 'periodic-box';
  }

  private get periodicY(): boolean {
    return this.domain.type === 'periodic-box';
  }

  public getCellSizeMeters(config: FluidConfig): number {
    if (this.domain.type === 'channel-x') {
      const hM = Math.max(0.01, this.domain.channelHeightM ?? 0.1);
      return hM / this.n;
    }
    if (this.domain.type === 'periodic-box') {
      const lenM = Math.max(0.01, this.domain.channelLengthM ?? 2 * Math.PI);
      return lenM / this.n;
    }
    const diameterM = Math.max(0.05, config.tankDiameterMm * 0.001);
    return diameterM / (2 * this.tankRadiusGrid);
  }

  private buildMasks(): void {
    const N = this.n;
    const rs = this.rowSize;
    this.pMask.fill(0);
    this.uMask.fill(0);
    this.vMask.fill(0);
    this.uWallFactor.fill(0);
    this.vWallFactor.fill(0);
    this.uWallTargetVel.fill(0);
    this.wallDeltaE.fill(1);
    this.wallDeltaW.fill(1);
    this.wallDeltaN.fill(1);
    this.wallDeltaS.fill(1);

    let count = 0;

    if (this.domain.type === 'cylindrical-tank') {
      const rSq = this.tankRadiusGrid * this.tankRadiusGrid;
      for (let j = 1; j <= N; j++) {
        const dj = j - this.midGrid;
        for (let i = 1; i <= N; i++) {
          const di = i - this.midGrid;
          const idx = i + j * rs;
          if (di * di + dj * dj < rSq) {
            this.pMask[idx] = 1;
            count++;
          }
        }
      }
    } else {
      for (let j = 1; j <= N; j++) {
        for (let i = 1; i <= N; i++) {
          this.pMask[i + j * rs] = 1;
          count++;
        }
      }
    }
    this.fluidCellCount = count;

    syncPeriodicGhostByte(this.pMask, N, rs, this.periodicX, this.periodicY);

    const rimTargets: number[] = [];
    const rimSources: number[] = [];
    if (this.domain.type === 'cylindrical-tank') {
      for (let j = 1; j <= N; j++) {
        for (let i = 1; i <= N; i++) {
          const idx = i + j * rs;
          if (this.pMask[idx]) continue;
          let src = 0;
          if (this.pMask[idx - 1]) src = idx - 1;
          else if (this.pMask[idx + 1]) src = idx + 1;
          else if (this.pMask[idx - rs]) src = idx - rs;
          else if (this.pMask[idx + rs]) src = idx + rs;
          else if (this.pMask[idx - 1 - rs]) src = idx - 1 - rs;
          else if (this.pMask[idx + 1 - rs]) src = idx + 1 - rs;
          else if (this.pMask[idx - 1 + rs]) src = idx - 1 + rs;
          else if (this.pMask[idx + 1 + rs]) src = idx + 1 + rs;
          if (src > 0) {
            rimTargets.push(idx);
            rimSources.push(src);
          }
        }
      }
    }
    this.rimTargetIndices = new Int32Array(rimTargets);
    this.rimSourceIndices = new Int32Array(rimSources);

    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const idx = i + j * rs;
        if (this.pMask[idx] && this.pMask[idx - 1]) {
          this.uMask[idx] = 1;
        }
        if (this.pMask[idx] && this.pMask[idx - rs]) {
          this.vMask[idx] = 1;
        }
      }
    }
    syncPeriodicGhostByte(this.uMask, N, rs, this.periodicX, this.periodicY);
    syncPeriodicGhostByte(this.vMask, N, rs, this.periodicX, this.periodicY);

    if (this.domain.type === 'cylindrical-tank') {
      const rTank = this.tankRadiusGrid;
      const rSq = rTank * rTank;
      const mid = this.midGrid;
      const axisTheta = (cx: number, cy: number, dx: number, dy: number): number => {
        const rx = cx - mid;
        const ry = cy - mid;
        const b = rx * dx + ry * dy;
        const c = rx * rx + ry * ry - rSq;
        const disc = b * b - c;
        if (disc <= 0) return CUT_CELL_THETA_MIN;
        const t = -b + Math.sqrt(disc);
        return Math.max(CUT_CELL_THETA_MIN, Math.min(1.0, t));
      };

      for (let j = 1; j <= N; j++) {
        const dj = j - mid;
        for (let i = 1; i <= N; i++) {
          const di = i - mid;
          const idx = i + j * rs;
          if (this.pMask[idx]) {
            const xWall = Math.sqrt(Math.max(0, rSq - dj * dj));
            const yWall = Math.sqrt(Math.max(0, rSq - di * di));
            if (!this.pMask[idx + 1]) {
              this.wallDeltaE[idx] = Math.max(0.02, Math.min(1.0, mid + xWall - i));
            }
            if (!this.pMask[idx - 1]) {
              this.wallDeltaW[idx] = Math.max(0.02, Math.min(1.0, i - (mid - xWall)));
            }
            if (!this.pMask[idx + rs]) {
              this.wallDeltaN[idx] = Math.max(0.02, Math.min(1.0, mid + yWall - j));
            }
            if (!this.pMask[idx - rs]) {
              this.wallDeltaS[idx] = Math.max(0.02, Math.min(1.0, j - (mid - yWall)));
            }
          }

          if (this.uMask[idx]) {
            const px = i - 0.5;
            const py = j;
            let wf = 0;
            // Fattore 2 sugli sforzi normali xx del tensore completo 2*mu*du/dx
            if (!this.uMask[idx + 1]) wf += 2 / axisTheta(px, py, 1, 0);
            if (!this.uMask[idx - 1]) wf += 2 / axisTheta(px, py, -1, 0);
            if (!this.uMask[idx + rs]) wf += 1 / axisTheta(px, py, 0, 1);
            if (!this.uMask[idx - rs]) wf += 1 / axisTheta(px, py, 0, -1);
            this.uWallFactor[idx] = wf;
          }
          if (this.vMask[idx]) {
            const px = i;
            const py = j - 0.5;
            let wf = 0;
            if (!this.vMask[idx + 1]) wf += 1 / axisTheta(px, py, 1, 0);
            if (!this.vMask[idx - 1]) wf += 1 / axisTheta(px, py, -1, 0);
            // Fattore 2 sugli sforzi normali yy del tensore completo 2*mu*dv/dy
            if (!this.vMask[idx + rs]) wf += 2 / axisTheta(px, py, 0, 1);
            if (!this.vMask[idx - rs]) wf += 2 / axisTheta(px, py, 0, -1);
            this.vWallFactor[idx] = wf;
          }
        }
      }
    } else if (this.domain.type === 'channel-x') {
      const topVel = this.domain.topWallVxMs ?? 0;
      for (let i = 1; i <= N; i++) {
        // Parete inferiore (y=0, distanza 0.5*h da u_{i,1})
        const botIdx = i + rs;
        this.uWallFactor[botIdx] = 2.0;
        this.wallDeltaS[botIdx] = 0.5;

        // Parete superiore (y=H, distanza 0.5*h da u_{i,N})
        const topIdx = i + N * rs;
        this.uWallFactor[topIdx] = 2.0;
        this.uWallTargetVel[topIdx] = topVel;
        this.wallDeltaN[topIdx] = 0.5;
      }
    }

    const p0 = this.pressLevels[0];
    p0.active.set(this.pMask);
    p0.selfDiag.fill(0);
    p0.cE.fill(0);
    p0.cN.fill(0);
    p0.diag.fill(1);
    for (let j = 1; j <= N; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= N; i++, idx++) {
        if (!this.pMask[idx]) continue;
        if (this.pMask[idx + 1]) p0.cE[idx] = 1.0;
        if (this.pMask[idx + rs]) p0.cN[idx] = 1.0;
      }
    }
    coarsenGalerkinHierarchy(this.pressLevels, this.periodicX, this.periodicY);
    // Ricalcola la diagonale fine dopo sync halo periodico
    for (let j = 1; j <= N; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= N; i++, idx++) {
        if (!p0.active[idx]) continue;
        const d = p0.cE[idx - 1] + p0.cE[idx] + p0.cN[idx - rs] + p0.cN[idx];
        p0.diag[idx] = d > 1e-12 ? d : 1;
      }
    }
    coarsenGalerkinHierarchy(this.pressLevels, this.periodicX, this.periodicY);
  }

  public reset(initialMuPaS?: number): void {
    this.u.fill(0);
    this.v.fill(0);
    this.uTmp.fill(0);
    this.vTmp.fill(0);
    this.p.fill(0);
    this.dye.fill(0);
    this.wake.fill(0);
    this.shearRate.fill(0);
    this.shearStress.fill(0);
    this.vorticity.fill(0);
    this.absVort.fill(0);
    this.speedField.fill(0);
    this.uRodWeight.fill(0);
    this.vRodWeight.fill(0);
    this.extForceX.fill(0);
    this.extForceY.fill(0);
    this.stirrer.active = false;
    this.elapsedSec = 0;
    this.emaMaxSpeed = 0.25;
    this.emaMaxVort = 20;
    this.emaMaxShear = 5;
    this.lastDtPhysSec = 0.016;
    this.lastCourant = 0;
    this.lastSubsteps = 1;
    this.lastTimeDilation = 1.0;
    this.lastDiffResidual = 0;
    this.lastPressResidual = 0;
    this.lastPicardIter = 1;
    this.lastPicardResidual = 0;
    this.lastConvergenceStatus = 'converged';
    this.rollbacksCount = 0;
    this.lastClampedCount = 0;
    this.lastSgsMeanPas = 0;
    this.lastSgsMaxPas = 0;
    this.lastDivRmsRaw = 0;
    this.lastDivRmsNorm = 0;
    this.lastDivMaxNorm = 0;
    this.lastNetBoundaryFlux = 0;

    const muFill = Math.max(MIN_VISCOSITY_PAS, initialMuPaS ?? 1e-3);
    this.muApp.fill(muFill);
    this.muSgs.fill(0);
    this.muEff.fill(muFill);

    if (this.domain.type === 'cylindrical-tank') {
      const blobRadius = this.tankRadiusGrid * 0.48;
      const sigmaSq = 2 * Math.pow(blobRadius * 0.56, 2);
      for (let j = 1; j <= this.n; j++) {
        const dj = j - this.midGrid;
        for (let i = 1; i <= this.n; i++) {
          const di = i - this.midGrid;
          const idx = i + j * this.rowSize;
          if (!this.pMask[idx]) continue;
          const rSq = di * di + dj * dj;
          if (rSq < blobRadius * blobRadius * 1.6) {
            this.dye[idx] = Math.exp(-rSq / sigmaSq);
          }
        }
      }
      this.refVariance = Math.max(1e-4, this.computeDyeVariance());
    } else {
      for (let j = 1; j <= this.n; j++) {
        for (let i = 1; i <= this.n; i++) {
          const idx = i + j * this.rowSize;
          if (this.pMask[idx]) {
            this.dye[idx] = i <= this.n / 2 ? 1.0 : 0.0;
          }
        }
      }
      this.refVariance = Math.max(1e-4, this.computeDyeVariance());
    }
  }

  /**
   * Imposta campi analitici iniziali in metri per benchmark canonici (es. Taylor-Green Vortex 2D).
   */
  public setVelocityFieldSI(
    fn: (xM: number, yM: number) => { u: number; v: number },
    config: FluidConfig
  ): void {
    const h = this.getCellSizeMeters(config);
    for (let j = 1; j <= this.n; j++) {
      for (let i = 1; i <= this.n; i++) {
        const idx = i + j * this.rowSize;
        if (this.uMask[idx]) {
          const xU = (i - 1) * h;
          const yU = (j - 0.5) * h;
          this.u[idx] = fn(xU, yU).u;
        }
        if (this.vMask[idx]) {
          const xV = (i - 0.5) * h;
          const yV = (j - 1) * h;
          this.v[idx] = fn(xV, yV).v;
        }
      }
    }
    if (this.periodicX || this.periodicY) {
      syncPeriodicGhostFloat(this.u, this.n, this.rowSize, this.periodicX, this.periodicY);
      syncPeriodicGhostFloat(this.v, this.n, this.rowSize, this.periodicX, this.periodicY);
    }
    this.computeKinematicsAndRheology(h, config);
  }

  public applyStirrerImpulse(
    x0Norm: number,
    y0Norm: number,
    x1Norm: number,
    y1Norm: number,
    dt: number,
    config: FluidConfig
  ): void {
    if (dt <= 0) return;
    const h = this.getCellSizeMeters(config);

    const gx0 = x0Norm * this.n + 0.5;
    const gy0 = y0Norm * this.n + 0.5;
    const gx1 = x1Norm * this.n + 0.5;
    const gy1 = y1Norm * this.n + 0.5;

    const segDx = gx1 - gx0;
    const segDy = gy1 - gy0;
    const segLenSq = segDx * segDx + segDy * segDy;

    const rawVx = (segDx * h) / dt;
    const rawVy = (segDy * h) / dt;
    const speed = Math.hypot(rawVx, rawVy);
    const maxTipSpeed = 3.2;
    const clampScale = speed > maxTipSpeed ? maxTipSpeed / speed : 1;

    this.stirrer = {
      active: true,
      gx0,
      gy0,
      gx1,
      gy1,
      rodRadiusGrid: Math.max(1.8, (config.stirrerDiameterMm * 0.0005) / h),
      tipVx: segLenSq > 1e-8 ? rawVx * clampScale : 0,
      tipVy: segLenSq > 1e-8 ? rawVy * clampScale : 0,
    };
  }

  private saveSnapshot(): void {
    this.snap.u.set(this.u);
    this.snap.v.set(this.v);
    this.snap.p.set(this.p);
    this.snap.dye.set(this.dye);
    this.snap.wake.set(this.wake);
    this.snap.muApp.set(this.muApp);
    this.snap.elapsedSec = this.elapsedSec;
  }

  private restoreSnapshot(): void {
    this.u.set(this.snap.u);
    this.v.set(this.snap.v);
    this.p.set(this.snap.p);
    this.dye.set(this.snap.dye);
    this.wake.set(this.snap.wake);
    this.muApp.set(this.snap.muApp);
    this.elapsedSec = this.snap.elapsedSec;
  }

  public step(
    requestedDt: number,
    config: FluidConfig,
    opts?: StepControlOptions
  ): void {
    const h = this.getCellSizeMeters(config);
    const dtDesired = opts?.fixedDtSec
      ? opts.fixedDtSec
      : Math.min(0.033, Math.max(0.001, requestedDt));

    let maxVel = this.stirrer.active
      ? Math.hypot(this.stirrer.tipVx, this.stirrer.tipVy)
      : 0;
    for (let i = 0; i < this.gridSize; i++) {
      const au = Math.abs(this.u[i]);
      const av = Math.abs(this.v[i]);
      if (au > maxVel) maxVel = au;
      if (av > maxVel) maxVel = av;
    }

    let substeps = 1;
    let dtPhys = dtDesired;
    let timeDilation = 1.0;

    if (!opts?.disableAdaptiveSubsteps) {
      const safeMaxVel = Math.max(maxVel, 1e-6);
      const maxCflDt = (CFL_TARGET * h) / safeMaxVel;
      if (dtDesired > maxCflDt) {
        const needed = Math.ceil(dtDesired / maxCflDt);
        if (needed <= MAX_SUBSTEPS) {
          substeps = needed;
          dtPhys = dtDesired / substeps;
        } else {
          // Non violare MAI il vincolo CFL: rallenta esplicitamente il tempo simulato
          substeps = MAX_SUBSTEPS;
          dtPhys = maxCflDt;
          timeDilation = (substeps * dtPhys) / dtDesired;
        }
      }
    }

    this.lastDtPhysSec = dtPhys;
    this.lastSubsteps = substeps;
    this.lastTimeDilation = timeDilation;

    let anyUnderRelaxed = false;
    let anyRollback = false;

    for (let s = 0; s < substeps; s++) {
      const outcome = this.stepSubWithRollback(dtPhys, h, config, opts);
      if (outcome === 'under-relaxed') anyUnderRelaxed = true;
      if (outcome === 'rollback-recovered') anyRollback = true;
    }

    this.lastCourant = (maxVel * dtPhys) / h;
    if (anyRollback) {
      this.lastConvergenceStatus = 'rollback-recovered';
    } else if (timeDilation < 0.999) {
      this.lastConvergenceStatus = 'load-shedding';
    } else if (anyUnderRelaxed) {
      this.lastConvergenceStatus = 'under-relaxed';
    } else {
      this.lastConvergenceStatus = 'converged';
    }

    this.stirrer.active = false;
  }

  private stepSubWithRollback(
    dt: number,
    h: number,
    config: FluidConfig,
    opts?: StepControlOptions
  ): ConvergenceStatus {
    this.saveSnapshot();

    for (let attempt = 0; attempt <= MAX_STEP_RETRIES; attempt++) {
      const subPieces = 1 << attempt;
      const dtPiece = dt / subPieces;
      let ok = true;
      let pieceStatus: ConvergenceStatus = 'converged';

      for (let pIdx = 0; pIdx < subPieces; pIdx++) {
        const res = this.executeSingleSubstep(dtPiece, h, config, opts);
        if (!res.ok) {
          ok = false;
          break;
        }
        if (res.status === 'under-relaxed') {
          pieceStatus = 'under-relaxed';
        }
      }

      if (ok) {
        return attempt > 0 ? 'rollback-recovered' : pieceStatus;
      }

      this.restoreSnapshot();
      this.rollbacksCount++;
    }

    // Se tutti i tentativi di rollback falliscono, mantieni lo stato precedente valido
    this.restoreSnapshot();
    this.computeKinematicsAndRheology(h, config);
    return 'rollback-recovered';
  }

  private buildStirrerPenaltyWeights(dt: number): void {
    this.uRodWeight.fill(0);
    this.vRodWeight.fill(0);
    if (!this.stirrer.active) return;

    const { gx0, gy0, gx1, gy1, rodRadiusGrid } = this.stirrer;
    const segDx = gx1 - gx0;
    const segDy = gy1 - gy0;
    const segLenSq = segDx * segDx + segDy * segDy;
    const searchPad = Math.ceil(rodRadiusGrid) + 2;

    const minI = Math.max(2, Math.floor(Math.min(gx0, gx1) - searchPad));
    const maxI = Math.min(this.n, Math.ceil(Math.max(gx0, gx1) + searchPad));
    const minJ = Math.max(2, Math.floor(Math.min(gy0, gy1) - searchPad));
    const maxJ = Math.min(this.n, Math.ceil(Math.max(gy0, gy1) + searchPad));

    // Coefficiente di accoppiamento asta-fluido in unità SI (s^-1 * dt = adimensionale):
    // tau_coupling = 2.0e-3 s -> dt * k_drag adimensionale
    const couplingRatePerSec = 500;

    for (let j = minJ; j <= maxJ; j++) {
      for (let i = minI; i <= maxI; i++) {
        const idx = i + j * this.rowSize;
        if (this.uMask[idx]) {
          const px = i - 0.5;
          const py = j;
          const t =
            segLenSq > 1e-8
              ? Math.max(0, Math.min(1, ((px - gx0) * segDx + (py - gy0) * segDy) / segLenSq))
              : 0;
          const dist = Math.hypot(px - (gx0 + t * segDx), py - (gy0 + t * segDy));
          if (dist < rodRadiusGrid) {
            const s = 1 - dist / rodRadiusGrid;
            const w = s * s * s * (10 + s * (-15 + 6 * s));
            this.uRodWeight[idx] = w * couplingRatePerSec * dt;
          }
        }
        if (this.vMask[idx]) {
          const px = i;
          const py = j - 0.5;
          const t =
            segLenSq > 1e-8
              ? Math.max(0, Math.min(1, ((px - gx0) * segDx + (py - gy0) * segDy) / segLenSq))
              : 0;
          const dist = Math.hypot(px - (gx0 + t * segDx), py - (gy0 + t * segDy));
          if (dist < rodRadiusGrid) {
            const s = 1 - dist / rodRadiusGrid;
            const w = s * s * s * (10 + s * (-15 + 6 * s));
            this.vRodWeight[idx] = w * couplingRatePerSec * dt;
          }
        }
      }
    }
  }

  private sampleExternalForcing(dt: number, h: number, config: FluidConfig, opts?: StepControlOptions): void {
    const N = this.n;
    const rs = this.rowSize;
    const bodyX = this.domain.bodyForceXMs2 ?? 0;
    const bodyY = this.domain.bodyForceYMs2 ?? 0;
    const extFn = opts?.externalSource;

    if (bodyX === 0 && bodyY === 0 && !extFn) {
      return;
    }

    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const idx = i + j * rs;
        if (this.uMask[idx]) {
          const fx = extFn ? extFn((i - 1) * h, (j - 0.5) * h, this.elapsedSec, h).fx : bodyX;
          this.u[idx] += dt * fx;
        }
        if (this.vMask[idx]) {
          const fy = extFn ? extFn((i - 0.5) * h, (j - 1) * h, this.elapsedSec, h).fy : bodyY;
          this.v[idx] += dt * fy;
        }
      }
    }
    void config;
  }

  private executeSingleSubstep(
    dt: number,
    h: number,
    config: FluidConfig,
    opts?: StepControlOptions
  ): { ok: boolean; status: ConvergenceStatus } {
    const rho = Math.max(200, config.densityKgM3);

    this.computeKinematicsAndRheology(h, config, opts);

    // Avvezione esplicita dell'inerzia (omessa solo se il passo temporale di Stokes è stabile senza di essa? No: in MacCormack è stabile a CFL < 0.65 ovunque; per pure creeping Stokes a Re << 10^-3 il termine convettivo è trascurabile ma mantenerlo o escluderlo sotto Pe_c è documentato: lo includiamo sempre tranne overflow, così anche Poiseuille/Couette sono esattamente Navier-Stokes completi!)
    this.advectVelocityMacCormack(dt, h);
    this.sampleExternalForcing(dt, h, config, opts);

    if (this.periodicX || this.periodicY) {
      syncPeriodicGhostFloat(this.u, this.n, this.rowSize, this.periodicX, this.periodicY);
      syncPeriodicGhostFloat(this.v, this.n, this.rowSize, this.periodicX, this.periodicY);
    }

    this.uStar.set(this.u);
    this.vStar.set(this.v);
    this.pPicardBase.set(this.p);

    this.buildStirrerPenaltyWeights(dt);

    const isNonLinear = config.model !== 'newtonian' || config.enableSmagorinsky;
    const picardMax = isNonLinear ? PICARD_MAX_ITER : 1;

    let picardIter = 0;
    let picardResidual = 0;
    let picardConverged = !isNonLinear;
    let lastDiffRes = 0;
    let lastPressRes = 0;

    for (let k = 0; k < picardMax; k++) {
      picardIter = k + 1;
      if (isNonLinear) {
        this.muEffPrev.set(this.muEff);
        this.uPicardPrev.set(this.u);
        this.vPicardPrev.set(this.v);
      }

      // Parte dai campi pre-diffusione uStar, vStar e dalla pressione base di inizio passo ad ogni iterazione di Picard
      this.u.set(this.uStar);
      this.v.set(this.vStar);
      this.p.set(this.pPicardBase);

      const diffRes = this.solveDiffusionTensorGalerkin(dt, h, rho);
      lastDiffRes = Math.max(diffRes.uRel, diffRes.vRel);
      if (!diffRes.converged || !Number.isFinite(lastDiffRes)) {
        this.lastDiffResidual = lastDiffRes;
        return { ok: false, status: 'rollback-recovered' };
      }

      const pressRes = this.projectPressureGalerkin(dt, h, rho, true);
      lastPressRes = pressRes.relativeResidual;
      if (!pressRes.converged || !Number.isFinite(lastPressRes)) {
        this.lastPressResidual = lastPressRes;
        return { ok: false, status: 'rollback-recovered' };
      }

      this.computeKinematicsAndRheology(h, config, opts);

      if (isNonLinear) {
        // Sottorilassamento adattivo di Picard dopo iterazioni iniziali
        const omega = k >= 4 ? 0.55 : k >= 2 ? 0.75 : 0.9;
        if (k > 0 && omega < 1.0) {
          for (let i = 0; i < this.gridSize; i++) {
            this.muEff[i] = omega * this.muEff[i] + (1 - omega) * this.muEffPrev[i];
          }
        }

        let muDiffSq = 0;
        let muNormSq = 0;
        let velDiffSq = 0;
        let velNormSq = 0;
        for (let i = 0; i < this.gridSize; i++) {
          if (!this.pMask[i]) continue;
          const dm = this.muEff[i] - this.muEffPrev[i];
          muDiffSq += dm * dm;
          muNormSq += this.muEff[i] * this.muEff[i];
          const du = this.u[i] - this.uPicardPrev[i];
          const dv = this.v[i] - this.vPicardPrev[i];
          velDiffSq += du * du + dv * dv;
          velNormSq += this.u[i] * this.u[i] + this.v[i] * this.v[i];
        }
        const relMu = Math.sqrt(muDiffSq / Math.max(1e-18, muNormSq));
        const relVel = Math.sqrt(velDiffSq / Math.max(1e-14, velNormSq));
        picardResidual = Math.max(relMu, relVel);

        if (!Number.isFinite(picardResidual)) {
          return { ok: false, status: 'rollback-recovered' };
        }
        if (k > 0 && relMu <= PICARD_REL_TOL && relVel <= PICARD_REL_TOL) {
          picardConverged = true;
          break;
        }
      }
    }

    this.lastDiffResidual = lastDiffRes;
    this.lastPressResidual = lastPressRes;
    this.lastPicardIter = picardIter;
    this.lastPicardResidual = picardResidual;

    this.computeDivergenceDiagnostics(h);
    if (
      !Number.isFinite(this.lastDivMaxNorm) ||
      this.lastDivMaxNorm > DIV_ROLLBACK_THRESHOLD
    ) {
      return { ok: false, status: 'rollback-recovered' };
    }

    // Trasporto conservativo ai volumi finiti (MUSCL-TVD split) per conservazione massa tracciante
    this.advectScalarConservativeFV(this.dye, this.dyeFwd, this.dyeTmp, dt, h);
    const effBasePaS = getEffectiveBaseViscosityMpas(config.viscosityMpas) * 1e-3;
    this.updatePlasticWake(dt, config, effBasePaS);
    this.computeKinematicsAndRheology(h, config, opts);

    this.elapsedSec += dt;

    return {
      ok: true,
      status: picardConverged ? 'converged' : 'under-relaxed',
    };
  }

  private updatePlasticWake(dt: number, config: FluidConfig, effBasePaS: number): void {
    const N = this.n;
    const rs = this.rowSize;

    if (this.stirrer.active) {
      const { gx0, gy0, gx1, gy1, rodRadiusGrid } = this.stirrer;
      const segDx = gx1 - gx0;
      const segDy = gy1 - gy0;
      const segLenSq = segDx * segDx + segDy * segDy;
      const speedRod = Math.hypot(this.stirrer.tipVx, this.stirrer.tipVy);
      const stampGain = Math.min(1.0, 0.25 + speedRod * 0.55);
      const wakeRad = rodRadiusGrid * 1.12;
      const pad = Math.ceil(wakeRad) + 2;

      const minI = Math.max(1, Math.floor(Math.min(gx0, gx1) - pad));
      const maxI = Math.min(N, Math.ceil(Math.max(gx0, gx1) + pad));
      const minJ = Math.max(1, Math.floor(Math.min(gy0, gy1) - pad));
      const maxJ = Math.min(N, Math.ceil(Math.max(gy0, gy1) + pad));

      for (let j = minJ; j <= maxJ; j++) {
        for (let i = minI; i <= maxI; i++) {
          const idx = i + j * rs;
          if (!this.pMask[idx]) continue;
          const t =
            segLenSq > 1e-8
              ? Math.max(0, Math.min(1, ((i - gx0) * segDx + (j - gy0) * segDy) / segLenSq))
              : 0;
          const dist = Math.hypot(i - (gx0 + t * segDx), j - (gy0 + t * segDy));
          if (dist < wakeRad) {
            const s = 1 - dist / wakeRad;
            const deposit = s * s * stampGain;
            if (deposit > this.wake[idx]) {
              this.wake[idx] = Math.min(1.0, deposit);
            }
          }
        }
      }
    }

    const h = this.getCellSizeMeters(config);
    this.advectScalarMacCormack(this.wake, this.wakeFwd, this.wakeBwd, this.wakeTmp, dt, h);

    const decayRate =
      config.model === 'herschel-bulkley'
        ? 0.08
        : effBasePaS > 1.0
        ? 0.14
        : 0.48;
    const decay = Math.exp(-decayRate * dt);
    const smoothRate = effBasePaS > 1.0 ? 0.015 : 0.05;

    for (let j = 1; j <= N; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= N; i++, idx++) {
        if (!this.pMask[idx]) {
          this.wakeTmp[idx] = 0;
          continue;
        }
        let sumNb = 0;
        let cnt = 0;
        if (this.pMask[idx - 1]) {
          sumNb += this.wake[idx - 1];
          cnt++;
        }
        if (this.pMask[idx + 1]) {
          sumNb += this.wake[idx + 1];
          cnt++;
        }
        if (this.pMask[idx - rs]) {
          sumNb += this.wake[idx - rs];
          cnt++;
        }
        if (this.pMask[idx + rs]) {
          sumNb += this.wake[idx + rs];
          cnt++;
        }
        const avgNb = cnt > 0 ? sumNb / cnt : this.wake[idx];
        const smoothed = this.wake[idx] * (1 - smoothRate) + avgNb * smoothRate;
        this.wakeTmp[idx] = smoothed * decay;
      }
    }
    this.wake.set(this.wakeTmp);
  }

  public computeKinematicsAndRheology(
    h: number,
    config: FluidConfig,
    opts?: StepControlOptions
  ): void {
    const N = this.n;
    const rs = this.rowSize;
    const invH = 1 / h;
    const ucBuf = this.scalarA;
    const vcBuf = this.scalarB;
    const rho = Math.max(200, config.densityKgM3);

    if (this.periodicX || this.periodicY) {
      syncPeriodicGhostFloat(this.u, N, rs, this.periodicX, this.periodicY);
      syncPeriodicGhostFloat(this.v, N, rs, this.periodicX, this.periodicY);
    }

    for (let j = 1; j <= N; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= N; i++, idx++) {
        if (!this.pMask[idx]) {
          ucBuf[idx] = 0;
          vcBuf[idx] = 0;
          this.shearRate[idx] = 0;
          this.shearStress[idx] = 0;
          this.vorticity[idx] = 0;
          this.absVort[idx] = 0;
          this.speedField[idx] = 0;
          this.muSgs[idx] = 0;
          continue;
        }

        const hasW = this.uMask[idx];
        const hasE = this.uMask[idx + 1];
        let uc = 0;
        if (hasW && hasE) {
          uc = 0.5 * (this.u[idx] + this.u[idx + 1]);
        } else if (hasW) {
          const dE = this.wallDeltaE[idx];
          uc = this.u[idx] * (dE / (0.5 + dE));
        } else if (hasE) {
          const dW = this.wallDeltaW[idx];
          uc = this.u[idx + 1] * (dW / (0.5 + dW));
        }

        const hasS = this.vMask[idx];
        const hasN = this.vMask[idx + rs];
        let vc = 0;
        if (hasS && hasN) {
          vc = 0.5 * (this.v[idx] + this.v[idx + rs]);
        } else if (hasS) {
          const dN = this.wallDeltaN[idx];
          vc = this.v[idx] * (dN / (0.5 + dN));
        } else if (hasN) {
          const dS = this.wallDeltaS[idx];
          vc = this.v[idx + rs] * (dS / (0.5 + dS));
        }

        ucBuf[idx] = uc;
        vcBuf[idx] = vc;
        this.speedField[idx] = Math.hypot(uc, vc);
      }
    }

    if (this.periodicX || this.periodicY) {
      syncPeriodicGhostFloat(ucBuf, N, rs, this.periodicX, this.periodicY);
      syncPeriodicGhostFloat(vcBuf, N, rs, this.periodicX, this.periodicY);
    }

    let clampedCount = 0;
    let sgsSum = 0;
    let sgsMax = 0;

    const topVel = this.domain.type === 'channel-x' ? this.domain.topWallVxMs ?? 0 : 0;

    for (let j = 1; j <= N; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= N; i++, idx++) {
        if (!this.pMask[idx]) continue;

        const hasW = this.uMask[idx];
        const hasE = this.uMask[idx + 1];
        let dudx = 0;
        if (hasW && hasE) {
          dudx = (this.u[idx + 1] - this.u[idx]) * invH;
        } else if (hasW) {
          dudx = -this.u[idx] / ((0.5 + this.wallDeltaE[idx]) * h);
        } else if (hasE) {
          dudx = this.u[idx + 1] / ((0.5 + this.wallDeltaW[idx]) * h);
        }

        const hasS = this.vMask[idx];
        const hasN = this.vMask[idx + rs];
        let dvdy = 0;
        if (hasS && hasN) {
          dvdy = (this.v[idx + rs] - this.v[idx]) * invH;
        } else if (hasS) {
          dvdy = -this.v[idx] / ((0.5 + this.wallDeltaN[idx]) * h);
        } else if (hasN) {
          dvdy = this.v[idx + rs] / ((0.5 + this.wallDeltaS[idx]) * h);
        }

        const pN = this.pMask[idx + rs];
        const pS = this.pMask[idx - rs];
        let dudy = 0;
        if (pN && pS) {
          dudy = (ucBuf[idx + rs] - ucBuf[idx - rs]) * (0.5 * invH);
        } else if (this.domain.type === 'channel-x' && !pS && pN) {
          // Interpolazione quadratica esatta fino a y=0 (u=0): (uc[1] + uc[2]/3)/h
          dudy = (ucBuf[idx] + ucBuf[idx + rs] / 3) * invH;
        } else if (this.domain.type === 'channel-x' && !pN && pS) {
          // Interpolazione quadratica esatta fino a y=H (u=topVel)
          dudy = (topVel - ucBuf[idx] + (topVel - ucBuf[idx - rs]) / 3) * invH;
        } else if (pS) {
          dudy = -ucBuf[idx - rs] / ((1 + this.wallDeltaN[idx]) * h);
        } else if (pN) {
          dudy = ucBuf[idx + rs] / ((1 + this.wallDeltaS[idx]) * h);
        }

        const pE = this.pMask[idx + 1];
        const pW = this.pMask[idx - 1];
        let dvdx = 0;
        if (pE && pW) {
          dvdx = (vcBuf[idx + 1] - vcBuf[idx - 1]) * (0.5 * invH);
        } else if (pW) {
          dvdx = -vcBuf[idx - 1] / ((1 + this.wallDeltaE[idx]) * h);
        } else if (pE) {
          dvdx = vcBuf[idx + 1] / ((1 + this.wallDeltaW[idx]) * h);
        }

        const vort = dvdx - dudy;
        this.vorticity[idx] = vort;
        this.absVort[idx] = Math.abs(vort);

        const gamma = Math.sqrt(
          2 * dudx * dudx + 2 * dvdy * dvdy + (dudy + dvdx) * (dudy + dvdx)
        );
        this.shearRate[idx] = gamma;

        const muPhysical = opts?.externalViscosityField
          ? opts.externalViscosityField((i - 0.5) * h, (j - 0.5) * h)
          : computeApparentViscosityPaS(gamma, config);
        this.muApp[idx] = muPhysical;
        // Sforzo di taglio fisico basato esclusivamente su muApp (mai contaminato da mu_sgs!)
        this.shearStress[idx] = muPhysical * gamma;

        let muSgsVal = 0;
        if (config.enableSmagorinsky) {
          const cs = Math.max(0.05, Math.min(0.3, config.smagorinskyCs));
          // Smorzamento semplice alla parete solida: riduce mu_sgs nelle celle adiacenti al contorno
          const isBoundary =
            !this.pMask[idx - 1] ||
            !this.pMask[idx + 1] ||
            !this.pMask[idx - rs] ||
            !this.pMask[idx + rs];
          const wallDamp = isBoundary ? 0.35 : 1.0;
          const lSgs = cs * wallDamp * h;
          muSgsVal = rho * lSgs * lSgs * gamma;
        }
        this.muSgs[idx] = muSgsVal;
        sgsSum += muSgsVal;
        if (muSgsVal > sgsMax) sgsMax = muSgsVal;

        const bounded = clampToSolverViscosityDomainPaS(muPhysical + muSgsVal);
        if (bounded.clamped) clampedCount++;
        this.muEff[idx] = bounded.value;
      }
    }

    if (this.periodicX || this.periodicY) {
      syncPeriodicGhostFloat(this.muEff, N, rs, this.periodicX, this.periodicY);
    }

    this.lastClampedCount = clampedCount;
    this.lastSgsMeanPas = this.fluidCellCount > 0 ? sgsSum / this.fluidCellCount : 0;
    this.lastSgsMaxPas = sgsMax;
  }

  private sampleFace(
    src: Float32Array,
    gx: number,
    gy: number,
    isU: boolean
  ): [number, number, number] {
    const N = this.n;
    const rs = this.rowSize;
    let x = gx;
    let y = gy;

    if (this.periodicX) {
      x = ((x - 1) % N + N) % N + 1;
    } else {
      const maxX = isU ? N + 0.999 : N - 0.001;
      x = x < 1 ? 1 : x > maxX ? maxX : x;
    }

    if (this.periodicY) {
      y = ((y - 1) % N + N) % N + 1;
    } else {
      const maxY = isU ? N - 0.001 : N + 0.999;
      y = y < 1 ? 1 : y > maxY ? maxY : y;
    }

    const i0 = x | 0;
    const j0 = y | 0;
    const sx = x - i0;
    const sy = y - j0;
    const idx00 = i0 + j0 * rs;
    const idx10 = idx00 + 1;
    const idx01 = idx00 + rs;
    const idx11 = idx01 + 1;

    const q00 = src[idx00];
    const q10 = src[idx10];
    const q01 = src[idx01];
    const q11 = src[idx11];

    const minV = Math.min(q00, q10, q01, q11);
    const maxV = Math.max(q00, q10, q01, q11);
    const val = (1 - sx) * ((1 - sy) * q00 + sy * q01) + sx * ((1 - sy) * q10 + sy * q11);
    return [val, minV, maxV];
  }

  private advectVelocityMacCormack(dt: number, h: number): void {
    const N = this.n;
    const rs = this.rowSize;
    const dtOverH = dt / h;
    const u = this.u;
    const v = this.v;

    if (this.periodicX || this.periodicY) {
      syncPeriodicGhostFloat(u, N, rs, this.periodicX, this.periodicY);
      syncPeriodicGhostFloat(v, N, rs, this.periodicX, this.periodicY);
    }

    this.uFwd.set(u);
    this.vFwd.set(v);

    for (let j = 1; j <= N; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= N; i++, idx++) {
        if (this.uMask[idx]) {
          const vx = u[idx];
          const vy = 0.25 * (v[idx - 1] + v[idx] + v[idx - 1 + rs] + v[idx + rs]);
          const [val] = this.sampleFace(u, i - dtOverH * vx, j - dtOverH * vy, true);
          this.uFwd[idx] = val;
        }
        if (this.vMask[idx]) {
          const vx = 0.25 * (u[idx - rs] + u[idx + 1 - rs] + u[idx] + u[idx + 1]);
          const vy = v[idx];
          const [val] = this.sampleFace(v, i - dtOverH * vx, j - dtOverH * vy, false);
          this.vFwd[idx] = val;
        }
      }
    }

    if (this.periodicX || this.periodicY) {
      syncPeriodicGhostFloat(this.uFwd, N, rs, this.periodicX, this.periodicY);
      syncPeriodicGhostFloat(this.vFwd, N, rs, this.periodicX, this.periodicY);
    }

    this.uBwd.set(this.uFwd);
    this.vBwd.set(this.vFwd);

    for (let j = 1; j <= N; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= N; i++, idx++) {
        if (this.uMask[idx]) {
          const vx = u[idx];
          const vy = 0.25 * (v[idx - 1] + v[idx] + v[idx - 1 + rs] + v[idx + rs]);
          const [val] = this.sampleFace(this.uFwd, i + dtOverH * vx, j + dtOverH * vy, true);
          this.uBwd[idx] = val;
        }
        if (this.vMask[idx]) {
          const vx = 0.25 * (u[idx - rs] + u[idx + 1 - rs] + u[idx] + u[idx + 1]);
          const vy = v[idx];
          const [val] = this.sampleFace(this.vFwd, i + dtOverH * vx, j + dtOverH * vy, false);
          this.vBwd[idx] = val;
        }
      }
    }

    for (let j = 1; j <= N; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= N; i++, idx++) {
        if (this.uMask[idx]) {
          const vx = u[idx];
          const vy = 0.25 * (v[idx - 1] + v[idx] + v[idx - 1 + rs] + v[idx + rs]);
          const [fwd, minV, maxV] = this.sampleFace(u, i - dtOverH * vx, j - dtOverH * vy, true);
          const corr = fwd + 0.5 * (u[idx] - this.uBwd[idx]);
          this.uTmp[idx] = corr < minV ? minV : corr > maxV ? maxV : corr;
        } else {
          this.uTmp[idx] = 0;
        }

        if (this.vMask[idx]) {
          const vx = 0.25 * (u[idx - rs] + u[idx + 1 - rs] + u[idx] + u[idx + 1]);
          const vy = v[idx];
          const [fwd, minV, maxV] = this.sampleFace(v, i - dtOverH * vx, j - dtOverH * vy, false);
          const corr = fwd + 0.5 * (v[idx] - this.vBwd[idx]);
          this.vTmp[idx] = corr < minV ? minV : corr > maxV ? maxV : corr;
        } else {
          this.vTmp[idx] = 0;
        }
      }
    }

    this.u.set(this.uTmp);
    this.v.set(this.vTmp);
  }

  /**
   * Discretizzazione coerente del tensore completo degli sforzi viscosi:
   * div(mu_eff * (grad u + grad u^T))
   * con parte diagonale SPD risolta implicitamente via Galerkin Multigrid + PCG
   * e termini misti trasversi (d/dy(mu dv/dx) per u, d/dx(mu du/dy) per v) valutati ai nodi d'angolo.
   */
  private solveDiffusionTensorGalerkin(
    dt: number,
    h: number,
    rho: number
  ): { converged: boolean; uRel: number; vRel: number } {
    const N = this.n;
    const rs = this.rowSize;
    const baseAlpha = dt / (rho * h * h);
    const invScale = dt / (rho * h);
    const mu = this.muEff;
    const p = this.p;

    if (this.periodicX || this.periodicY) {
      syncPeriodicGhostFloat(this.u, N, rs, this.periodicX, this.periodicY);
      syncPeriodicGhostFloat(this.v, N, rs, this.periodicX, this.periodicY);
      syncPeriodicGhostFloat(p, N, rs, this.periodicX, this.periodicY);
      syncPeriodicGhostFloat(mu, N, rs, this.periodicX, this.periodicY);
    }

    const harmonicCornerMu = (a: number, b: number, c: number, d: number): number => {
      if (a <= 0 || b <= 0 || c <= 0 || d <= 0) {
        return Math.max(a, b, c, d);
      }
      return 4 / (1 / a + 1 / b + 1 / c + 1 / d);
    };

    // ---- 1. Equazione per u ----
    const l0 = this.diffLevels[0];
    l0.active.set(this.uMask);
    l0.selfDiag.fill(0);
    l0.cE.fill(0);
    l0.cN.fill(0);
    l0.diag.fill(1);
    this.cgScratch.x.fill(0);
    this.cgScratch.r.fill(0);
    this.cgScratch.p.fill(0);
    this.cgScratch.ap.fill(0);

    for (let j = 1; j <= N; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= N; i++, idx++) {
        if (!this.uMask[idx]) continue;

        const mC = mu[idx];
        const mW = mu[idx - 1];
        const mAvg = 0.5 * (mC + mW);

        // Flusso normale Est (centro cella idx) -> fattore 2 per 2 * mu * du/dx
        if (this.uMask[idx + 1]) {
          l0.cE[idx] = 2 * baseAlpha * mC;
        }
        // Flusso di taglio Nord (angolo i-1/2, j+1/2)
        const muNE = harmonicCornerMu(
          mu[idx],
          mu[idx - 1],
          this.pMask[idx + rs] ? mu[idx + rs] : mu[idx],
          this.pMask[idx - 1 + rs] ? mu[idx - 1 + rs] : mu[idx - 1]
        );
        const muSE = harmonicCornerMu(
          mu[idx],
          mu[idx - 1],
          this.pMask[idx - rs] ? mu[idx - rs] : mu[idx],
          this.pMask[idx - 1 - rs] ? mu[idx - 1 - rs] : mu[idx - 1]
        );
        if (this.uMask[idx + rs]) {
          l0.cN[idx] = baseAlpha * muNE;
        }

        const crossN = this.pMask[idx + rs] && this.pMask[idx - 1 + rs]
          ? muNE * (this.v[idx + rs] - this.v[idx - 1 + rs])
          : 0;
        const crossS = this.pMask[idx - rs] && this.pMask[idx - 1 - rs]
          ? muSE * (this.v[idx] - this.v[idx - 1])
          : 0;
        const crossRhs = baseAlpha * (crossN - crossS);

        const wallDiag = baseAlpha * mAvg * this.uWallFactor[idx];
        const rw = this.uRodWeight[idx];
        l0.selfDiag[idx] = 1.0 + rw + wallDiag;

        const pGrad = invScale * (p[idx] - p[idx - 1]);
        const wallTargetRhs = wallDiag * this.uWallTargetVel[idx];
        this.cgScratch.r[idx] =
          this.u[idx] + rw * this.stirrer.tipVx + wallTargetRhs + crossRhs - pGrad;
        this.cgScratch.x[idx] =
          rw > 0 ? this.stirrer.tipVx : this.u[idx] / (1.0 + 0.015 * baseAlpha * mAvg);
      }
    }

    syncGalerkinAndComputeDiag(this.diffLevels, l0, N, rs, this.periodicX, this.periodicY);
    const uRes = solveGalerkinPCG(
      this.diffLevels,
      this.cgScratch,
      DIFF_MAX_ITER,
      DIFF_REL_TOL,
      DIFF_ABS_TOL,
      this.periodicX,
      this.periodicY,
      false
    );
    if (!uRes.converged) {
      return { converged: false, uRel: uRes.relativeResidual, vRel: 0 };
    }
    this.uTmp.set(this.cgScratch.x);

    // ---- 2. Equazione per v ----
    l0.active.set(this.vMask);
    l0.selfDiag.fill(0);
    l0.cE.fill(0);
    l0.cN.fill(0);
    l0.diag.fill(1);
    this.cgScratch.x.fill(0);
    this.cgScratch.r.fill(0);
    this.cgScratch.p.fill(0);
    this.cgScratch.ap.fill(0);

    for (let j = 1; j <= N; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= N; i++, idx++) {
        if (!this.vMask[idx]) continue;

        const mC = mu[idx];
        const mS = mu[idx - rs];
        const mAvg = 0.5 * (mC + mS);

        // Flusso normale Nord (centro cella idx) -> fattore 2 per 2 * mu * dv/dy
        if (this.vMask[idx + rs]) {
          l0.cN[idx] = 2 * baseAlpha * mC;
        }
        // Flusso di taglio Est (angolo i+1/2, j-1/2)
        const muNE = harmonicCornerMu(
          mu[idx],
          mu[idx - rs],
          this.pMask[idx + 1] ? mu[idx + 1] : mu[idx],
          this.pMask[idx + 1 - rs] ? mu[idx + 1 - rs] : mu[idx - rs]
        );
        const muNW = harmonicCornerMu(
          mu[idx],
          mu[idx - rs],
          this.pMask[idx - 1] ? mu[idx - 1] : mu[idx],
          this.pMask[idx - 1 - rs] ? mu[idx - 1 - rs] : mu[idx - rs]
        );
        if (this.vMask[idx + 1]) {
          l0.cE[idx] = baseAlpha * muNE;
        }

        const crossE = this.pMask[idx + 1] && this.pMask[idx + 1 - rs]
          ? muNE * (this.u[idx + 1] - this.u[idx + 1 - rs])
          : 0;
        const crossW = this.pMask[idx - 1] && this.pMask[idx - 1 - rs]
          ? muNW * (this.u[idx] - this.u[idx - rs])
          : 0;
        const crossRhs = baseAlpha * (crossE - crossW);

        const wallDiag = baseAlpha * mAvg * this.vWallFactor[idx];
        const rw = this.vRodWeight[idx];
        l0.selfDiag[idx] = 1.0 + rw + wallDiag;

        const pGrad = invScale * (p[idx] - p[idx - rs]);
        this.cgScratch.r[idx] = this.v[idx] + rw * this.stirrer.tipVy + crossRhs - pGrad;
        this.cgScratch.x[idx] =
          rw > 0 ? this.stirrer.tipVy : this.v[idx] / (1.0 + 0.015 * baseAlpha * mAvg);
      }
    }

    syncGalerkinAndComputeDiag(this.diffLevels, l0, N, rs, this.periodicX, this.periodicY);
    const vRes = solveGalerkinPCG(
      this.diffLevels,
      this.cgScratch,
      DIFF_MAX_ITER,
      DIFF_REL_TOL,
      DIFF_ABS_TOL,
      this.periodicX,
      this.periodicY,
      false
    );
    if (!vRes.converged) {
      return { converged: false, uRel: uRes.relativeResidual, vRel: vRes.relativeResidual };
    }

    for (let i = 0; i < l0.size; i++) {
      this.u[i] = this.uMask[i] ? this.uTmp[i] : 0;
      this.v[i] = this.vMask[i] ? this.cgScratch.x[i] : 0;
    }

    if (this.periodicX || this.periodicY) {
      syncPeriodicGhostFloat(this.u, N, rs, this.periodicX, this.periodicY);
      syncPeriodicGhostFloat(this.v, N, rs, this.periodicX, this.periodicY);
    }

    return {
      converged: true,
      uRel: uRes.relativeResidual,
      vRel: vRes.relativeResidual,
    };
  }

  private projectPressureGalerkin(
    dt: number,
    h: number,
    rho: number,
    incremental: boolean
  ): { converged: boolean; relativeResidual: number } {
    const N = this.n;
    const rs = this.rowSize;
    const p0 = this.pressLevels[0];
    const scale = (rho * h) / dt;
    const pMask = this.pMask;

    if (this.periodicX || this.periodicY) {
      syncPeriodicGhostFloat(this.u, N, rs, this.periodicX, this.periodicY);
      syncPeriodicGhostFloat(this.v, N, rs, this.periodicX, this.periodicY);
    }

    const cgX = this.cgScratch.x;
    const cgR = this.cgScratch.r;
    cgX.fill(0);
    cgR.fill(0);
    this.cgScratch.p.fill(0);
    this.cgScratch.ap.fill(0);

    let divSum = 0;
    for (let j = 1; j <= N; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= N; i++, idx++) {
        if (!pMask[idx]) continue;
        const divH = this.u[idx + 1] - this.u[idx] + this.v[idx + rs] - this.v[idx];
        this.uTmp[idx] = divH / h;
        const rawRhs = -divH * scale;
        cgR[idx] = rawRhs;
        cgX[idx] = incremental ? 0 : this.p[idx];
        divSum += rawRhs;
      }
    }

    const divMean = this.fluidCellCount > 0 ? divSum / this.fluidCellCount : 0;
    for (let j = 1; j <= N; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= N; i++, idx++) {
        if (pMask[idx]) cgR[idx] -= divMean;
      }
    }

    const res = solveGalerkinPCG(
      this.pressLevels,
      this.cgScratch,
      PRESS_MAX_ITER,
      PRESS_REL_TOL,
      PRESS_ABS_TOL,
      this.periodicX,
      this.periodicY,
      true
    );

    if (!res.converged) {
      return { converged: false, relativeResidual: res.relativeResidual };
    }

    let pSum = 0;
    for (let j = 1; j <= N; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= N; i++, idx++) {
        if (pMask[idx]) {
          const nextP = incremental ? this.p[idx] + cgX[idx] : cgX[idx];
          this.p[idx] = nextP;
          pSum += nextP;
        } else {
          this.p[idx] = 0;
        }
      }
    }
    const pMean = this.fluidCellCount > 0 ? pSum / this.fluidCellCount : 0;
    for (let j = 1; j <= N; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= N; i++, idx++) {
        if (pMask[idx]) this.p[idx] -= pMean;
      }
    }
    if (this.periodicX || this.periodicY) {
      syncPeriodicGhostFloat(this.p, N, rs, this.periodicX, this.periodicY);
    }

    const invScale = dt / (rho * h);
    for (let j = 1; j <= N; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= N; i++, idx++) {
        if (this.uMask[idx]) {
          this.u[idx] -= invScale * (cgX[idx] - cgX[idx - 1]);
        } else {
          this.u[idx] = 0;
        }
        if (this.vMask[idx]) {
          this.v[idx] -= invScale * (cgX[idx] - cgX[idx - rs]);
        } else {
          this.v[idx] = 0;
        }
      }
    }

    if (this.periodicX || this.periodicY) {
      syncPeriodicGhostFloat(this.u, N, rs, this.periodicX, this.periodicY);
      syncPeriodicGhostFloat(this.v, N, rs, this.periodicX, this.periodicY);
    }

    void p0;
    return { converged: true, relativeResidual: res.relativeResidual };
  }

  private computeDivergenceDiagnostics(h: number): void {
    const N = this.n;
    const rs = this.rowSize;
    if (this.periodicX || this.periodicY) {
      syncPeriodicGhostFloat(this.u, N, rs, this.periodicX, this.periodicY);
      syncPeriodicGhostFloat(this.v, N, rs, this.periodicX, this.periodicY);
    }

    let divSqSum = 0;
    let divMaxRaw = 0;
    let maxSpeed = 0;
    let boundaryFlux = 0;

    for (let j = 1; j <= N; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= N; i++, idx++) {
        if (!this.pMask[idx]) continue;

        const uL = this.u[idx];
        const uR = this.u[idx + 1];
        const vB = this.v[idx];
        const vT = this.v[idx + rs];

        const d = Math.abs((uR - uL + vT - vB) / h);
        divSqSum += d * d;
        if (d > divMaxRaw) divMaxRaw = d;

        const uc = 0.5 * (uL + uR);
        const vc = 0.5 * (vB + vT);
        const sp = Math.hypot(uc, vc);
        if (sp > maxSpeed) maxSpeed = sp;

        // Flusso netto sui bordi solidi non periodici (identicamente uguale al integrale della divergenza!)
        if (!this.pMask[idx - 1]) boundaryFlux -= uL * h;
        if (!this.pMask[idx + 1]) boundaryFlux += uR * h;
        if (!this.pMask[idx - rs]) boundaryFlux -= vB * h;
        if (!this.pMask[idx + rs]) boundaryFlux += vT * h;
      }
    }

    const divRmsRaw = Math.sqrt(divSqSum / (this.fluidCellCount || 1));
    const uScale = Math.max(maxSpeed, 1e-4);
    this.lastDivRmsRaw = divRmsRaw;
    this.lastDivRmsNorm = (divRmsRaw * h) / uScale;
    this.lastDivMaxNorm = (divMaxRaw * h) / uScale;
    this.lastNetBoundaryFlux = boundaryFlux;
  }

  private sampleCellScalar(src: Float32Array, gx: number, gy: number): [number, number, number] {
    const N = this.n;
    const rs = this.rowSize;
    let x = gx;
    let y = gy;

    if (this.domain.type === 'cylindrical-tank') {
      const dx = x - this.midGrid;
      const dy = y - this.midGrid;
      const maxR = this.tankRadiusGrid - 0.5;
      const distSq = dx * dx + dy * dy;
      if (distSq > maxR * maxR) {
        const scale = maxR / Math.sqrt(distSq);
        x = this.midGrid + dx * scale;
        y = this.midGrid + dy * scale;
      }
    }

    if (this.periodicX) {
      x = ((x - 1) % N + N) % N + 1;
    } else {
      x = x < 1 ? 1 : x > N - 0.001 ? N - 0.001 : x;
    }
    if (this.periodicY) {
      y = ((y - 1) % N + N) % N + 1;
    } else {
      y = y < 1 ? 1 : y > N - 0.001 ? N - 0.001 : y;
    }

    const i0 = x | 0;
    const j0 = y | 0;
    const sx = x - i0;
    const sy = y - j0;

    const idx00 = i0 + j0 * rs;
    const idx10 = idx00 + 1;
    const idx01 = idx00 + rs;
    const idx11 = idx01 + 1;

    const centerVal = src[Math.round(x) + Math.round(y) * rs];
    const q00 = this.pMask[idx00] ? src[idx00] : centerVal;
    const q10 = this.pMask[idx10] ? src[idx10] : centerVal;
    const q01 = this.pMask[idx01] ? src[idx01] : centerVal;
    const q11 = this.pMask[idx11] ? src[idx11] : centerVal;

    const minV = Math.min(q00, q10, q01, q11);
    const maxV = Math.max(q00, q10, q01, q11);
    const val = (1 - sx) * ((1 - sy) * q00 + sy * q01) + sx * ((1 - sy) * q10 + sy * q11);
    return [val, minV, maxV];
  }

  private advectScalarConservativeFV(
    field: Float32Array,
    fluxBuf: Float32Array,
    tmpBuf: Float32Array,
    dt: number,
    h: number
  ): void {
    const N = this.n;
    const rs = this.rowSize;
    const dtOverH = dt / h;
    const minmod = (a: number, b: number): number => {
      if (a * b <= 0) return 0;
      return Math.abs(a) < Math.abs(b) ? a : b;
    };

    if (this.periodicX || this.periodicY) {
      syncPeriodicGhostFloat(field, N, rs, this.periodicX, this.periodicY);
    }

    // Sweep X: flussi sulle facce Est (i + 1/2, j)
    fluxBuf.fill(0);
    for (let j = 1; j <= N; j++) {
      const row = j * rs;
      for (let i = 0; i <= N; i++) {
        if (i === 0 && !this.periodicX) continue;
        if (i === N && !this.periodicX) continue;
        const leftIdx = (i === 0 ? N : i) + row;
        const rightIdx = (i === N ? 1 : i + 1) + row;
        if (!this.pMask[leftIdx] || !this.pMask[rightIdx]) continue;

        const vel = this.u[i + 1 + row];
        if (vel === 0) continue;

        const cfl = Math.min(0.95, Math.abs(vel) * dtOverH);
        let phiFace = 0;
        if (vel > 0) {
          const prevI = i === 1 ? (this.periodicX ? N : 0) : i - 1;
          const prevIdx = prevI + row;
          const slope =
            prevI > 0 && this.pMask[prevIdx]
              ? minmod(field[leftIdx] - field[prevIdx], field[rightIdx] - field[leftIdx])
              : 0;
          phiFace = field[leftIdx] + 0.5 * (1 - cfl) * slope;
        } else {
          const nextI = i + 2 <= N ? i + 2 : this.periodicX ? ((i + 1) % N) + 1 : 0;
          const nextIdx = nextI + row;
          const slope =
            nextI > 0 && this.pMask[nextIdx]
              ? minmod(field[nextIdx] - field[rightIdx], field[rightIdx] - field[leftIdx])
              : 0;
          phiFace = field[rightIdx] - 0.5 * (1 - cfl) * slope;
        }
        fluxBuf[i + row] = vel * phiFace;
      }
      if (this.periodicX) {
        fluxBuf[row] = fluxBuf[N + row];
      }
    }

    tmpBuf.set(field);
    for (let j = 1; j <= N; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= N; i++, idx++) {
        if (!this.pMask[idx]) {
          tmpBuf[idx] = 0;
          continue;
        }
        tmpBuf[idx] = field[idx] - dtOverH * (fluxBuf[idx] - fluxBuf[idx - 1]);
      }
    }

    if (this.periodicX || this.periodicY) {
      syncPeriodicGhostFloat(tmpBuf, N, rs, this.periodicX, this.periodicY);
    }

    // Sweep Y: flussi sulle facce Nord (i, j + 1/2)
    fluxBuf.fill(0);
    for (let j = 0; j <= N; j++) {
      if (j === 0 && !this.periodicY) continue;
      if (j === N && !this.periodicY) continue;
      const botJ = j === 0 ? N : j;
      const topJ = j === N ? 1 : j + 1;
      for (let i = 1; i <= N; i++) {
        const botIdx = i + botJ * rs;
        const topIdx = i + topJ * rs;
        if (!this.pMask[botIdx] || !this.pMask[topIdx]) continue;

        const vel = this.v[i + (j + 1) * rs];
        if (vel === 0) continue;

        const cfl = Math.min(0.95, Math.abs(vel) * dtOverH);
        let phiFace = 0;
        if (vel > 0) {
          const prevJ = j === 1 ? (this.periodicY ? N : 0) : j - 1;
          const prevIdx = i + prevJ * rs;
          const slope =
            prevJ > 0 && this.pMask[prevIdx]
              ? minmod(tmpBuf[botIdx] - tmpBuf[prevIdx], tmpBuf[topIdx] - tmpBuf[botIdx])
              : 0;
          phiFace = tmpBuf[botIdx] + 0.5 * (1 - cfl) * slope;
        } else {
          const nextJ = j + 2 <= N ? j + 2 : this.periodicY ? ((j + 1) % N) + 1 : 0;
          const nextIdx = i + nextJ * rs;
          const slope =
            nextJ > 0 && this.pMask[nextIdx]
              ? minmod(tmpBuf[nextIdx] - tmpBuf[topIdx], tmpBuf[topIdx] - tmpBuf[botIdx])
              : 0;
          phiFace = tmpBuf[topIdx] - 0.5 * (1 - cfl) * slope;
        }
        fluxBuf[i + j * rs] = vel * phiFace;
      }
      if (this.periodicY && j === N) {
        for (let i = 1; i <= N; i++) {
          fluxBuf[i] = fluxBuf[i + N * rs];
        }
      }
    }

    for (let j = 1; j <= N; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= N; i++, idx++) {
        if (!this.pMask[idx]) {
          field[idx] = 0;
          continue;
        }
        const nextVal = tmpBuf[idx] - dtOverH * (fluxBuf[idx] - fluxBuf[idx - rs]);
        field[idx] = nextVal < 0 ? 0 : nextVal > 1 ? 1 : nextVal;
      }
    }
  }

  private advectScalarMacCormack(
    field: Float32Array,
    fwdBuf: Float32Array,
    bwdBuf: Float32Array,
    tmpBuf: Float32Array,
    dt: number,
    h: number
  ): void {
    const N = this.n;
    const rs = this.rowSize;
    const dtOverH = dt / h;

    if (this.periodicX || this.periodicY) {
      syncPeriodicGhostFloat(field, N, rs, this.periodicX, this.periodicY);
    }

    for (let j = 1; j <= N; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= N; i++, idx++) {
        if (!this.pMask[idx]) {
          fwdBuf[idx] = 0;
          continue;
        }
        const vx = 0.5 * (this.u[idx] + this.u[idx + 1]);
        const vy = 0.5 * (this.v[idx] + this.v[idx + rs]);
        const [val] = this.sampleCellScalar(field, i - dtOverH * vx, j - dtOverH * vy);
        fwdBuf[idx] = val;
      }
    }

    if (this.periodicX || this.periodicY) {
      syncPeriodicGhostFloat(fwdBuf, N, rs, this.periodicX, this.periodicY);
    }

    for (let j = 1; j <= N; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= N; i++, idx++) {
        if (!this.pMask[idx]) {
          bwdBuf[idx] = 0;
          continue;
        }
        const vx = 0.5 * (this.u[idx] + this.u[idx + 1]);
        const vy = 0.5 * (this.v[idx] + this.v[idx + rs]);
        const [val] = this.sampleCellScalar(fwdBuf, i + dtOverH * vx, j + dtOverH * vy);
        bwdBuf[idx] = val;
      }
    }

    for (let j = 1; j <= N; j++) {
      let idx = 1 + j * rs;
      for (let i = 1; i <= N; i++, idx++) {
        if (!this.pMask[idx]) {
          tmpBuf[idx] = 0;
          continue;
        }
        const vx = 0.5 * (this.u[idx] + this.u[idx + 1]);
        const vy = 0.5 * (this.v[idx] + this.v[idx + rs]);
        const [fwd, minV, maxV] = this.sampleCellScalar(field, i - dtOverH * vx, j - dtOverH * vy);
        const corr = fwd + 0.5 * (field[idx] - bwdBuf[idx]);
        const clamped = corr < minV ? minV : corr > maxV ? maxV : corr;
        tmpBuf[idx] = clamped < 0 ? 0 : clamped > 1 ? 1 : clamped;
      }
    }

    field.set(tmpBuf);
  }

  public computeTracerMassIntegral(config: FluidConfig): number {
    const h = this.getCellSizeMeters(config);
    const cellArea = h * h;
    let sum = 0;
    for (let j = 1; j <= this.n; j++) {
      let idx = 1 + j * this.rowSize;
      for (let i = 1; i <= this.n; i++, idx++) {
        if (this.pMask[idx]) sum += this.dye[idx];
      }
    }
    return sum * cellArea;
  }

  private computeDyeVariance(): number {
    let sum = 0;
    let sumSq = 0;
    const count = this.fluidCellCount || 1;
    for (let j = 1; j <= this.n; j++) {
      let idx = 1 + j * this.rowSize;
      for (let i = 1; i <= this.n; i++, idx++) {
        if (!this.pMask[idx]) continue;
        const c = this.dye[idx];
        sum += c;
        sumSq += c * c;
      }
    }
    const mean = sum / count;
    return Math.max(0, sumSq / count - mean * mean);
  }

  private extrapolateRim(field: Float32Array): void {
    const targets = this.rimTargetIndices;
    const sources = this.rimSourceIndices;
    for (let k = 0; k < targets.length; k++) {
      field[targets[k]] = field[sources[k]];
    }
  }

  public prepareRenderFields(mode: VisualizationMode): ScaleRange {
    const N = this.n;
    const rs = this.rowSize;
    this.scalarA.fill(0);
    this.scalarB.fill(0);

    if (mode === 'fluid') {
      for (let j = 1; j <= N; j++) {
        let idx = 1 + j * rs;
        for (let i = 1; i <= N; i++, idx++) {
          if (!this.pMask[idx]) continue;
          const w = this.wake[idx];
          const s = this.speedField[idx] * 0.55;
          const groove = Math.min(1, w * 0.92 + (1 - w) * Math.min(0.45, s) * 0.28);
          const sheen = Math.min(1, Math.min(1.5, this.shearRate[idx] * 0.025) * 0.35 + w * 0.5);
          this.scalarA[idx] = groove;
          this.scalarB[idx] = sheen;
        }
      }
      this.extrapolateRim(this.scalarA);
      this.extrapolateRim(this.scalarB);
    } else if (mode === 'velocity') {
      let instMax = 0.08;
      for (let j = 1; j <= N; j++) {
        let idx = 1 + j * rs;
        for (let i = 1; i <= N; i++, idx++) {
          if (this.pMask[idx] && this.speedField[idx] > instMax) instMax = this.speedField[idx];
        }
      }
      this.emaMaxSpeed = Math.max(0.1, this.emaMaxSpeed * 0.9 + instMax * 0.1);
      const invMax = 1 / this.emaMaxSpeed;
      for (let j = 1; j <= N; j++) {
        let idx = 1 + j * rs;
        for (let i = 1; i <= N; i++, idx++) {
          if (!this.pMask[idx]) continue;
          const v = this.speedField[idx] * invMax;
          this.scalarA[idx] = v > 1 ? 1 : v;
        }
      }
      this.extrapolateRim(this.scalarA);
    } else if (mode === 'vorticity') {
      let instMax = 6.0;
      for (let j = 1; j <= N; j++) {
        let idx = 1 + j * rs;
        for (let i = 1; i <= N; i++, idx++) {
          if (this.pMask[idx] && this.absVort[idx] > instMax) instMax = this.absVort[idx];
        }
      }
      this.emaMaxVort = Math.max(6, this.emaMaxVort * 0.9 + instMax * 0.1);
      const invTwoMax = 0.5 / this.emaMaxVort;
      for (let j = 1; j <= N; j++) {
        let idx = 1 + j * rs;
        for (let i = 1; i <= N; i++, idx++) {
          if (!this.pMask[idx]) {
            this.scalarA[idx] = 0.5;
            continue;
          }
          const norm = 0.5 + this.vorticity[idx] * invTwoMax;
          this.scalarA[idx] = norm < 0 ? 0 : norm > 1 ? 1 : norm;
        }
      }
      this.extrapolateRim(this.scalarA);
    } else {
      let instMax = 1.5;
      for (let j = 1; j <= N; j++) {
        let idx = 1 + j * rs;
        for (let i = 1; i <= N; i++, idx++) {
          if (this.pMask[idx] && this.shearStress[idx] > instMax) instMax = this.shearStress[idx];
        }
      }
      this.emaMaxShear = Math.max(1.5, this.emaMaxShear * 0.9 + instMax * 0.1);
      const invMax = 1 / this.emaMaxShear;
      for (let j = 1; j <= N; j++) {
        let idx = 1 + j * rs;
        for (let i = 1; i <= N; i++, idx++) {
          if (!this.pMask[idx]) continue;
          const v = this.shearStress[idx] * invMax;
          this.scalarA[idx] = v > 1 ? 1 : v;
        }
      }
      this.extrapolateRim(this.scalarA);
    }

    return this.getActiveScaleRange(mode);
  }

  public packRenderBytes(outBytes: Uint8Array, mode: VisualizationMode): void {
    const N = this.n;
    const rs = this.rowSize;
    const a = this.scalarA;
    const b = this.scalarB;
    const isFluid = mode === 'fluid';

    for (let j = 1; j <= N; j++) {
      let idx = 1 + j * rs;
      let out = (j - 1) * N * 4;
      for (let i = 1; i <= N; i++, idx++, out += 4) {
        outBytes[out] = (a[idx] * 255 + 0.5) | 0;
        outBytes[out + 1] = isFluid ? (b[idx] * 255 + 0.5) | 0 : 0;
        outBytes[out + 2] = 0;
        outBytes[out + 3] = 255;
      }
    }
  }

  public packVectorSamples(outVecs: Float32Array, stride = 6): number {
    const N = this.n;
    const rs = this.rowSize;
    let count = 0;
    const maxCount = (outVecs.length / 4) | 0;
    for (let j = 3; j <= N - 2; j += stride) {
      for (let i = 3; i <= N - 2; i += stride) {
        if (count >= maxCount) return count;
        const idx = i + j * rs;
        if (!this.pMask[idx]) continue;
        const uc = 0.5 * (this.u[idx] + this.u[idx + 1]);
        const vc = 0.5 * (this.v[idx] + this.v[idx + rs]);
        const sp = Math.hypot(uc, vc);
        if (sp < 0.005) continue;
        const off = count * 4;
        outVecs[off] = (i - 0.5) / N;
        outVecs[off + 1] = (j - 0.5) / N;
        outVecs[off + 2] = uc;
        outVecs[off + 3] = vc;
        count++;
      }
    }
    return count;
  }

  public getActiveScaleRange(mode: VisualizationMode): ScaleRange {
    if (mode === 'velocity') {
      return {
        min: 0,
        mid: this.emaMaxSpeed * 0.5,
        max: this.emaMaxSpeed,
        unit: 'm/s',
        label: 'Modulo Velocità |u|',
      };
    }
    if (mode === 'vorticity') {
      return {
        min: -this.emaMaxVort,
        mid: 0,
        max: this.emaMaxVort,
        unit: 's⁻¹',
        label: 'Vorticità ω',
      };
    }
    if (mode === 'shear') {
      return {
        min: 0,
        mid: this.emaMaxShear * 0.5,
        max: this.emaMaxShear,
        unit: 'Pa',
        label: 'Sforzo di Taglio τ',
      };
    }
    return {
      min: 0,
      mid: 50,
      max: 100,
      unit: '',
      label: 'Moto del Fluido',
    };
  }

  public sampleProbe(xNorm: number, yNorm: number, config: FluidConfig): ProbeSample {
    const i = Math.round(xNorm * this.n + 0.5);
    const j = Math.round(yNorm * this.n + 0.5);
    if (i < 1 || i > this.n || j < 1 || j > this.n) {
      return {
        active: false,
        rMm: 0,
        xMm: 0,
        yMm: 0,
        speedMs: 0,
        shearRate: 0,
        shearStressPa: 0,
        apparentViscosityMpas: config.viscosityMpas,
        vorticity: 0,
      };
    }

    const idx = i + j * this.rowSize;
    if (!this.pMask[idx]) {
      return {
        active: false,
        rMm: 0,
        xMm: 0,
        yMm: 0,
        speedMs: 0,
        shearRate: 0,
        shearStressPa: 0,
        apparentViscosityMpas: config.viscosityMpas,
        vorticity: 0,
      };
    }

    const hMm = this.getCellSizeMeters(config) * 1000;
    const xMm = (i - this.midGrid) * hMm;
    const yMm = (this.midGrid - j) * hMm;
    const rMm = Math.hypot(xMm, yMm);

    return {
      active: true,
      rMm,
      xMm,
      yMm,
      speedMs: this.speedField[idx],
      shearRate: this.shearRate[idx],
      shearStressPa: this.shearStress[idx],
      apparentViscosityMpas: this.muApp[idx] * 1000,
      vorticity: this.vorticity[idx],
    };
  }

  public getDiagnostics(renderFps = 0, solverUps = 0): ExactDiagnosticsReport {
    let sumSpeedSq = 0;
    for (let j = 1; j <= this.n; j++) {
      let idx = 1 + j * this.rowSize;
      for (let i = 1; i <= this.n; i++, idx++) {
        if (!this.pMask[idx]) continue;
        const sp = this.speedField[idx];
        sumSpeedSq += sp * sp;
      }
    }
    const keJKg = 0.5 * (sumSpeedSq / (this.fluidCellCount || 1));

    return {
      renderFps,
      solverUps,
      dtPhysSec: this.lastDtPhysSec,
      simulatedTimeSec: this.elapsedSec,
      gridN: this.n,
      courantNumber: this.lastCourant,
      divRms: this.lastDivRmsNorm,
      divMax: this.lastDivMaxNorm,
      divRmsRaw: this.lastDivRmsRaw,
      netBoundaryFlux: this.lastNetBoundaryFlux,
      diffusionResidual: this.lastDiffResidual,
      pressureResidual: this.lastPressResidual,
      picardIterations: this.lastPicardIter,
      picardResidual: this.lastPicardResidual,
      convergenceStatus: this.lastConvergenceStatus,
      substepsLastStep: this.lastSubsteps,
      timeDilationRatio: this.lastTimeDilation,
      rollbacksCount: this.rollbacksCount,
      sgsMeanViscosityMpas: this.lastSgsMeanPas * 1000,
      sgsMaxViscosityMpas: this.lastSgsMaxPas * 1000,
      numericalViscosityClampedCount: this.lastClampedCount,
      tracerMassIntegral: 0,
      kineticEnergyJKg: keJKg,
    };
  }

  public getMetrics(
    config: FluidConfig,
    scaleRange: ScaleRange,
    renderFps = 0,
    solverUps = 0
  ): SimulationMetrics {
    const count = this.fluidCellCount || 1;
    let maxSpeed = 0;
    let sumShear = 0;
    let maxShearRate = 0;
    let maxShearStress = 0;
    let sumMuWeighted = 0;
    let weightSum = 0;
    let sumMuAll = 0;
    let sumSpeedSq = 0;

    for (let j = 1; j <= this.n; j++) {
      let idx = 1 + j * this.rowSize;
      for (let i = 1; i <= this.n; i++, idx++) {
        if (!this.pMask[idx]) continue;
        const sp = this.speedField[idx];
        if (sp > maxSpeed) maxSpeed = sp;

        sumSpeedSq += sp * sp;
        const g = this.shearRate[idx];
        sumShear += g;
        if (g > maxShearRate) maxShearRate = g;
        if (this.shearStress[idx] > maxShearStress) maxShearStress = this.shearStress[idx];

        const muLocal = this.muApp[idx];
        sumMuAll += muLocal;
        if (g > 0.05) {
          sumMuWeighted += muLocal * g;
          weightSum += g;
        }
      }
    }

    const meanShearRate = sumShear / count;
    const meanMuPaS = sumMuAll / count;
    const effMuRefPaS = weightSum > 1e-9 ? sumMuWeighted / weightSum : meanMuPaS;

    // Definizione documentata di Re: rho * U_max * L_asta / mu_eff_attiva (Re = 0 se fermo)
    const charLengthM = Math.max(0.005, config.stirrerDiameterMm * 0.001);
    const reynolds =
      maxSpeed > 1e-7
        ? (config.densityKgM3 * maxSpeed * charLengthM) / Math.max(1e-7, effMuRefPaS)
        : 0;

    let regime: SimulationMetrics['regime'] = 'Laminare';
    if (reynolds <= 1e-6) {
      regime = 'Fermo';
    } else if (reynolds < 1) {
      regime = 'Stokes / Creeping';
    } else if (reynolds < 2300) {
      regime = 'Laminare';
    } else if (reynolds < 4000) {
      regime = 'Transizione';
    } else {
      regime = 'Turbolento';
    }

    const variance = this.computeDyeVariance();
    const intensityOfSegregation = Math.min(1, variance / Math.max(1e-6, this.refVariance));
    const mixingIndex = Math.max(
      0,
      Math.min(100, (1 - Math.sqrt(intensityOfSegregation)) * 100)
    );
    const kineticEnergyMjKg = 0.5 * (sumSpeedSq / count) * 1000;

    const diagnostics = this.getDiagnostics(renderFps, solverUps);
    diagnostics.tracerMassIntegral = this.computeTracerMassIntegral(config);

    return {
      elapsedSec: this.elapsedSec,
      reynolds,
      regime,
      maxSpeedMs: maxSpeed,
      meanShearRate,
      maxShearRate,
      maxShearStressPa: maxShearStress,
      effectiveViscosityMpas: meanMuPaS * 1000,
      sgsMeanViscosityMpas: this.lastSgsMeanPas * 1000,
      mixingIndex,
      kineticEnergyMjKg,
      scaleRange,
      diagnostics,
    };
  }
}

function syncGalerkinAndComputeDiag(
  levels: GalerkinLevel[],
  l0: GalerkinLevel,
  N: number,
  rs: number,
  periodicX: boolean,
  periodicY: boolean
): void {
  coarsenGalerkinHierarchy(levels, periodicX, periodicY);
  for (let j = 1; j <= N; j++) {
    let idx = 1 + j * rs;
    for (let i = 1; i <= N; i++, idx++) {
      if (!l0.active[idx]) {
        l0.diag[idx] = 1;
        continue;
      }
      l0.diag[idx] =
        l0.selfDiag[idx] +
        l0.cE[idx - 1] +
        l0.cE[idx] +
        l0.cN[idx - rs] +
        l0.cN[idx];
    }
  }
  coarsenGalerkinHierarchy(levels, periodicX, periodicY);
}
