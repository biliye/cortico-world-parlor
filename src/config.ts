import type { ConfigGroup } from 'cortico/core/types.ts';
import { DEFAULT_WAKE_TIER, type WakeTier } from './room/protocol.ts';

/** config.json 的 worlds.parlor 段，默认禁用；bot 或部署可启用。 */
export interface ParlorConfigSection {
  enabled: boolean;
  /** 空 = 由这个 World 自己开一台客厅；填 http(s) 地址 = 连别人的。 */
  serverUrl: string;
  room: string;
  /** 空 = 用 bot 的显示名。 */
  seatName: string;
  /** 自己开客厅时绑定的地址；127.0.0.1 = 只给本机，0.0.0.0 = 给局域网。 */
  host: string;
  port: number;
  /** 会说话的席位上限；观看者不计。 */
  maxSeats: number;
  /** 默认提醒挡位；改动会同步到服务器上的这个席位。 */
  wakeTier: WakeTier;
}

export const PARLOR_DEFAULTS: ParlorConfigSection = {
  enabled: false,
  serverUrl: '',
  room: 'lobby',
  seatName: '',
  host: '127.0.0.1',
  port: 8790,
  maxSeats: 8,
  wakeTier: DEFAULT_WAKE_TIER,
};

export const PARLOR_CONFIG_GROUP: ConfigGroup = {
  id: 'world:parlor',
  owner: 'world:parlor',
  schema: {
    type: 'object',
    title: '客厅',
    description: '一个共享房间。serverUrl 留空时由这个 World 自己开一台；填地址时连过去，邀请码放在部署 .env。',
    properties: {
      'worlds.parlor.serverUrl': {
        type: 'string',
        title: '服务器地址',
        description: '留空 = 自己开客厅（本机 + 端口）。填 http(s)://host:port = 连别人的房间，需要邀请码。',
        'x-hot': false,
      },
      'worlds.parlor.room': {
        type: 'string',
        title: '房间名',
        description: '房间标识；同一个服务器上的席位要进同一个房间。',
        'x-hot': false,
      },
      'worlds.parlor.seatName': {
        type: 'string',
        title: '席位名',
        description: '客厅里显示的名字；留空用 bot 的显示名。',
        'x-hot': false,
      },
      'worlds.parlor.host': {
        type: 'string',
        title: '监听地址',
        description: '只有自己开客厅时有用：127.0.0.1 只给本机，0.0.0.0 给局域网。',
        'x-hot': false,
      },
      'worlds.parlor.port': {
        type: 'integer',
        title: '端口',
        description: '只有自己开客厅时有用。',
        minimum: 1,
        maximum: 65535,
        'x-hot': false,
      },
      'worlds.parlor.maxSeats': {
        type: 'integer',
        title: '席位上限',
        description: '只有自己开客厅时有用；会说话的席位上限，观看者不计入。',
        minimum: 2,
        maximum: 12,
        'x-hot': false,
      },
      'worlds.parlor.wakeTier': {
        type: 'string',
        title: '提醒挡位',
        description: '热闹 = 闲聊也叫；摘要 = 被 @ 或私聊才叫，另加周期摘要；只 @ = 只有被 @ 或私聊；离开 = 完全不叫。',
        enum: ['full', 'digest', 'quiet', 'off'],
        'x-hot': true,
      },
    },
  },
};
