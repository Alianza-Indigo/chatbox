import { describe, expect, it, vi } from 'vitest';
import { buildPromptArchitectBrief, generatePromptArchitectDraft } from '../src/services/prompt-architect.service';

describe('prompt architect service', () => {
  it('builds a structured brief with existing prompt context', () => {
    const brief = buildPromptArchitectBrief(
      {
        name: 'Asistente AMECREC',
        locale: 'es-MX',
        currentPrompt: 'Eres un asistente util.',
        branding: { companyName: 'Asociacion Mexicana', website: 'https://example.com', supportContact: 'contacto@example.com' },
      },
      {
        mode: 'advanced',
        objective: 'Calificar leads y responder dudas frecuentes',
        tone: 'Profesional y cercano',
        escalationRules: 'Escalar si piden asesoria legal o una cotizacion compleja',
      },
    );

    expect(brief).toContain('Modo de trabajo: Avanzado');
    expect(brief).toContain('Objetivo del agente: Calificar leads y responder dudas frecuentes');
    expect(brief).toContain('PROMPT ACTUAL A MEJORAR');
    expect(brief).toContain('Eres un asistente util.');
  });

  it('sanitizes fenced output from the provider', async () => {
    const provider = {
      complete: vi.fn().mockResolvedValue({
        text: '```text\n# ROL\nAtiende prospectos.\n```',
      }),
    };

    const draft = await generatePromptArchitectDraft({
      provider,
      apiKey: 'test-key',
      model: 'test-model',
      bot: { name: 'Bot demo', locale: 'es-MX' },
      blueprint: { mode: 'quick', objective: 'Atender preguntas frecuentes' },
    });

    expect(draft).toBe('# ROL\nAtiende prospectos.');
    expect(provider.complete).toHaveBeenCalledOnce();
  });
});
