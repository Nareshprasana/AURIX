// Gateway-backed research interpreter (P1-5). Lives in model-gateway so the
// research-agents boundary stays intact: this module adapts ModelGateway to
// the interpreter shape ({ interpret(prompt, input) }) WITHOUT research code
// importing the gateway. Wiring is always explicit and opt-in — the research
// orchestrator defaults to no interpreter (deterministic core stands).
import { ModelGateway } from './index.js';

export interface ResearchInterpreter {
  interpret(prompt: string, input: string): Promise<{ text: string; model: string }>;
}

export interface InterpreterPolicy {
  /** Which agent IDs may receive LLM interpretation. Default: fundamental only. */
  allowedAgents: string[];
  promptName: string;
  promptVersion: string;
  caller: string;
}

export const DEFAULT_INTERPRETER_POLICY: InterpreterPolicy = {
  allowedAgents: ['fundamental'],
  promptName: 'agent-interpretation',
  promptVersion: 'v1',
  caller: 'research-agents'
};

export function gatewayInterpreter(
  gw: ModelGateway,
  policy: Partial<InterpreterPolicy> = {},
  traceIdPrefix = 'interp'
): ResearchInterpreter {
  const merged = { ...DEFAULT_INTERPRETER_POLICY, ...policy };
  let n = 0;
  return {
    async interpret(prompt: string, input: string) {
      n += 1;
      const r = await gw.chat({
        promptName: merged.promptName,
        promptVersion: merged.promptVersion,
        input: `[${prompt}] ${input}`,
        caller: merged.caller,
        traceId: `${traceIdPrefix}-${n}`
      });
      return { text: r.text, model: r.model };
    }
  };
}

/** Per-agent gate: only explicitly allowed agents get the interpreter. */
export function interpreterForAgent(
  agentId: string,
  interp: ResearchInterpreter | undefined,
  policy: Partial<InterpreterPolicy> = {}
): ResearchInterpreter | undefined {
  const allowed = policy.allowedAgents ?? DEFAULT_INTERPRETER_POLICY.allowedAgents;
  if (!interp || !allowed.includes(agentId)) return undefined;
  return interp;
}
