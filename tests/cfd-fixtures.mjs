export function forEachVelocityFace(engine, visit) {
  for (const [field, mask, ox, oy, component] of [
    [engine.u, engine.uMask, 0.5, 0, 0],
    [engine.v, engine.vMask, 0, 0.5, 1],
  ]) {
    for (let j = 1; j <= engine.n; j++) {
      for (let i = 1; i <= engine.n; i++) {
        const index = i + j * engine.rowSize;
        if (mask[index]) visit(field, index, i - engine.midGrid - ox, j - engine.midGrid - oy, component);
      }
    }
  }
}

export function divergenceRms(engine, h) {
  let sum = 0;
  for (let i = 0; i < engine.pMask.length; i++) {
    if (!engine.pMask[i]) continue;
    const div = (engine.u[i + 1] - engine.u[i] + engine.v[i + engine.rowSize] - engine.v[i]) / h;
    sum += div ** 2;
  }
  return Math.sqrt(sum / engine.fluidCellCount);
}

export function seedPressureGradient(engine, h) {
  const potential = (index) => {
    const x = (index % engine.rowSize - engine.midGrid) * h;
    const y = (Math.floor(index / engine.rowSize) - engine.midGrid) * h;
    return 0.001 * (Math.cos(25 * x) + 0.35 * Math.sin(33 * y));
  };
  forEachVelocityFace(engine, (field, index, _x, _y, component) => {
    field[index] = (potential(index) - potential(index - (component === 0 ? 1 : engine.rowSize))) / h;
  });
}
