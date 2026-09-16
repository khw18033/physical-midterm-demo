import { STATE_STYLE } from '../graph/stateStyle.ts';
import type { TaskStatus } from '../model/types.ts';
export function StatusLegend() { return <div className="legend">{(Object.keys(STATE_STYLE) as TaskStatus[]).map((status) => <span className={STATE_STYLE[status].className} key={status}>{STATE_STYLE[status].icon} {STATE_STYLE[status].label}</span>)}</div>; }
