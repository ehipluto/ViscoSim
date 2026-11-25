export function stressDivergenceAt(engine, h, index, component) {
  const { u, v, muApp, rowSize: row } = engine;
  const normalX = (i) => 2 * muApp[i] * (u[i + 1] - u[i]) / h;
  const normalY = (i) => 2 * muApp[i] * (v[i + row] - v[i]) / h;
  const shear = (i) => {
    const mu = (muApp[i] + muApp[i - 1] + muApp[i - row] + muApp[i - row - 1]) / 4;
    return mu * (u[i] - u[i - row] + v[i] - v[i - 1]) / h;
  };
  if (component === 0) {
    return (normalX(index) - normalX(index - 1) + shear(index + row) - shear(index)) / h;
  }
  return (normalY(index) - normalY(index - row) + shear(index + 1) - shear(index)) / h;
}
