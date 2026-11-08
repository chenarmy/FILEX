import { describe, expect, it } from 'vitest';
import {
  assistantEndpointAllowsKeyless,
  assistantProviderPresetById,
  assistantSuggestedModels,
  matchAssistantProviderPreset,
  normalizeAssistantEndpoint,
} from '@/domain/assistantProviders';

describe('assistant provider presets', () => {
  it('matches known endpoints after normalizing a trailing slash', () => {
    expect(matchAssistantProviderPreset(' https://api.deepseek.com/v1/ ').id).toBe('deepseek');
    expect(matchAssistantProviderPreset('https://unknown.example/v1').id).toBe('custom');
    expect(normalizeAssistantEndpoint(' https://api.openai.com/v1/// ')).toBe('https://api.openai.com/v1');
  });

  it('allows keyless configuration only for loopback HTTP endpoints', () => {
    expect(assistantEndpointAllowsKeyless('http://127.0.0.1:11434/v1')).toBe(true);
    expect(assistantEndpointAllowsKeyless('http://localhost:11434/v1')).toBe(true);
    expect(assistantEndpointAllowsKeyless('http://[::1]:11434/v1')).toBe(true);
    expect(assistantEndpointAllowsKeyless('https://api.example.com/v1')).toBe(false);
    expect(assistantEndpointAllowsKeyless('http://192.0.2.10:11434/v1')).toBe(false);
  });

  it('keeps a current model available when a preset uses a different default', () => {
    const preset = assistantProviderPresetById('ollama');
    expect(assistantSuggestedModels('ollama', 'custom-local:latest')).toEqual([
      'custom-local:latest',
      ...preset.models,
    ]);
  });
});
