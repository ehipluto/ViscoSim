export type RheologyModel = 'newtonian' | 'power-law' | 'herschel-bulkley';

export type VisualizationMode = 'fluid' | 'velocity' | 'vorticity' | 'shear';

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
  kineticEnergyMjKg: number;
}

export interface SimulationMetrics {
  elapsedSec: number;
  reynolds: number;
  maxSpeedMs: number;
  meanShearRate: number;
  maxShearRate: number;
  maxShearStressPa: number;
  effectiveViscosityMpas: number;
  mixingIndex: number;
  kineticEnergyMjKg: number;
  scaleRange: ScaleRange;
  stressSolveResidual: number;
}
