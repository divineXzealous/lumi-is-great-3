// Entry point. Express keeps a web port open (Replit needs one) and
// starts the WhatsApp connection.
const express = require('express');
const config = require('./config');
const log = require('./logger');
const db = require('./db');
const memory = require('./memory');
const settings = require('./settings');
const extras = require('./extras');
const { start, state } = require('./connection');
const sessions = require('./sessions');
const { handleMessage } = require('./messageHandler');

const app = express();
app.get('/', (_req, res) => res.send('Lumi is up.'));
app.get('/health', (_req, res) => res.json({ status: state.status, paired: sessions.list().length, uptimeSec: Math.floor(process.uptime()) }));

app.listen(config.port, () => log.info(`Web server on port ${config.port}`));

process.on('unhandledRejection', (e) => log.error('Unhandled rejection:', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => log.error('Uncaught exception:', e && e.message ? e.message : e));

(async () => {
  await db.init();        // no-op unless DATABASE_URL is set
  await memory.init();
  await settings.init();
  await extras.init();
  await require('./groupfun').init();
  await require('./stickerbox').init();
  await require('./social').init();
  await require('./favstickers').init();
  await require('./blocklist').init();
  await require('./chatlog').init();
  await sessions.init();
  sessions.setHandler(handleMessage);
  await start(handleMessage);
  sessions.resumeAll().catch((e) => log.error('Could not resume paired numbers:', e.message));
})().catch((e) => log.error('Failed to start:', e.message));
