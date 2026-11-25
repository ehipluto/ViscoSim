# ViscoSim — CFD Viscosity & Rheology Simulator

High-performance client-side web application for 2D computational fluid dynamics (CFD) simulation in a stirred cylindrical vessel and rheological analysis of industrial fluids across the range `0 – 500,000 mPa·s`.

## Numerical Solver & Rendering Architecture

- **Fluid Solver**: `96×96` staggered MAC grid with exact circular no-slip boundary conditions and sub-cell edge distance weighting.
- **Viscous & Pressure Integrator**: 5-level *Galerkin Multigrid* + *PCG* solver for implicit viscous diffusion and 2-pass *Rotational Incremental Pressure-Correction* for robust stability in Creeping/Stokes flows and low-Reynolds regimes.
- **Rheology Engine**: Newtonian, *Power-Law*, and regularized *Herschel-Bulkley* (Papanastasiou) models calculating real-time shear rate $\dot{\gamma}$, shear stress $\tau$, vorticity $\omega$, Reynolds number $Re$, and Danckwerts mixing index $M(t)$.
- **Visualization Pipeline**: *WebGL1* renderer with Catmull-Rom bicubic filtering on normalized float textures, vector field overlays, local interactive probes, and automatic *Canvas 2D* fallback.

## Project Structure

```text
src/
├── components/
│   ├── FluidViewport.tsx   # Interactive WebGL viewport + vector overlay & local probe
│   ├── InfoTooltip.tsx     # Accessible contextual tooltips
│   ├── MixingChart.tsx     # Danckwerts mixing index M(t) & kinetic energy Ek history
│   └── RheologyChart.tsx   # Log-log flow curve τ(γ̇) & μ(γ̇) with live operating point
├── constants/
│   └── fluids.ts           # Calibrated industrial presets and rheological formulas
├── simulation/
│   └── cfdEngine.ts        # Galerkin MG-PCG CFD engine & WebGL/2D renderer
├── types/
│   └── rheology.ts         # TypeScript interfaces for configuration, probes, and metrics
└── App.tsx                 # Control dashboard, real-time telemetry & CSV export
```

## Development & Build

```bash
npm install
npm run dev      # Start Vite development server on http://localhost:3000
npm run lint     # Run strict TypeScript type check
npm run build    # Generate production static bundle in dist/
```
