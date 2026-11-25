# ViscoSim — CFD Viscosity and Rheology Simulator

A client-side web application for 2D computational fluid dynamics (CFD) simulation in a cylindrical stirred tank and rheological analysis of industrial fluids within the `0 – 500,000 mPa·s` viscosity range.

## Numerical Model and Rendering

- **Fluid Solver**: `96×96` staggered MAC grid with *no-slip* boundary conditions along the circular wall and exact sub-cell distances for boundary gradient calculations.
- **Viscous Integration & Pressure**: *Galerkin Multigrid* (`5` levels) combined with *PCG* for implicit viscous diffusion, and a two-step *Rotational Incremental Pressure-Correction* scheme for numerical stability under *Stokes/Creeping Flow* and low-Reynolds-number conditions.
- **Rheology**: Newtonian, *Power-Law*, and Papanastasiou-regularized *Herschel-Bulkley* models, with real-time computation of shear rate $\dot{\gamma}$, shear stress $\tau$, vorticity $\omega$, Reynolds number $Re$, and Danckwerts' homogeneity index $M(t)$.
- **Visualization**: *WebGL1* rendering pipeline with *Catmull-Rom* bicubic filtering on normalized floating-point textures and automatic fallback to *Canvas 2D*.

## Project Structure

```text
src/
├── components/
│   ├── FluidViewport.tsx   # Interactive WebGL viewport with vector overlays and local probe
│   ├── InfoTooltip.tsx     # Accessible contextual tooltips
│   ├── MixingChart.tsx     # Time series of homogeneity M(t) and kinetic energy Ek
│   └── RheologyChart.tsx   # Log-log flow curves τ(γ̇) and μ(γ̇)
├── constants/
│   └── fluids.ts           # Calibrated industrial fluid presets and rheological functions
├── simulation/
│   └── cfdEngine.ts        # Galerkin MG-PCG CFD engine and WebGL/2D renderer
├── types/
│   └── rheology.ts         # TypeScript contracts for configuration, probe, and metrics
└── App.tsx                 # Control interface, telemetry, and CSV export
```

## Development and Build

```bash
npm install
npm run dev      # Starts the development server at http://localhost:3000
npm run lint     # Performs TypeScript type checking in strict mode
npm run build    # Generates the static production bundle in dist/
```
