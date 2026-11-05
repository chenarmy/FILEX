<script setup lang="ts" generic="T">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { computeVirtualWindow } from '@/utils/virtualWindow';

const props = withDefaults(defineProps<{
  items: T[];
  rowHeight?: number;
  overscan?: number;
}>(), {
  rowHeight: 34,
  overscan: 8,
});

const host = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(480);
let resizeObserver: ResizeObserver | null = null;

const window = computed(() => computeVirtualWindow(
  scrollTop.value,
  viewportHeight.value,
  props.items.length,
  props.rowHeight,
  props.overscan,
));

const visibleItems = computed(() => props.items.slice(window.value.startIndex, window.value.endIndex));

function onScroll(event: Event): void {
  if (event.target instanceof HTMLElement) scrollTop.value = event.target.scrollTop;
}

onMounted(() => {
  if (!host.value) return;
  viewportHeight.value = host.value.clientHeight || viewportHeight.value;
  resizeObserver = new ResizeObserver(() => {
    if (host.value) viewportHeight.value = host.value.clientHeight || viewportHeight.value;
  });
  resizeObserver.observe(host.value);
});

onBeforeUnmount(() => resizeObserver?.disconnect());
</script>

<template>
  <div ref="host" class="virtual-list" @scroll.passive="onScroll">
    <div class="virtual-list-phantom" :style="{ height: `${window.totalHeight}px` }">
      <div class="virtual-list-window" :style="{ transform: `translateY(${window.startOffset}px)` }">
        <div
          v-for="(item, index) in visibleItems"
          :key="window.startIndex + index"
          class="virtual-list-row"
          :style="{ height: `${rowHeight}px` }"
        >
          <slot :item="item" :index="window.startIndex + index" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.virtual-list {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.virtual-list-phantom {
  position: relative;
  width: 100%;
}

.virtual-list-window {
  position: absolute;
  inset-inline: 0;
  top: 0;
}

.virtual-list-row {
  display: flex;
  align-items: center;
}
</style>
