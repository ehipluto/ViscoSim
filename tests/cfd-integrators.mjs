const gamma = 2 - Math.SQRT2;
const implicitFraction = gamma / 2;
const previousWeight = 1 + (1 - gamma) ** 2;
const finalScale = 1 / (gamma * (2 - gamma));

export function createTrBdf2Stage(engine) {
  const initialU = new Float32Array(engine.u.length);
  const initialV = new Float32Array(engine.v.length);
  const rodU = new Float32Array(engine.uRodWeight.length);
  const rodV = new Float32Array(engine.vRodWeight.length);

  return (dt, solve) => {
    initialU.set(engine.u);
    initialV.set(engine.v);
    rodU.set(engine.uRodWeight);
    rodV.set(engine.vRodWeight);
    for (let i = 0; i < rodU.length; i++) {
      // The rod contributes a dimensionless diagonal proportional to the stage duration.
      engine.uRodWeight[i] = rodU[i] * implicitFraction;
      engine.vRodWeight[i] = rodV[i] * implicitFraction;
    }
    try {
      const implicitTime = dt * implicitFraction;
      solve(implicitTime);
      // Recover the trapezoidal stage from an implicit midpoint solve, including affine forcing.
      for (let i = 0; i < initialU.length; i++) {
        engine.u[i] = (2 * engine.u[i] - previousWeight * initialU[i]) * finalScale;
        engine.v[i] = (2 * engine.v[i] - previousWeight * initialV[i]) * finalScale;
      }
      solve(implicitTime);
    } finally {
      engine.uRodWeight.set(rodU);
      engine.vRodWeight.set(rodV);
    }
  };
}

export function overrideNewtonianIntegrator(engine, integrator) {
  const solveDiffusion = engine.solveDiffusionGalerkin.bind(engine);
  const trBdf2 = createTrBdf2Stage(engine);
  engine.integrateNewtonianViscosity = (dt, h, rho) => {
    const solve = (duration) => solveDiffusion(duration, h, rho, true, 10, 1e-8);
    if (integrator === 'TR-BDF2') trBdf2(dt, solve);
    else solve(dt);
  };
}

// Historical force for controlled comparisons. The application no longer adds it.
export function useLegacyConfinement(engine, baseNu) {
  const advect = engine.advectVelocityMacCormack.bind(engine);
  engine.advectVelocityMacCormack = (dt, h) => {
    applyLegacyConfinement(engine, dt, h, baseNu);
    advect(dt, h);
  };
}

function applyLegacyConfinement(engine, dt, h, baseNu) {
  const reScale = Math.max(0, Math.min(1, (1e-5 / Math.max(baseNu, 1e-8) - 0.15) * 0.25));
  if (reScale <= 0.01) return;

  const eps = 1.6 * h * reScale * dt;

  for (let j = 2; j < engine.n; j++) {
    let idx = 2 + j * engine.rowSize;
    for (let i = 2; i < engine.n; i++, idx++) {
      if (!engine.pMask[idx]) continue;

      const dwDx = (engine.absVort[idx + 1] - engine.absVort[idx - 1]) * (0.5 / h);
      const dwDy = (engine.absVort[idx + engine.rowSize] - engine.absVort[idx - engine.rowSize]) * (0.5 / h);
      const len = Math.hypot(dwDx, dwDy) + 1e-6;
      const nx = dwDx / len;
      const ny = dwDy / len;

      const fx = ny * engine.vorticity[idx] * eps;
      const fy = -nx * engine.vorticity[idx] * eps;

      if (engine.uMask[idx]) engine.u[idx] += fx;
      if (engine.uMask[idx + 1]) engine.u[idx + 1] += fx;
      if (engine.vMask[idx]) engine.v[idx] += fy;
      if (engine.vMask[idx + engine.rowSize]) engine.v[idx + engine.rowSize] += fy;
    }
  }
}
