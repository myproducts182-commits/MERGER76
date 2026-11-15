// /api/mcp — خادم MCP (Streamable HTTP، عديم الحالة). يُعاد توجيه /mcp → هنا عبر vercel.json
const { handleMcp } = require('../lib/mcp-server');

module.exports = async (req, res) => {
  try {
    await handleMcp(req, res);
  } catch (e) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null }));
    }
  }
};
