"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { AI_SHOW_DELAY_MS } from '@/lib/motion/delay';
import { useDelayedFlag } from '@/lib/motion/use-delayed-flag';
import { mountAgentPlayer, markSizes, type AgentShape, type MarkSize } from '@ensemble/brand/web-activity';
import { EnsembleMark } from '../brand/Logo';
import { useMotion } from './motion-context';

type Props = { kind: AgentShape | null; size?: MarkSize; rest?: boolean };

export const AgentActivityMark = memo(function AgentActivityMark({ kind, size = 'inline', rest = false }: Props) {
  const shown = useDelayedFlag(kind !== null, AI_SHOW_DELAY_MS);
  const [retained, retain] = useState(false);
  const settled = useCallback(() => retain(false), []);
  useEffect(() => { if (shown) retain(true); }, [shown]);
  if (shown || retained) return <Player kind={kind} size={size} settled={settled} />;
  return rest ? <Still size={size} /> : null;
});

function Knot({ size }: { size: MarkSize }) {
  return <EnsembleMark data-rest="" size={markSizes[size][1]} viewBox="20 20 280 280" />;
}
function Still({ size }: { size: MarkSize }) {
  const [width, height] = markSizes[size];
  return <span className="agent-activity-mark" style={{ width, height }} aria-hidden><Knot size={size} /></span>;
}
function Player({ kind, size, settled }: { kind: AgentShape | null; size: MarkSize; settled: () => void }) {
  const { reduce } = useMotion(), [width, height] = markSizes[size];
  const el = useRef<HTMLSpanElement>(null), ctl = useRef<ReturnType<typeof mountAgentPlayer> | null>(null);
  useEffect(() => {
    ctl.current = mountAgentPlayer(el.current!, size, settled);
    return () => { ctl.current?.destroy(); ctl.current = null; };
  }, [size, settled]);
  useEffect(() => { ctl.current?.update(kind, reduce); }, [kind, size, reduce]);
  return <span className="agent-activity-mark" ref={el} data-agent-motion={kind ?? 'return'} style={{ width, height }} aria-hidden>
    <Knot size={size} />
    <svg data-live="" viewBox={`0 0 ${width} ${height}`} fill="none" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path /><path /></svg>
  </span>;
}
