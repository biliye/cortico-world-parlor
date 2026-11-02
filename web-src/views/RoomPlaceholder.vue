<script setup lang="ts">
/** 客厅页的占位：这一刀只把入口和大厅接真服务，客厅与牌桌留到第 2 刀后半 / 第 3 刀。 */
import { goRoom, snapshot } from '../stores/parlor.ts';

async function backToHall(): Promise<void> {
  await goRoom('hall');
}
</script>

<template>
  <div class="view view-lobby">
    <header class="topbar">
      <p class="brand">鲸语 <small>PARLOR CLUB</small></p>
      <button class="btn ghost small" type="button" @click="backToHall">回大厅</button>
    </header>
    <section class="panel">
      <span class="eyebrow">PARLOR</span>
      <h1>{{ snapshot?.name || snapshot?.id }}</h1>
      <p class="sub">这间客厅的成员、聊天和牌桌还在迁移中：聊天外壳在第 2 刀后半，牌桌在第 3 刀。</p>
      <p class="muted">{{ snapshot?.seats?.length || 0 }} / {{ snapshot?.maxSeats || 30 }} 人在客厅</p>
    </section>
  </div>
</template>
