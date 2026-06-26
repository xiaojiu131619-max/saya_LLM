import { LayoutGrid, Square } from 'lucide-react';
import { useApp } from '@/context/AppContext';

export default function ColumnToggle() {
  const { state, dispatch } = useApp();

  return (
    <div className="flex h-9 items-center gap-1 rounded-md border border-[#DCD8CF] bg-[#FAF9F5] p-1">
      <button
        type="button"
        onClick={() => dispatch({ type: 'SET_GRID_COLUMNS', payload: 1 })}
        className={`relative rounded-lg p-2 transition-colors active:scale-95 ${
          state.gridColumns === 1 ? 'bg-[#EDE8DE]' : 'hover:bg-[#F1EEE7]'
        }`}
        title="单列"
      >
        <Square className={`relative z-10 h-4 w-4 ${state.gridColumns === 1 ? 'text-[#D06646]' : 'text-[#7D766B]'}`} />
      </button>
      <button
        type="button"
        onClick={() => dispatch({ type: 'SET_GRID_COLUMNS', payload: 2 })}
        className={`relative rounded-lg p-2 transition-colors active:scale-95 ${
          state.gridColumns === 2 ? 'bg-[#EDE8DE]' : 'hover:bg-[#F1EEE7]'
        }`}
        title="多列"
      >
        <LayoutGrid className={`relative z-10 h-4 w-4 ${state.gridColumns === 2 ? 'text-[#D06646]' : 'text-[#7D766B]'}`} />
      </button>
    </div>
  );
}
