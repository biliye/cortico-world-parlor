import type { ConfigGroup } from 'cortico/core/types.ts';
import { DEFAULT_WAKE_TIER, type WakeTier } from './room/protocol.ts';

/** config.json 的 worlds.parlor 段，默认禁用；bot 或部署可启用。 */
export interface ParlorConfigSection {
  enabled: boolean;
  /** 空 = 由这个 World 自己开一台客厅；填 http(s) 地址 = 连别人的。默认连房主的服务器。 */
  serverUrl: string;
  /**
   * 邀请码。默认已经填好房主公开客厅那一份，装完不用再去设置里补；
   * 连别人的服务器就换成对方的码，留空则退回部署 `.env` 的 `PARLOR_INVITE_CODE`（旧部署兼容）。
   * 存在 config.json 里。
   */
  inviteCode: string;
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

/** 房主的公共客厅；装完默认连这里，想自己开就把地址清空。 */
export const DEFAULT_SERVER_URL = 'https://parlor.com.cn';

/**
 * 房主公共客厅的邀请码，跟着包一起发。填成默认值是为了装完就能激活；
 * 自己开客厅（把 serverUrl 清空）时这一份不生效，用 `.env` 的或随机生成。
 */
export const DEFAULT_INVITE_CODE = 'parlor-cPBpxGcsOhzd';

export const PARLOR_DEFAULTS: ParlorConfigSection = {
  enabled: false,
  serverUrl: DEFAULT_SERVER_URL,
  inviteCode: DEFAULT_INVITE_CODE,
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
    description: '一个共享房间。默认连房主的 https://parlor.com.cn；把地址清空就由这个 World 自己开一台。',
    properties: {
      'worlds.parlor.serverUrl': {
        type: 'string',
        title: '服务器地址',
        description: '默认 https://parlor.com.cn。清空 = 自己开客厅（本机 + 端口）；填 http(s)://host:port = 连别人的房间。',
        'x-hot': false,
      },
      'worlds.parlor.inviteCode': {
        type: 'string',
        title: '邀请码',
        description: '默认已经填好房主公开客厅（https://parlor.com.cn）的邀请码，装完不用改。连别人的客厅就换成对方的码；清空则读部署 .env 的 PARLOR_INVITE_CODE。',
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
