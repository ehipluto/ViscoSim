export type RheologyModel = 'newtonian' | 'power-law' | 'herschel-bulkley';

export type VisualizationMode = 'fluid' | 'velocity' | 'vorticity' | 'shear';

export type QualityLevel = 'low' | 'standard' | 'high';

export type DomainType = 'cylindrical-tank' | 'channel-x' | 'periodic-box';

export type ConvergenceStatus =
  | 'converged'
  | 'under-relaxed'
  | 'rollback-recovered'
  | 'load-shedding';

export interface FluidConfig {
  presetId: string | null;
  name: string;
  model: RheologyModel;
  viscosityMpas: number;
  flowIndex: number;
  yieldStressPa: number;
  papanastasiouM: number;
  densityKgM3: number;
  tankDiameterMm: number;
  stirrerDiameterMm: number;
  color: string;
  enableSmagorinsky: boolean;
  smagorinskyCs: number;
  quality: QualityLevel;
}

export interface FluidPreset {
  id: string;
  name: string;
  category: string;
  model: RheologyModel;
  viscosityMpas: number;
  flowIndex: number;
  yieldStressPa: number;
  papanastasiouM: number;
  densityKgM3: number;
  color: string;
  description: string;
}

export interface ProbeSample {
  active: boolean;
  rMm: number;
  xMm: number;
  yMm: number;
  speedMs: number;
  shearRate: number;
  shearStressPa: number;
  apparentViscosityMpas: number;
  vorticity: number;
}

export interface ScaleRange {
  min: number;
  mid: number;
  max: number;
  unit: string;
  label: string;
}

export interface TimeSeriesPoint {
  timeSec: number;
  mixingIndex: number;
  kineticEnergyMjKg: number;
}

export interface DiagnosticsSnapshot {
  renderFps: number;
  solverUps: number;
  dtPhysSec: number;
  simulatedTimeSec: number;
  gridN: number;
  courantNumber: number;
  divRms: number;
  divMax: number;
  divRmsRaw: number;
  netBoundaryFlux: number;
  diffusionResidual: number;
  pressureResidual: number;
  picardIterations: number;
  picardResidual: number;
  convergenceStatus: ConvergenceStatus;
  substepsLastStep: number;
  timeDilationRatio: number;
  rollbacksCount: number;
  sgsMeanViscosityMpas: number;
  sgsMaxViscosityMpas: number;
  numericalViscosityClampedCount: number;
}

export interface SimulationMetrics {
  elapsedSec: number;
  reynolds: number;
  regime: 'Fermo' | 'Stokes / Creeping' | 'Laminare' | 'Transizione' | 'Turbolento';
  maxSpeedMs: number;
  meanShearRate: number;
  maxShearRate: number;
  maxShearStressPa: number;
  effectiveViscosityMpas: number;
  sgsMeanViscosityMpas: number;
  mixingIndex: number;
  kineticEnergyMjKg: number;
  scaleRange: ScaleRange;
  diagnostics: DiagnosticsSnapshot;
}

export interface InteractionEvent {
  type?: 'stir' | 'reset';
  stepIndex: number;
  tSimSec: number;
  dtSec: number;
  x0Norm: number;
  y0Norm: number;
  x1Norm: number;
  y1Norm: number;
}

export interface PersistedConfigV2 {
  schemaVersion: 2;
  units: {
    viscosity: 'mPa*s';
    yieldStress: 'Pa';
    papanastasiouM: 's';
    density: 'kg/m^3';
    length: 'mm';
  };
  config: FluidConfig;
}

export interface InteractionTraceV2 {
  schemaVersion: 2;
  solverVersion: string;
  gridN: number;
  seed: number;
  exportedAt: string;
  initialConfig: FluidConfig;
  events: InteractionEvent[];
  note: string;
}

export interface ConfigValidationResult {
  ok: boolean;
  config?: FluidConfig;
  warnings: string[];
  error?: string;
}
