// @aurix/model-gateway-client — typed caller for the gateway (server enforces redaction).
export interface ChatRequest {
  promptName: string;
  promptVersion: string;
  messages: { role: string; content: string }[];
  traceId: string;
}
export interface ChatResponse {
  text: string;
  provider: string;
  model: string;
  promptVersion: string;
}
