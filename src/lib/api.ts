import { SYSTEM_PROMPTS, SAFETY_SETTINGS } from '../constants';
import { FuncType, Message } from '../types';

const QWEN_API_KEY = 'sk-e2e47dc4977d4b7d8a74f60674fa69fc';
const QWEN_API_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

const GEMINI_API_KEY = 'sk-8CaGPhYzMiXPsf7DC0ygpn2pVWv95o4KrXknfgLJsbs9veTz';
const GEMINI_API_BASE_URL = 'https://yunwu.ai/v1beta/models';

function buildQwenRequestBody(messages: Message[], func: FuncType, modelId: string, stream: boolean = false, subFunc?: string) {
  let systemPrompt = SYSTEM_PROMPTS[func] || SYSTEM_PROMPTS.chat;
  
  if (func === 'drama' && subFunc) {
    systemPrompt += `\n\n【重要指令】用户已选择功能：${subFunc}。请直接跳过步骤1的询问，直接开始执行该功能的步骤2。`;
  }
  
  const formattedMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    })),
  ];

  return {
    model: modelId,
    messages: formattedMessages,
    stream: stream,
  };
}

function buildGeminiRequestBody(messages: Message[], func: FuncType, subFunc?: string) {
  let systemPrompt = SYSTEM_PROMPTS[func] || SYSTEM_PROMPTS.chat;
  
  if (func === 'drama' && subFunc) {
    systemPrompt += `\n\n【重要指令】用户已选择功能：${subFunc}。请直接跳过步骤1的询问，直接开始执行该功能的步骤2。`;
  }

  const contents = messages.map((m) => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content }],
  }));

  return {
    contents,
    systemInstruction: {
      parts: [{ text: systemPrompt }],
      role: 'user',
    },
    safetySettings: SAFETY_SETTINGS,
    tools: [],
    generationConfig: {
      temperature: 1,
      topP: 1,
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget: 26240,
      },
    },
  };
}

export async function callGeminiStreamAPI(
  messages: Message[],
  func: FuncType,
  modelId: string,
  apiKey: string,
  subFunc: string | undefined,
  onChunk: (text: string) => void,
  onThinking: (text: string) => void,
  signal: AbortSignal
) {
  const isGemini = modelId.startsWith('gemini');
  
  let apiUrl = '';
  let fetchOptions: RequestInit = {};

  if (isGemini) {
    apiUrl = `${GEMINI_API_BASE_URL}/${modelId}:streamGenerateContent?key=&alt=sse`;
    const body = buildGeminiRequestBody(messages, func, subFunc);
    fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GEMINI_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal,
    };
  } else {
    apiUrl = `${QWEN_API_BASE_URL}/chat/completions`;
    const body = buildQwenRequestBody(messages, func, modelId, true, subFunc);
    fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${QWEN_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal,
    };
  }

  const response = await fetch(apiUrl, fetchOptions);

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    let errMsg = `API错误: ${response.status}`;
    try {
      const errData = JSON.parse(errText);
      if (errData?.error?.message) errMsg = errData.error.message;
    } catch (e) {
      if (errText) errMsg += ' - ' + errText.slice(0, 200);
    }
    throw new Error(errMsg);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No reader available');
  const decoder = new TextDecoder();
  let fullText = '';
  let thinkingText = '';
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('data:')) {
          const jsonStr = trimmedLine.slice(5).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;
          try {
            const data = JSON.parse(jsonStr);
            if (isGemini) {
              const parts = data.candidates?.[0]?.content?.parts || [];
              for (const part of parts) {
                if (part.thought) {
                  thinkingText += part.thought;
                  onThinking(thinkingText);
                } else if (part.text) {
                  fullText += part.text;
                  onChunk(fullText);
                }
              }
            } else {
              if (data.choices?.[0]?.delta?.content) {
                fullText += data.choices[0].delta.content;
                onChunk(fullText);
              }
            }
          } catch (e) {
            if (e instanceof Error && e.message !== 'Unexpected end of JSON input') {
              console.error('JSON parse error or API error:', e);
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { text: fullText, thinking: thinkingText };
}

export async function callGeminiAPI(
  messages: Message[],
  func: FuncType,
  modelId: string,
  apiKey: string,
  subFunc: string | undefined,
  signal: AbortSignal
) {
  const isGemini = modelId.startsWith('gemini');
  
  let apiUrl = '';
  let fetchOptions: RequestInit = {};

  if (isGemini) {
    apiUrl = `${GEMINI_API_BASE_URL}/${modelId}:generateContent?key=`;
    const body = buildGeminiRequestBody(messages, func, subFunc);
    fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GEMINI_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal,
    };
  } else {
    apiUrl = `${QWEN_API_BASE_URL}/chat/completions`;
    const body = buildQwenRequestBody(messages, func, modelId, false, subFunc);
    fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${QWEN_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal,
    };
  }

  const response = await fetch(apiUrl, fetchOptions);

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    let errMsg = `API错误: ${response.status}`;
    try {
      const errData = JSON.parse(errText);
      if (errData?.error?.message) errMsg = errData.error.message;
    } catch (e) {
      if (errText) errMsg += ' - ' + errText.slice(0, 200);
    }
    throw new Error(errMsg);
  }

  const data = await response.json();
  
  if (isGemini) {
    const parts = data.candidates?.[0]?.content?.parts || [];
    let text = '';
    let thinking = '';
    for (const part of parts) {
      if (part.thought) thinking += part.thought;
      else if (part.text) text += part.text;
    }
    return { text, thinking };
  } else {
    if (data.choices?.[0]?.message?.content) {
      return { text: data.choices[0].message.content, thinking: '' };
    }
  }
  
  throw new Error('API返回了意外的响应格式');
}
