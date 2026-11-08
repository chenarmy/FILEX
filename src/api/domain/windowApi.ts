import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauriRuntime } from '@/api/common';

export function desktopWindowControlsAvailable(): boolean {
  return isTauriRuntime();
}

export async function minimizeCurrentWindow(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    await getCurrentWindow().minimize();
    return true;
  } catch {
    return false;
  }
}

export async function closeCurrentWindow(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    await getCurrentWindow().close();
    return true;
  } catch {
    return false;
  }
}

export async function isCurrentWindowMaximized(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    return await getCurrentWindow().isMaximized();
  } catch {
    return false;
  }
}

export async function toggleCurrentWindowMaximize(): Promise<boolean | null> {
  if (!isTauriRuntime()) return null;
  try {
    const currentWindow = getCurrentWindow();
    await currentWindow.toggleMaximize();
    return await currentWindow.isMaximized();
  } catch {
    return null;
  }
}

export async function onCurrentWindowResized(listener: () => void): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};
  try {
    return await getCurrentWindow().onResized(listener);
  } catch {
    return () => {};
  }
}

export async function startDraggingCurrentWindow(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    await getCurrentWindow().startDragging();
    return true;
  } catch {
    return false;
  }
}
