require('dotenv').config();
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const MONGO_COLLECTION = process.env.MONGO_COLLECTION || 'baileys_auth_session';

if (!MONGO_URI) {
    console.error("FATAL ERROR: MONGO_URI is not defined in .env file. Please add it and ensure it starts with mongodb://");
    process.exit(1);
}

let sock;
let currentQR = null; // Variable to store the current QR code

// --- Mongoose / MongoDB Setup ---
mongoose.connect(MONGO_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => {
      console.error('Could not connect to MongoDB. Please check your MONGO_URI in .env file.', err);
      process.exit(1);
  });

// Schema for Baileys Auth Session
const AuthSessionSchema = new mongoose.Schema({
  _id: String,
  session: String,
});
const AuthSession = mongoose.model('AuthSession', AuthSessionSchema, MONGO_COLLECTION);

const useMongoDBAuthState = async (sessionId) => {
  const getKey = (id) => `${sessionId}-${id}`;

  const writeData = async (data, id) => {
    const session = JSON.stringify(data, BufferJSON.replacer);
    await AuthSession.updateOne({ _id: getKey(id) }, { _id: getKey(id), session }, { upsert: true });
  };

  const readData = async (id) => {
    const doc = await AuthSession.findOne({ _id: getKey(id) });
    if (doc && doc.session) {
      return JSON.parse(doc.session, BufferJSON.reviver);
    }
    return null;
  };

  const clearData = async () => {
      await AuthSession.deleteMany({ _id: { $regex: `^${sessionId}-` } });
  }

  const creds = await readData('creds') || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => {
      return writeData(creds, 'creds');
    },
    clearData,
  };
};
// --- End of Mongoose / MongoDB Auth Store ---


// Menyajikan file statis dari direktori root
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('A browser connected.');

    if (sock && sock.user) {
        socket.emit('status', { status: 'Connected', user: sock.user.id.split(':')[0] });
    } else if (currentQR) {
        socket.emit('qr_code', currentQR);
    } else {
        socket.emit('status', { status: 'Disconnected' });
    }

    socket.on('logout', async () => {
        if (sock) {
            console.log('Logout request received. Logging out...');
            try {
                await sock.logout();
            } catch (error) {
                console.error('Error during logout:', error);
            }
        } else {
            console.log('Logout request received, but no active WhatsApp connection.');
        }
    });

    socket.on('disconnect', () => {
        console.log('Browser disconnected.');
    });
});


async function connectToWhatsApp() {
    const sessionId = MONGO_COLLECTION;
    const { state, saveCreds, clearData } = await useMongoDBAuthState(sessionId);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        printQRInTerminal: false,
        auth: state,
        shouldIgnoreJid: jid => jid.includes('@broadcast'),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('QR code received, sending to all clients.');
            currentQR = qr;
            io.emit('qr_code', qr);
        }

        if (connection === 'close') {
            currentQR = null;
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting: ', shouldReconnect);

            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('Permanent disconnect detected. Clearing session and restarting...');
                io.emit('status', { status: 'Disconnected' });
                try {
                    await clearData();
                    sock = undefined;
                    connectToWhatsApp();
                } catch (error) {
                    console.error('Error during cleanup and restart:', error);
                }
            }
        } else if (connection === 'open') {
            currentQR = null;
            const userNumber = sock.user.id.split(':')[0];
            console.log('WhatsApp connection open, connected as', userNumber);
            io.emit('status', { status: 'Connected', user: userNumber });
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            const sender = msg.key.remoteJid;
            const messageContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            
            if(messageContent) {
                console.log(`Pesan dari ${sender}: ${messageContent}`);
                io.emit('new_message', { from: sender, message: messageContent });
            }
        }
    });
}

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    connectToWhatsApp();
});
