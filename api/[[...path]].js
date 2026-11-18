// api/[[...path]].js — الدالة الوحيدة على Vercel: كل مسارات /api/* و /mcp تمر من هنا.
// (خطة Hobby تسمح بـ 12 Serverless Function كحد أقصى — كانت المشروع 14، الآن 1)
// التوزيع الفعلي في lib/router.js — نفس الموزع يستخدمه خادم التطوير المحلي.
const { handle } = require('../lib/router');

module.exports = async (req, res) => handle(req, res);
