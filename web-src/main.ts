/**
 * Vue 客户端的入口。
 *
 * 页面用一支 loader 载入这里（旧 play.js 已在 0.40.0 下线，不再有第二支）。
 * 挂载前给 <html> 打上 vue-app 标记：夜航会馆视觉只作用在这棵树上。
 */
import { createApp } from 'vue';
import App from './App.vue';

document.documentElement.classList.add('vue-app');

const host = document.getElementById('app') || document.body;
host.replaceChildren();

createApp(App).mount(host);
