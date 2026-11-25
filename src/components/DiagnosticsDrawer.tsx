import React, { useState } from 'react';
import { Activity, ChevronDown, ChevronUp } from 'lucide-react';
import { formatViscosityDisplay } from '../constants/fluids';
import { ConvergenceStatus, DiagnosticsSnapshot } from '../types/rheology';

interface DiagnosticsDrawerProps {
  diagnostics: DiagnosticsSnapshot;
  enableSmagorinsky: boolean;
}

const CONVERGENCE_BADGE: Record<
  ConvergenceStatus,
  { label: string; className: string }
> = {
  converged: {
    label: 'Convergente',
    className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  },
  'under-relaxed': {
    label: 'Picard Sotto-rilassato',
    className: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  },
  'rollback-recovered': {
    label: 'Rollback Δt/2 Eseguito',
    className: 'bg-sky-500/15 text-sky-300 border-sky-500/40',
  },
  'load-shedding': {
    label: 'Rallentamento CFL Attivo',
    className: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  },
};

const DiagnosticsDrawer: React.FC<DiagnosticsDrawerProps> = ({
  diagnostics,
  enableSmagorinsky,
}) => {
  const [open, setOpen] = useState(false);
  const badge = CONVERGENCE_BADGE[diagnostics.convergenceStatus];

  return (
    <div className="bg-[#0F141D] border border-slate-800 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs hover:bg-slate-800/30 transition-colors"
      >
        <span className="inline-flex items-center gap-2 font-semibold text-slate-200">
          <Activity size={14} className="text-cyan-400" />
          Diagnostica Solutore &amp; Numerica
        </span>

        <span className="flex flex-wrap items-center gap-2.5 font-mono text-[11px] tabular-nums text-slate-400">
          <span>
            {diagnostics.renderFps} FPS · {diagnostics.solverUps} UPS
          </span>
          <span>CFL {diagnostics.courantNumber.toFixed(2)}</span>
          <span className={`px-2 py-0.5 rounded border text-[10.5px] font-sans font-medium ${badge.className}`}>
            {badge.label}
          </span>
          {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-2 border-t border-slate-800/80 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono tabular-nums">
          <div className="bg-[#07090E] border border-slate-800/80 rounded p-2.5">
            <div className="font-sans text-[11px] text-slate-400">Griglia &amp; Passo Δt_phys</div>
            <div className="mt-1 text-slate-100">
              {diagnostics.gridN}×{diagnostics.gridN} · {(diagnostics.dtPhysSec * 1000).toFixed(2)} ms
            </div>
            <div className="text-[10.5px] text-slate-400">
              t_sim = {diagnostics.simulatedTimeSec.toFixed(2)} s (×{diagnostics.timeDilationRatio.toFixed(2)})
            </div>
          </div>

          <div className="bg-[#07090E] border border-slate-800/80 rounded p-2.5">
            <div className="font-sans text-[11px] text-slate-400">Divergenza Norm. (RMS / Max)</div>
            <div className="mt-1 text-emerald-300">
              {diagnostics.divRms.toExponential(2)} / {diagnostics.divMax.toExponential(2)}
            </div>
            <div className="text-[10.5px] text-slate-400">
              Flusso contorno: {diagnostics.netBoundaryFlux.toExponential(1)} m²/s
            </div>
          </div>

          <div className="bg-[#07090E] border border-slate-800/80 rounded p-2.5">
            <div className="font-sans text-[11px] text-slate-400">Residui PCG (Diff / Press)</div>
            <div className="mt-1 text-slate-100">
              {diagnostics.diffusionResidual.toExponential(1)} / {diagnostics.pressureResidual.toExponential(1)}
            </div>
            <div className="text-[10.5px] text-slate-400">
              Picard: {diagnostics.picardIterations} it (err {diagnostics.picardResidual.toExponential(1)})
            </div>
          </div>

          <div className="bg-[#07090E] border border-slate-800/80 rounded p-2.5">
            <div className="font-sans text-[11px] text-slate-400">Stabilità &amp; Sottogriglia</div>
            <div className="mt-1 text-slate-100">
              Substep: {diagnostics.substepsLastStep} · Rollback: {diagnostics.rollbacksCount}
            </div>
            <div className="text-[10.5px] text-slate-400">
              {enableSmagorinsky
                ? `μ_sgs max: ${formatViscosityDisplay(diagnostics.sgsMaxViscosityMpas)} mPa·s`
                : 'Smagorinsky 2D: Disattivo'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DiagnosticsDrawer;
