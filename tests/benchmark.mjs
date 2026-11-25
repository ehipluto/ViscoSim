import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { forEachVelocityFace, divergenceRms, seedPressureGradient } from './cfd-fixtures.mjs';
import { createTrBdf2Stage, useLegacyConfinement, overrideNewtonianIntegrator } from './cfd-integrators.mjs';
import { stressDivergenceAt } from './cfd-stress-stencil.mjs';

const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
  appType: 'custom',
});

try {
  const { CFDEngine } = await vite.ssrLoadModule('/src/simulation/cfdEngine.ts');
  const { DEFAULT_FLUID_CONFIG, FLUID_PRESETS } = await vite.ssrLoadModule('/src/constants/fluids.ts');
  const base = { ...DEFAULT_FLUID_CONFIG, densityKgM3: 1000 };
  const gridSizes = [48, 96, 192];
  const wallClock = process.argv.includes('--timing');

  // Benchmark harness reads solver buffers directly. These are internal state, not public UI diagnostics.
  const j11 = 3.8317059702075125;
  const swirlViscosityMpas = 30000;
  const swirlDurationSec = 1 / 30;
  const trBdf2Gamma = 2 - Math.SQRT2;
  function besselJ1(x) {
    let term = x / 2;
    let sum = term;
    for (let k = 1; k <= 20; k++) {
      term *= -(x * x) / (4 * k * (k + 1));
      sum += term;
    }
    return sum;
  }

  function swirl(n, hz, integrator = 'application', viscosityMpas = swirlViscosityMpas, endTime = swirlDurationSec) {
    const config = { ...base, viscosityMpas };
    const engine = new CFDEngine(n);
    const h = engine.getCellSizeMeters(config);
    const radius = engine.tankRadiusGrid * h;
    const viscosity = config.viscosityMpas / (1000 * config.densityKgM3);
    const steps = Math.round(endTime * hz);
    const referenceDecay = Math.exp(-viscosity * (j11 / radius) ** 2 * endTime);
    const initial = (x, y, component) => {
      const r = Math.hypot(x, y);
      return r === 0 ? 0 : 0.02 * besselJ1(j11 * r / engine.tankRadiusGrid) * (component === 0 ? -y : x) / r;
    };
    forEachVelocityFace(engine, (field, i, x, y, component) => { field[i] = initial(x, y, component); });
    const dt = endTime / steps;
    const diffuse = (duration) =>
      engine.solveDiffusionGalerkin(duration, h, config.densityKgM3, false, 24, 1e-10);
    const trBdf2Stage = integrator === 'TR-BDF2' ? createTrBdf2Stage(engine) : null;
    const project = () => engine.projectPressureGalerkin(dt, h, config.densityKgM3, false, 24, 1e-10);
    engine.computeKinematicsAndRheology(h, config);
    for (let i = 0; i < steps; i++) {
      if (integrator === 'application') {
        engine.step(dt, config);
      } else if (integrator === 'backwardEuler') {
        diffuse(dt);
        project();
      } else {
        trBdf2Stage(dt, diffuse);
        project();
      }
    }

    let errorSq = 0;
    let refSq = 0;
    let wallErrorSq = 0;
    let wallRefSq = 0;
    forEachVelocityFace(engine, (field, i, x, y, component) => {
      const expected = referenceDecay * initial(x, y, component);
      errorSq += (field[i] - expected) ** 2;
      refSq += expected ** 2;
      if (Math.hypot(x, y) >= 0.85 * engine.tankRadiusGrid) {
        wallErrorSq += (field[i] - expected) ** 2;
        wallRefSq += expected ** 2;
      }
    });
    return {
      grid: n, hz, integrator,
      profileErrorPct: 100 * Math.sqrt(errorSq / refSq),
      errorAsPctOfInitialSpeed: 100 * Math.sqrt(errorSq / refSq) * referenceDecay,
      outerRingErrorPct: 100 * Math.sqrt(wallErrorSq / wallRefSq),
      divergenceRmsPerSec: divergenceRms(engine, h),
    };
  }

  function compareTimeIntegrators() {
    const radius = base.tankDiameterMm / 2000;
    const nu = swirlViscosityMpas / (1000 * base.densityKgM3);
    const lambda = -nu * (j11 / radius) ** 2;
    const exact = Math.exp(lambda * swirlDurationSec);
    const gamma = trBdf2Gamma;
    return [60, 120, 240, 600].map((hz) => {
      const steps = Math.round(swirlDurationSec * hz);
      const z = lambda * swirlDurationSec / steps;
      const backwardEuler = 1 / (1 - z);
      const midpointRatio = (1 + gamma * z / 2) / (1 - gamma * z / 2);
      const trBdf2 =
        (midpointRatio - (1 - gamma) ** 2) / (gamma * (2 - gamma - (1 - gamma) * z));
      const errorPct = (ratio) => 100 * Math.abs(ratio ** steps / exact - 1);
      return { hz, backwardEulerErrorPct: errorPct(backwardEuler), trBdf2ErrorPct: errorPct(trBdf2) };
    });
  }

  function pressureProjection(n, iterations = 5) {
    const engine = new CFDEngine(n);
    const h = engine.getCellSizeMeters(base);
    seedPressureGradient(engine, h);
    const before = divergenceRms(engine, h);
    if (iterations === 'default') engine.projectPressureGalerkin(1 / 60, h, base.densityKgM3, true);
    else engine.projectPressureGalerkin(1 / 60, h, base.densityKgM3, true, iterations, 1e-7);
    const after = divergenceRms(engine, h);
    let residualSpeed = 0;
    forEachVelocityFace(engine, (field, i) => { residualSpeed = Math.max(residualSpeed, Math.abs(field[i])); });
    return { grid: n, iterations, beforeRmsPerSec: before, afterRmsPerSec: after, remainingPct: 100 * after / before, maxResidualMs: residualSpeed };
  }

  function stressTensor() {
    const engine = new CFDEngine();
    const h = engine.getCellSizeMeters(base);
    const gamma = 2;
    const viscosityGradient = 5;
    const dt = 0.0001;
    for (let i = 0; i < engine.muApp.length; i++) {
      const x = (i % engine.rowSize - engine.midGrid) * h;
      engine.muApp[i] = 1 + viscosityGradient * x;
    }
    forEachVelocityFace(engine, (field, i, _x, y, component) => { field[i] = component === 0 ? gamma * y * h : 0; });
    engine.solveDiffusionGalerkin(dt, h, base.densityKgM3, false, 20, 1e-10);
    const center = Math.round(engine.midGrid);
    const scalarCross = engine.v[center + center * engine.rowSize] / dt;
    forEachVelocityFace(engine, (field, i, _x, y, component) => { field[i] = component === 0 ? gamma * y * h : 0; });
    engine.solveStressDiffusion(dt, h, base.densityKgM3, false, 24);
    // u=γ y, v=0 and μ=μ0+β x. The y component of div(μ(grad u+grad uᵀ)) is βγ.
    return {
      expectedCrossAccelerationMs2: gamma * viscosityGradient / base.densityKgM3,
      scalarCrossAccelerationMs2: scalarCross,
      actualCrossAccelerationMs2: engine.v[center + center * engine.rowSize] / dt,
      remainingRelativeResidual: engine.getStressSolveResidual(),
    };
  }

  function stressStencil(n) {
    const engine = new CFDEngine(n);
    const h = engine.getCellSizeMeters(base);
    const a = 3;
    const beta = 5;
    // u=a*x^2, v=-2*a*x*y is divergence-free. Here μ=1+β*y is positive in the entire tank.
    for (let i = 0; i < engine.muApp.length; i++) {
      const y = (Math.floor(i / engine.rowSize) - engine.midGrid) * h;
      engine.muApp[i] = 1 + beta * y;
    }
    forEachVelocityFace(engine, (field, i, x, y, component) => {
      field[i] = component === 0 ? a * (x * h) ** 2 : -2 * a * x * y * h ** 2;
    });
    let discrepancy = 0;
    let norm = 0;
    forEachVelocityFace(engine, (_field, i, x, y, component) => {
      if (Math.hypot(x, y) > engine.tankRadiusGrid * 0.7) return;
      const exact = component === 0 ? 2 * a : -4 * a * beta * x * h;
      discrepancy += (stressDivergenceAt(engine, h, i, component) - exact) ** 2;
      norm += exact ** 2;
    });
    const relativeErrorPct = 100 * Math.sqrt(discrepancy / norm);
    assert.ok(relativeErrorPct < 0.02, 'Manufactured tensor stencil: unexpected interior error');
    return { grid: n, relativeErrorPct };
  }

  const trajectory = (t) => [0.5 + 0.2 * Math.cos(5 * t), 0.5 + 0.2 * Math.sin(5 * t)];
  function stirredTank(id, config, hz, n = 96, options = {}) {
    const engine = new CFDEngine(n);
    const dt = 1 / hz;
    const h = engine.getCellSizeMeters(config);
    if (options.integrator) overrideNewtonianIntegrator(engine, options.integrator);
    if (options.legacyConfinement) {
      useLegacyConfinement(engine, config.viscosityMpas / (1000 * config.densityKgM3));
    }
    const scale = engine.getActiveScaleRange('fluid');
    const dyeMass = () => engine.dye.reduce((sum, concentration) => sum + concentration, 0);
    const originalMass = dyeMass();
    const driveSteps = Math.round(hz * (options.driveSec ?? 0.5));
    const totalSteps = Math.round(hz * (options.durationSec ?? 1));
    let energyAtRelease = 0;
    let lastEnergy = 0;
    let energyAfterRelease = 0;
    let maxEnergyIncrease = 0;
    let maxDivergence = 0;
    let peakSpeed = 0;
    let maxStressResidual = 0;
    const times = [];
    for (let k = 0; k < totalSteps; k++) {
      const start = performance.now();
      if (k < driveSteps) engine.applyStirrerImpulse(...trajectory(k * dt), ...trajectory((k + 1) * dt), dt, config);
      engine.step(dt, config);
      if (k >= 5) times.push(performance.now() - start);
      const metrics = engine.getMetrics(config, scale);
      if (!Number.isFinite(metrics.kineticEnergyMjKg + metrics.maxSpeedMs + metrics.maxShearStressPa)) {
        throw new Error('Non-finite tank metrics: ' + id + ', step ' + k);
      }
      peakSpeed = Math.max(peakSpeed, metrics.maxSpeedMs);
      maxDivergence = Math.max(maxDivergence, divergenceRms(engine, h));
      maxStressResidual = Math.max(maxStressResidual, engine.getStressSolveResidual());
      if (k === driveSteps - 1) {
        energyAtRelease = metrics.kineticEnergyMjKg;
        options.sampleFields?.('release', engine);
      }
      if (k === driveSteps + hz / 60 - 1) {
        energyAfterRelease = metrics.kineticEnergyMjKg;
        options.sampleFields?.('earlyDecay', engine);
      }
      if (k >= driveSteps) maxEnergyIncrease = Math.max(maxEnergyIncrease, metrics.kineticEnergyMjKg - lastEnergy);
      lastEnergy = metrics.kineticEnergyMjKg;
    }
    times.sort((a, b) => a - b);
    return {
      fluid: id, grid: n, hz,
      peakSpeedMs: peakSpeed,
      releaseEnergyMjKg: energyAtRelease,
      retainedEnergyPct: energyAtRelease > 0 ? 100 * energyAfterRelease / energyAtRelease : 0,
      finalEnergyMjKg: lastEnergy,
      dyeMassDriftPct: 100 * (dyeMass() / originalMass - 1),
      maxDivergenceRmsPerSec: maxDivergence,
      maxStressResidual,
      maxUnforcedEnergyIncreasePctOfRelease: energyAtRelease > 0 ? 100 * maxEnergyIncrease / energyAtRelease : 0,
      ...(wallClock ? { stepP95Ms: times[Math.ceil(0.95 * times.length) - 1] } : {}),
    };
  }

  const fluid = (viscosityMpas) => ({ ...base, viscosityMpas });
  const preset = (id) => ({ ...base, ...FLUID_PRESETS.find((entry) => entry.id === id) });
  function compareTankRuns(id, config, runs, referenceOptions) {
    const reference = {};
    stirredTank(id, config, 480, 96, {
      ...referenceOptions,
      sampleFields: (phase, engine) => { reference[phase] = [engine.u.slice(), engine.v.slice()]; },
    });
    const releaseNorm = reference.release.reduce(
      (total, component) => component.reduce((sum, value) => sum + value ** 2, total), 0,
    );
    return runs.map(({ hz, options }) => {
      const fieldErrors = {};
      const report = stirredTank(id, config, hz, 96, {
        ...options,
        sampleFields: (phase, engine) => {
          let error = 0;
          let norm = 0;
          forEachVelocityFace(engine, (field, i, _x, _y, component) => {
            const expected = reference[phase][component][i];
            error += (field[i] - expected) ** 2;
            norm += expected ** 2;
          });
          fieldErrors[phase + 'L2Pct'] = 100 * Math.sqrt(error / norm);
          if (phase === 'earlyDecay') fieldErrors.decayL2OfReleasePct = 100 * Math.sqrt(error / releaseNorm);
        },
      });
      return { ...report, ...options, ...fieldErrors };
    });
  }

  function movingRodIntegrators() {
    const variants = ['backwardEuler', 'TR-BDF2'];
    const plans = [
      { id: 'water', config: fluid(1) },
      { id: '1000 mPa.s', config: fluid(1000) },
      { id: '30000 mPa.s', config: fluid(30000) },
    ];
    return plans.flatMap(({ id, config }) => {
      const runs = [60, 120, 240].flatMap((hz) => variants.map((integrator) => ({ hz, options: { integrator } })));
      return compareTankRuns(id, config, runs, { integrator: 'TR-BDF2' });
    });
  }

  function waterTransport() {
    return [true, false].flatMap((legacyConfinement) => {
      const options = { legacyConfinement };
      return compareTankRuns('water', fluid(1), [60, 120, 240].map((hz) => ({ hz, options })), options);
    });
  }

  function highViscosity() {
    const values = process.argv.includes('--quick')
      ? [30000, 500000, 5000000]
      : [10000, 30000, 100000, 500000, 1000000, 2500000, 5000000];
    return values.flatMap((viscosity) => {
      const id = viscosity / 1000 + ' Pa.s';
      const config = fluid(viscosity);
      return compareTankRuns(id, config, [60, 120, 240].map((hz) => ({ hz, options: {} })), {});
    });
  }

  function nonNewtonian() {
    const cases = [
      ['power law, K = 50 Pa.s^n', { ...base, model: 'power-law', viscosityMpas: 50000, flowIndex: 0.35 }],
      ['Herschel-Bulkley, K = 500 Pa.s^n, yield = 320 Pa', preset('cement-slurry')],
      ['high yield, K = 200 Pa.s^n, yield = 500 Pa', { ...preset('cement-slurry'), viscosityMpas: 200000, yieldStressPa: 500 }],
    ];
    return cases.flatMap(([id, config]) =>
      compareTankRuns(id, config, [60, 120, 240].map((hz) => ({ hz, options: {} })), {}),
    );
  }

  function highSpatial() {
    function sample(engine) {
      const values = [];
      for (let j = -10; j <= 10; j++) {
        for (let i = -10; i <= 10; i++) {
          if (Math.hypot(i, j) > 10) continue;
          const x = engine.midGrid + i * engine.tankRadiusGrid * 0.085;
          const y = engine.midGrid + j * engine.tankRadiusGrid * 0.085;
          values.push(engine.sampleFace(engine.u, x + 0.5, y, true)[0]);
          values.push(engine.sampleFace(engine.v, x, y + 0.5, false)[0]);
        }
      }
      return values;
    }
    return [30000, 500000, 5000000].flatMap((viscosity) => {
      const id = viscosity / 1000 + ' Pa.s';
      const config = fluid(viscosity);
      const fields = new Map();
      const runs = gridSizes.map((n) => stirredTank(id, config, 120, n, {
        driveSec: 0.1,
        durationSec: 0.125,
        sampleFields: (phase, engine) => {
          if (phase === 'release') fields.set(n, sample(engine));
        },
      }));
      const reference = fields.get(192);
      const norm = reference.reduce((total, value) => total + value ** 2, 0);
      return runs.map((row) => {
        const field = fields.get(row.grid);
        const error = field.reduce((total, value, i) => total + (value - reference[i]) ** 2, 0);
        return { ...row, sampledVelocityL2Pct: 100 * Math.sqrt(error / norm) };
      });
    });
  }

  function highModal() {
    return [30000, 100000, 500000, 1000000, 5000000].map((viscosityMpas) => ({
      viscosityPaS: viscosityMpas / 1000,
      ...swirl(96, 60, 'application', viscosityMpas, 1 / 60),
    }));
  }
  const benchmarks = {
    swirlTime: () => [60, 300, 600, 1200, 2400].map((hz) => swirl(96, hz)),
    swirlGrid: () => gridSizes.map((n) => swirl(n, 2400)),
    integrators: compareTimeIntegrators,
    diffusionPrototype: () => [60, 120, 240].flatMap((hz) => [
      swirl(96, hz, 'backwardEuler'), swirl(96, hz, 'TR-BDF2'),
    ]),
    pressure: () => gridSizes.flatMap((n) => [5, 12, 'default', 24].map((iterations) => pressureProjection(n, iterations))),
    stressTensor,
    stressStencil: () => gridSizes.map(stressStencil),
    tankProfiles: () => [
      ['0.01 mPa.s', fluid(0.01)], ['water', fluid(1)], ['olive oil', preset('olive-oil')],
      ['1000 mPa.s', fluid(1000)], ['19900 mPa.s', fluid(19900)], ['20100 mPa.s', fluid(20100)],
      ['500000 mPa.s', fluid(500000)], ['ketchup', preset('ketchup')],
    ].map(([id, config]) => stirredTank(id, config, 60)),
    tankTime: () => [60, 120, 240].flatMap((hz) => [
      stirredTank('water', fluid(1), hz),
      stirredTank('1000 mPa.s', fluid(1000), hz),
    ]),
    tankGrid: () => gridSizes.map((n) => stirredTank('water', fluid(1), 120, n)),
  };
  const suite = process.argv.find((arg) => arg.startsWith('--suite='))?.slice('--suite='.length);
  const extendedBenchmarks = { movingRodIntegrators, waterTransport, highViscosity, highSpatial, highModal, nonNewtonian };
  if (Object.hasOwn(extendedBenchmarks, suite)) benchmarks[suite] = extendedBenchmarks[suite];
  if (suite && !Object.hasOwn(benchmarks, suite)) throw new Error('Unknown benchmark: ' + suite);
  const report = Object.fromEntries(
    Object.entries(benchmarks).filter(([name]) => !suite || name === suite).map(([name, run]) => [name, run()]),
  );
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const [name, results] of Object.entries(report)) {
      console.log(name);
      console.table(Array.isArray(results) ? results : [results]);
    }
  }
} finally {
  await vite.close();
}
