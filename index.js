require('dotenv').config();
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const mongoose = require('mongoose');
const kirimPesan = require('./routes/kirimPesan.js');
const kirimMedia = require('./routes/kirimMedia.js');
const cetakPesan = require('./routes/cetakPesan.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware to parse JSON request bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Tambahkan ini untuk parsing form-data/urlencoded jika diperlukan

const PORT = process.env.PORT || 8000; // Fallback to 8000 if not defined
const MONGO_URI = process.env.MONGO_URI;
const MONGO_COLLECTION = process.env.MONGO_COLLECTION;

if (!MONGO_URI) {
    console.error("FATAL ERROR: MONGO_URI is not defined in .env file. Please add it and ensure it starts with mongodb://");
    process.exit(1);
}

let sock;
let currentQR = null; // Variable to store the current QR code

// --- Printer Logic Variables ---
let printerPairingCode = generatePairingCode(); // Generate code on start
let printerSocket = null; // Store the active printer socket

function generatePairingCode() {
    return Math.floor(100000 + Math.random() * 900000).toString(); // 6 digit random number
}
// --- End Printer Logic Variables ---

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

// untuk kirim pesan & media
app.use('/kirim-pesan', kirimPesan.router);
app.use('/kirim-media', kirimMedia.router);
app.use('/cetak-pesan', cetakPesan.router);

// Menyajikan file statis dari direktori root
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    // Ambil IP Address Client
    const clientIp = socket.handshake.address;
    // console.log(`New socket connection from IP: ${clientIp}`);

    // --- WhatsApp Status ---
    if (sock && sock.user) {
        socket.emit('status', { status: 'Connected', user: sock.user.id.split(':')[0] });
    } else if (currentQR) {
        socket.emit('qr_code', currentQR);
    } else {
        socket.emit('status', { status: 'Disconnected' });
    }

    // --- Printer Status ---
    // Send current printer status to the newly connected client (Web UI)
    socket.emit('printer_status', {
        connected: !!printerSocket, 
        code: printerSocket ? null : printerPairingCode // Only send code if not connected
    });

    // --- Printer Logic ---

    // 1. Handle Printer Identification (from Android)
    socket.on('identify_printer', (data) => {
        const timestamp = new Date().toLocaleString();
        console.log(`[${timestamp}] 🖨️  Printer connection attempt from IP: ${clientIp} | Code: ${data.code}`);

        if (data.code === printerPairingCode) {
            console.log(`[${timestamp}] ✅ Printer identified successfully! IP: ${clientIp}`);
            printerSocket = socket;
            cetakPesan.setPrinterSocket(printerSocket);
            
            // Notify Android
            socket.emit('printer_connected', { status: true });

            // Notify all Web clients
            io.emit('printer_status', { connected: true, code: null });

            // Handle printer disconnect
            socket.on('disconnect', () => {
                const disconnectTime = new Date().toLocaleString();
                console.log(`[${disconnectTime}] ⚠️  Printer disconnected. IP: ${clientIp}`);
                printerSocket = null;
                cetakPesan.setPrinterSocket(null);
                io.emit('printer_status', { connected: false, code: printerPairingCode });
            });

        } else {
            console.log(`[${timestamp}] ❌ Printer identification failed. Invalid code. IP: ${clientIp}`);
            socket.emit('printer_connected', { status: false, error: 'Invalid Code' });
        }
    });

    // 2. Handle Disconnect Request (from Web UI)
    socket.on('disconnect_printer', () => {
        console.log('Web UI requested to disconnect printer.');
        if (printerSocket) {
            printerSocket.disconnect(true); // Force disconnect the printer socket
            printerSocket = null;
            cetakPesan.setPrinterSocket(null);
        }
        
        // Generate NEW code for security
        printerPairingCode = generatePairingCode();
        console.log('New pairing code generated:', printerPairingCode);

        // Notify all Web clients
        io.emit('printer_status', { connected: false, code: printerPairingCode });
    });

    // --- End Printer Logic ---

    socket.on('logout', async () => {
        if (sock) {
            console.log('Logout request received. Logging out...');
            io.emit('status', { status: 'Logging out' });
            try {
                await sock.logout();
            } catch (error) {
                console.error('Error during sock.logout():', error);
                io.emit('status', { status: 'Logout failed', error: error.message });
            }
        } else {
            console.log('Logout request received, but no active WhatsApp connection.');
            io.emit('status', { status: 'Disconnected' });
        }
    });

    socket.on('disconnect', () => {
        // console.log('Client disconnected.');
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

    // Pass the sock object to the message sending routers
    kirimPesan.init(sock);
    kirimMedia.init(sock);

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
            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`Connection closed. Reason: "${lastDisconnect.error?.message}", status code: ${statusCode}. Reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('Permanent disconnect (logged out). Clearing session and restarting...');
                io.emit('status', { status: 'Disconnected' });
                try {
                    await clearData();
                    sock = undefined;
                    kirimPesan.init(null);
                    kirimMedia.init(null);
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
            const imageCaption = msg.message?.imageMessage?.caption;

            if (messageContent) {
                console.log(`Pesan dari ${sender}: ${messageContent}`);
                io.emit('new_message', { from: sender, message: messageContent });
                
                // --- PRINTER INTEGRATION ---
                // Jika ada printer yang terhubung, kirim pesan ke printer
                if (printerSocket) {
                    console.log(`Sending message to printer...`);
                    printerSocket.emit('print_message', {
                        sender: sender.replace('@s.whatsapp.net', ''),
                        message: messageContent,
                        timestamp: new Date().toISOString()
                    });
                }
            }

            // Logic to forward image if caption is '/forward'
            if (imageCaption && imageCaption.toLowerCase() === '/forward') {
                console.log(`Received image with /forward caption from ${sender}`);

                // Kakak, jangan lupa ganti nomor ini dengan nomor tujuan yang benar
                const targetJid = '6281234567890@s.whatsapp.net';

                try {
                    // Forward the original message object
                    await sock.sendMessage(targetJid, {
                        forward: msg 
                    });

                    // Send a confirmation back to the sender
                    await sock.sendMessage(sender, {
                        text: 'Gambar sudah berhasil di-forward, kakak!' 
                    });
                    console.log(`Image from ${sender} forwarded to ${targetJid}`);
                } catch (error) {
                    console.error('Failed to forward image:', error);
                    await sock.sendMessage(sender, { 
                        text: 'Maaf, gagal mem-forward gambar.' 
                    });
                }
            }
        }
    });
}

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    connectToWhatsApp();
});
