import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { divergenceRms, forEachVelocityFace, seedPressureGradient } from './cfd-fixtures.mjs';
import { createTrBdf2Stage } from './cfd-integrators.mjs';
import { stressDivergenceAt } from './cfd-stress-stencil.mjs';

const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
  appType: 'custom',
});
after(() => vite.close());
const { CFDEngine } = await vite.ssrLoadModule('/src/simulation/cfdEngine.ts');
const { DEFAULT_FLUID_CONFIG, FLUID_PRESETS, computeApparentViscosityPaS, computeShearStressPa } =
  await vite.ssrLoadModule('/src/constants/fluids.ts');
const { PointerPath, SIMULATION_STEP_SEC, SimulationClock } =
  await vite.ssrLoadModule('/src/simulation/simulationClock.ts');
const metrics = (engine, config) => engine.getMetrics(config, engine.getActiveScaleRange('fluid'));
const dyeMass = (engine) => engine.dye.reduce((sum, concentration) => sum + concentration, 0);

test('water and Herschel–Bulkley fluid have zero strain, stress and Reynolds at rest', () => {
  for (const preset of [DEFAULT_FLUID_CONFIG, FLUID_PRESETS.find(({ id }) => id === 'ketchup')]) {
    const config = { ...DEFAULT_FLUID_CONFIG, ...preset };
    const engine = new CFDEngine();
    const originalMass = dyeMass(engine);
    engine.step(SIMULATION_STEP_SEC, config);
    const result = metrics(engine, config);
    assert.equal(result.reynolds, 0);
    assert.equal(result.maxShearRate, 0);
    assert.equal(result.maxShearStressPa, 0);
    assert.equal(computeShearStressPa(0, config), 0);
    assert.ok(computeShearStressPa(1e-9, config) < 1e-5);
    assert.equal(dyeMass(engine), originalMass);
  }
});

function demoPoint(seconds) {
  return [0.5 + 0.2 * Math.cos(seconds * 5), 0.5 + 0.2 * Math.sin(seconds * 5)];
}

function runDemo(refreshRate) {
  const config = DEFAULT_FLUID_CONFIG;
  const engine = new CFDEngine();
  const clock = new SimulationClock(0);
  const initialMass = dyeMass(engine);
  let steps = 0;
  for (let frame = 1; frame <= 2 * refreshRate; frame++) {
    clock.advance((frame * 1000) / refreshRate, () => {
      if (steps < 90) {
        engine.applyStirrerImpulse(
          ...demoPoint(steps * SIMULATION_STEP_SEC),
          ...demoPoint((steps + 1) * SIMULATION_STEP_SEC),
          SIMULATION_STEP_SEC,
          config,
        );
      }
      engine.step(SIMULATION_STEP_SEC, config);
      steps++;
    });
  }
  const massError = Math.abs(dyeMass(engine) / initialMass - 1);
  return { steps, massError, ...metrics(engine, config) };
}

test('a fixed benchmark trajectory is independent of drawing frequency and conserves tracer mass', (context) => {
  const reference = runDemo(60);
  assert.equal(reference.steps, 120);
  assert.ok(Math.abs(reference.elapsedSec - 2) < 1e-9);
  assert.ok(reference.maxSpeedMs > 0);
  assert.ok(reference.massError <= 0.001, `Tracer mass error: ${reference.massError}`);
  context.diagnostic(`Relative tracer mass drift: ${(reference.massError * 100).toExponential(2)}%`);
  for (const refreshRate of [20, 30, 120]) {
    assert.deepEqual(runDemo(refreshRate), reference);
  }
});

test('timestamped pointer input interpolates positions and ends at release', () => {
  const path = new PointerPath();
  path.push({ timeMs: 5, x: 0.25, y: 0.5, kind: 'down' });
  path.push({ timeMs: 25, x: 0.75, y: 0.5, kind: 'move' });
  path.push({ timeMs: 35, x: 0.75, y: 0.75, kind: 'up' });
  assert.equal(path.sample(0), undefined);
  assert.deepEqual(path.sample(15), [0.25, 0.5, 0.5, 0.5]);
  assert.deepEqual(path.sample(35), [0.5, 0.5, 0.75, 0.75]);
  assert.equal(path.sample(50), undefined);
  assert.equal(path.hasPendingInput, false);
});

test('the local kinematics match a manufactured linear shear field', () => {
  const config = DEFAULT_FLUID_CONFIG;
  const engine = new CFDEngine();
  const h = engine.getCellSizeMeters(config);
  const shear = 2;
  for (let index = 0; index < engine.u.length; index++) {
    const row = Math.floor(index / engine.rowSize);
    if (engine.uMask[index]) engine.u[index] = shear * h * (row - engine.midGrid);
  }
  engine.computeKinematicsAndRheology(h, config);
  const center = engine.sampleProbe(0.5, 0.5, config);
  assert.ok(Math.abs(center.shearRate - shear) < 1e-6);
  assert.ok(Math.abs(center.shearStressPa - 0.002) < 1e-8);
});

test('pressure projection removes at least 99% of a discrete gradient divergence', () => {
  const config = DEFAULT_FLUID_CONFIG;
  for (const size of [48, 96, 192]) {
    const engine = new CFDEngine(size);
    const h = engine.getCellSizeMeters(config);
    seedPressureGradient(engine, h);
    const before = divergenceRms(engine, h);
    engine.projectPressureGalerkin(SIMULATION_STEP_SEC, h, config.densityKgM3, true);
    assert.ok(before > 1);
    const remaining = divergenceRms(engine, h) / before;
    assert.ok(remaining <= 0.01, `Grid ${size}: remaining divergence ratio ${remaining}`);
  }
});

test('TR-BDF2 integrates an affine viscous step and restores the original rod weights', () => {
  const engine = {
    u: Float32Array.of(0.4),
    v: Float32Array.of(0),
    uRodWeight: Float32Array.of(0.5),
    vRodWeight: Float32Array.of(0),
  };
  const dt = 0.2;
  const lambda = -3 - engine.uRodWeight[0] / dt;
  const source = 0.75 * engine.uRodWeight[0] / dt;
  const initial = engine.u[0];
  const fraction = 2 - Math.SQRT2;
  const stage = (initial + fraction * dt * (lambda * initial / 2 + source)) /
    (1 - fraction * dt * lambda / 2);
  const expected = (stage - (1 - fraction) ** 2 * initial + fraction * (1 - fraction) * dt * source) /
    (fraction * (2 - fraction - (1 - fraction) * dt * lambda));
  createTrBdf2Stage(engine)(dt, (implicitTime) => {
    engine.u[0] = (engine.u[0] + 0.75 * engine.uRodWeight[0]) /
      (1 + 3 * implicitTime + engine.uRodWeight[0]);
  });
  assert.ok(Math.abs(engine.u[0] - expected) < 1e-7);
  assert.equal(engine.uRodWeight[0], 0.5);
});

test('the interior stress stencil includes the transverse stress from a viscosity gradient', () => {
  const engine = new CFDEngine(48);
  const h = engine.getCellSizeMeters(DEFAULT_FLUID_CONFIG);
  for (let i = 0; i < engine.muApp.length; i++) {
    engine.muApp[i] = 1 + 5 * (i % engine.rowSize - engine.midGrid) * h;
  }
  forEachVelocityFace(engine, (field, i, _x, y, component) => {
    field[i] = component === 0 ? 2 * y * h : 0;
  });
  const center = Math.round(engine.midGrid);
  const transverseStress = stressDivergenceAt(engine, h, center * engine.rowSize + center, 1);
  assert.ok(Math.abs(transverseStress - 10) < 1e-4);
  engine.solveStressDiffusion(0.0001, h, 1000, false, 24);
  assert.ok(Math.abs(engine.v[center * engine.rowSize + center] / 0.0001 - 0.01) < 1e-5);
});

test('the rod footprint stays inside the tank and its penalty scales with the time step', () => {
  const config = { ...DEFAULT_FLUID_CONFIG, viscosityMpas: 500000 };
  const engine = new CFDEngine(48);
  const h = engine.getCellSizeMeters(config);
  const dt = SIMULATION_STEP_SEC;
  engine.applyStirrerImpulse(1, 0.5, 1.03, 0.51, dt, config);
  const rod = engine.stirrer;
  assert.ok(Math.hypot(rod.gx1 - engine.midGrid, rod.gy1 - engine.midGrid) + rod.rodRadiusGrid <= engine.tankRadiusGrid + 1e-10);
  engine.muApp.fill(500);
  const alpha = dt / (config.densityKgM3 * h ** 2);
  engine.buildStirrerPenaltyWeights(alpha, dt);
  const full = engine.uRodWeight.slice();
  engine.buildStirrerPenaltyWeights(alpha / 2, dt / 2);
  assert.ok(full.some((weight) => weight > 0));
  for (let i = 0; i < full.length; i++) assert.equal(engine.uRodWeight[i], full[i] / 2);
});

test('high Newtonian viscosity is retained and free sub-frame decay leaves no artificial pressure tail', () => {
  for (const viscosityMpas of [500000, 5000000]) {
    const config = { ...DEFAULT_FLUID_CONFIG, viscosityMpas };
    assert.equal(computeApparentViscosityPaS(1, config), viscosityMpas / 1000);
    const engine = new CFDEngine(48);
    const h = engine.getCellSizeMeters(config);
    const dt = SIMULATION_STEP_SEC;
    for (let i = 0; i < 8; i++) {
      engine.applyStirrerImpulse(...demoPoint(i * dt), ...demoPoint((i + 1) * dt), dt, config);
      engine.step(dt, config);
    }
    const before = metrics(engine, config);
    assert.ok(before.maxSpeedMs > 0.05 && before.maxSpeedMs < 0.5);
    assert.ok(divergenceRms(engine, h) < 0.03);
    engine.step(dt, config);
    const after = metrics(engine, config);
    assert.ok(after.kineticEnergyMjKg < before.kineticEnergyMjKg * 0.002);
  }
});
