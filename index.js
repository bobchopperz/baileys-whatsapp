const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

let sock;

// Menyajikan file statis dari direktori root
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('A user connected');

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
        console.log('User disconnected');
    });
});


async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        printQRInTerminal: false,
        auth: state
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('QR code received, sending to client.');
            io.emit('qr_code', qr);
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            io.emit('status', { status: 'Connection Closed' });
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('Connection closed permanently. Not reconnecting.');
                sock = undefined;
            }
        } else if (connection === 'open') {
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
