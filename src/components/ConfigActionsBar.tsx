import React, { useRef } from 'react';
import { Download, FileJson, RotateCcw, Share2, Upload } from 'lucide-react';

interface ConfigActionsBarProps {
  onShareUrl: () => void;
  onExportJson: () => void;
  onImportJsonFile: (file: File) => void;
  onResetDefaults: () => void;
  onExportCsv: () => void;
}

const ConfigActionsBar: React.FC<ConfigActionsBarProps> = ({
  onShareUrl,
  onExportJson,
  onImportJsonFile,
  onResetDefaults,
  onExportCsv,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
      <button
        type="button"
        onClick={onShareUrl}
        title="Copia URL con configurazione corrente"
        className="inline-flex items-center gap-1.5 px-2.5 py-2 text-xs font-medium text-slate-200 bg-[#0F141D] border border-slate-800 hover:border-slate-700 rounded-md transition-colors whitespace-nowrap shrink-0 min-h-[36px]"
      >
        <Share2 size={13} />
        <span className="hidden sm:inline">Condividi URL</span>
      </button>

      <button
        type="button"
        onClick={onExportJson}
        title="Esporta configurazione e traccia input in formato JSON"
        className="inline-flex items-center gap-1.5 px-2.5 py-2 text-xs font-medium text-slate-200 bg-[#0F141D] border border-slate-800 hover:border-slate-700 rounded-md transition-colors whitespace-nowrap shrink-0 min-h-[36px]"
      >
        <FileJson size={13} />
        <span className="hidden sm:inline">Esporta JSON</span>
      </button>

      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        title="Importa configurazione da file JSON"
        className="inline-flex items-center gap-1.5 px-2.5 py-2 text-xs font-medium text-slate-200 bg-[#0F141D] border border-slate-800 hover:border-slate-700 rounded-md transition-colors whitespace-nowrap shrink-0 min-h-[36px]"
      >
        <Upload size={13} />
        <span className="hidden sm:inline">Importa JSON</span>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            onImportJsonFile(f);
            e.target.value = '';
          }
        }}
      />

      <button
        type="button"
        onClick={onResetDefaults}
        title="Ripristina i parametri predefiniti"
        className="inline-flex items-center gap-1.5 px-2.5 py-2 text-xs font-medium text-slate-200 bg-[#0F141D] border border-slate-800 hover:border-slate-700 rounded-md transition-colors whitespace-nowrap shrink-0 min-h-[36px]"
      >
        <RotateCcw size={13} />
        <span className="hidden xl:inline">Predefiniti</span>
      </button>

      <button
        type="button"
        onClick={onExportCsv}
        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-md transition-colors whitespace-nowrap shrink-0 min-h-[36px]"
      >
        <Download size={14} />
        <span>Esporta CSV</span>
      </button>
    </div>
  );
};

export default ConfigActionsBar;
