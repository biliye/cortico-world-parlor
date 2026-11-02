/**
 * Vue 客户端的入口。
 *
 * 页面用一支 loader 分派：默认载入这里；?legacy=1 回退旧 play.js。
 * 挂载前给 <html> 打上 vue-app 标记：新的夜航会馆视觉只作用在这棵树上，
 * 旧页（回退用）继续用老样式，互不打架。
 */
import { createApp } from 'vue';
import App from './App.vue';

document.documentElement.classList.add('vue-app');

const host = document.getElementById('app') || document.body;
host.replaceChildren();

createApp(App).mount(host);
