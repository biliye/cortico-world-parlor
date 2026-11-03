<script setup lang="ts">
/** 中性的目的地提示；只有真实请求失败才给出恢复操作。 */
import Icon from './Icon.vue';

defineProps<{ destination: string; from: string; returning: boolean; error: string }>();
defineEmits<{ retry: [] }>();
</script>

<template>
  <main class="room-transit" :class="{ 'is-returning': returning, 'has-error': !!error }" aria-label="会馆转场">
    <a class="transit-brand" href="/play" aria-label="鲸语会馆"><Icon name="whale" /><span>鲸语 <small>PARLOR CLUB</small></span></a>
    <section class="transit-content" :role="error ? 'alert' : 'status'" :aria-busy="!error" aria-live="polite" aria-atomic="true">
      <div class="transit-symbol" aria-hidden="true"><Icon :name="returning ? 'lamp' : 'whale'" /></div>
      <p v-if="from" class="transit-route"><span>{{ from }}</span><span aria-hidden="true">→</span><b>{{ destination }}</b></p>
      <p v-else class="transit-route">即将到达 · {{ destination }}</p>
      <h1>{{ error ? '暂时没能进入' + destination : returning ? '正在返回大厅' : '正在进入' + destination }}</h1>
      <p class="transit-description">{{ error || (destination === '大厅' ? '正在为你打开大厅。' : '正在为你打开客厅。') }}</p>
      <div v-if="!error" class="transit-track" aria-hidden="true"><span /></div>
      <button v-else class="btn primary transit-retry" type="button" @click="$emit('retry')">重新连接</button>
    </section>
  </main>
</template>

<style scoped>
.room-transit {
  height: 100%; overflow-y: auto; box-sizing: border-box; padding: 36px 32px;
  display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 1fr; background: var(--bg); color: var(--text);
}
.transit-brand { display: flex; align-items: center; gap: 12px; width: fit-content; max-width: 100%; min-width: 0; color: var(--text); }
.transit-brand :deep(svg.icon) { width: 34px; height: 34px; color: var(--lime); }
.transit-brand > span { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; min-width: 0; font-size: 19px; font-weight: 700; }
.transit-brand small { font-size: 11px; letter-spacing: .16em; font-weight: 500; color: var(--muted); }
.transit-content {
  align-self: center; justify-self: center; width: min(100%, 440px); min-width: 0;
  padding: 36px 0 90px; text-align: center; animation: transit-arrive 180ms ease-out;
}
.transit-symbol {
  display: grid; place-items: center; width: 72px; height: 72px; margin: 0 auto 30px;
  border: 1px solid var(--line-2); border-radius: 50%; background: var(--bg-soft); color: var(--lime);
}
.transit-symbol :deep(svg.icon) { width: 32px; height: 32px; }
.transit-route { display: flex; justify-content: center; align-items: center; flex-wrap: wrap; gap: 12px; margin: 0 0 14px; color: var(--muted); font-size: 14px; overflow-wrap: anywhere; }
.transit-route b { font-weight: 500; color: var(--text); }
.transit-content h1 { margin: 0; font-size: clamp(25px, 4vw, 32px); line-height: 1.35; font-weight: 600; letter-spacing: .02em; overflow-wrap: anywhere; text-wrap: balance; }
.transit-description { margin: 16px 0 0; color: var(--muted); font-size: 15px; line-height: 1.75; overflow-wrap: anywhere; }
.transit-track { width: 100px; height: 3px; margin: 30px auto 0; border-radius: 3px; background: var(--line-2); overflow: hidden; }
.transit-track span { display: block; width: 36px; height: 100%; border-radius: inherit; background: var(--lime); animation: transit-travel 1.2s ease-in-out infinite alternate; }
.is-returning .transit-track span { animation-direction: alternate-reverse; }
.transit-retry { margin-top: 28px; width: min(100%, 160px); min-width: 0; transition: transform 150ms ease; }
.transit-retry:active { transform: scale(.98); }
.transit-retry:focus-visible, .transit-brand:focus-visible { outline: 2px solid var(--lime); outline-offset: 5px; }
.has-error .transit-symbol { color: var(--muted); }
@keyframes transit-arrive { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
@keyframes transit-travel { from { transform: translateX(0); } to { transform: translateX(64px); } }
@media (max-width: 540px) { .room-transit { padding: 24px; } .transit-brand small { font-size: 10px; } .transit-content { padding-bottom: 60px; } }
@media (max-width: 320px) { .room-transit { padding-inline: 16px; } .transit-brand small { display: none; } }
@media (max-height: 600px) {
  .room-transit { padding-block: 20px; }
  .transit-content { padding: 12px 0; }
  .transit-symbol { width: 56px; height: 56px; margin-bottom: 16px; }
  .transit-track { margin-top: 24px; }
}
@media (prefers-reduced-motion: reduce) { .transit-content, .transit-track span { animation: none; } .transit-track span { margin: auto; } .transit-retry { transition: none; } }
</style>
