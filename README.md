# ViscoSim — CFD Viscosity and Rheology Simulator

ViscoSim is a browser-based tool for exploring fluid motion and rheology in a circular 2D tank. The Newtonian viscosity input ranges from `0.01` to `5,000,000 mPa·s` (5,000 Pa·s). Above 500 Pa·s, the interface flags that viscous decay may be faster than the displayed time step. For Power Law and Herschel–Bulkley fluids, the input is the consistency coefficient K, up to `500,000 mPa·sⁿ`.

**Exploratory model.** The tank represents a plane of an incompressible, single-phase fluid at constant temperature. The fluid view uses a qualitative wake, the presets are illustrative, and the readings are preliminary numerical estimates. Quantitative validation requires convergence studies and comparisons against experimental measurements. The mixing index remains internal pending checks of numerical diffusion in the tracer transport.

## Using ViscoSim

Select a fluid and drag inside the tank to stir it. Use the selector above the tank to switch between the fluid, velocity, vorticity, and shear-stress views. **Charts** contains the rheology curve and kinetic-energy history and starts collapsed. The header provides CSV export, theme controls, and an English/Italian language selector. ViscoSim opens in English and remembers your preferred language and theme. Changing the physical inputs starts a new run.

## Numerical Model and Rendering

- **Fluid solver.** The interface uses a `96×96` staggered MAC grid. Benchmarks can select other resolutions. The circular wall uses masks and bounded subcell distance corrections.
- **Newtonian diffusion.** The solver uses backward Euler at low temporal stiffness, TR-BDF2 at intermediate stiffness, and implicit substeps with pressure projection at high stiffness. Galerkin multigrid preconditions the conjugate-gradient solves with symmetric sweeps. Pressure projection stops when the squared relative residual reaches `10⁻⁵` or after 16 iterations.
- **Variable viscosity.** The Power Law and Papanastasiou-regularized Herschel–Bulkley models solve both velocity components with the coupled viscous stress tensor `2μD(u)`. A predictor updates the apparent viscosity. The interface flags a relative residual above 1% in the latest coupled viscous solve.
- **Stirring and transport.** The base time step is 1/60 s with internal substeps. The solver samples the rod at the substep midpoint, constrains its physical radius to the tank, and scales the penalty by the substep duration. Velocity transport uses limited MacCormack advection with midpoint characteristic tracing. Tracer transport uses conservative fluxes across MAC faces.
- **Visualization.** The renderer uses WebGL 1 with bicubic filtering and automatically falls back to Canvas 2D.

## Project Structure

```text
src/
├── components/
│   ├── FluidViewport.tsx   # WebGL viewport, vector overlays, and local probe
│   ├── InfoTooltip.tsx     # Contextual help
│   ├── MixingChart.tsx    # Kinetic-energy history
│   └── RheologyChart.tsx  # Log-log flow curves
├── constants/
│   └── fluids.ts         # Illustrative presets and rheology functions
├── simulation/
│   ├── cfdEngine.ts       # CFD solver and WebGL/2D renderer
│   └── simulationClock.ts # Fixed-step clock and timestamped pointer input
├── types/
│   └── rheology.ts        # Configuration, probe, and metrics types
├── locale.ts              # English and Italian copy
└── App.tsx                # Controls, readouts, and CSV export
```

## Development and Build

Use Node.js 24, which is also the version used in GitHub Actions.

```bash
npm ci
npm run dev        # Development server at http://localhost:3000
npm run lint       # TypeScript type check
npm test           # Numerical regressions
npm run benchmark  # Extended numerical checks in Node.js
npm run build      # Static production bundle in dist/
```

## Numerical Verification

```bash
npm run benchmark -- --suite=pressure
npm run benchmark -- --suite=diffusionPrototype
npm run benchmark -- --suite=movingRodIntegrators --timing
npm run benchmark -- --suite=waterTransport
npm run benchmark -- --suite=stressStencil
npm run benchmark -- --suite=highViscosity --timing
npm run benchmark -- --suite=highSpatial
npm run benchmark -- --suite=highModal
npm run benchmark -- --suite=nonNewtonian
npm run benchmark -- --json --timing
```

The benchmark suite checks spatial and temporal sensitivity, pressure projection, and rheology. The standard stirring case uses a 200 mm tank and a 16 mm rod, with 0.5 s of prescribed circular motion followed by 0.5 s of decay. The diffusion case initializes a Newtonian azimuthal mode with a stationary wall, μ = 30 Pa·s, and ρ = 1,000 kg/m³. Its reference profile is proportional to `J₁(j₁,₁ r/R) exp(−ν(j₁,₁/R)² t)`. Relative L² errors use the velocity components on the grid faces. [Bessel equation, NIST DLMF](https://dlmf.nist.gov/10.2) · [Bessel function zeros](https://dlmf.nist.gov/10.21)

| Check | Measured result |
|---|---|
| Pressure projection | The discrete-gradient case on `96×96` retained **0.31%** of the initial RMS divergence, down from **14.07%**. The `48×48` and `192×192` cases retained **0.20%** and **0.39%**, respectively. |
| Newtonian diffusion | At 30 Pa·s on `96×96`, with a base step of `1/60 s` and evaluation at `t = 1/30 s`, the profile error fell from **44.04%** to **3.95%**. |
| Isolated integrator comparison | With the same spatial operator on `96×96` and a step of `1/60 s`, backward Euler had **44.13%** error and TR-BDF2 had **3.84%**. At `1/120 s` TR-BDF2 had **1.17%** overall profile error and **2.37%** in the outer ring. |
| Stirred water | At `96×96`, the L² difference at release was **40.92%** at `1/60 s` and **18.54%** at `1/240 s` against the same setup at `1/480 s`. Quantitative use in this regime requires further transport and grid verification. |
| Variable viscosity | For the manufactured field `u = γy, v = 0, μ = μ₀ + βx`, the expected transverse acceleration is **0.01 m/s²**. The scalar operator returns **0**. The coupled stress solve returns **0.01000017 m/s²**. |

The isolated TR-BDF2 comparison uses a fixed wall. The stirring cases include the moving rod and its velocity penalty. Physical validation requires a measured tank geometry, rheological curve, rod trajectory, and experimental uncertainty. [Hosea and Shampine, TR-BDF2](https://pages.mtu.edu/~struther/Courses/OLD/Other/LessOld/5628_11/TRBDF2_Hosea_AppNumMath_20_pp21-37_1996.pdf) · [Angot et al., penalization](https://www.math.u-bordeaux.fr/~chabrune/publi/ABF-NM.pdf) · [NIST, CFD verification and validation](https://www.nist.gov/publications/summary-industrial-verification-validation-and-uncertainty-quantification-procedures)

### High-viscosity cases

The temporal comparison uses the velocity field at rod release on `96×96`, with a `1/480 s` reference on the same grid. The spatial comparison samples up to `0.85R` at release after 0.1 s, with a base step of `1/120 s` and a `192×192` reference. Both comparisons use numerical references.

| Newtonian viscosity | Previous temporal L² difference at `1/60 s` | Current difference |
|---|---:|---:|
| 30 Pa·s | 6.49% | 3.93% |
| 500 Pa·s | 10.19% | 4.04% |
| 5,000 Pa·s | 11.22% | 4.53% |

The spatial L² difference between `96×96` and `192×192` was **7.41%** at 500 Pa·s and **7.66%** at 5,000 Pa·s. For the highest-consistency Herschel–Bulkley case tested (`K = 500 Pa·sⁿ`, yield stress 320 Pa), the temporal difference was approximately **9.2%** at `1/60 s` and **3.0%** at `1/240 s`.

During free decay, the solver uses a quasi-steady limit if the flow is creeping, the reference viscous mode decays by at least a factor of `exp(−12)` within the step, and the estimated displacement is below 0.1 grid cells. In the stationary-wall case at 500 Pa·s, this limit gives an error of **0.00049%** relative to the initial velocity norm. The subframe transient is below the simulator's temporal resolution.

In the prescribed stirring benchmark at 5,000 Pa·s, Node.js measured approximately **83 ms per step** at the 95th percentile. Runtime varies with the device, geometry, and trajectory, and can exceed a real-time frame budget.
