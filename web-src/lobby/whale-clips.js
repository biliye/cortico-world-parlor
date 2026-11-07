/* 鲸鱼娘用的两段动画清单（从原型 assets/whale/clips.js 里抽出来的子集）。
   全部 21 段都在原型里；大厅只用这两段，所以这里只带这两段，贴图也只有两张。

   字段含义（照抄原清单，别改名）：
     tile     雪碧图里单帧的宽高
     anchor   把这一帧贴到画面上的锚点 = pivot − crop，**不是画布中心**
     durations  逐帧时长（毫秒），按顺序累加出时间轴        */

export const WHALE_CLIPS = {
    "room/idle/east": {
      "sheet": "sheet/room-idle-east.png",
      "tile": [
        81,
        113
      ],
      "cols": 16,
      "rows": 4,
      "count": 56,
      "canvas": [
        128,
        128
      ],
      "pivot": [
        64,
        120
      ],
      "crop": [
        14,
        8
      ],
      "anchor": [
        50,
        112
      ],
      "loop": true,
      "is_static": false,
      "frame_ms": null,
      "durations": [
        71,
        72,
        71,
        72,
        71,
        72,
        71,
        71,
        72,
        71,
        72,
        71,
        72,
        71,
        71,
        72,
        71,
        72,
        71,
        72,
        71,
        71,
        72,
        71,
        72,
        71,
        72,
        71,
        71,
        72,
        71,
        72,
        71,
        72,
        71,
        71,
        72,
        71,
        72,
        71,
        72,
        71,
        71,
        72,
        71,
        72,
        71,
        72,
        71,
        71,
        72,
        71,
        72,
        71,
        72,
        71
      ],
      "total_ms": 4000
    },
    "room/hair-adjust/east": {
      "sheet": "sheet/room-hair-adjust-east.png",
      "tile": [
        85,
        114
      ],
      "cols": 16,
      "rows": 4,
      "count": 56,
      "canvas": [
        128,
        128
      ],
      "pivot": [
        64,
        120
      ],
      "crop": [
        11,
        7
      ],
      "anchor": [
        53,
        113
      ],
      "loop": false,
      "is_static": false,
      "frame_ms": null,
      "durations": [
        83,
        84,
        83,
        83,
        84,
        83,
        83,
        84,
        83,
        83,
        84,
        83,
        83,
        84,
        83,
        83,
        84,
        83,
        83,
        84,
        83,
        83,
        84,
        83,
        83,
        84,
        83,
        83,
        84,
        83,
        83,
        84,
        83,
        83,
        84,
        83,
        83,
        84,
        83,
        83,
        84,
        83,
        83,
        84,
        83,
        83,
        84,
        83,
        83,
        84,
        83,
        83,
        84,
        83,
        83,
        84
      ],
      "total_ms": 4667
    }
  };

/** 大厅实际要用到的贴图：文件名 → 相对 /play/assets/whale/ 的路径 */
export const WHALE_SHEETS = [
  'room-idle-east.png',
  'room-hair-adjust-east.png',
];
