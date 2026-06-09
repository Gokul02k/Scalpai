import { groqChat } from '../../lib/groq';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const { system, messages, model } = await request.json();

    if (!messages?.length) {
      return Response.json({ error: 'No messages provided' }, { status: 400 });
    }

    const text = await groqChat({ system, messages, model });
    return Response.json({ text });
  } catch (error) {
    console.error('Chat API error:', error);
    const message = error.message || 'Failed to reach Groq';
    const status = /not set/i.test(message) ? 503 : 502;
    return Response.json({ error: message }, { status });
  }
}
