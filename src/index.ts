/** 包入口：默认导出 `WorldDefinition`，加载器按 `cortico.kind === 'world'` 认它。 */
import { PARLOR } from './definition.ts';

export default PARLOR;
export { PARLOR };
export type { ParlorConfigSection } from './config.ts';
export type { RoomEvent, Seat, WakeTier } from './room/protocol.ts';
