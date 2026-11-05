<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
  ariaLabel?: string;
}>(), {
  width: 240,
  height: 36,
  color: 'hsl(220 84% 56%)',
  fill: true,
  ariaLabel: '',
});

const points = computed(() => {
  const values = props.values.filter((value) => Number.isFinite(value));
  if (values.length < 2) return '';
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * props.width;
      const y = props.height - ((value - min) / range) * (props.height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
});

const areaPoints = computed(() => (points.value
  ? `${points.value} ${props.width},${props.height} 0,${props.height}`
  : ''));
</script>

<template>
  <svg
    class="sparkline"
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    preserveAspectRatio="none"
    role="img"
    :aria-label="ariaLabel"
  >
    <polygon v-if="fill && areaPoints" :points="areaPoints" :fill="color" opacity="0.15" />
    <polyline v-if="points" :points="points" fill="none" :stroke="color" stroke-width="1.5" />
  </svg>
</template>

<style scoped>
.sparkline {
  display: block;
}
</style>
