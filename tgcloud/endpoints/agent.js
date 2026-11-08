import { executeCode } from '../lib/runner.js';

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
  }

  try {
    const body = await request.json();
    const { prompt, action = 'chat', language = 'python' } = body;

    if (action === 'execute') {
      const result = await executeCode(prompt, language);
      return new Response(JSON.stringify({ response: result }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ response: `Terminal AI: Command ${prompt} processed.` }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
