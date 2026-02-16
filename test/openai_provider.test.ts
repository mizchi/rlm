import { afterEach, describe, expect, test, vi } from 'vitest';
import { OpenAIProvider } from '../src/llm/OpenAIProvider.ts';

const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_RLM_OPENAI_API_KEY = process.env.RLM_OPENAI_API_KEY;

const restoreEnv = (): void => {
  if (ORIGINAL_OPENAI_API_KEY === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_API_KEY;
  }
  if (ORIGINAL_RLM_OPENAI_API_KEY === undefined) {
    delete process.env.RLM_OPENAI_API_KEY;
  } else {
    process.env.RLM_OPENAI_API_KEY = ORIGINAL_RLM_OPENAI_API_KEY;
  }
};

const mockFetchOK = () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"op":"finalize","from":"answer"}' } }],
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const authHeaderFromInit = (init: RequestInit | undefined): string | null =>
  new Headers(init?.headers as HeadersInit | undefined).get('authorization');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restoreEnv();
});

describe('OpenAIProvider api key resolution', () => {
  test('RLM_OPENAI_API_KEY を認識する', async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.RLM_OPENAI_API_KEY = 'rlm-key';
    const fetchMock = mockFetchOK();

    const provider = new OpenAIProvider({ model: 'gpt-4.1-mini' });
    await provider.complete([{ role: 'user', content: 'hello' }]);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(authHeaderFromInit(init)).toBe('Bearer rlm-key');
  });

  test('apiKey 引数が環境変数より優先される', async () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.RLM_OPENAI_API_KEY = 'rlm-key';
    const fetchMock = mockFetchOK();

    const provider = new OpenAIProvider({
      model: 'gpt-4.1-mini',
      apiKey: 'explicit-key',
    });
    await provider.complete([{ role: 'user', content: 'hello' }]);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(authHeaderFromInit(init)).toBe('Bearer explicit-key');
  });

  test('キー未設定時は分かるエラーメッセージを返す', () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.RLM_OPENAI_API_KEY;

    expect(() => new OpenAIProvider({ model: 'gpt-4.1-mini' })).toThrowError(
      /RLM_OPENAI_API_KEY|OPENAI_API_KEY/,
    );
  });
});
