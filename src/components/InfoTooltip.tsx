import React, { useEffect, useId, useRef, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import type { Language } from '../locale';

interface InfoTooltipProps {
  language: Language;
  title: string;
  description: string;
}

const InfoTooltip: React.FC<InfoTooltipProps> = ({ language, title, description }) => {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; placeAbove: boolean }>({
    top: 0,
    left: 0,
    placeAbove: true,
  });
  const btnRef = useRef<HTMLButtonElement>(null);
  const tooltipId = useId();

  const updatePosition = () => {
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const boxW = Math.min(280, window.innerWidth - 24);
    const placeAbove = rect.top > 150;
    const rawLeft = rect.left + rect.width * 0.5 - boxW * 0.5;
    const left = Math.max(12, Math.min(window.innerWidth - boxW - 12, rawLeft));
    const top = placeAbove ? rect.top - 8 : rect.bottom + 8;
    setCoords({ top, left, placeAbove });
  };

  useEffect(() => {
    if (!open) return;
    updatePosition();

    const handleOutside = (e: Event) => {
      if (btnRef.current && !btnRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleScrollOrResize = () => setOpen(false);

    window.addEventListener('pointerdown', handleOutside);
    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize);
    return () => {
      window.removeEventListener('pointerdown', handleOutside);
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
    };
  }, [open]);

  return (
    <span className="inline-flex items-center align-middle">
      <button
        ref={btnRef}
        type="button"
        aria-label={(language === 'it' ? 'Informazioni · ' : 'Information · ') + title}
        aria-describedby={open ? tooltipId : undefined}
        onMouseEnter={() => {
          updatePosition();
          setOpen(true);
        }}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => {
          updatePosition();
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.stopPropagation();
          updatePosition();
          setOpen((v) => !v);
        }}
        className="inline-flex items-center justify-center w-5 h-5 rounded text-slate-400 hover:text-cyan-400 focus-visible:text-cyan-400 focus-visible:outline-none transition-colors cursor-help"
      >
        <HelpCircle size={13} />
      </button>

      {open && (
        <div
          id={tooltipId}
          role="tooltip"
          style={{
            position: 'fixed',
            top: coords.top,
            left: coords.left,
            width: Math.min(280, typeof window !== 'undefined' ? window.innerWidth - 24 : 280),
            transform: coords.placeAbove ? 'translateY(-100%)' : 'translateY(0)',
          }}
          className="z-50 pointer-events-none bg-[#0B1018] border border-slate-700 rounded-lg p-3 shadow-xl text-left"
        >
          <div className="text-xs font-semibold text-cyan-300 mb-1">{title}</div>
          <p className="text-[11.5px] leading-relaxed text-slate-300 font-normal normal-case tracking-normal">
            {description}
          </p>
        </div>
      )}
    </span>
  );
};

export default InfoTooltip;
