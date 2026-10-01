import type { AccioRequest } from './accio.ts'

/** A labelled text heuristic, not a tokenizer or a truncation decision. */
export function estimateInput(req: AccioRequest): { estimatedInputTokens: number; contextEstimateIncomplete: boolean } {
  let text = req.systemInstruction + JSON.stringify(req.tools)
  let incomplete = false
  for (const turn of req.contents) for (const part of turn.parts) {
    text += part.text ?? ''
    text += part.functionCall?.argsJson ?? ''
    text += part.functionResponse?.responseJson ?? ''
    if (part.inlineData || part.fileData || part.thoughtSignature || part.functionCall?.thoughtSignature) incomplete = true
  }
  const ascii = (text.match(/[\x00-\x7f]/g) ?? []).length
  return { estimatedInputTokens: Math.ceil(ascii / 4 + (text.length - ascii) / 1.5), contextEstimateIncomplete: incomplete }
}
