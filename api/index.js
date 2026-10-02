// Vercel entry point: every /api/*, /oauth/* and /media/* request is handled here.
// The app is loaded lazily so a startup problem shows up as a readable error message
// instead of Vercel's generic FUNCTION_INVOCATION_FAILED page.
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));

let handlerP = null;

export default async function vercelHandler(req, res) {
  try {
    handlerP ??= import('../src/server.js').then((m) => m.handler);
    const handler = await handlerP;
    return await handler(req, res);
  } catch (e) {
    handlerP = null;
    console.error('startup error:', e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: `Server startup problem: ${e.message}` }));
    }
  }
}
