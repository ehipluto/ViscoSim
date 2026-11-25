# ViscoSim — Simulatore CFD di Viscosità e Reologia

Applicazione web client-side per la simulazione fluidodinamica 2D in vasca cilindrica agitata e l'analisi reologica di fluidi industriali nell'intervallo `0 – 500.000 mPa·s`.

## Modello Numerico e Rendering

- **Solutore fluido**: griglia sfalsata MAC `96×96` con condizioni al contorno *no-slip* sulla parete circolare e distanze sub-cella esatte per i gradienti di bordo.
- **Integratore viscoso & pressione**: *Galerkin Multigrid* (`5` livelli) + *PCG* per la diffusione viscosa implicita e schema *Rotational Incremental Pressure-Correction* a 2 passaggi per stabilità in regime *Stokes/Creeping* e basso Reynolds.
- **Reologia**: modelli Newtoniano, *Power-Law* e *Herschel-Bulkley* regolarizzato (Papanastasiou) con calcolo in tempo reale di taglio $\dot{\gamma}$, sforzo $\tau$, vorticità $\omega$, numero di Reynolds $Re$ ed indice di omogeneità di Danckwerts $M(t)$.
- **Visualizzazione**: pipeline *WebGL1* con filtraggio bicubico *Catmull-Rom* su texture floating-normalized e fallback automatico su *Canvas 2D*.

## Struttura del Progetto

```text
src/
├── components/
│   ├── FluidViewport.tsx   # Viewport interattivo WebGL + overlay vettori e sonda locale
│   ├── InfoTooltip.tsx     # Tooltip contestuali accessibili
│   ├── MixingChart.tsx     # Serie storica omogeneità M(t) ed energia cinetica Ek
│   └── RheologyChart.tsx   # Curva di flusso log-log τ(γ̇) e μ(γ̇)
├── constants/
│   └── fluids.ts           # Preset industriali calibrati e funzioni reologiche
├── simulation/
│   └── cfdEngine.ts        # Motore CFD Galerkin MG-PCG e renderer WebGL/2D
├── types/
│   └── rheology.ts         # Contratti TypeScript per configurazione, sonda e metriche
└── App.tsx                 # Interfaccia di controllo, telemetria ed esportazione CSV
```

## Sviluppo e Build

```bash
npm install
npm run dev      # Avvia il server di sviluppo su http://localhost:3000
npm run lint     # Verifica tipi TypeScript in modalità strict
npm run build    # Genera il bundle statico di produzione in dist/
```

