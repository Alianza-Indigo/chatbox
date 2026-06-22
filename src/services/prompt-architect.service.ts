import type { BotBranding } from '@prisma/client';
import type { LLMProvider } from '../providers/llm';

export interface PromptArchitectBlueprint {
  mode: 'quick' | 'advanced';
  assistantName?: string;
  businessName?: string;
  objective: string;
  audience?: string;
  tone?: string;
  businessContext?: string;
  offerings?: string;
  successCriteria?: string;
  happyPath?: string;
  conversationFlow?: string;
  knowledgePolicy?: string;
  variables?: string;
  tools?: string;
  escalationRules?: string;
  handoffTriggers?: string;
  outOfScope?: string;
  prohibitedContent?: string;
  outputFormat?: string;
  exampleDialogues?: string;
  testScenarios?: string;
}

interface GeneratePromptArchitectDraftInput {
  provider: LLMProvider;
  apiKey: string;
  model: string;
  bot: {
    name: string;
    locale: string;
    currentPrompt?: string | null;
    branding?: Pick<BotBranding, 'companyName' | 'website' | 'supportContact'> | null;
  };
  blueprint: PromptArchitectBlueprint;
}

const ARCHITECT_SYSTEM_PROMPT = `
Eres un arquitecto senior de prompts para agentes conversacionales de WhatsApp de Whabot.

Tu tarea es redactar un SYSTEM PROMPT listo para produccion, en espanol, claro, operativo y versionable.

Reglas:
- Devuelve solo el system prompt final. No agregues explicaciones, prefacios ni bloques de markdown.
- Escribe instrucciones accionables, no teoria.
- Si hay un prompt actual, mejoralo y reestructuralo sin perder la intencion del negocio.
- Respeta el tono, alcance y restricciones del brief.
- El agente debe evitar inventar datos cuando el conocimiento o las variables no alcancen.
- Cuando el brief lo sugiera, incluye rutas de escalamiento a humano, uso de conocimiento, manejo de datos sensibles y limites de promesas.
- Mantén una estructura profesional con encabezados simples como:
ROL, OBJETIVO, CONTEXTO, TONO, FLUJO, CONOCIMIENTO, ESCALAMIENTO, RESTRICCIONES, FORMATO.
- Prioriza respuestas utiles para operacion real por WhatsApp: cortas, claras, guiadas a cierre o siguiente paso.
`.trim();

export async function generatePromptArchitectDraft(input: GeneratePromptArchitectDraftInput): Promise<string> {
  const response = await input.provider.complete({
    systemPrompt: ARCHITECT_SYSTEM_PROMPT,
    history: [],
    userMessage: buildPromptArchitectBrief(input.bot, input.blueprint),
    apiKey: input.apiKey,
    model: input.model,
    params: { temperature: 0.35, max_tokens: 1400 },
  });

  return sanitizeDraft(response.text);
}

export function buildPromptArchitectBrief(
  bot: GeneratePromptArchitectDraftInput['bot'],
  blueprint: PromptArchitectBlueprint,
): string {
  const sections = [
    ['Modo de trabajo', blueprint.mode === 'advanced' ? 'Avanzado' : 'Rapido'],
    ['Nombre interno del agente', blueprint.assistantName || bot.name],
    ['Negocio o marca', blueprint.businessName || bot.branding?.companyName || bot.name],
    ['Locale principal', bot.locale],
    ['Objetivo del agente', blueprint.objective],
    ['Audiencia principal', blueprint.audience],
    ['Tono y estilo', blueprint.tone],
    ['Contexto del negocio', blueprint.businessContext],
    ['Productos, servicios o casos que atiende', blueprint.offerings],
    ['Criterios de exito', blueprint.successCriteria],
    ['Flujo ideal de atencion', blueprint.happyPath],
    ['Flujo conversacional detallado', blueprint.conversationFlow],
    ['Politica de conocimiento', blueprint.knowledgePolicy],
    ['Variables dinamicas esperadas', blueprint.variables],
    ['Herramientas o integraciones disponibles', blueprint.tools],
    ['Reglas de escalamiento', blueprint.escalationRules],
    ['Disparadores para handoff humano', blueprint.handoffTriggers],
    ['Fuera de alcance', blueprint.outOfScope],
    ['Contenido o conductas prohibidas', blueprint.prohibitedContent],
    ['Formato de salida esperado', blueprint.outputFormat],
    ['Ejemplos o dialogos de referencia', blueprint.exampleDialogues],
    ['Escenarios de prueba', blueprint.testScenarios],
    ['Sitio o referencia publica', bot.branding?.website],
    ['Contacto de soporte', bot.branding?.supportContact],
  ]
    .filter(([, value]) => Boolean(value && String(value).trim()))
    .map(([label, value]) => `- ${label}: ${String(value).trim()}`);

  const currentPromptSection = bot.currentPrompt?.trim()
    ? `\nPROMPT ACTUAL A MEJORAR\n${bot.currentPrompt.trim()}\n`
    : '\nNo existe prompt actual publicado. Genera la primera version.\n';

  return [
    'Construye el system prompt final para este agente de Whabot.',
    '',
    'BRIEF',
    ...sections,
    currentPromptSection.trimEnd(),
    '',
    'INSTRUCCIONES ADICIONALES',
    '- Piensa en conversaciones de WhatsApp de negocio a cliente.',
    '- Si falta informacion, redacta supuestos prudentes y operativos dentro del prompt, sin mencionarlos como duda.',
    '- El resultado debe quedar listo para pegarse y publicarse como nueva version del prompt.',
  ].join('\n');
}

function sanitizeDraft(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```[\w-]*\s*/u, '').replace(/\s*```$/u, '').trim();
}
