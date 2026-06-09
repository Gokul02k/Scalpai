import { aiChat, AI_SETUP_HINT } from '../../lib/ai';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const { system, messages } = await request.json();

    if (!messages?.length) {
      return Response.json({ error: 'No messages provided' }, { status: 400 });
    }

    const text = await aiChat({ system, messages });
    return Response.json({ text });
  } catch (error) {
    console.error('Chat API error:', error);
    const message = error.message || 'Failed to reach AI service';
    const status = /not configured|not set/i.test(message) ? 503 : 502;
    const needsHint = /not configured|not set|quota|rate limit/i.test(message);
    return Response.json(
      { error: needsHint ? `${message} ${AI_SETUP_HINT}` : message },
      { status }
    );
  }
}
