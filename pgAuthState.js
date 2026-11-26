// Stores the WhatsApp login (credentials + keys) in Postgres instead of files.
// Same idea as Baileys' useMultiFileAuthState.
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const db = require('./db');

async function read(P, key) {
  const v = await db.get(P + key);
  return v ? JSON.parse(v, BufferJSON.reviver) : null;
}
const write = (P, key, value) => db.set(P + key, JSON.stringify(value, BufferJSON.replacer));

// prefix: 'auth:' for Lumi's own login; paired numbers use their own prefix ('auth:p<number>:').
async function usePgAuthState(P = 'auth:') {
  const creds = (await read(P, 'creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          await Promise.all(ids.map(async (id) => {
            let v = await read(P, `${type}-${id}`);
            if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
            out[id] = v;
          }));
          return out;
        },
        set: async (data) => {
          const jobs = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const v = data[category][id];
              jobs.push(v ? write(P, `${category}-${id}`, v) : db.del(`${P}${category}-${id}`));
            }
          }
          await Promise.all(jobs);
        },
      },
    },
    saveCreds: () => write(P, 'creds', creds),
  };
}

module.exports = { usePgAuthState };
