export type AssistantProviderPresetId =
  | 'openai'
  | 'deepseek'
  | 'gemini'
  | 'kimi'
  | 'qwen'
  | 'zhipu'
  | 'minimax'
  | 'openrouter'
  | 'ollama'
  | 'custom';

export interface AssistantProviderPreset {
  id: AssistantProviderPresetId;
  name: string;
  endpoint: string;
  defaultModel: string;
  models: string[];
}

export const assistantProviderPresets: readonly AssistantProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1-mini',
    models: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'gemini',
    name: 'Gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.0-flash',
    models: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  },
  {
    id: 'kimi',
    name: 'Kimi',
    endpoint: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  },
  {
    id: 'qwen',
    name: 'Qwen',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen2.5-coder-32b-instruct'],
  },
  {
    id: 'zhipu',
    name: 'Zhipu',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    models: ['glm-4-flash', 'glm-4-plus', 'glm-4-long'],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    endpoint: 'https://api.minimax.chat/v1',
    defaultModel: 'MiniMax-Text-01',
    models: ['MiniMax-Text-01', 'abab6.5s-chat'],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-3.5-sonnet',
    models: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o', 'deepseek/deepseek-chat'],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    endpoint: 'http://127.0.0.1:11434/v1',
    defaultModel: 'llama3.2',
    models: ['llama3.2', 'qwen2.5-coder:7b', 'deepseek-r1:7b'],
  },
  {
    id: 'custom',
    name: 'Custom',
    endpoint: '',
    defaultModel: '',
    models: [],
  },
];

export function assistantProviderPresetById(id: AssistantProviderPresetId): AssistantProviderPreset {
  return assistantProviderPresets.find((preset) => preset.id === id)
    ?? assistantProviderPresets[assistantProviderPresets.length - 1]!;
}

export function normalizeAssistantEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '');
}

export function matchAssistantProviderPreset(endpoint: string): AssistantProviderPreset {
  const normalized = normalizeAssistantEndpoint(endpoint);
  return assistantProviderPresets.find((preset) => preset.id !== 'custom'
    && normalizeAssistantEndpoint(preset.endpoint) === normalized)
    ?? assistantProviderPresetById('custom');
}

export function assistantEndpointAllowsKeyless(endpoint: string): boolean {
  try {
    const url = new URL(normalizeAssistantEndpoint(endpoint));
    return url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

export function assistantSuggestedModels(presetId: AssistantProviderPresetId, currentModel = ''): string[] {
  const preset = assistantProviderPresetById(presetId);
  return [...new Set([
    ...(currentModel.trim() ? [currentModel.trim()] : []),
    ...preset.models,
  ])];
}
