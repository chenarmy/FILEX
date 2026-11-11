import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './styles/theme.css';
import './styles/workbench.css';

document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
});

createApp(App).use(createPinia()).mount('#app');
